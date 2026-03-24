// ── Interval ────────────────────────────────────────────────

export interface Interval {
  type: 'play' | 'rest' | 'pause';
  startOffset: number;       // seconds from session start
  duration: number;           // seconds
  pieceName?: string;         // only meaningful for 'play' intervals
}

// ── Session Record ──────────────────────────────────────────

export interface SessionRecord {
  id: string;
  date: string;                // ISO timestamp of session start
  totalDuration: number;       // total elapsed time in seconds (excludes manual pause)
  playTime: number;
  restTime: number;
  pauseTime: number;
  intervals: Interval[];
  pairBoundaries: number[];    // indices into intervals[] where each new pair starts (e.g. [0, 5, 12])
  notes: string;
}

// ── Display Pair (computed from intervals + boundaries) ─────

export interface DisplayPair {
  pieceName?: string;
  playTime: number;
  restTime: number;
  totalTime: number;
  intervalStartIndex: number;  // index of first interval in this pair
  intervalEndIndex: number;    // index past last interval in this pair
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

export type SessionStatus = 'idle' | 'waiting' | 'playing' | 'resting' | 'paused';

// ── Settings ────────────────────────────────────────────────

export interface Settings {
  sensitivityThreshold: number;   // 0–1, default ~0.5
  minRestDuration: number;        // seconds, 1–60, default 5
  minPlayDuration: number;        // seconds, 1–120, default 30
}
