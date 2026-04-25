import AVFoundation
import CoreAudio

/// Queries Core Audio's HAL input latency properties for an audio capture
/// device and returns the total input latency in seconds.
///
/// The latency represents the time between an acoustic event hitting the
/// mic and the corresponding sample buffer's PTS being stamped. Subtracting
/// this from audio PTS aligns audio with the real-world moment the sound
/// was produced, rather than when it was delivered to the host.
///
/// Reference: Cap's `crates/audio/src/latency.rs` (`compute_input_latency`).
enum HALInputLatency {
    /// Query total input latency for an `AVCaptureDevice` (audio).
    /// Returns 0 if the device can't be resolved or any query fails.
    static func totalInputLatency(for device: AVCaptureDevice) -> Double {
        guard let audioDeviceID = resolveAudioDeviceID(uid: device.uniqueID) else {
            print("[hal-latency] Could not resolve AudioDeviceID for \(device.localizedName)")
            return 0
        }

        let sampleRate = nominalSampleRate(device: audioDeviceID) ?? 48000

        let deviceLatency = getUInt32Property(
            object: audioDeviceID,
            selector: kAudioDevicePropertyLatency,
            scope: kAudioObjectPropertyScopeInput
        ) ?? 0

        let safetyOffset = getUInt32Property(
            object: audioDeviceID,
            selector: kAudioDevicePropertySafetyOffset,
            scope: kAudioObjectPropertyScopeInput
        ) ?? 0

        let bufferFrames = getUInt32Property(
            object: audioDeviceID,
            selector: kAudioDevicePropertyBufferFrameSize,
            scope: kAudioObjectPropertyScopeGlobal
        ) ?? 512

        let streamLatency = maxInputStreamLatency(device: audioDeviceID) ?? 0

        let deviceSeconds = Double(deviceLatency + safetyOffset + streamLatency) / sampleRate
        let bufferSeconds = Double(bufferFrames) / sampleRate
        let total = deviceSeconds + bufferSeconds

        print(String(
            format: "[hal-latency] %@: dev=%d safety=%d stream=%d buf=%d rate=%.0f → %.2fms",
            device.localizedName,
            deviceLatency, safetyOffset, streamLatency, bufferFrames,
            sampleRate, total * 1000
        ))

        return total
    }

    // MARK: - Private

    private static func resolveAudioDeviceID(uid: String) -> AudioDeviceID? {
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let cfUID = uid as CFString

        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = withUnsafePointer(to: cfUID) { uidPtr in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                UInt32(MemoryLayout<CFString>.size),
                uidPtr,
                &size,
                &deviceID
            )
        }

        guard status == noErr, deviceID != kAudioObjectUnknown else { return nil }
        return deviceID
    }

    private static func nominalSampleRate(device: AudioDeviceID) -> Double? {
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate)
        guard status == noErr, rate > 0 else { return nil }
        return rate
    }

    private static func getUInt32Property(
        object: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope
    ) -> UInt32? {
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr else { return nil }
        return value
    }

    private static func maxInputStreamLatency(device: AudioDeviceID) -> UInt32? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )

        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size)
        guard status == noErr, size > 0 else { return nil }

        let streamCount = Int(size) / MemoryLayout<AudioStreamID>.size
        var streams = [AudioStreamID](repeating: 0, count: streamCount)
        status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &streams)
        guard status == noErr else { return nil }

        var maxLatency: UInt32 = 0
        for stream in streams {
            if let lat = getUInt32Property(
                object: stream,
                selector: kAudioStreamPropertyLatency,
                scope: kAudioObjectPropertyScopeInput
            ) {
                maxLatency = max(maxLatency, lat)
            }
        }
        return maxLatency
    }
}
