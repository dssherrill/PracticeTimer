import AsyncStorage from '@react-native-async-storage/async-storage';
import { SessionRecord, CumulativeStats } from '../types';

const SESSIONS_KEY = '@PracticeTimer:sessions';
const STATS_KEY = '@PracticeTimer:cumulativeStats';
const PIECE_NAMES_KEY = '@PracticeTimer:pieceNames';

// ── Sessions ────────────────────────────────────────────────

export async function getSessions(): Promise<SessionRecord[]> {
  const json = await AsyncStorage.getItem(SESSIONS_KEY);
  return json ? JSON.parse(json) : [];
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
  const names = await getPieceNames();
  if (!names.includes(name)) {
    names.push(name);
    names.sort((a, b) => a.localeCompare(b));
    await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(names));
  }
}

export async function removePieceName(name: string): Promise<void> {
  const names = await getPieceNames();
  const filtered = names.filter((n) => n !== name);
  await AsyncStorage.setItem(PIECE_NAMES_KEY, JSON.stringify(filtered));
}
