import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
} from 'react';
import { AppState, AppStateStatus, Alert } from 'react-native';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import type { AudioRecorder } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SessionStatus, Interval, SessionRecord } from '../types';
import { useSettings } from './SettingsContext';

// ── Music detection ─────────────────────────────────────────
// Buffer size: 30 samples × 100ms = 3-second sliding window
const MUSIC_DETECT_BUFFER_SIZE = 30;

/**
 * Score how "music-like" the recent amplitude envelope is.
 *
 * Wind instruments produce sustained, stable amplitude. Speech has rapid
 * syllable-rate fluctuations (~3-7 Hz) and frequent dips. We measure:
 *   1. Sustain ratio — fraction of samples above the sensitivity threshold.
 *   2. Amplitude stability — 1 minus the coefficient of variation of the
 *      above-threshold samples (low CV = steady tone).
 *
 * Returns a score in [0, 1] where higher = more music-like.
 */
function computeMusicScore(buffer: number[], threshold: number): number {
  if (buffer.length < 5) return 1;   // not enough data — assume music

  const aboveThreshold = buffer.filter(a => a >= threshold);
  const sustainRatio = aboveThreshold.length / buffer.length;

  if (aboveThreshold.length < 3) return 0;   // mostly silence

  const mean = aboveThreshold.reduce((s, v) => s + v, 0) / aboveThreshold.length;
  const variance =
    aboveThreshold.reduce((s, v) => s + (v - mean) ** 2, 0) / aboveThreshold.length;
  const cv = Math.sqrt(variance) / Math.max(mean, 0.001);
  const stability = Math.max(0, 1 - cv);

  return 0.5 * sustainRatio + 0.5 * stability;
}

// ── Storage keys ────────────────────────────────────────────
const SNAPSHOT_KEY = '@PracticeTimer:sessionSnapshot';
const SESSIONS_KEY = '@PracticeTimer:sessions';
const SESSIONS_BACKUP_KEY = '@PracticeTimer:sessionsBackup';
const STATS_KEY = '@PracticeTimer:cumulativeStats';
const PIECE_NAMES_KEY = '@PracticeTimer:pieceNames';

// ── Snapshot (for crash recovery) ───────────────────────────
interface SessionSnapshot {
  sessionStartISO: string;
  elapsedAtSnapshot: number;     // seconds of elapsed session time at snapshot
  playTime: number;
  restTime: number;
  pauseTime: number;
  intervals: Interval[];
  pairBoundaries: number[];
  status: SessionStatus;
  currentIntervalStart: number;  // offset in seconds from session start
  lastUpdateEpoch: number;       // Date.now() at snapshot
  notes: string;
}

// ── Context value ───────────────────────────────────────────
interface SessionContextValue {
  status: SessionStatus;
  elapsed: number;               // total session seconds (excl. pause)
  playTime: number;
  restTime: number;
  pauseTime: number;
  intervals: Interval[];
  pairBoundaries: number[];
  micLevel: number;              // 0–1, live mic level
  start: () => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  nextPair: () => void;
  saveSession: (notes: string) => Promise<void>;
  discardSession: () => void;
  pendingSession: SessionRecord | null;   // set after STOP, before save/discard
  updatePairPieceName: (pairIndex: number, name: string) => void;
  currentPieceName: string;
  updateCurrentPieceName: (name: string) => void;
}

const SessionContext = createContext<SessionContextValue>({
  status: 'idle',
  elapsed: 0,
  playTime: 0,
  restTime: 0,
  pauseTime: 0,
  intervals: [],
  pairBoundaries: [],
  micLevel: 0,
  start: async () => {},
  stop: () => {},
  pause: () => {},
  resume: () => {},
  nextPair: () => {},
  saveSession: async () => {},
  discardSession: () => {},
  pendingSession: null,
  updatePairPieceName: () => {},
  currentPieceName: '',
  updateCurrentPieceName: () => {},
});

export function useSession() {
  return useContext(SessionContext);
}

// ── Provider ────────────────────────────────────────────────
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { settings } = useSettings();

  // ── state ──
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [playTime, setPlayTime] = useState(0);
  const [restTime, setRestTime] = useState(0);
  const [pauseTime, setPauseTime] = useState(0);
  const [intervals, setIntervals] = useState<Interval[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [pairBoundaries, setPairBoundaries] = useState<number[]>([]);
  const [pendingSession, setPendingSession] = useState<SessionRecord | null>(null);
  const [currentPieceName, setCurrentPieceNameState] = useState('');

  // Create the recorder via the hook so expo-audio manages its lifecycle
  const recorder = useAudioRecorder(
    { ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true },
  );
  const recorderRef = useRef<AudioRecorder | null>(null);
  recorderRef.current = recorder;

  // ── refs (mutable, no re-render) ──
  const statusRef = useRef<SessionStatus>('idle');
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef = useRef<string>('');
  const elapsedRef = useRef(0);
  const playTimeRef = useRef(0);
  const restTimeRef = useRef(0);
  const pauseTimeRef = useRef(0);
  const intervalsRef = useRef<Interval[]>([]);
  const currentIntervalStartRef = useRef(0);
  const silenceStartRef = useRef<number | null>(null);
  const soundStartRef = useRef<number | null>(null);
  const pauseStartRef = useRef<number | null>(null);
  const pairBoundariesRef = useRef<number[]>([]);
  const currentPieceNameRef = useRef('');
  const amplitudeBufferRef = useRef<number[]>([]);
  const settingsRef = useRef(settings);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // ── helpers ──
  const syncState = useCallback(() => {
    setElapsed(elapsedRef.current);
    setPlayTime(playTimeRef.current);
    setRestTime(restTimeRef.current);
    setPauseTime(pauseTimeRef.current);
    setIntervals([...intervalsRef.current]);
    setPairBoundaries([...pairBoundariesRef.current]);
  }, []);

  const finishCurrentInterval = useCallback((atOffset: number) => {
    const st = statusRef.current;
    if (st !== 'playing' && st !== 'resting') return;
    const dur = atOffset - currentIntervalStartRef.current;
    if (dur > 0) {
      intervalsRef.current.push({
        type: st === 'playing' ? 'play' : 'rest',
        startOffset: currentIntervalStartRef.current,
        duration: dur,
        ...(st === 'playing' && currentPieceNameRef.current ? { pieceName: currentPieceNameRef.current } : {}),
      });
    }
  }, []);

  const writeSnapshot = useCallback(() => {
    if (statusRef.current === 'idle') return;
    const snap: SessionSnapshot = {
      sessionStartISO: sessionStartRef.current,
      elapsedAtSnapshot: elapsedRef.current,
      playTime: playTimeRef.current,
      restTime: restTimeRef.current,
      pauseTime: pauseTimeRef.current,
      intervals: intervalsRef.current,
      pairBoundaries: pairBoundariesRef.current,
      status: statusRef.current,
      currentIntervalStart: currentIntervalStartRef.current,
      lastUpdateEpoch: Date.now(),
      notes: '',
    };
    AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  }, []);

  // ── START ──
  const start = useCallback(async () => {
    const { status: permStatus } = await requestRecordingPermissionsAsync();
    if (permStatus !== 'granted') {
      Alert.alert(
        'Microphone Required',
        'PracticeTimer needs microphone access to detect when you are playing. Please enable it in your device settings.',
      );
      return;
    }

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    });

    const rec = recorderRef.current;
    if (!rec) return;
    await rec.prepareToRecordAsync({
      ...RecordingPresets.LOW_QUALITY,
      isMeteringEnabled: true,
    });
    rec.record();

    // Reset state
    sessionStartRef.current = new Date().toISOString();
    elapsedRef.current = 0;
    playTimeRef.current = 0;
    restTimeRef.current = 0;
    pauseTimeRef.current = 0;
    intervalsRef.current = [];
    pairBoundariesRef.current = [0];
    currentPieceNameRef.current = '';
    setCurrentPieceNameState('');
    currentIntervalStartRef.current = 0;
    silenceStartRef.current = null;
    soundStartRef.current = null;
    pauseStartRef.current = null;
    amplitudeBufferRef.current = [];

    statusRef.current = 'waiting';
    setStatus('waiting');
    syncState();

    // Tick every 100ms: update elapsed/play/rest times AND poll metering
    tickRef.current = setInterval(() => {
      const st = statusRef.current;
      if (st === 'paused' || st === 'idle') return;

      elapsedRef.current += 0.1;

      if (st === 'playing') {
        playTimeRef.current += 0.1;
      } else if (st === 'resting') {
        restTimeRef.current += 0.1;
      }

      // Poll metering from recorder
      const r = recorderRef.current;
      if (r) {
        try {
          const recStatus = r.getStatus();
          if (recStatus.isRecording && recStatus.metering != null) {
            const db = Math.max(-60, Math.min(0, recStatus.metering));
            const norm = (db + 60) / 60;
            setMicLevel(norm);

            // Update amplitude buffer for music detection
            const buf = amplitudeBufferRef.current;
            buf.push(norm);
            if (buf.length > MUSIC_DETECT_BUFFER_SIZE) buf.shift();

            const threshold = settingsRef.current.sensitivityThreshold;
            let isLoud = norm >= threshold;

            // Apply music detection filter if enabled
            if (isLoud && settingsRef.current.musicDetectionEnabled) {
              const score = computeMusicScore(buf, threshold);
              // Strictness [0,1] maps to required score [0.2, 0.7]
              const required = 0.2 + settingsRef.current.musicDetectionStrictness * 0.5;
              isLoud = score >= required;
            }

            if (st === 'waiting') {
              // Immediate transition to playing on any sound
              if (isLoud) {
                currentIntervalStartRef.current = elapsedRef.current;
                statusRef.current = 'playing';
                setStatus('playing');
                silenceStartRef.current = null;
              }
            } else if (st === 'playing') {
              if (!isLoud) {
                if (silenceStartRef.current === null) {
                  silenceStartRef.current = elapsedRef.current;
                } else if (
                  elapsedRef.current - silenceStartRef.current >=
                  settingsRef.current.minRestDuration
                ) {
                  const silenceStart = silenceStartRef.current;
                  const playDur = silenceStart - currentIntervalStartRef.current;
                  // Play was over-counted during silence detection window
                  const overCount = elapsedRef.current - silenceStart;
                  playTimeRef.current -= overCount;

                  if (playDur >= settingsRef.current.minPlayDuration) {
                    // Valid play — finalize interval, transition to resting
                    restTimeRef.current += overCount;
                    if (playDur > 0) {
                      intervalsRef.current.push({
                        type: 'play',
                        startOffset: currentIntervalStartRef.current,
                        duration: playDur,
                        ...(currentPieceNameRef.current ? { pieceName: currentPieceNameRef.current } : {}),
                      });
                    }
                    currentIntervalStartRef.current = silenceStart;
                    statusRef.current = 'resting';
                    setStatus('resting');
                    writeSnapshot();
                  } else {
                    // Too-short play — false alarm (cough, page turn)
                    playTimeRef.current -= playDur;
                    if (intervalsRef.current.some(iv => iv.type === 'play')) {
                      // Had real play before — attribute to rest (cough during rest)
                      restTimeRef.current += overCount + playDur;
                      statusRef.current = 'resting';
                      setStatus('resting');
                    } else {
                      // No play yet — go back to waiting
                      statusRef.current = 'waiting';
                      setStatus('waiting');
                    }
                  }
                  silenceStartRef.current = null;
                }
              } else {
                silenceStartRef.current = null;
              }
            } else if (st === 'resting') {
              // Immediate transition to playing — finalize rest interval
              if (isLoud) {
                const restDur = elapsedRef.current - currentIntervalStartRef.current;
                if (restDur > 0) {
                  intervalsRef.current.push({
                    type: 'rest',
                    startOffset: currentIntervalStartRef.current,
                    duration: restDur,
                  });
                }
                currentIntervalStartRef.current = elapsedRef.current;
                statusRef.current = 'playing';
                setStatus('playing');
                silenceStartRef.current = null;
                writeSnapshot();
              }
            }
          }
        } catch {}
      }

      syncState();
    }, 100);

    writeSnapshot();
  }, [syncState, finishCurrentInterval, writeSnapshot]);

  // ── PAUSE ──
  const pause = useCallback(() => {
    const st = statusRef.current;
    if (st === 'idle' || st === 'paused') return;

    // Finalize the current play/rest interval
    if (st === 'playing' || st === 'resting') {
      finishCurrentInterval(elapsedRef.current);
    }

    pauseStartRef.current = Date.now();
    currentIntervalStartRef.current = elapsedRef.current;
    statusRef.current = 'paused';
    setStatus('paused');
    silenceStartRef.current = null;
    soundStartRef.current = null;
    amplitudeBufferRef.current = [];

    // Pause mic
    try { recorderRef.current?.pause(); } catch {}

    syncState();
    writeSnapshot();
  }, [finishCurrentInterval, syncState, writeSnapshot]);

  // ── RESUME ──
  const resume = useCallback(() => {
    if (statusRef.current !== 'paused') return;

    if (pauseStartRef.current) {
      const pausedMs = Date.now() - pauseStartRef.current;
      const pauseDur = pausedMs / 1000;
      pauseTimeRef.current += pauseDur;

      // Record pause interval
      intervalsRef.current.push({
        type: 'pause',
        startOffset: currentIntervalStartRef.current,
        duration: Math.round(pauseDur * 10) / 10,
      });
      pauseStartRef.current = null;
    }

    // Always go to waiting — wait for sound before playing
    statusRef.current = 'waiting';
    setStatus('waiting');
    currentIntervalStartRef.current = elapsedRef.current;
    silenceStartRef.current = null;
    soundStartRef.current = null;

    try { recorderRef.current?.record(); } catch {}

    syncState();
    writeSnapshot();
  }, [syncState, writeSnapshot]);

  // ── NEXT PAIR ──
  const nextPair = useCallback(() => {
    const st = statusRef.current;
    if (st === 'idle' || st === 'paused') return;

    // Finish the current interval
    if (st === 'playing' || st === 'resting') {
      finishCurrentInterval(elapsedRef.current);
    }

    // Mark a new pair boundary at the next interval index
    pairBoundariesRef.current.push(intervalsRef.current.length);
    currentPieceNameRef.current = '';
    setCurrentPieceNameState('');

    // Go back to waiting for sound
    statusRef.current = 'waiting';
    setStatus('waiting');
    currentIntervalStartRef.current = elapsedRef.current;
    silenceStartRef.current = null;
    soundStartRef.current = null;
    amplitudeBufferRef.current = [];

    syncState();
    writeSnapshot();
  }, [finishCurrentInterval, syncState, writeSnapshot]);

  // ── STOP ──
  const stopSession = useCallback(() => {
    if (statusRef.current === 'idle') return;

    // Stop tick
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }

    // Stop mic
    try { recorderRef.current?.stop(); } catch {}
    setAudioModeAsync({ allowsRecording: false }).catch(() => {});

    // Finalise: discard trailing rest, keep up to last play
    const curStatus = statusRef.current;
    if (curStatus === 'playing') {
      // Finish current play interval
      finishCurrentInterval(elapsedRef.current);
    } else if (curStatus === 'resting') {
      // Discard trailing rest — don't add it. Trim elapsed/restTime.
      const trailingDur = elapsedRef.current - currentIntervalStartRef.current;
      restTimeRef.current -= trailingDur;
      elapsedRef.current -= trailingDur;
    }
    // if 'waiting' or 'paused' with no intervals, session is empty

    // Handle pause time if stopped while paused
    if (curStatus === 'paused' && pauseStartRef.current) {
      const pausedMs = Date.now() - pauseStartRef.current;
      const pauseDur = pausedMs / 1000;
      pauseTimeRef.current += pauseDur;
      intervalsRef.current.push({
        type: 'pause',
        startOffset: currentIntervalStartRef.current,
        duration: Math.round(pauseDur * 10) / 10,
      });
      pauseStartRef.current = null;
    }

    statusRef.current = 'idle';
    setStatus('idle');
    setMicLevel(0);

    // Build pending session record
    if (intervalsRef.current.some(iv => iv.type === 'play')) {
      const rec: SessionRecord = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: sessionStartRef.current,
        totalDuration: Math.round(elapsedRef.current * 10) / 10,
        playTime: Math.round(playTimeRef.current * 10) / 10,
        restTime: Math.round(restTimeRef.current * 10) / 10,
        pauseTime: Math.round(pauseTimeRef.current * 10) / 10,
        intervals: intervalsRef.current.map((iv) => ({
          ...iv,
          duration: Math.round(iv.duration * 10) / 10,
          startOffset: Math.round(iv.startOffset * 10) / 10,
        })),
        pairBoundaries: [...pairBoundariesRef.current],
        notes: '',
      };
      setPendingSession(rec);
    }

    syncState();
    AsyncStorage.removeItem(SNAPSHOT_KEY);
  }, [finishCurrentInterval, syncState]);

  // ── SAVE SESSION ──
  const saveSession = useCallback(async (notes: string) => {
    if (!pendingSession) return;
    const session = { ...pendingSession, notes };

    // Save to sessions list
    const existing = await AsyncStorage.getItem(SESSIONS_KEY);
    const sessions: SessionRecord[] = existing ? JSON.parse(existing) : [];
    sessions.unshift(session);
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));

    // Update cumulative stats
    const statsJson = await AsyncStorage.getItem(STATS_KEY);
    const stats = statsJson
      ? JSON.parse(statsJson)
      : { allTimeTotalDuration: 0, allTimePlayTime: 0, allTimeRestTime: 0, sessionCount: 0, dailyTotals: {} };

    stats.allTimeTotalDuration += session.totalDuration;
    stats.allTimePlayTime += session.playTime;
    stats.allTimeRestTime += session.restTime;
    stats.sessionCount += 1;

    const dayKey = session.date.slice(0, 10); // YYYY-MM-DD
    if (!stats.dailyTotals[dayKey]) {
      stats.dailyTotals[dayKey] = { totalDuration: 0, playTime: 0 };
    }
    stats.dailyTotals[dayKey].totalDuration += session.totalDuration;
    stats.dailyTotals[dayKey].playTime += session.playTime;

    // Prune dailyTotals older than 90 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    for (const key of Object.keys(stats.dailyTotals)) {
      if (key < cutoffKey) delete stats.dailyTotals[key];
    }

    await AsyncStorage.setItem(STATS_KEY, JSON.stringify(stats));

    // Update piece names list
    const pieceNamesJson = await AsyncStorage.getItem(PIECE_NAMES_KEY);
    const knownNames: string[] = pieceNamesJson ? JSON.parse(pieceNamesJson) : [];
    let changed = false;
    for (const iv of session.intervals) {
      if (iv.pieceName && !knownNames.includes(iv.pieceName)) {
        knownNames.push(iv.pieceName);
        changed = true;
      }
    }
    if (changed) {
      knownNames.sort((a, b) => a.localeCompare(b));
      await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(knownNames));
    }

    setPendingSession(null);
  }, [pendingSession]);

  // ── DISCARD ──
  const discardSession = useCallback(() => {
    setPendingSession(null);
  }, []);

  // ── UPDATE PIECE NAME ON PAIR ──
  const updatePairPieceName = useCallback((pairIndex: number, name: string) => {
    setPendingSession((prev) => {
      if (!prev) return prev;
      const bounds = prev.pairBoundaries.length > 0 ? prev.pairBoundaries : [0];
      const start = bounds[pairIndex];
      const end = pairIndex + 1 < bounds.length ? bounds[pairIndex + 1] : prev.intervals.length;
      if (start === undefined) return prev;

      const newIntervals = [...prev.intervals];
      for (let i = start; i < end; i++) {
        if (newIntervals[i].type === 'play') {
          newIntervals[i] = { ...newIntervals[i], pieceName: name || undefined };
        }
      }
      return { ...prev, intervals: newIntervals };
    });
  }, []);

  // ── UPDATE CURRENT PIECE NAME (live session) ──
  const updateCurrentPieceName = useCallback((name: string) => {
    const trimmed = name || '';
    currentPieceNameRef.current = trimmed;
    setCurrentPieceNameState(trimmed);

    // Retroactively update existing play intervals in the current pair
    const bounds = pairBoundariesRef.current;
    const currentPairStart = bounds.length > 0 ? bounds[bounds.length - 1] : 0;
    for (let i = currentPairStart; i < intervalsRef.current.length; i++) {
      if (intervalsRef.current[i].type === 'play') {
        intervalsRef.current[i] = { ...intervalsRef.current[i], pieceName: trimmed || undefined };
      }
    }
    syncState();
  }, [syncState]);

  // ── APP STATE HANDLING (background/termination save) ──
  useEffect(() => {
    const handler = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        if (statusRef.current !== 'idle') {
          writeSnapshot();
        }
      }
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [writeSnapshot]);

  // ── CRASH RECOVERY: check for orphaned snapshot on mount ──
  useEffect(() => {
    (async () => {
      const snapJson = await AsyncStorage.getItem(SNAPSHOT_KEY);
      if (!snapJson) return;
      try {
        const snap: SessionSnapshot = JSON.parse(snapJson);
        // Back up existing sessions before modifying
        const existingJson = await AsyncStorage.getItem(SESSIONS_KEY);
        if (existingJson) {
          await AsyncStorage.setItem(SESSIONS_BACKUP_KEY, existingJson);
        }
        // Auto-save the orphaned session
        if (snap.intervals.some(iv => iv.type === 'play')) {
          // Trim trailing rest / pause intervals
          let finalIntervals = snap.intervals;
          let finalPlayTime = snap.playTime;
          let finalRestTime = snap.restTime;
          let finalElapsed = snap.elapsedAtSnapshot;

          while (finalIntervals.length > 0) {
            const last = finalIntervals[finalIntervals.length - 1];
            if (last.type === 'rest') {
              finalRestTime -= last.duration;
              finalElapsed -= last.duration;
              finalIntervals = finalIntervals.slice(0, -1);
            } else if (last.type === 'pause') {
              finalIntervals = finalIntervals.slice(0, -1);
            } else {
              break;
            }
          }

          if (finalIntervals.length > 0) {
            const session: SessionRecord = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              date: snap.sessionStartISO,
              totalDuration: Math.round(finalElapsed * 10) / 10,
              playTime: Math.round(finalPlayTime * 10) / 10,
              restTime: Math.round(finalRestTime * 10) / 10,
              pauseTime: Math.round(snap.pauseTime * 10) / 10,
              intervals: finalIntervals.map((iv) => ({
                ...iv,
                duration: Math.round(iv.duration * 10) / 10,
                startOffset: Math.round(iv.startOffset * 10) / 10,
              })),
              pairBoundaries: snap.pairBoundaries || [0],
              notes: '(auto-saved — app was terminated)',
            };

            const existing = await AsyncStorage.getItem(SESSIONS_KEY);
            const sessions: SessionRecord[] = existing ? JSON.parse(existing) : [];
            sessions.unshift(session);
            await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));

            // Update cumulative stats
            const statsJson = await AsyncStorage.getItem(STATS_KEY);
            const stats = statsJson
              ? JSON.parse(statsJson)
              : { allTimeTotalDuration: 0, allTimePlayTime: 0, allTimeRestTime: 0, sessionCount: 0, dailyTotals: {} };
            stats.allTimeTotalDuration += session.totalDuration;
            stats.allTimePlayTime += session.playTime;
            stats.allTimeRestTime += session.restTime;
            stats.sessionCount += 1;
            const dayKey = session.date.slice(0, 10);
            if (!stats.dailyTotals[dayKey]) {
              stats.dailyTotals[dayKey] = { totalDuration: 0, playTime: 0 };
            }
            stats.dailyTotals[dayKey].totalDuration += session.totalDuration;
            stats.dailyTotals[dayKey].playTime += session.playTime;
            await AsyncStorage.setItem(STATS_KEY, JSON.stringify(stats));
          }
        }
      } catch {}
      await AsyncStorage.removeItem(SNAPSHOT_KEY);
    })();
  }, []);

  // ── MIGRATE OLD DATA: backfill pairBoundaries for legacy sessions ──
  useEffect(() => {
    (async () => {
      const json = await AsyncStorage.getItem(SESSIONS_KEY);
      if (!json) return;
      try {
        const sessions: any[] = JSON.parse(json);
        let changed = false;
        for (const s of sessions) {
          if (!s.pairBoundaries) {
            s.pairBoundaries = [0];
            changed = true;
          }
        }
        if (changed) {
          // Back up before migrating
          await AsyncStorage.setItem(SESSIONS_BACKUP_KEY, json);
          await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
        }
      } catch {}
    })();
  }, []);

  return (
    <SessionContext.Provider
      value={{
        status,
        elapsed,
        playTime,
        restTime,
        pauseTime,
        intervals,
        pairBoundaries,
        micLevel,
        start,
        stop: stopSession,
        pause,
        resume,
        nextPair,
        saveSession,
        discardSession,
        pendingSession,
        updatePairPieceName,
        currentPieceName,
        updateCurrentPieceName,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
