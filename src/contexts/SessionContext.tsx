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

// ── Wall-clock helpers ──────────────────────────────────────
/** Seconds between two epoch-ms timestamps. */
function secsBetween(startMs: number, endMs: number): number {
  return Math.max(0, (endMs - startMs) / 1000);
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
  elapsed: number;               // total session seconds (wall-clock)
  playTime: number;
  restTime: number;
  intervals: Interval[];
  pairBoundaries: number[];
  micLevel: number;              // 0–1, live mic level
  start: () => Promise<boolean>;
  stop: () => void;
  nextPair: () => void;
  saveSession: (notes: string) => Promise<void>;
  discardSession: () => void;
  pendingSession: SessionRecord | null;   // set after STOP, before save/discard
  updatePairPieceName: (pairIndex: number, name: string) => void;
  currentPieceName: string;
  updateCurrentPieceName: (name: string) => void;
  updateLivePairPieceName: (pairIndex: number, name: string) => void;
}

const SessionContext = createContext<SessionContextValue>({
  status: 'idle',
  elapsed: 0,
  playTime: 0,
  restTime: 0,
  intervals: [],
  pairBoundaries: [],
  micLevel: 0,
  start: async () => false,
  stop: () => {},
  nextPair: () => {},
  saveSession: async () => {},
  discardSession: () => {},
  pendingSession: null,
  updatePairPieceName: () => {},
  currentPieceName: '',
  updateCurrentPieceName: () => {},
  updateLivePairPieceName: () => {},
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
  const intervalsRef = useRef<Interval[]>([]);
  const pairBoundariesRef = useRef<number[]>([]);
  const currentPieceNameRef = useRef('');
  const amplitudeBufferRef = useRef<number[]>([]);
  const settingsRef = useRef(settings);

  // ── Wall-clock timestamps (ms) ──
  // When the session first started counting (waiting→playing)
  const sessionEpochRef = useRef(0);
  // When the current play or rest interval began
  const intervalStartEpochRef = useRef(0);
  // Accumulated play/rest seconds from finalized intervals
  const accumPlayRef = useRef(0);
  const accumRestRef = useRef(0);
  // When silence started (for minRestDuration detection)
  const silenceStartEpochRef = useRef<number | null>(null);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // ── helpers ──

  /** Compute display values from wall clock and push to React state. */
  const syncState = useCallback(() => {
    const now = Date.now();
    const st = statusRef.current;
    if (st !== 'idle' && st !== 'waiting' && sessionEpochRef.current > 0) {
      const totalElapsed = secsBetween(sessionEpochRef.current, now);
      const inProgressSec = secsBetween(intervalStartEpochRef.current, now);

      let displayPlay: number;
      let displayRest: number;
      if (st === 'playing') {
        displayPlay = accumPlayRef.current + inProgressSec;
        displayRest = accumRestRef.current;
      } else {
        // resting
        displayPlay = accumPlayRef.current;
        displayRest = accumRestRef.current + inProgressSec;
      }
      setElapsed(Math.round(totalElapsed));
      setPlayTime(Math.round(displayPlay));
      setRestTime(Math.round(displayRest));
    } else {
      setElapsed(0);
      setPlayTime(0);
      setRestTime(0);
    }
    setIntervals([...intervalsRef.current]);
    setPairBoundaries([...pairBoundariesRef.current]);
  }, []);

  /** Finalize the current play/rest interval at the given wall-clock epoch. */
  const finishInterval = useCallback((atEpoch: number) => {
    const st = statusRef.current;
    if (st !== 'playing' && st !== 'resting') return;

    const dur = secsBetween(intervalStartEpochRef.current, atEpoch);
    const offset = secsBetween(sessionEpochRef.current, intervalStartEpochRef.current);

    if (dur > 0) {
      if (st === 'playing') {
        intervalsRef.current.push({
          type: 'play',
          startOffset: offset,
          duration: dur,
          ...(currentPieceNameRef.current ? { pieceName: currentPieceNameRef.current } : {}),
        });
        accumPlayRef.current += dur;
      } else {
        intervalsRef.current.push({
          type: 'rest',
          startOffset: offset,
          duration: dur,
        });
        accumRestRef.current += dur;
      }
    }
  }, []);

  const writeSnapshot = useCallback(() => {
    if (statusRef.current === 'idle') return;
    const now = Date.now();
    const totalElapsed = sessionEpochRef.current > 0
      ? secsBetween(sessionEpochRef.current, now) : 0;
    const inProgress = secsBetween(intervalStartEpochRef.current, now);
    let snapPlay = accumPlayRef.current;
    let snapRest = accumRestRef.current;
    if (statusRef.current === 'playing') snapPlay += inProgress;
    else if (statusRef.current === 'resting') snapRest += inProgress;

    const snap: SessionSnapshot = {
      sessionStartISO: sessionStartRef.current,
      elapsedAtSnapshot: totalElapsed,
      playTime: snapPlay,
      restTime: snapRest,
      intervals: intervalsRef.current,
      pairBoundaries: pairBoundariesRef.current,
      status: statusRef.current,
      currentIntervalStart: secsBetween(sessionEpochRef.current, intervalStartEpochRef.current),
      lastUpdateEpoch: now,
      notes: '',
    };
    AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  }, []);

  // ── START ──
  const start = useCallback(async (): Promise<boolean> => {
    try {
    const { status: permStatus } = await requestRecordingPermissionsAsync();
    if (permStatus !== 'granted') {
      Alert.alert(
        'Microphone Required',
        'PracticeTimer needs microphone access to detect when you are playing. Please enable it in your device settings.',
      );
      return false;
    }

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    });

    const rec = recorderRef.current;
    if (!rec) return false;
    await rec.prepareToRecordAsync({
      ...RecordingPresets.LOW_QUALITY,
      isMeteringEnabled: true,
    });
    rec.record();

    // Reset state
    sessionStartRef.current = new Date().toISOString();
    intervalsRef.current = [];
    pairBoundariesRef.current = [0];
    currentPieceNameRef.current = '';
    setCurrentPieceNameState('');
    amplitudeBufferRef.current = [];

    sessionEpochRef.current = 0;
    intervalStartEpochRef.current = 0;
    accumPlayRef.current = 0;
    accumRestRef.current = 0;
    silenceStartEpochRef.current = null;

    statusRef.current = 'waiting';
    setStatus('waiting');
    syncState();

    // Tick every 100ms: poll metering and evaluate state transitions
    tickRef.current = setInterval(() => {
      const st = statusRef.current;
      if (st === 'idle') return;

      // Poll metering from recorder
      const r = recorderRef.current;
      if (!r) return;
      try {
        const recStatus = r.getStatus();
        if (!recStatus.isRecording || recStatus.metering == null) return;

        const now = Date.now();
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
          const required = 0.2 + settingsRef.current.musicDetectionStrictness * 0.5;
          isLoud = score >= required;
        }

        if (st === 'waiting') {
          if (isLoud) {
            // First sound — session timing begins
            sessionEpochRef.current = now;
            intervalStartEpochRef.current = now;
            statusRef.current = 'playing';
            setStatus('playing');
            silenceStartEpochRef.current = null;
          }
        } else if (st === 'playing') {
          if (!isLoud) {
            if (silenceStartEpochRef.current === null) {
              silenceStartEpochRef.current = now;
            } else {
              const silenceSec = secsBetween(silenceStartEpochRef.current, now);
              if (silenceSec >= settingsRef.current.minRestDuration) {
                // Silence confirmed — retroactively split at silenceStart
                const silenceStart = silenceStartEpochRef.current;
                const playDur = secsBetween(intervalStartEpochRef.current, silenceStart);

                if (playDur >= settingsRef.current.minPlayDuration) {
                  // Valid play — finalize play interval ending at silenceStart,
                  // then start rest interval from silenceStart
                  const playOffset = secsBetween(sessionEpochRef.current, intervalStartEpochRef.current);
                  if (playDur > 0) {
                    intervalsRef.current.push({
                      type: 'play',
                      startOffset: playOffset,
                      duration: playDur,
                      ...(currentPieceNameRef.current ? { pieceName: currentPieceNameRef.current } : {}),
                    });
                    accumPlayRef.current += playDur;
                  }
                  intervalStartEpochRef.current = silenceStart;
                  statusRef.current = 'resting';
                  setStatus('resting');
                  writeSnapshot();
                } else {
                  // Too-short play — false alarm (cough, page turn)
                  if (intervalsRef.current.some(iv => iv.type === 'play')) {
                    // Had real play before — attribute to rest
                    statusRef.current = 'resting';
                    setStatus('resting');
                  } else {
                    // No play yet — go back to waiting
                    statusRef.current = 'waiting';
                    setStatus('waiting');
                  }
                }
                silenceStartEpochRef.current = null;
              }
            }
          } else {
            silenceStartEpochRef.current = null;
          }
        } else if (st === 'resting') {
          if (isLoud) {
            // Sound resumes — finalize rest interval, start playing
            finishInterval(now);
            intervalStartEpochRef.current = now;
            statusRef.current = 'playing';
            setStatus('playing');
            silenceStartEpochRef.current = null;
            writeSnapshot();
          }
        }
      } catch {}

      syncState();
    }, 100);

    writeSnapshot();
    return true;
    } catch (e) {
      console.error('Failed to start session:', e);
      Alert.alert('Start Failed', 'Could not start the session. Please try again.');
      return false;
    }
  }, [syncState, finishInterval, writeSnapshot]);

  // ── NEXT PAIR ──
  const nextPair = useCallback(() => {
    const st = statusRef.current;
    if (st === 'idle') return;

    const now = Date.now();

    // Finish the current interval
    if (st === 'playing' || st === 'resting') {
      finishInterval(now);
    }

    // Mark a new pair boundary at the next interval index
    pairBoundariesRef.current.push(intervalsRef.current.length);
    currentPieceNameRef.current = '';
    setCurrentPieceNameState('');

    // Go directly to resting (skip waiting)
    statusRef.current = 'resting';
    setStatus('resting');
    intervalStartEpochRef.current = now;
    silenceStartEpochRef.current = null;
    amplitudeBufferRef.current = [];

    syncState();
    writeSnapshot();
  }, [finishInterval, syncState, writeSnapshot]);

  // ── STOP ──
  const stopSession = useCallback(() => {
    if (statusRef.current === 'idle') return;

    const now = Date.now();

    // Stop tick
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }

    // Stop mic
    try { recorderRef.current?.stop(); } catch {}
    setAudioModeAsync({ allowsRecording: false }).catch(() => {});

    // Finalize current interval
    const curStatus = statusRef.current;
    if (curStatus === 'playing' || curStatus === 'resting') {
      finishInterval(now);
    }

    statusRef.current = 'idle';
    setStatus('idle');
    setMicLevel(0);

    // Build pending session record
    if (intervalsRef.current.some(iv => iv.type === 'play')) {
      const totalElapsed = secsBetween(sessionEpochRef.current, now);
      const rec: SessionRecord = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: sessionStartRef.current,
        totalDuration: Math.round(totalElapsed * 10) / 10,
        playTime: Math.round(accumPlayRef.current * 10) / 10,
        restTime: Math.round(accumRestRef.current * 10) / 10,
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
  }, [finishInterval, syncState]);

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

  // ── UPDATE LIVE PAIR PIECE NAME (any pair during live session) ──
  const updateLivePairPieceName = useCallback((pairIndex: number, name: string) => {
    const trimmed = name || '';
    const bounds = pairBoundariesRef.current;
    const pairStart = bounds[pairIndex];
    const pairEnd = pairIndex + 1 < bounds.length ? bounds[pairIndex + 1] : intervalsRef.current.length;
    if (pairStart === undefined) return;

    for (let i = pairStart; i < pairEnd; i++) {
      if (intervalsRef.current[i].type === 'play') {
        intervalsRef.current[i] = { ...intervalsRef.current[i], pieceName: trimmed || undefined };
      }
    }

    // If editing the current (last) pair, also update the currentPieceName ref
    if (pairIndex === bounds.length - 1) {
      currentPieceNameRef.current = trimmed;
      setCurrentPieceNameState(trimmed);
    }

    syncState();
  }, [syncState]);

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
          // Treat any legacy 'pause' intervals as 'rest'
          let finalIntervals = snap.intervals.map(iv =>
            (iv as any).type === 'pause' ? { ...iv, type: 'rest' as const } : iv
          );
          let finalPlayTime = snap.playTime;
          let finalRestTime = snap.restTime;
          let finalElapsed = snap.elapsedAtSnapshot;

          // Add any tracked pause time to rest (for legacy snapshots)
          if ((snap as any).pauseTime) {
            finalRestTime += (snap as any).pauseTime;
            finalElapsed += (snap as any).pauseTime;
          }

          if (finalIntervals.length > 0) {
            const session: SessionRecord = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              date: snap.sessionStartISO,
              totalDuration: Math.round(finalElapsed * 10) / 10,
              playTime: Math.round(finalPlayTime * 10) / 10,
              restTime: Math.round(finalRestTime * 10) / 10,
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
        intervals,
        pairBoundaries,
        micLevel,
        start,
        stop: stopSession,
        nextPair,
        saveSession,
        discardSession,
        pendingSession,
        updatePairPieceName,
        currentPieceName,
        updateCurrentPieceName,
        updateLivePairPieceName,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
