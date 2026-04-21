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
import { SessionStatus, Section, SessionRecord, DATA_FORMAT_VERSION } from '../types';
import { useSettings } from './SettingsContext';
import {
  normalizeSessionRecord,
  rebuildPieceNamesFromSessions,
  recomputeCumulativeStatsFromSessions,
} from '../utils/sessionNormalization';

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
  snapshotVersion: number;       // 2
  sessionStartISO: string;
  elapsedAtSnapshot: number;
  playTime: number;
  restTime: number;
  sections: Section[];           // completed sections
  currentSectionPlay: number;
  currentSectionRest: number;
  currentPieceName: string;
  status: SessionStatus;
  currentIntervalStart: number;  // offset in seconds from session start
  lastUpdateEpoch: number;
}

// ── Context value ───────────────────────────────────────────
interface SessionContextValue {
  status: SessionStatus;
  elapsed: number;               // total session seconds (wall-clock)
  playTime: number;
  restTime: number;
  sections: Section[];           // completed + current in-progress section
  micLevel: number;              // 0–1, live mic level
  start: () => Promise<boolean>;
  stop: () => void;
  nextPair: () => void;
  saveSession: (notes: string) => Promise<void>;
  discardSession: () => void;
  pendingSession: SessionRecord | null;
  updateSectionPieceName: (sectionIndex: number, name: string) => void;
  currentPieceName: string;
  updateCurrentPieceName: (name: string) => void;
  updateLiveSectionPieceName: (sectionIndex: number, name: string) => void;
}

const SessionContext = createContext<SessionContextValue>({
  status: 'idle',
  elapsed: 0,
  playTime: 0,
  restTime: 0,
  sections: [],
  micLevel: 0,
  start: async () => false,
  stop: () => {},
  nextPair: () => {},
  saveSession: async () => {},
  discardSession: () => {},
  pendingSession: null,
  updateSectionPieceName: () => {},
  currentPieceName: '',
  updateCurrentPieceName: () => {},
  updateLiveSectionPieceName: () => {},
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
  const [sections, setSections] = useState<Section[]>([]);
  const [micLevel, setMicLevel] = useState(0);
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
  const sectionsRef = useRef<Section[]>([]);
  const currentSectionPlayRef = useRef(0);
  const currentSectionRestRef = useRef(0);
  const currentPieceNameRef = useRef('');
  const amplitudeBufferRef = useRef<number[]>([]);
  const settingsRef = useRef(settings);
  const pendingAutoSavePromiseRef = useRef<Promise<void> | null>(null);

  // ── Wall-clock timestamps (ms) ──
  const sessionEpochRef = useRef(0);
  const intervalStartEpochRef = useRef(0);
  // Accumulated play/rest seconds from all finalized intervals (session totals)
  const accumPlayRef = useRef(0);
  const accumRestRef = useRef(0);
  // When silence started (for minRestDuration detection)
  const silenceStartEpochRef = useRef<number | null>(null);
  // Whether any play has been detected in the session
  const hasPlayRef = useRef(false);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // ── helpers ──

  /** Compute display values from wall clock and push to React state. */
  const syncState = useCallback(() => {
    const now = Date.now();
    const st = statusRef.current;
    if (st !== 'idle' && st !== 'waiting' && sessionEpochRef.current > 0) {
      const inProgressSec = Math.floor(secsBetween(intervalStartEpochRef.current, now));

      let displayPlay: number;
      let displayRest: number;
      let curSectionPlay = currentSectionPlayRef.current;
      let curSectionRest = currentSectionRestRef.current;
      if (st === 'playing') {
        displayPlay = accumPlayRef.current + inProgressSec;
        displayRest = accumRestRef.current;
        curSectionPlay += inProgressSec;
      } else {
        displayPlay = accumPlayRef.current;
        displayRest = accumRestRef.current + inProgressSec;
        curSectionRest += inProgressSec;
      }
      setElapsed(displayPlay + displayRest);
      setPlayTime(displayPlay);
      setRestTime(displayRest);

      // Build live sections: completed + current in-progress
      setSections([
        ...sectionsRef.current,
        {
          ...(currentPieceNameRef.current ? { pieceName: currentPieceNameRef.current } : {}),
          playDuration: curSectionPlay,
          restDuration: curSectionRest,
        },
      ]);
    } else {
      setElapsed(0);
      setPlayTime(0);
      setRestTime(0);
      setSections([...sectionsRef.current]);
    }
  }, []);

  /** Finalize the current play/rest interval at the given wall-clock epoch. */
  const finishInterval = useCallback((atEpoch: number) => {
    const st = statusRef.current;
    if (st !== 'playing' && st !== 'resting') return;

    const dur = Math.floor(secsBetween(intervalStartEpochRef.current, atEpoch));

    if (dur > 0) {
      if (st === 'playing') {
        accumPlayRef.current += dur;
        currentSectionPlayRef.current += dur;
      } else {
        accumRestRef.current += dur;
        currentSectionRestRef.current += dur;
      }
    }
  }, []);

  /** Push the current section to the completed list and reset accumulators. */
  const finalizeCurrentSection = useCallback(() => {
    const play = currentSectionPlayRef.current;
    const rest = currentSectionRestRef.current;
    if (play > 0 || rest > 0) {
      sectionsRef.current.push({
        ...(currentPieceNameRef.current ? { pieceName: currentPieceNameRef.current } : {}),
        playDuration: play,
        restDuration: rest,
      });
    }
    currentSectionPlayRef.current = 0;
    currentSectionRestRef.current = 0;
  }, []);

  const writeSnapshot = useCallback(() => {
    if (statusRef.current === 'idle') return;
    const now = Date.now();
    const totalElapsed = sessionEpochRef.current > 0
      ? secsBetween(sessionEpochRef.current, now) : 0;
    const inProgress = secsBetween(intervalStartEpochRef.current, now);
    let snapPlay = accumPlayRef.current;
    let snapRest = accumRestRef.current;
    let snapSectionPlay = currentSectionPlayRef.current;
    let snapSectionRest = currentSectionRestRef.current;
    if (statusRef.current === 'playing') {
      snapPlay += inProgress;
      snapSectionPlay += inProgress;
    } else if (statusRef.current === 'resting') {
      snapRest += inProgress;
      snapSectionRest += inProgress;
    }

    const snap: SessionSnapshot = {
      snapshotVersion: 2,
      sessionStartISO: sessionStartRef.current,
      elapsedAtSnapshot: totalElapsed,
      playTime: snapPlay,
      restTime: snapRest,
      sections: sectionsRef.current,
      currentSectionPlay: snapSectionPlay,
      currentSectionRest: snapSectionRest,
      currentPieceName: currentPieceNameRef.current,
      status: statusRef.current,
      currentIntervalStart: secsBetween(sessionEpochRef.current, intervalStartEpochRef.current),
      lastUpdateEpoch: now,
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
    sectionsRef.current = [];
    currentSectionPlayRef.current = 0;
    currentSectionRestRef.current = 0;
    currentPieceNameRef.current = '';
    setCurrentPieceNameState('');
    amplitudeBufferRef.current = [];
    hasPlayRef.current = false;

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
                  // Valid play — accumulate play time, start rest
                  const flooredPlayDur = Math.floor(playDur);
                  accumPlayRef.current += flooredPlayDur;
                  currentSectionPlayRef.current += flooredPlayDur;
                  hasPlayRef.current = true;
                  intervalStartEpochRef.current = silenceStart;
                  statusRef.current = 'resting';
                  setStatus('resting');
                  writeSnapshot();
                } else {
                  // Too-short play — false alarm (cough, page turn)
                  if (hasPlayRef.current) {
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
            // Sound resumes — finalize rest, start playing
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

    // Finalize the current section and start a new one
    finalizeCurrentSection();
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
  }, [finishInterval, finalizeCurrentSection, syncState, writeSnapshot]);

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

    // Finalize current section
    finalizeCurrentSection();

    statusRef.current = 'idle';
    setStatus('idle');
    setMicLevel(0);

    // Build final session record and persist immediately
    if (sectionsRef.current.some(s => s.playDuration > 0)) {
      const rawRecord: SessionRecord = {
        formatVersion: DATA_FORMAT_VERSION,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: sessionStartRef.current,
        totalDuration: 0,
        playTime: 0,
        restTime: 0,
        sections: sectionsRef.current,
        notes: '',
      };
      const rec = normalizeSessionRecord(rawRecord);

      // Keep a live pending session so notes/section names can be edited then saved.
      setPendingSession(rec);

      const autoSavePromise = (async () => {
        try {
          // Save to sessions list with normalized totals and section names.
          const existing = await AsyncStorage.getItem(SESSIONS_KEY);
          const sessions: SessionRecord[] = existing ? JSON.parse(existing) : [];
          sessions.unshift(rec);
          const normalizedSessions = sessions.map(normalizeSessionRecord);
          await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(normalizedSessions));

          // Recompute cumulative stats from corrected sessions.
          const recomputedStats = recomputeCumulativeStatsFromSessions(normalizedSessions);
          await AsyncStorage.setItem(STATS_KEY, JSON.stringify(recomputedStats));

          // Rebuild and normalize piece names from sessions + existing names.
          const pieceNamesJson = await AsyncStorage.getItem(PIECE_NAMES_KEY);
          const knownNames: string[] = pieceNamesJson ? JSON.parse(pieceNamesJson) : [];
          const normalizedNames = rebuildPieceNamesFromSessions(normalizedSessions, knownNames);
          await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(normalizedNames));
        } catch (e) {
          console.error('Failed to auto-save session:', e);
          Alert.alert(
            'Session Save Failed',
            'The session could not be saved automatically. Please try saving again.'
          );
        }
      })();

      pendingAutoSavePromiseRef.current = autoSavePromise;
      autoSavePromise.finally(() => {
        if (pendingAutoSavePromiseRef.current === autoSavePromise) {
          pendingAutoSavePromiseRef.current = null;
        }
      });
    }

    syncState();
    AsyncStorage.removeItem(SNAPSHOT_KEY);
  }, [finishInterval, finalizeCurrentSection, syncState]);

  // ── SAVE SESSION ──
  const saveSession = useCallback(async (notes: string) => {
    if (!pendingSession) return;
    if (pendingAutoSavePromiseRef.current) {
      try {
        await pendingAutoSavePromiseRef.current;
      } catch {
        // Auto-save error is already surfaced to the user.
      }
    }

    const session = normalizeSessionRecord({ ...pendingSession, notes });

    try {
      // Update existing saved session by ID; if missing, insert as fallback.
      const existing = await AsyncStorage.getItem(SESSIONS_KEY);
      const sessions: SessionRecord[] = existing ? JSON.parse(existing) : [];
      const idx = sessions.findIndex((s) => s.id === session.id);
      if (idx >= 0) {
        sessions[idx] = session;
      } else {
        sessions.unshift(session);
      }
      const normalizedSessions = sessions.map(normalizeSessionRecord);
      await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(normalizedSessions));

      // Recompute stats and piece names from corrected sessions.
      const recomputedStats = recomputeCumulativeStatsFromSessions(normalizedSessions);
      await AsyncStorage.setItem(STATS_KEY, JSON.stringify(recomputedStats));

      const pieceNamesJson = await AsyncStorage.getItem(PIECE_NAMES_KEY);
      const knownNames: string[] = pieceNamesJson ? JSON.parse(pieceNamesJson) : [];
      const normalizedNames = rebuildPieceNamesFromSessions(normalizedSessions, knownNames);
      await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(normalizedNames));

      setPendingSession(null);
    } catch (e) {
      console.error('Failed to save session changes:', e);
      Alert.alert('Save Failed', 'Could not save session changes. Please try again.');
    }
  }, [pendingSession]);

  // ── DISCARD ──
  const discardSession = useCallback(() => {
    setPendingSession(null);
  }, []);

  // ── UPDATE PIECE NAME ON SECTION (pending session) ──
  const updateSectionPieceName = useCallback((sectionIndex: number, name: string) => {
    setPendingSession((prev) => {
      if (!prev || sectionIndex < 0 || sectionIndex >= prev.sections.length) return prev;
      const newSections = [...prev.sections];
      newSections[sectionIndex] = { ...newSections[sectionIndex], pieceName: name || undefined };
      return { ...prev, sections: newSections };
    });
  }, []);

  // ── UPDATE LIVE SECTION PIECE NAME (any section during live session) ──
  const updateLiveSectionPieceName = useCallback((sectionIndex: number, name: string) => {
    const trimmed = name || '';
    const completed = sectionsRef.current;

    if (sectionIndex < completed.length) {
      // Update a completed section
      completed[sectionIndex] = { ...completed[sectionIndex], pieceName: trimmed || undefined };
    }

    // If editing the current (last) section, update the ref
    if (sectionIndex >= completed.length) {
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
        const snap: any = JSON.parse(snapJson);
        // Back up existing sessions before modifying
        const existingJson = await AsyncStorage.getItem(SESSIONS_KEY);
        if (existingJson) {
          await AsyncStorage.setItem(SESSIONS_BACKUP_KEY, existingJson);
        }

        let recoveredSections: Section[];
        let finalPlayTime: number;
        let finalRestTime: number;
        let finalElapsed: number;

        if (snap.snapshotVersion >= 2) {
          // New format snapshot
          recoveredSections = [...(snap.sections || [])];
          const curPlay = Math.round(snap.currentSectionPlay || 0);
          const curRest = Math.round(snap.currentSectionRest || 0);
          if (curPlay > 0 || curRest > 0) {
            recoveredSections.push({
              ...(snap.currentPieceName ? { pieceName: snap.currentPieceName } : {}),
              playDuration: curPlay,
              restDuration: curRest,
            });
          }
          finalPlayTime = Math.round(snap.playTime || 0);
          finalRestTime = Math.round(snap.restTime || 0);
          finalElapsed = Math.round(snap.elapsedAtSnapshot || 0);
        } else {
          // Legacy format snapshot (intervals + pairBoundaries)
          const intervals: any[] = (snap.intervals || []).map((iv: any) =>
            iv.type === 'pause' ? { ...iv, type: 'rest' } : iv
          );
          const bounds: number[] = snap.pairBoundaries?.length
            ? [...snap.pairBoundaries].sort((a: number, b: number) => a - b)
            : [0];
          if (bounds[0] !== 0) bounds.unshift(0);

          recoveredSections = [];
          for (let i = 0; i < bounds.length; i++) {
            const start = bounds[i];
            const end = i + 1 < bounds.length ? bounds[i + 1] : intervals.length;
            if (start >= intervals.length) break;
            let playDuration = 0;
            let restDuration = 0;
            let pieceName: string | undefined;
            for (let j = start; j < end; j++) {
              const iv = intervals[j];
              if (iv.type === 'play') {
                playDuration += iv.duration;
                if (!pieceName && iv.pieceName) pieceName = iv.pieceName;
              } else {
                restDuration += iv.duration;
              }
            }
            recoveredSections.push({
              ...(pieceName ? { pieceName } : {}),
              playDuration: Math.round(playDuration),
              restDuration: Math.round(restDuration),
            });
          }
          finalPlayTime = Math.round(snap.playTime || 0);
          finalRestTime = Math.round(snap.restTime || 0);
          finalElapsed = Math.round(snap.elapsedAtSnapshot || 0);
          if ((snap as any).pauseTime) {
            finalRestTime += Math.round((snap as any).pauseTime);
            finalElapsed += Math.round((snap as any).pauseTime);
          }
        }

        if (recoveredSections.some(s => s.playDuration > 0)) {
          const rawSession: SessionRecord = {
            formatVersion: DATA_FORMAT_VERSION,
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            date: snap.sessionStartISO,
            totalDuration: finalElapsed,
            playTime: finalPlayTime,
            restTime: finalRestTime,
            sections: recoveredSections,
            notes: '(auto-saved — app was terminated)',
          };
          const session = normalizeSessionRecord(rawSession);

          const existing = await AsyncStorage.getItem(SESSIONS_KEY);
          const sessions: SessionRecord[] = existing ? JSON.parse(existing) : [];
          sessions.unshift(session);
          const normalizedSessions = sessions.map(normalizeSessionRecord);
          await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(normalizedSessions));

          const recomputedStats = recomputeCumulativeStatsFromSessions(normalizedSessions);
          await AsyncStorage.setItem(STATS_KEY, JSON.stringify(recomputedStats));

          const pieceNamesJson = await AsyncStorage.getItem(PIECE_NAMES_KEY);
          const knownNames: string[] = pieceNamesJson ? JSON.parse(pieceNamesJson) : [];
          const normalizedNames = rebuildPieceNamesFromSessions(normalizedSessions, knownNames);
          await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(normalizedNames));
        }
      } catch {}
      await AsyncStorage.removeItem(SNAPSHOT_KEY);
    })();
  }, []);

  return (
    <SessionContext.Provider
      value={{
        status,
        elapsed,
        playTime,
        restTime,
        sections,
        micLevel,
        start,
        stop: stopSession,
        nextPair,
        saveSession,
        discardSession,
        pendingSession,
        updateSectionPieceName,
        currentPieceName,
        updateCurrentPieceName,
        updateLiveSectionPieceName,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
