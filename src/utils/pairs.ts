import { Interval, DisplayPair } from '../types';

/**
 * Compute display pairs from raw intervals + pair boundaries.
 * Each pair aggregates play/rest time across all intervals in the range.
 * The piece name comes from the first play interval in the pair that has one.
 */
export function computeDisplayPairs(
  intervals: Interval[],
  pairBoundaries: number[],
): DisplayPair[] {
  if (intervals.length === 0) return [];

  // Ensure boundaries are sorted and start with 0
  const bounds = pairBoundaries.length > 0
    ? [...pairBoundaries].sort((a, b) => a - b)
    : [0];
  if (bounds[0] !== 0) bounds.unshift(0);

  const pairs: DisplayPair[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i];
    const end = i + 1 < bounds.length ? bounds[i + 1] : intervals.length;
    if (start >= intervals.length) break;

    let playTime = 0;
    let restTime = 0;
    let pieceName: string | undefined;

    for (let j = start; j < end; j++) {
      const iv = intervals[j];
      if (iv.type === 'play') {
        playTime += iv.duration;
        if (!pieceName && iv.pieceName) pieceName = iv.pieceName;
      } else if (iv.type === 'rest') {
        restTime += iv.duration;
      }
    }

    pairs.push({
      pieceName,
      playTime,
      restTime,
      totalTime: playTime + restTime,
      intervalStartIndex: start,
      intervalEndIndex: end,
    });
  }

  return pairs;
}

/**
 * Like computeDisplayPairs, but augments the current (last) pair with
 * live in-progress time derived from the running playTime/restTime counters.
 * Use during an active session so the current section always renders
 * with up-to-date times.
 */
export function computeLivePairs(
  intervals: Interval[],
  pairBoundaries: number[],
  playTime: number,
  restTime: number,
): DisplayPair[] {
  const finished = computeDisplayPairs(intervals, pairBoundaries);
  let finishedPlay = 0;
  let finishedRest = 0;
  for (const p of finished) {
    finishedPlay += p.playTime;
    finishedRest += p.restTime;
  }
  const curPlay = Math.max(0, playTime - finishedPlay);
  const curRest = Math.max(0, restTime - finishedRest);

  const expectCount = Math.max(1, pairBoundaries.length);
  if (finished.length < expectCount) {
    return [...finished, {
      pieceName: undefined,
      playTime: curPlay,
      restTime: curRest,
      totalTime: curPlay + curRest,
      intervalStartIndex: intervals.length,
      intervalEndIndex: intervals.length,
    }];
  }

  if (finished.length > 0) {
    const result = [...finished];
    const last = result[result.length - 1];
    result[result.length - 1] = {
      ...last,
      playTime: last.playTime + curPlay,
      restTime: last.restTime + curRest,
      totalTime: last.playTime + curPlay + last.restTime + curRest,
    };
    return result;
  }

  return [{
    pieceName: undefined,
    playTime: curPlay,
    restTime: curRest,
    totalTime: curPlay + curRest,
    intervalStartIndex: 0,
    intervalEndIndex: 0,
  }];
}
