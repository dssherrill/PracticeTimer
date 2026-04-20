// ── Section ─────────────────────────────────────────────────

export interface Section {
  pieceName?: string;
  playDuration: number;        // seconds (whole)
  restDuration: number;        // seconds (whole)
}

// ── Session Record ──────────────────────────────────────────

export const DATA_FORMAT_VERSION = 2;

export interface SessionRecord {
  formatVersion: number;       // DATA_FORMAT_VERSION
  id: string;
  date: string;                // ISO timestamp of session start
  totalDuration: number;       // total elapsed time in seconds (whole)
  playTime: number;            // seconds (whole)
  restTime: number;            // seconds (whole)
  sections: Section[];
  notes: string;
}

// ── Cumulative Statistics ───────────────────────────────────

export interface DailyTotal {
  totalDuration: number;
  playTime: number;
}

export interface CumulativeStats {
  allTimeTotalDuration: number;
  allTimePlayTime: number;
  allTimeRestTime: number;
  sessionCount: number;
  dailyTotals: Record<string, DailyTotal>;   // key: YYYY-MM-DD
}

// ── Session State Machine ───────────────────────────────────

export type SessionStatus = 'idle' | 'waiting' | 'playing' | 'resting';

// ── Settings ────────────────────────────────────────────────

export interface Settings {
  sensitivityThreshold: number;   // 0–1, default ~0.5
  minRestDuration: number;        // seconds, 1–60, default 5
  minPlayDuration: number;        // seconds, 1–120, default 30
  musicDetectionEnabled: boolean; // default false
  musicDetectionStrictness: number; // 0–1, default 0.3 (low = permissive)
}
