import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreGraphics
import CoreImage

/// 将逻辑区域换算为主屏原生像素；裁剪坐标仍为 points。
func nativeRecordingSize(_ rect: CGRect, bounds: CGRect, pixelWidth: Int, pixelHeight: Int) -> (Int, Int) {
    let width = Int((rect.width * CGFloat(pixelWidth) / bounds.width).rounded()) / 2 * 2
    let height = Int((rect.height * CGFloat(pixelHeight) / bounds.height).rounded()) / 2 * 2
    return (width, height)
}

/// 将原生错误转换为供 Rust 释放的字符串。
private func message(_ text: String) -> UnsafeMutablePointer<CChar>? { strdup(text) }
/// 构造面向调用方的原生录屏错误。
private func failure(_ text: String) -> NSError {
    NSError(domain: "ScreenCaptureTool", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
}

/// 展开有界原生错误链及失败原因，避免包装错误遮住底层 OSStatus。
func errorMessage(_ error: Error) -> String {
    var current: NSError? = error as NSError
    var visited = Set<ObjectIdentifier>()
    var details: [String] = []
    while let native = current, details.count < 8 {
        guard visited.insert(ObjectIdentifier(native)).inserted else { break }
        var text = "\(native.localizedDescription) [\(native.domain):\(native.code)]"
        if let reason = native.localizedFailureReason { text += "；失败原因：\(reason)" }
        if let suggestion = native.localizedRecoverySuggestion { text += "；恢复建议：\(suggestion)" }
        if let fourCC = native.userInfo["AVErrorFourCharCode"] as? String {
            text += "；FourCC：\(fourCC)"
        }
        details.append(text)
        current = native.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return details.joined(separator: "\n  原因：")
}

/// 添加失败阶段，同时保留原生错误供桥接诊断。
private func contextualFailure(_ stage: String, _ error: Error) -> NSError {
    let native = error as NSError
    return NSError(domain: native.domain, code: native.code, userInfo: [
        NSLocalizedDescriptionKey: "\(stage)：\(native.localizedDescription)",
        NSUnderlyingErrorKey: native
    ])
}

/// 全程保有发现会话；枚举与启动共用 macOS 10.15 支持的音频设备类型。
private enum Microphones {
    static let discovery = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.builtInMicrophone, .externalUnknown], mediaType: .audio, position: .unspecified)

    /// 等待所选设备连接；挂起状态交由原生输入打开流程处理。
    static func connectedDevice(id: String, timeout: TimeInterval = 5) throws -> AVCaptureDevice {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let device = discovery.devices.first(where: { $0.uniqueID == id }),
               device.isConnected {
                return device
            }
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
            // 无可运行事件源时仍限制轮询频率。
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        throw failure("音频输入连接超时：所选麦克风未连接或尚未就绪，请确认设备连接后重新选择")
    }
}

/// 保留 CoreMedia 返回码以便定位格式和样本构造错误。
private func requireSuccess(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else { throw failure("\(operation)失败（OSStatus \(status)）") }
}

/// 保存迟到回调的结果；超时后回调仍拥有独立且受锁保护的存储。
private final class PendingResult<Value> {
    let lock = NSLock()
    var result: Result<Value, Error>?
    func store(_ value: Result<Value, Error>) {
        lock.lock()
        result = value
        lock.unlock()
    }
    func read() -> Result<Value, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return result
    }
}

/// 有界等待原生回调；回调捕获的资源不会随等待方超时而销毁。
func awaitResult<Value>(timeout: TimeInterval = 15, label: String,
    _ body: (@escaping (Result<Value, Error>) -> Void) -> Void) throws -> Value {
    let signal = DispatchSemaphore(value: 0)
    let pending = PendingResult<Value>()
    body { result in pending.store(result); signal.signal() }
    guard signal.wait(timeout: .now() + timeout) == .success,
          let result = pending.read() else { throw failure("\(label)超时") }
    return try result.get()
}

/// 将系统错误回调适配为有界等待，并保留回调可能继续访问的资源。
private func waitFor(label: String, retaining owner: AnyObject,
                     _ body: (@escaping (Error?) -> Void) -> Void) throws {
    let _: Void = try awaitResult(label: label) { done in
        body { [owner] error in
            withExtendedLifetime(owner) {
                done(error.map { .failure($0) } ?? .success(()))
            }
        }
    }
}

/// 将两种采集路径统一写入同一 MOV，串行处理时间戳和错误。
final class Recorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
    AVCaptureAudioDataOutputSampleBufferDelegate {
    let queue = DispatchQueue(label: "screen-capture.writer")
    let writer: AVAssetWriter
    let video: AVAssetWriterInput
    let audio: AVAssetWriterInput?
    let outputWidth: Int
    let outputHeight: Int
    let imageContext = CIContext()
    let lifecycle = DispatchQueue(label: "screen-capture.session")
    let stopLock = NSLock()
    private var stopRequested = false
    var session: AVCaptureSession?
    var screenStream: AnyObject?
    var streamOutput: AnyObject?
    var error: Error?
    var started = false
    var stopping = false
    var videoCount = 0
    var startTime = CMTime.invalid
    var startHostTime = CMTime.invalid
    var lastVideoTime = CMTime.invalid
    var lastImage: CVPixelBuffer?
    var audioFormat: CMAudioFormatDescription?
    var audioFrames: Int64 = 0
    var requiresMicrophoneAudio = false
    var receivedAudio = false
    var didSignalReady = false
    let ready = DispatchSemaphore(value: 0)
    var observers: [NSObjectProtocol] = []
    let pcmFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    var converter: AVAudioConverter?
    var converterFormat: AVAudioFormat?
    var audioTimer: DispatchSourceTimer?
    var pendingAudio: [(Int64, AVAudioPCMBuffer)] = []

    /// 供迟到的启动回调确认是否还应保持采集。
    func isStopRequested() -> Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        return stopRequested
    }

    /// 配置 H.264 及可选 AAC 输入；关闭音频时不创建音轨。
    init(path: String, width: Int, height: Int, audioEnabled: Bool = false) throws {
        guard width > 0, height > 0 else { throw failure("录屏区域必须至少为 2×2") }
        outputWidth = width
        outputHeight = height
        writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mov)
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width, AVVideoHeightKey: height
        ])
        audio = audioEnabled ? AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192000
        ]) : nil
        super.init()
        video.expectsMediaDataInRealTime = true
        guard writer.canAdd(video) else { throw failure("无法创建 H.264 录屏编码器") }
        writer.add(video)
        if let audio = audio {
            audio.expectsMediaDataInRealTime = true
            guard writer.canAdd(audio) else { throw failure("无法创建 AAC 录屏编码器") }
            writer.add(audio)
        }
        guard writer.startWriting() else { throw writer.error ?? failure("无法开始写入录屏") }
    }

    /// 在写入队列中保留首个异步错误并立即中断启动等待。
    func fail(_ problem: Error) {
        if error == nil {
            error = problem
        }
        ready.signal()
    }

    /// 麦克风必须收到真实 PCM 帧；系统声音允许全程无音频回调。
    func signalIfReady() {
        guard !didSignalReady, videoCount > 0,
              !requiresMicrophoneAudio || receivedAudio else { return }
        didSignalReady = true
        ready.signal()
    }

    /// 以首视频为时间基准，丢弃此前音频并按采集模式判断就绪。
    func append(_ sample: CMSampleBuffer, isAudio: Bool) {
        guard !stopping, error == nil, CMSampleBufferDataIsReady(sample) else { return }
        do {
            if isAudio {
                if audio != nil && started { try appendAudio(sample) }
                return
            }
            guard video.isReadyForMoreMediaData,
                  let image = CMSampleBufferGetImageBuffer(sample) else { return }
            let time = CMSampleBufferGetPresentationTimeStamp(sample)
            if !started {
                startTime = time
                startHostTime = CMClockGetTime(CMClockGetHostTimeClock())
                writer.startSession(atSourceTime: startTime)
                started = true
                startAudioTimer()
            }
            guard !lastVideoTime.isValid || CMTimeCompare(time, lastVideoTime) > 0 else { return }
            let normalized = try normalizeImage(image)
            try writeVideo(normalized, at: time, duration: CMTime(value: 1, timescale: 30))
            lastImage = normalized
            lastVideoTime = time
            videoCount += 1
            signalIfReady()
        } catch {
            fail(contextualFailure(isAudio ? "音频输出处理失败" : "视频输出处理失败", error))
        }
    }

    /// 使用实际像素尺寸缩放到编码尺寸，覆盖 Retina 和奇数区域宽高。
    func normalizeImage(_ image: CVPixelBuffer) throws -> CVPixelBuffer {
        if CVPixelBufferGetWidth(image) == outputWidth && CVPixelBufferGetHeight(image) == outputHeight {
            return image
        }
        var result: CVPixelBuffer?
        let status = CVPixelBufferCreate(kCFAllocatorDefault, outputWidth, outputHeight,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &result)
        guard status == kCVReturnSuccess, let result = result else { throw failure("创建录屏缩放缓冲失败") }
        let input = CIImage(cvPixelBuffer: image)
        let scaled = input.transformed(by: CGAffineTransform(
            scaleX: CGFloat(outputWidth) / input.extent.width,
            y: CGFloat(outputHeight) / input.extent.height))
        imageContext.render(scaled, to: result)
        return result
    }

    /// 写入具有明确持续时间的画面；最后一帧可一直保持到停止时刻。
    func writeVideo(_ image: CVPixelBuffer, at time: CMTime, duration: CMTime) throws {
        var description: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
            imageBuffer: image, formatDescriptionOut: &description) == noErr,
            let description = description else { throw failure("创建视频格式失败") }
        var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
            formatDescription: description, sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
            let sample = sample, video.append(sample) else {
            throw writer.error ?? failure("视频帧写入失败")
        }
    }

    /// 对编码器背压做有界等待；绝不将等待失败当成合法静音。
    func waitUntilReady(_ input: AVAssetWriterInput, deadline: Date) throws {
        while !input.isReadyForMoreMediaData {
            guard writer.status == .writing else { throw writer.error ?? failure("录屏编码器已停止") }
            guard Date() < deadline else { throw failure("等待录屏编码器接收样本超时") }
            Thread.sleep(forTimeInterval: 0.002)
        }
    }

    /// 获取并验证固定 PCM 格式，静音使用与真实音频相同的布局和采样率。
    func prepareAudioFormat(_ format: CMAudioFormatDescription? = nil) throws {
        audioFormat = pcmFormat.formatDescription
    }

    /// 将当前音频位置转换到与视频相同的原生时间轴。
    func audioTime(_ frames: Int64) -> CMTime {
        return CMTimeAdd(startTime, CMTime(value: frames, timescale: 48000))
    }

    /// 按 PCM 帧补齐实际音频之间的空白；全程无声也产生真实 AAC 音轨。
    func fillSilence(until target: Int64, deadline: Date, realtime: Bool = false) throws {
        guard let audio = audio else { return }
        while audioFrames < target {
            if realtime && !audio.isReadyForMoreMediaData { return }
            try waitUntilReady(audio, deadline: deadline)
            while let first = pendingAudio.first,
                  first.0 + Int64(first.1.frameLength) <= audioFrames { pendingAudio.removeFirst() }
            let first = pendingAudio.first
            var count = min(Int64(960), target - audioFrames)
            if let first = first, first.0 > audioFrames { count = min(count, first.0 - audioFrames) }
            if let first = first, first.0 <= audioFrames {
                count = min(count, first.0 + Int64(first.1.frameLength) - audioFrames)
            }
            guard let pcm = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(count)) else {
                throw failure("创建静音 PCM 缓冲失败")
            }
            pcm.frameLength = AVAudioFrameCount(count)
            for channel in 0..<2 {
                let destination = pcm.floatChannelData![channel]
                if let first = first, first.0 <= audioFrames {
                    let source = first.1.floatChannelData![channel].advanced(by: Int(audioFrames - first.0))
                    destination.update(from: source, count: Int(count))
                } else { destination.initialize(repeating: 0, count: Int(count)) }
            }
            let sample = try makePCMSample(pcm, at: audioTime(audioFrames))
            guard audio.append(sample) else {
                throw writer.error ?? failure("静音 PCM 写入失败")
            }
            audioFrames += Int64(count)
        }
    }

    /// PCM 样本使用精确的 1/sampleRate 时基；近似纳秒时基会被 CoreMedia 拒绝。
    func makePCMSample(_ pcm: AVAudioPCMBuffer, at time: CMTime) throws -> CMSampleBuffer {
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(pcm.format.sampleRate)),
            presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        let description = pcm.format.streamDescription.pointee
        var size = Int(description.mBytesPerFrame) *
            (pcm.format.isInterleaved ? 1 : Int(description.mChannelsPerFrame))
        try requireSuccess(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: pcm.format.formatDescription,
            sampleCount: Int(pcm.frameLength), sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample), "创建 PCM 样本")
        guard let sample = sample else { throw failure("创建 PCM 样本为空") }
        try requireSuccess(CMSampleBufferSetDataBufferFromAudioBufferList(sample,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, bufferList: pcm.audioBufferList), "复制 PCM 数据")
        try requireSuccess(CMSampleBufferSetDataReady(sample), "标记 PCM 样本就绪")
        return sample
    }

    /// 根据原始 PTS 补静音并裁掉首帧前或重叠音频，随后沿共同时间轴写入。
    func appendAudio(_ sample: CMSampleBuffer) throws {
        guard audio != nil else { return }
        guard let format = CMSampleBufferGetFormatDescription(sample) else { throw failure("缺少音频样本格式") }
        let source = AVAudioFormat(cmAudioFormatDescription: format)
        let count = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard count > 0, let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: count) else {
            throw failure("创建原生音频缓冲失败")
        }
        input.frameLength = count
        try requireSuccess(CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0,
            frameCount: Int32(count), into: input.mutableAudioBufferList), "读取原生 PCM")
        let pcm: AVAudioPCMBuffer
        if source == pcmFormat {
            pcm = input
        } else {
            if converter == nil || converterFormat != source {
                converter = AVAudioConverter(from: source, to: pcmFormat)
                converterFormat = source
                converter?.primeMethod = .none
            }
            guard let converter = converter,
                let output = AVAudioPCMBuffer(pcmFormat: pcmFormat,
                    frameCapacity: AVAudioFrameCount(ceil(Double(count) * 48000 / source.sampleRate)) + 64) else {
                throw failure("创建音频格式转换器失败")
            }
            var supplied = false
            var problem: NSError?
            let status = converter.convert(to: output, error: &problem) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true
                state.pointee = .haveData
                return input
            }
            if status == .error { throw problem ?? failure("转换原生 PCM 失败") }
            pcm = output
        }
        let offset = CMTimeGetSeconds(CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(sample), startTime))
        guard offset.isFinite else { throw failure("音频时间戳无效") }
        if pcm.frameLength > 0 {
            pendingAudio.append((Int64((offset * 48000).rounded()), pcm))
            if started {
                receivedAudio = true
                signalIfReady()
            }
        }
    }

    /// 每 20ms 推进音轨；250ms 重排窗口让正常晚于视频到达的音频先入队。
    func startAudioTimer() {
        guard audio != nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.02, repeating: 0.02)
        timer.setEventHandler { [weak self] in
            guard let self = self, !self.stopping, self.error == nil else { return }
            let elapsed = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), self.startHostTime))
            do {
                try self.fillSilence(until: max(0, Int64((elapsed - 0.25) * 48000)),
                    deadline: Date().addingTimeInterval(2), realtime: true)
            } catch { self.fail(contextualFailure("音频输出写入失败", error)) }
        }
        audioTimer = timer
        timer.resume()
    }

    /// 接收麦克风样本及旧版会话的视频样本。
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        append(sampleBuffer, isAudio: output is AVCaptureAudioDataOutput)
    }

    /// 配置旧版主屏输入及可选麦克风；纯视频路径不查询或请求麦克风权限。
    func startCaptureSession(microphoneID: String?, rect: CGRect) throws {
        requiresMicrophoneAudio = microphoneID != nil
        if microphoneID != nil {
            var allowed = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                allowed = try awaitResult(timeout: 60, label: "等待麦克风授权") { done in
                    AVCaptureDevice.requestAccess(for: .audio) { done(.success($0)) }
                }
            }
            guard allowed else { throw failure("麦克风权限未授予，请在系统设置中允许本应用访问麦克风") }
        }
        var inputs: [(AVCaptureInput, String)] = []
        var outputs: [(AVCaptureOutput, String)] = []
        if #unavailable(macOS 13.0) {
            guard let screen = AVCaptureScreenInput(displayID: CGMainDisplayID()) else {
                throw failure("屏幕输入失败：无法创建主屏采集")
            }
            // UI 区域原点在左上角，AVCaptureScreenInput 的裁剪原点在左下角。
            let bounds = CGDisplayBounds(CGMainDisplayID())
            screen.cropRect = CGRect(x: rect.minX, y: bounds.height - rect.maxY,
                                     width: rect.width, height: rect.height)
            screen.minFrameDuration = CMTime(value: 1, timescale: 30)
            screen.capturesCursor = true
            screen.scaleFactor = 1
            inputs.append((screen, "屏幕"))
            let videoOutput = AVCaptureVideoDataOutput()
            // cropRect 始终使用原逻辑坐标；实际 Retina 像素尺寸在 normalizeImage 中校正。
            videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: queue)
            outputs.append((videoOutput, "视频"))
        }
        if let id = microphoneID {
            let device = try Microphones.connectedDevice(id: id)
            let microphone: AVCaptureDeviceInput
            do { microphone = try AVCaptureDeviceInput(device: device) }
            catch { throw contextualFailure("音频输入创建失败（\(device.localizedName)）", error) }
            inputs.append((microphone, "音频"))
            let audioOutput = AVCaptureAudioDataOutput()
            audioOutput.setSampleBufferDelegate(self, queue: queue)
            outputs.append((audioOutput, "音频"))
        }
        let capture = AVCaptureSession()
        session = capture
        var notifications = [AVCaptureSession.runtimeErrorNotification]
        if #available(macOS 10.14, *) { notifications.append(AVCaptureSession.wasInterruptedNotification) }
        for name in notifications {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: capture, queue: nil) {
                [weak self] notification in
                let problem = notification.userInfo?[AVCaptureSessionErrorKey] as? Error
                    ?? failure("麦克风或屏幕采集被系统中断")
                self?.queue.async { [weak self] in
                    self?.fail(contextualFailure("屏幕/麦克风采集会话中断", problem))
                }
            })
        }
        capture.beginConfiguration()
        defer { capture.commitConfiguration() }
        for (input, label) in inputs {
            guard capture.canAddInput(input) else { throw failure("\(label)输入失败：采集会话无法添加输入") }
            capture.addInput(input)
        }
        for (output, label) in outputs {
            guard capture.canAddOutput(output) else { throw failure("\(label)输出失败：采集会话无法添加输出") }
            capture.addOutput(output)
        }
    }

    /// 启动主屏流，按采集模式决定是否同时接收系统声音。
    @available(macOS 13.0, *)
    func startScreen(rect: CGRect, capturesAudio: Bool) throws {
        let content: SCShareableContent = try awaitResult(label: "读取可录制主屏") { done in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) {
                if let error = $1 { done(.failure(error)) }
                else if let content = $0 { done(.success(content)) }
                else { done(.failure(failure("系统未返回可录制屏幕"))) }
            }
        }
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
            throw failure("无法获取主屏，请检查屏幕录制权限")
        }
        let config = SCStreamConfiguration()
        config.sourceRect = rect
        config.width = outputWidth
        config.height = outputHeight
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.showsCursor = true
        config.capturesAudio = capturesAudio
        config.sampleRate = 48000
        config.channelCount = 2
        let output = ScreenOutput(self)
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []),
                              configuration: config, delegate: output)
        screenStream = stream
        streamOutput = output
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
        if capturesAudio {
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)
        }
        try waitFor(label: "启动屏幕采集", retaining: self) { [self, stream, output] done in
            stream.startCapture { [self, stream, output] error in
                if isStopRequested() {
                    // 超时后才启动成功时，继续持有输出对象直到补偿停止完成。
                    stream.stopCapture { [self, stream, output] _ in
                        withExtendedLifetime((self, stream, output)) { done(error) }
                    }
                } else {
                    withExtendedLifetime((self, stream, output)) { done(error) }
                }
            }
        }
    }

    /// 有界等待会阻塞的 AVCaptureSession 操作，后台闭包保有完整录制资源。
    func changeSession(running: Bool) throws {
        let _: Void = try awaitResult(label: running ? "启动采集会话" : "停止采集会话") { done in
            lifecycle.async { [self] in
                if running { session?.startRunning() } else { session?.stopRunning() }
                done(.success(()))
            }
        }
    }

    /// 封装到用户停止的时刻，补静音和静止画面尾帧以保持音视频同长。
    func finalize(at hostTime: CMTime, stopError: Error?) throws {
        stopping = true
        audioTimer?.cancel()
        audioTimer = nil
        defer {
            observers.forEach { NotificationCenter.default.removeObserver($0) }
            observers.removeAll()
        }
        do {
            if let problem = error ?? stopError { throw problem }
            guard started, videoCount > 0, let image = lastImage else {
                throw failure("录屏未收到视频帧，请检查屏幕录制权限")
            }
            let deadline = Date().addingTimeInterval(25)
            let frameDuration = CMTime(value: 1, timescale: 30)
            let mappedStop = CMTimeAdd(startTime, CMTimeSubtract(hostTime, startHostTime))
            let pendingEnd = pendingAudio.map { $0.0 + Int64($0.1.frameLength) }.max() ?? 0
            var end = CMTimeMaximum(mappedStop, CMTimeAdd(lastVideoTime, frameDuration))
            if audio != nil {
                try prepareAudioFormat()
                end = CMTimeMaximum(end, audioTime(max(audioFrames, pendingEnd)))
                let rate = CMAudioFormatDescriptionGetStreamBasicDescription(audioFormat!)!.pointee.mSampleRate
                let targetFrames = Int64(ceil(CMTimeGetSeconds(CMTimeSubtract(end, startTime)) * rate))
                try fillSilence(until: targetFrames, deadline: deadline)
            }
            let tailTime = CMTimeAdd(lastVideoTime, frameDuration)
            if CMTimeCompare(end, tailTime) > 0 {
                try waitUntilReady(video, deadline: deadline)
                try writeVideo(image, at: tailTime, duration: CMTimeSubtract(end, tailTime))
            }
            writer.endSession(atSourceTime: end)
            video.markAsFinished()
            audio?.markAsFinished()
            try waitFor(label: "完成录屏封装", retaining: writer) { [self] done in
                writer.finishWriting { [self] in done(writer.error) }
            }
            guard writer.status == .completed else { throw writer.error ?? failure("录屏文件封装失败") }
        } catch {
            // cancelWriting 不会销毁 finishWriting 回调持有的 writer/recorder。
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: writer.outputURL)
            throw error
        }
    }

    /// 停止时等待均有上限；迟到回调继续持有其访问的采集器和输出对象。
    func stop(aborting startupError: Error? = nil) throws {
        let hostTime = CMClockGetTime(CMClockGetHostTimeClock())
        stopLock.lock()
        stopRequested = true
        stopLock.unlock()
        var stopError: Error? = startupError
        if #available(macOS 13.0, *), let stream = screenStream as? SCStream {
            do {
                try waitFor(label: "停止屏幕采集", retaining: self) { [self, stream] done in
                    stream.stopCapture { [self, stream, output = streamOutput] error in
                        withExtendedLifetime((self, stream, output)) { done(error) }
                    }
                }
            }
            catch { stopError = stopError ?? error }
        }
        if session != nil {
            do { try changeSession(running: false) } catch { stopError = stopError ?? error }
        }
        let problem = stopError
        let _: Void = try awaitResult(timeout: 45, label: "停止录屏并排空编码队列") { done in
            queue.async { [self] in
                do { try finalize(at: hostTime, stopError: problem); done(.success(())) }
                catch { done(.failure(error)) }
            }
        }
    }
}

@available(macOS 13.0, *)
private final class ScreenOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    weak var recorder: Recorder?
    init(_ recorder: Recorder) { self.recorder = recorder }

    /// 只接收完整屏幕帧，并将系统声音交给共同写入器。
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer,
                of type: SCStreamOutputType) {
        if type == .screen {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
                let status = attachments.first?[.status] as? Int,
                status == SCFrameStatus.complete.rawValue else { return }
            recorder?.append(sample, isAudio: false)
        } else if type == .audio { recorder?.append(sample, isAudio: true) }
    }

    /// 在同一串行队列中保留流中断原因。
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard let recorder = recorder else { return }
        recorder.queue.async { recorder.fail(contextualFailure("屏幕采集流中断", error)) }
    }
}

/// 原生枚举不弹权限框；麦克风仅在用户实际开始录制时申请。
@_cdecl("sct_audio_sources")
public func audioSources() -> UnsafeMutablePointer<CChar>? {
    var sources: [[String: String]] = [["id": "system", "name": "系统声音", "kind": "内置"]]
    sources += Microphones.discovery.devices.map {
        ["id": $0.uniqueID, "name": $0.localizedName, "kind": "麦克风"]
    }
    let data = try! JSONSerialization.data(withJSONObject: sources)
    return message(String(decoding: data, as: UTF8.self))
}

/// 创建采集器并等待原生启动完成，不使用运行时脚本或外部编码器。
@_cdecl("sct_record_start")
public func recordStart(_ path: UnsafePointer<CChar>, _ source: UnsafePointer<CChar>,
                 _ audioEnabled: Bool,
                 _ x: UInt32, _ y: UInt32, _ width: UInt32, _ height: UInt32,
                 _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> UnsafeMutableRawPointer? {
    let destination = String(cString: path)
    var recorder: Recorder?
    do {
        let sourceID = String(cString: source)
        if audioEnabled && sourceID == "system" {
            guard #available(macOS 13.0, *) else { throw failure("系统声音录制需要 macOS 13 或更新版本，请选择麦克风") }
        }
        let rect = CGRect(x: Int(x), y: Int(y), width: Int(width), height: Int(height))
        let displayID = CGMainDisplayID()
        let native = nativeRecordingSize(rect, bounds: CGDisplayBounds(displayID),
            pixelWidth: CGDisplayPixelsWide(displayID), pixelHeight: CGDisplayPixelsHigh(displayID))
        let instance = try Recorder(path: destination, width: native.0, height: native.1,
                                    audioEnabled: audioEnabled)
        recorder = instance
        if !audioEnabled {
            if #available(macOS 13.0, *) {
                try instance.startScreen(rect: rect, capturesAudio: false)
            } else {
                try instance.startCaptureSession(microphoneID: nil, rect: rect)
                try instance.changeSession(running: true)
            }
        } else if sourceID == "system" {
            if #available(macOS 13.0, *) {
                try instance.startScreen(rect: rect, capturesAudio: true)
            }
        } else {
            try instance.startCaptureSession(microphoneID: sourceID, rect: rect)
            try instance.changeSession(running: true)
            if #available(macOS 13.0, *) {
                try instance.startScreen(rect: rect, capturesAudio: false)
            }
        }
        let signaled = instance.ready.wait(timeout: .now() + (instance.requiresMicrophoneAudio ? 15 : 10)) == .success
        let _: Void = try awaitResult(label: "检查录屏启动结果") { done in
            instance.queue.async {
                if let error = instance.error { done(.failure(error)) }
                else if !signaled {
                    let detail = instance.videoCount == 0
                        ? "未收到视频帧，请检查屏幕录制权限"
                        : "音频输入未就绪：所选麦克风未提供可转换的 PCM 帧，请检查设备连接"
                    done(.failure(failure("启动录屏超时：\(detail)")))
                }
                else { done(.success(())) }
            }
        }
        return Unmanaged.passRetained(instance).toOpaque()
    } catch {
        if let recorder = recorder {
            try? recorder.stop(aborting: error)
        } else {
            try? FileManager.default.removeItem(atPath: destination)
        }
        outError.pointee = message(errorMessage(error))
        return nil
    }
}

/// 消费句柄一次，返回停止或封装错误。
@_cdecl("sct_record_stop")
public func recordStop(_ handle: UnsafeMutableRawPointer) -> UnsafeMutablePointer<CChar>? {
    let recorder = Unmanaged<Recorder>.fromOpaque(handle).takeRetainedValue()
    do { try recorder.stop(); return nil }
    catch { return message(errorMessage(error)) }
}

/// 查询异步错误及 AVCaptureSession 意外停止状态。
@_cdecl("sct_record_finished")
public func recordFinished(_ handle: UnsafeMutableRawPointer) -> Bool {
    let recorder = Unmanaged<Recorder>.fromOpaque(handle).takeUnretainedValue()
    return recorder.queue.sync {
        recorder.error != nil || (recorder.session != nil && recorder.session?.isRunning == false)
    }
}

/// 释放桥接字符串。
@_cdecl("sct_string_free")
public func stringFree(_ value: UnsafeMutablePointer<CChar>) { free(value) }
