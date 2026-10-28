import Foundation
import AVFoundation
import CoreImage

/// 运行真实转换器的合成 PCM 回归，不依赖麦克风或屏幕权限。
@main
struct RecordingTests {
    /// 读取首像素以比较实际渲染结果。
    static func firstPixel(_ image: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(image, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        let bytes = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
        return Array(UnsafeBufferPointer(start: bytes, count: 4))
    }

    /// 验证单声道转换、全零 PCM 就绪及视频前音频丢弃。
    static func testPCM(rate: Double, silent: Bool) throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("sct-pcm-\(UUID().uuidString).mov")
        let recorder = try Recorder(path: url.path, width: 16, height: 16, audioEnabled: true)
        defer {
            recorder.writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
        }
        recorder.requiresMicrophoneAudio = true
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
        input.frameLength = 1024
        for frame in 0..<1024 {
            input.floatChannelData![0][frame] = silent ? 0 : Float(sin(Double(frame) * 0.1)) * 0.25
        }
        let sample = try recorder.makePCMSample(input, at: .zero)
        recorder.append(sample, isAudio: true)
        precondition(!recorder.receivedAudio && recorder.pendingAudio.isEmpty)
        recorder.started = true
        recorder.startTime = .zero
        recorder.videoCount = 1
        recorder.signalIfReady()
        precondition(recorder.ready.wait(timeout: .now()) == .timedOut)
        recorder.append(sample, isAudio: true)
        if let error = recorder.error { throw error }
        precondition(recorder.receivedAudio)
        precondition(recorder.ready.wait(timeout: .now()) == .success)
        let output = recorder.pendingAudio.first!.1
        precondition(output.frameLength > 0 && output.format.channelCount == 2)
        precondition(output.format.sampleRate == 48000)
        var energy: Float = 0
        for frame in 0..<Int(output.frameLength) {
            let left = output.floatChannelData![0][frame]
            let right = output.floatChannelData![1][frame]
            precondition(left.isFinite && right.isFinite && abs(left - right) < 0.0001)
            energy += abs(left)
        }
        precondition(silent ? energy == 0 : energy > 0)
        // 第二个样本继续使用同一转换器，覆盖流式转换状态。
        let next = try recorder.makePCMSample(input, at: CMTime(value: 1024, timescale: Int32(rate)))
        recorder.append(next, isAudio: true)
        if let error = recorder.error { throw error }
        precondition(recorder.pendingAudio.count == 2)
        precondition(recorder.ready.wait(timeout: .now()) == .timedOut)
    }

    /// 验证系统静音模式只等视频，以及异步错误立即唤醒等待。
    static func testReadiness() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("sct-ready-\(UUID().uuidString).mov")
        let recorder = try Recorder(path: url.path, width: 16, height: 16, audioEnabled: true)
        defer {
            recorder.writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
        }
        recorder.videoCount = 1
        recorder.signalIfReady()
        precondition(recorder.ready.wait(timeout: .now()) == .success)
        precondition(!recorder.receivedAudio)
        recorder.requiresMicrophoneAudio = true
        recorder.fail(NSError(domain: "SyntheticAudio", code: -123))
        precondition(recorder.ready.wait(timeout: .now()) == .success)
        precondition((recorder.error! as NSError).code == -123)
    }

    /// 验证多层阶段包装后仍输出真正的系统错误及失败原因。
    static func testErrorChain() {
        let underlying = NSError(domain: NSOSStatusErrorDomain, code: 1937010544,
            userInfo: [NSLocalizedDescriptionKey: "设备启动失败", "AVErrorFourCharCode": "stop"])
        let native = NSError(domain: AVFoundationErrorDomain, code: -11800,
            userInfo: [NSLocalizedFailureReasonErrorKey: "音频服务无法启动",
                       NSUnderlyingErrorKey: underlying])
        let wrapper = NSError(domain: AVFoundationErrorDomain, code: -11800,
            userInfo: [NSLocalizedDescriptionKey: "麦克风采集会话中断", NSUnderlyingErrorKey: native])
        let text = errorMessage(wrapper)
        precondition(text.contains("麦克风采集会话中断"))
        precondition(text.contains("音频服务无法启动"))
        precondition(text.contains("NSOSStatusErrorDomain:1937010544"))
        precondition(text.contains("FourCC：stop"))
    }

    /// 合成画面并检查真实 MOV 音轨；不依赖屏幕或麦克风权限。
    static func testTracks(audioEnabled: Bool) throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("sct-tracks-\(UUID().uuidString).mov")
        let recorder: Recorder
        if audioEnabled {
            recorder = try Recorder(path: url.path, width: 16, height: 16, audioEnabled: true)
        } else {
            // 不传参数也必须是纯视频。
            recorder = try Recorder(path: url.path, width: 16, height: 16)
        }
        defer {
            if recorder.writer.status == .writing { recorder.writer.cancelWriting() }
            try? FileManager.default.removeItem(at: url)
        }
        precondition((recorder.audio != nil) == audioEnabled)
        precondition(recorder.writer.inputs.filter { $0.mediaType == .audio }.count == (audioEnabled ? 1 : 0))
        let videoSettings = recorder.video.outputSettings!
        let colorProperties = videoSettings[AVVideoColorPropertiesKey] as! [String: Any]
        precondition(colorProperties[AVVideoColorPrimariesKey] as? String == AVVideoColorPrimaries_ITU_R_709_2)
        precondition(colorProperties[AVVideoTransferFunctionKey] as? String == AVVideoTransferFunction_ITU_R_709_2)
        precondition(colorProperties[AVVideoYCbCrMatrixKey] as? String == AVVideoYCbCrMatrix_ITU_R_709_2)
        var pixel: CVPixelBuffer?
        precondition(CVPixelBufferCreate(kCFAllocatorDefault, 16, 16, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel) == kCVReturnSuccess)
        let image = pixel!
        CVPixelBufferLockBaseAddress(image, [])
        let bytes = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
        for row in 0..<16 {
            for col in 0..<16 {
                let offset = row * CVPixelBufferGetBytesPerRow(image) + col * 4
                bytes[offset] = 64
                bytes[offset + 1] = 128
                bytes[offset + 2] = 192
                bytes[offset + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(image, [])
        CVBufferSetAttachment(image, kCVImageBufferColorPrimariesKey,
            kCVImageBufferColorPrimaries_P3_D65, .shouldPropagate)
        CVBufferSetAttachment(image, kCVImageBufferTransferFunctionKey,
            kCVImageBufferTransferFunction_sRGB, .shouldPropagate)
        CVBufferSetAttachment(image, kCVImageBufferCGColorSpaceKey,
            CGColorSpace(name: CGColorSpace.displayP3)!, .shouldPropagate)
        let sourceAttachments = CFDictionaryCreateCopy(kCFAllocatorDefault,
            CVBufferGetAttachments(image, .shouldPropagate)!)!
        var reference: CVPixelBuffer?
        precondition(CVPixelBufferCreate(kCFAllocatorDefault, 16, 16, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &reference) == kCVReturnSuccess)
        let referenceContext = CIContext()
        referenceContext.render(CIImage(cvPixelBuffer: image), to: reference!,
            bounds: CGRect(x: 0, y: 0, width: 16, height: 16),
            colorSpace: CGColorSpace(name: CGColorSpace.itur_709)!)
        var format: CMVideoFormatDescription?
        precondition(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
            imageBuffer: image, formatDescriptionOut: &format) == noErr)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        precondition(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault,
            imageBuffer: image, formatDescription: format!, sampleTiming: &timing,
            sampleBufferOut: &sample) == noErr)
        try recorder.queue.sync {
            recorder.append(sample!, isAudio: false)
            if let error = recorder.error { throw error }
            precondition(recorder.didSignalReady)
            precondition(CFEqual(sourceAttachments, CVBufferGetAttachments(image, .shouldPropagate)!))
            precondition(CVBufferGetAttachment(image, kCVImageBufferColorPrimariesKey, nil)
                .map { CFEqual($0.takeUnretainedValue(), kCVImageBufferColorPrimaries_P3_D65) } == true)
            precondition(CVBufferGetAttachment(image, kCVImageBufferTransferFunctionKey, nil)
                .map { CFEqual($0.takeUnretainedValue(), kCVImageBufferTransferFunction_sRGB) } == true)
            let normalized = recorder.lastImage!
            for (actual, expected) in zip(firstPixel(normalized), firstPixel(reference!)) {
                precondition(abs(Int(actual) - Int(expected)) <= 1)
            }
            precondition(firstPixel(normalized) != firstPixel(image))
            precondition(CVBufferGetAttachment(normalized, kCVImageBufferColorPrimariesKey, nil)
                .map { CFEqual($0.takeUnretainedValue(), kCVImageBufferColorPrimaries_ITU_R_709_2) } == true)
            precondition(CVBufferGetAttachment(normalized, kCVImageBufferTransferFunctionKey, nil)
                .map { CFEqual($0.takeUnretainedValue(), kCVImageBufferTransferFunction_ITU_R_709_2) } == true)
            precondition((recorder.audioTimer != nil) == audioEnabled)
            if !audioEnabled {
                let pcm = AVAudioPCMBuffer(pcmFormat: recorder.pcmFormat, frameCapacity: 960)!
                pcm.frameLength = 960
                let audio = try recorder.makePCMSample(pcm, at: .zero)
                recorder.append(audio, isAudio: true)
                try recorder.fillSilence(until: 960, deadline: Date())
                precondition(!recorder.receivedAudio && recorder.pendingAudio.isEmpty)
                precondition(recorder.audioFrames == 0 && recorder.audioFormat == nil)
            }
            // 每帧重新构造格式描述仍应保持格式等价，并成功写入连续画面。
            var firstFormat: CMVideoFormatDescription?
            precondition(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
                imageBuffer: normalized, formatDescriptionOut: &firstFormat) == noErr)
            for frame in 1...5 {
                timing.presentationTimeStamp = CMTime(value: Int64(frame), timescale: 30)
                precondition(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault,
                    imageBuffer: image, formatDescription: format!, sampleTiming: &timing,
                    sampleBufferOut: &sample) == noErr)
                try recorder.waitUntilReady(recorder.video, deadline: Date().addingTimeInterval(5))
                recorder.append(sample!, isAudio: false)
                if let error = recorder.error { throw error }
                var nextFormat: CMVideoFormatDescription?
                precondition(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
                    imageBuffer: recorder.lastImage!, formatDescriptionOut: &nextFormat) == noErr)
                precondition(CMFormatDescriptionEqual(firstFormat!, otherFormatDescription: nextFormat!))
            }
            precondition(recorder.videoCount == 6)
            precondition(CFEqual(sourceAttachments, CVBufferGetAttachments(image, .shouldPropagate)!))
        }
        let stopTime = CMTimeAdd(recorder.startHostTime, CMTime(value: 1, timescale: 2))
        try recorder.queue.sync { try recorder.finalize(at: stopTime, stopError: nil) }
        precondition(recorder.audioTimer == nil)
        let asset = AVURLAsset(url: url)
        precondition(asset.tracks(withMediaType: .video).count == 1)
        precondition(asset.tracks(withMediaType: .audio).count == (audioEnabled ? 1 : 0))
        precondition(CMTimeGetSeconds(asset.duration) >= 0.49)
        let track = asset.tracks(withMediaType: .video)[0]
        let encodedFormat = track.formatDescriptions[0] as! CMFormatDescription
        for key in [kCMFormatDescriptionExtension_ColorPrimaries,
                    kCMFormatDescriptionExtension_TransferFunction,
                    kCMFormatDescriptionExtension_YCbCrMatrix] {
            precondition(CMFormatDescriptionGetExtension(encodedFormat, extensionKey: key)
                .map { CFEqual($0, kCVImageBufferColorPrimaries_ITU_R_709_2) } == true)
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        reader.add(output)
        precondition(reader.startReading())
        var decodedFrames = 0
        while let decoded = output.copyNextSampleBuffer() {
            precondition(CMSampleBufferGetImageBuffer(decoded) != nil)
            decodedFrames += 1
        }
        if let error = reader.error { throw error }
        precondition(reader.status == .completed && decodedFrames >= 6)
    }

    /// 无真实采集地验证终止状态可被轮询发现，保留首错并清理输出。
    static func testTerminalCleanup(sessionStopped: Bool, firstError: Bool) throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("sct-terminal-\(UUID().uuidString).mov")
        let recorder = try Recorder(path: url.path, width: 16, height: 16)
        defer { try? FileManager.default.removeItem(at: url) }
        let original = NSError(domain: "SyntheticFirst", code: 73)
        recorder.queue.sync {
            if firstError { recorder.fail(original) }
            if sessionStopped {
                recorder.session = AVCaptureSession()
                recorder.didSignalReady = true
            } else {
                recorder.writer.cancelWriting()
            }
        }
        let handle = Unmanaged.passUnretained(recorder).toOpaque()
        precondition(recordFinished(handle))
        let detected = recorder.queue.sync { recorder.error! as NSError }
        if firstError { precondition(detected.domain == original.domain && detected.code == original.code) }
        do {
            try recorder.stop(aborting: NSError(domain: "SyntheticLaterStop", code: 99))
            preconditionFailure("终止状态必须返回错误")
        } catch {
            let returned = error as NSError
            precondition(returned.domain == detected.domain && returned.code == detected.code)
        }
        precondition(!FileManager.default.fileExists(atPath: url.path))
        precondition(recorder.audioTimer == nil && recorder.observers.isEmpty)
    }

    /// 验证纯视频启动取消能够清理文件，且无需音频对象。
    static func testVideoOnlyAbort() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("sct-abort-\(UUID().uuidString).mov")
        let recorder = try Recorder(path: url.path, width: 16, height: 16)
        do {
            try recorder.stop(aborting: NSError(domain: "SyntheticCancel", code: 42))
            preconditionFailure("取消应返回原始错误")
        } catch {
            precondition((error as NSError).domain == "SyntheticCancel")
        }
        precondition(recorder.audio == nil && recorder.audioTimer == nil)
        precondition(!FileManager.default.fileExists(atPath: url.path))
    }

    /// 验证 Retina 全屏、局部区域和普通屏幕的输出像素尺寸。
    static func testRecordingSize() {
        let bounds = CGRect(x: 0, y: 0, width: 1800, height: 1169)
        let full = nativeRecordingSize(bounds, bounds: bounds, pixelWidth: 3600, pixelHeight: 2338)
        precondition(full.0 == 3600 && full.1 == 2338)
        let region = nativeRecordingSize(CGRect(x: 100, y: 50, width: 801, height: 501),
            bounds: bounds, pixelWidth: 3600, pixelHeight: 2338)
        precondition(region.0 == 1602 && region.1 == 1002)
        let standard = nativeRecordingSize(bounds, bounds: bounds, pixelWidth: 1800, pixelHeight: 1169)
        precondition(standard.0 == 1800 && standard.1 == 1168)
    }

    /// 执行分辨率、PCM、真实音轨、取消及错误诊断回归。
    static func main() throws {
        testRecordingSize()
        print("PASS Retina full-screen, region and standard recording sizes")
        for rate in [44100.0, 48000.0] {
            for silent in [false, true] {
                try testPCM(rate: rate, silent: silent)
                print("PASS mono \(Int(rate)) Hz -> stereo 48000 Hz, silent=\(silent)")
            }
        }
        try testReadiness()
        print("PASS system silence and asynchronous error readiness")
        testErrorChain()
        print("PASS nested native error diagnostics")
        try testTracks(audioEnabled: false)
        print("PASS video-only MOV has no audio input, timer or track")
        try testTracks(audioEnabled: true)
        print("PASS enabled system silence retains AAC track")
        try testVideoOnlyAbort()
        print("PASS video-only startup cancellation cleanup")
        for sessionStopped in [false, true] {
            for firstError in [false, true] {
                try testTerminalCleanup(sessionStopped: sessionStopped, firstError: firstError)
                print("PASS terminal cleanup and first error, sessionStopped=\(sessionStopped), firstError=\(firstError)")
            }
        }
    }
}
