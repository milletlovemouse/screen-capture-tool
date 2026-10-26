import Foundation
import AVFoundation

/// 运行真实转换器的合成 PCM 回归，不依赖麦克风或屏幕权限。
@main
struct RecordingTests {
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
        var pixel: CVPixelBuffer?
        precondition(CVPixelBufferCreate(kCFAllocatorDefault, 16, 16, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel) == kCVReturnSuccess)
        let image = pixel!
        CVPixelBufferLockBaseAddress(image, [])
        memset(CVPixelBufferGetBaseAddress(image)!, 0, CVPixelBufferGetDataSize(image))
        CVPixelBufferUnlockBaseAddress(image, [])
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
        }
        let stopTime = CMTimeAdd(recorder.startHostTime, CMTime(value: 1, timescale: 2))
        try recorder.queue.sync { try recorder.finalize(at: stopTime, stopError: nil) }
        precondition(recorder.audioTimer == nil)
        let asset = AVURLAsset(url: url)
        precondition(asset.tracks(withMediaType: .video).count == 1)
        precondition(asset.tracks(withMediaType: .audio).count == (audioEnabled ? 1 : 0))
        precondition(CMTimeGetSeconds(asset.duration) >= 0.49)
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

    /// 执行 PCM、真实音轨、取消及错误诊断回归。
    static func main() throws {
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
    }
}
