/**
 * Project Touchline – Phase M research metrics
 *
 * RESEARCH ONLY. Nothing here is imported by the production app or by the frozen
 * model. These are additional scoring rules (RPS) and uncertainty estimates
 * (chronological block bootstrap) used to compare forecast models offline.
 *
 * Outcome convention (inherited from predictionMetrics.ts):
 *   0 = home win, 1 = draw, 2 = away win.
 * This is the natural ordinal order used throughout the project, so RPS uses the
 * same ordering: the cumulative distribution is compared at the home-win and
 * home-or-draw boundaries.
 */

import { Outcome, ProbabilityTriplet } from '../predictionMetrics';

/** Deterministic, seedable PRNG (mulberry32). Returns a function producing [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toArray(p: ProbabilityTriplet): [number, number, number] {
  return [p.homeWin, p.draw, p.awayWin];
}

/**
 * Ranked Probability Score for a single observation, using the ordinal ordering
 * home win < draw < away win. RPS = (1/(K-1)) * sum_{k=1}^{K-1} (cumulativeForecast_k - cumulativeObserved_k)^2
 * with K = 3, so RPS = 0.5 * [ (P_home - y_home)^2 + (P_home+P_draw - y_home - y_draw)^2 ].
 * Lower is better. Range [0, 1].
 */
export function rankedProbabilityScore(p: ProbabilityTriplet, outcome: Outcome): number {
  const [ph, pd] = toArray(p);
  const yh = outcome === 0 ? 1 : 0;
  const yd = outcome === 1 ? 1 : 0;
  const cFore1 = ph;
  const cObs1 = yh;
  const cFore2 = ph + pd;
  const cObs2 = yh + yd;
  return 0.5 * ((cFore1 - cObs1) ** 2 + (cFore2 - cObs2) ** 2);
}

export interface PairedObservation {
  /** Model probability triplet for this fixture. */
  probabilities: ProbabilityTriplet;
  outcome: Outcome;
  /** Chronological sort key (kickoff ms). Used only for block construction. */
  kickoffMs: number;
  /** Competition code, used only for block construction/reporting. */
  competitionCode: string;
}

export type PerMatchScorer = (o: PairedObservation) => number;

/** RPS scorer usable in paired comparisons. */
export const rpsScorer: PerMatchScorer = (o) => rankedProbabilityScore(o.probabilities, o.outcome);

/** Precomputes per-match scores for a scorer over an aligned observation list. */
export function scoreAll(observations: PairedObservation[], scorer: PerMatchScorer): number[] {
  return observations.map(scorer);
}

export interface PairedComparison {
  n: number;
  meanA: number;
  meanB: number;
  /** meanA - meanB. Negative means A scores better (lower) than B. */
  meanDifference: number;
  ciLow: number;
  ciHigh: number;
  /** Fraction of bootstrap resamples in which A scored strictly better than B. */
  probABetter: number;
  seed: number;
  blockSize: number;
  resamples: number;
}

export interface BootstrapOptions {
  seed?: number;
  resamples?: number;
  /** Fixed block length in fixtures (chronological). Default 20. */
  blockSize?: number;
  /** When true, blocks are built within each competition separately. Default true. */
  stratifyByCompetition?: boolean;
}

interface Block {
  indices: number[];
}

/**
 * Builds contiguous chronological blocks of fixture indices. When `stratify` is true,
 * blocks never span a competition boundary (a matchday-grouped, within-competition
 * block bootstrap), which respects both serial dependence and competition structure.
 */
export function buildBlocks(
  observations: PairedObservation[],
  blockSize: number,
  stratify: boolean
): Block[] {
  const blocks: Block[] = [];
  if (stratify) {
    const byComp = new Map<string, number[]>();
    for (let i = 0; i < observations.length; i++) {
      const key = observations[i].competitionCode;
      if (!byComp.has(key)) byComp.set(key, []);
      byComp.get(key)!.push(i);
    }
    // Deterministic competition order.
    for (const key of [...byComp.keys()].sort()) {
      const idx = byComp.get(key)!;
      idx.sort((a, b) => observations[a].kickoffMs - observations[b].kickoffMs || a - b);
      for (let i = 0; i < idx.length; i += blockSize) {
        blocks.push({ indices: idx.slice(i, i + blockSize) });
      }
    }
  } else {
    const order = observations
      .map((_, i) => i)
      .sort((a, b) => observations[a].kickoffMs - observations[b].kickoffMs || a - b);
    for (let i = 0; i < order.length; i += blockSize) {
      blocks.push({ indices: order.slice(i, i + blockSize) });
    }
  }
  return blocks;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/**
 * Paired chronological block bootstrap for the mean per-match score difference.
 * Accepts precomputed per-match score arrays aligned to `observations` (identical
 * eligible fixtures in a fixed order for both models). The same block resample is
 * applied to both, preserving pairing.
 */
export function pairedBlockBootstrapFromScores(
  observations: PairedObservation[],
  scoreA: number[],
  scoreB: number[],
  options: BootstrapOptions = {}
): PairedComparison {
  const seed = options.seed ?? 20261015;
  const resamples = options.resamples ?? 2000;
  const blockSize = options.blockSize ?? 20;
  const stratify = options.stratifyByCompetition ?? true;

  const meanA = mean(scoreA);
  const meanB = mean(scoreB);
  const meanDifference = meanA - meanB;

  const blocks = buildBlocks(observations, blockSize, stratify);
  const rng = mulberry32(seed);

  const diffs: number[] = [];
  let aBetter = 0;
  for (let r = 0; r < resamples; r++) {
    let sumDiff = 0;
    let count = 0;
    while (count < observations.length) {
      const b = blocks[Math.floor(rng() * blocks.length)];
      for (const i of b.indices) {
        sumDiff += scoreA[i] - scoreB[i];
        count++;
        if (count >= observations.length) break;
      }
    }
    const d = count > 0 ? sumDiff / count : 0;
    diffs.push(d);
    if (d < 0) aBetter++;
  }

  diffs.sort((x, y) => x - y);
  const loIdx = Math.max(0, Math.floor(0.025 * diffs.length));
  const hiIdx = Math.min(diffs.length - 1, Math.floor(0.975 * diffs.length));

  return {
    n: observations.length,
    meanA,
    meanB,
    meanDifference,
    ciLow: diffs[loIdx],
    ciHigh: diffs[hiIdx],
    probABetter: aBetter / resamples,
    seed,
    blockSize,
    resamples,
  };
}

/** Convenience: score both models then bootstrap. */
export function pairedBlockBootstrap(
  observations: PairedObservation[],
  scorerA: PerMatchScorer,
  scorerB: PerMatchScorer,
  options: BootstrapOptions = {}
): PairedComparison {
  return pairedBlockBootstrapFromScores(
    observations,
    scoreAll(observations, scorerA),
    scoreAll(observations, scorerB),
    options
  );
}

/** Pairs two aligned per-fixture score arrays into PairedObservations for scoring. */
export function alignPairs<T>(
  items: T[],
  keyFn: (item: T) => string
): { commonKeys: string[]; pairs: T[] } {
  const seen = new Map<string, number>();
  for (const it of items) {
    const k = keyFn(it);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const commonKeys = [...seen.keys()].sort();
  return { commonKeys, pairs: items };
}
