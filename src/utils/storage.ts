import AsyncStorage from '@react-native-async-storage/async-storage';
import { SessionRecord, CumulativeStats, Section, DATA_FORMAT_VERSION } from '../types';
import {
  normalizePieceName,
  normalizeSessionRecord,
  rebuildPieceNamesFromSessions,
} from './sessionNormalization';

const SESSIONS_KEY = '@PracticeTimer:sessions';
const STATS_KEY = '@PracticeTimer:cumulativeStats';
const PIECE_NAMES_KEY = '@PracticeTimer:pieceNames';
const SESSIONS_BACKUP_KEY = '@PracticeTimer:sessionsBackup';

// ── Migration ───────────────────────────────────────────────

/**
 * Migrate a legacy session (with intervals/pairBoundaries) to the new
 * section-based format.  Returns the session unchanged if already v2+.
 */
function migrateSession(raw: any): SessionRecord {
  if (raw.formatVersion >= DATA_FORMAT_VERSION) {
    return normalizeSessionRecord(raw as SessionRecord);
  }

  // Legacy format: has intervals[] and pairBoundaries[]
  const intervals: any[] = raw.intervals ?? [];
  const bounds: number[] = raw.pairBoundaries?.length ? [...raw.pairBoundaries].sort((a: number, b: number) => a - b) : [0];
  if (bounds[0] !== 0) bounds.unshift(0);

  const sections: Section[] = [];
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

    sections.push({
      ...(pieceName ? { pieceName } : {}),
      playDuration: Math.round(playDuration),
      restDuration: Math.round(restDuration),
    });
  }

  return normalizeSessionRecord({
    formatVersion: DATA_FORMAT_VERSION,
    id: raw.id,
    date: raw.date,
    totalDuration: Math.round(raw.totalDuration),
    playTime: Math.round(raw.playTime),
    restTime: Math.round(raw.restTime),
    sections,
    notes: raw.notes ?? '',
  });
}

// ── Sessions ────────────────────────────────────────────────

export async function getSessions(): Promise<SessionRecord[]> {
  const json = await AsyncStorage.getItem(SESSIONS_KEY);
  if (!json) return [];

  let raw: any[];
  try {
    raw = JSON.parse(json);
  } catch (e) {
    console.error('Failed to parse sessions, returning empty:', e);
    return [];
  }

  if (!Array.isArray(raw)) {
    console.error('Sessions data is not an array, returning empty');
    return [];
  }

  // Migrate if any session lacks formatVersion
  const needsMigration = raw.some((s) => !s.formatVersion || s.formatVersion < DATA_FORMAT_VERSION);
  const sessions = raw.map(migrateSession);
  if (needsMigration) {
    // Back up before overwriting
    await AsyncStorage.setItem(SESSIONS_BACKUP_KEY, json);
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  return sessions;
}

export async function deleteSession(id: string): Promise<void> {
  const sessions = await getSessions();
  const filtered = sessions.filter((s) => s.id !== id);
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(filtered));
}

export async function deleteAllSessions(): Promise<void> {
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify([]));
}

export async function updateSession(updated: SessionRecord): Promise<void> {
  const sessions = await getSessions();
  const idx = sessions.findIndex((s) => s.id === updated.id);
  if (idx >= 0) {
    sessions[idx] = updated;
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }
}

// ── Cumulative Stats ────────────────────────────────────────

const EMPTY_STATS: CumulativeStats = {
  allTimeTotalDuration: 0,
  allTimePlayTime: 0,
  allTimeRestTime: 0,
  sessionCount: 0,
  dailyTotals: {},
};

export async function getCumulativeStats(): Promise<CumulativeStats> {
  const json = await AsyncStorage.getItem(STATS_KEY);
  return json ? JSON.parse(json) : { ...EMPTY_STATS };
}

export async function resetCumulativeStats(): Promise<void> {
  await AsyncStorage.setItem(STATS_KEY, JSON.stringify({ ...EMPTY_STATS }));
}

// ── Piece Names ─────────────────────────────────────────────

export async function getPieceNames(): Promise<string[]> {
  const json = await AsyncStorage.getItem(PIECE_NAMES_KEY);
  return json ? JSON.parse(json) : [];
}

export async function addPieceName(name: string): Promise<void> {
  const normalized = normalizePieceName(name);
  const names = await getPieceNames();
  const rebuilt = rebuildPieceNamesFromSessions([], [...names, normalized]);
  if (rebuilt.length !== names.length || rebuilt.some((n, i) => names[i] !== n)) {
    await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(rebuilt));
  }
}

export async function removePieceName(name: string): Promise<void> {
  const names = await getPieceNames();
  const filtered = names.filter((n) => n !== name);
  await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(filtered));
}
