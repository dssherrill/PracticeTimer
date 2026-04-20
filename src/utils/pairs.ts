import { Section } from '../types';

/**
 * Build the live sections list for an active session.
 *
 * `completedSections` are sections that have been finalized (via nextPair).
 * The last section is always the "current" one; its play/rest times are
 * derived from the running totals minus what's already been finalized.
 */
export function computeLiveSections(
  completedSections: Section[],
  currentPieceName: string,
  totalPlayTime: number,
  totalRestTime: number,
): Section[] {
  let finishedPlay = 0;
  let finishedRest = 0;
  for (const s of completedSections) {
    finishedPlay += s.playDuration;
    finishedRest += s.restDuration;
  }
  const curPlay = Math.max(0, Math.round(totalPlayTime) - finishedPlay);
  const curRest = Math.max(0, Math.round(totalRestTime) - finishedRest);

  return [
    ...completedSections,
    {
      ...(currentPieceName ? { pieceName: currentPieceName } : {}),
      playDuration: curPlay,
      restDuration: curRest,
    },
  ];
}
