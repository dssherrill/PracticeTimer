import { useState, useRef, useCallback } from 'react';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';

/**
 * Hook that provides live microphone metering.
 * Returns the current dBFS level normalised to 0–1 and controls to start/stop.
 *
 * expo-audio's AudioRecorder reports metering in dBFS (negative values, where 0 is
 * max loudness). We map the range [-60, 0] → [0, 1].
 */
export function useMicMeter() {
  const [level, setLevel] = useState(0);           // 0–1
  const [isActive, setIsActive] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const recorder = useAudioRecorder(
    { ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true },
  );
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  const start = useCallback(async () => {
    const { status } = await requestRecordingPermissionsAsync();
    if (status !== 'granted') return false;

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    });

    const rec = recorderRef.current;
    await rec.prepareToRecordAsync({
      ...RecordingPresets.LOW_QUALITY,
      isMeteringEnabled: true,
    });
    rec.record();

    // Poll metering every 100ms
    tickRef.current = setInterval(() => {
      try {
        const s = recorderRef.current.getStatus();
        if (s.isRecording && s.metering != null) {
          const db = Math.max(-60, Math.min(0, s.metering));
          setLevel((db + 60) / 60);
        }
      } catch {}
    }, 100);

    setIsActive(true);
    return true;
  }, []);

  const stop = useCallback(async () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    try {
      await recorderRef.current.stop();
    } catch {}
    await setAudioModeAsync({ allowsRecording: false });
    setLevel(0);
    setIsActive(false);
  }, []);

  return { level, isActive, start, stop };
}
