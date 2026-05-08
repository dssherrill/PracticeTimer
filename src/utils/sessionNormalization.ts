import { CumulativeStats, Section, SessionRecord } from '../types';

export const DEFAULT_SECTION_PIECE_NAME = 'Transition';

export function normalizePieceName(name?: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return DEFAULT_SECTION_PIECE_NAME;

  const compact = trimmed.replace(/\s+/g, ' ');
  const exerciseMatch = compact.match(/^(Schantl|Kopprasch)\s*0*(\d+)$/i);
  if (exerciseMatch) {
    const method = exerciseMatch[1].toLowerCase() === 'schantl' ? 'Schantl' : 'Kopprasch';
    const num = String(parseInt(exerciseMatch[2], 10)).padStart(2, '0');
    return `${method} ${num}`;
  }

  return compact;
}

function toWholeSeconds(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
}

export function normalizeSection(section: Section): Section {
  return {
    pieceName: normalizePieceName(section.pieceName),
    playDuration: toWholeSeconds(section.playDuration),
    restDuration: toWholeSeconds(section.restDuration),
  };
}

export function normalizeSections(sections: Section[]): Section[] {
  return sections.map(normalizeSection);
}

export function deriveTotalsFromSections(sections: Section[]): {
  playTime: number;
  restTime: number;
  totalDuration: number;
} {
  let playTime = 0;
  let restTime = 0;
  for (const section of sections) {
    playTime += toWholeSeconds(section.playDuration);
    restTime += toWholeSeconds(section.restDuration);
  }

  return {
    playTime,
    restTime,
    totalDuration: playTime + restTime,
  };
}

export function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  const normalizedSections = normalizeSections(session.sections ?? []);
  const totals = deriveTotalsFromSections(normalizedSections);

  return {
    ...session,
    sections: normalizedSections,
    playTime: totals.playTime,
    restTime: totals.restTime,
    totalDuration: totals.totalDuration,
  };
}

export function rebuildPieceNamesFromSessions(
  sessions: SessionRecord[],
  existingPieceNames: string[] = [],
): string[] {
  const names = new Set<string>();

  for (const name of existingPieceNames) {
    names.add(normalizePieceName(name));
  }

  for (const session of sessions) {
    for (const section of (session.sections ?? [])) {
      names.add(normalizePieceName(section.pieceName));
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

export function recomputeCumulativeStatsFromSessions(sessions: SessionRecord[]): CumulativeStats {
  const stats: CumulativeStats = {
    allTimeTotalDuration: 0,
    allTimePlayTime: 0,
    allTimeRestTime: 0,
    sessionCount: 0,
    dailyTotals: {},
  };

  for (const session of sessions) {
    const normalized = normalizeSessionRecord(session);
    stats.allTimeTotalDuration += normalized.totalDuration;
    stats.allTimePlayTime += normalized.playTime;
    stats.allTimeRestTime += normalized.restTime;
    stats.sessionCount += 1;

    const dayKey = normalized.date.slice(0, 10);
    if (!stats.dailyTotals[dayKey]) {
      stats.dailyTotals[dayKey] = { totalDuration: 0, playTime: 0 };
    }
    stats.dailyTotals[dayKey].totalDuration += normalized.totalDuration;
    stats.dailyTotals[dayKey].playTime += normalized.playTime;
  }

  // Keep the same retention policy as runtime stats updates.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(stats.dailyTotals)) {
    if (key < cutoffKey) delete stats.dailyTotals[key];
  }

  return stats;
}