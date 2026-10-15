/**
 * Project Touchline – Prediction Evaluation Metrics
 *
 * Pure, deterministic metrics used to validate the frozen Poisson engine against
 * historical results. Nothing here changes the model — these functions only score
 * probabilities that the frozen engine already produced.
 *
 * Outcome convention: 0 = home win, 1 = draw, 2 = away win (the order used by
 * PoissonProbabilities: homeWin, draw, awayWin).
 */

export type Outcome = 0 | 1 | 2;

export interface ProbabilityTriplet {
  homeWin: number;
  draw: number;
  awayWin: number;
}

/** Maps a final score to the 3-way outcome index. Returns null when the score is incomplete. */
export function outcomeFromScore(home: number | null | undefined, away: number | null | undefined): Outcome | null {
  if (home == null || away == null || !Number.isFinite(home) || !Number.isFinite(away)) return null;
  if (home > away) return 0;
  if (home === away) return 1;
  return 2;
}

/** True when every probability is finite and within [0, 1]. */
export function areProbabilitiesValid(p: ProbabilityTriplet | null | undefined): boolean {
  if (!p) return false;
  const values = [p.homeWin, p.draw, p.awayWin];
  return values.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
}

/** Sum of the 3-way probabilities (no normalisation applied). */
export function probabilitySum(p: ProbabilityTriplet): number {
  return p.homeWin + p.draw + p.awayWin;
}

/**
 * Documented numerical tolerance for the 3-way probability sum.
 *
 * The frozen engine rounds each leg to 3 decimals independently, so the summed legs
 * can drift by up to 0.001 (observed max over 3,494 historical predictions: 0.001).
 * 2e-3 therefore bounds the frozen engine's rounding while still catching real
 * normalisation errors (e.g. an un-normalised distribution).
 */
export const PROBABILITY_SUM_TOLERANCE = 2e-3;

/** True when the 3-way probabilities sum to 1 within the given absolute tolerance. */
export function probabilitiesSumToOne(p: ProbabilityTriplet, tolerance = PROBABILITY_SUM_TOLERANCE): boolean {
  return Math.abs(probabilitySum(p) - 1) <= tolerance;
}

/** Multiclass (3-way) log loss for a single observation. */
export function multiclassLogLoss(p: ProbabilityTriplet, outcome: Outcome): number {
  const probs = [p.homeWin, p.draw, p.awayWin];
  const EPS = 1e-15;
  return -Math.log(Math.max(probs[outcome], EPS));
}

/** Multiclass Brier score for a single observation (sum of squared errors). */
export function multiclassBrier(p: ProbabilityTriplet, outcome: Outcome): number {
  const probs = [p.homeWin, p.draw, p.awayWin];
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const y = k === outcome ? 1 : 0;
    s += (probs[k] - y) ** 2;
  }
  return s;
}

/** Convenience: the probability assigned to the observed outcome. */
export function probabilityOfOutcome(p: ProbabilityTriplet, outcome: Outcome): number {
  return [p.homeWin, p.draw, p.awayWin][outcome];
}

export interface CalibrationBin {
  /** Inclusive lower bound, exclusive upper bound (except the final bin includes 1.0). */
  lower: number;
  upper: number;
  count: number;
  /** Mean predicted probability of the positive class in this bin. */
  meanPredicted: number;
  /** Observed frequency of the positive class in this bin. */
  observedFrequency: number;
}

export interface CalibrationResult {
  bins: CalibrationBin[];
  /** Mean absolute gap between meanPredicted and observedFrequency across non-empty bins. */
  expectedCalibrationError: number;
}

/**
 * One-vs-rest calibration for a single class. Each predicted probability is placed
 * in a fixed-width bin; the bin's observed frequency is the share of those matches
 * the class actually won. Empty bins are retained with zero count and excluded from ECE.
 */
export function calibrationForClass(
  probs: number[],
  outcomes: Outcome[],
  classIndex: Outcome,
  binCount = 10
): CalibrationResult {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < binCount; b++) {
    bins.push({ lower: b / binCount, upper: (b + 1) / binCount, count: 0, meanPredicted: 0, observedFrequency: 0 });
  }

  const sumPred = new Array(binCount).fill(0);
  const sumObs = new Array(binCount).fill(0);

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (!Number.isFinite(p)) continue;
    const clamped = Math.min(1, Math.max(0, p));
    let idx = Math.floor(clamped * binCount);
    if (idx >= binCount) idx = binCount - 1; // include exactly 1.0 in the last bin
    bins[idx].count++;
    sumPred[idx] += clamped;
    sumObs[idx] += outcomes[i] === classIndex ? 1 : 0;
  }

  let weightedGap = 0;
  let total = 0;
  for (let b = 0; b < binCount; b++) {
    if (bins[b].count > 0) {
      bins[b].meanPredicted = sumPred[b] / bins[b].count;
      bins[b].observedFrequency = sumObs[b] / bins[b].count;
      weightedGap += bins[b].count * Math.abs(bins[b].meanPredicted - bins[b].observedFrequency);
      total += bins[b].count;
    }
  }

  return { bins, expectedCalibrationError: total > 0 ? weightedGap / total : 0 };
}

export interface EvaluationSample {
  probabilities: ProbabilityTriplet;
  outcome: Outcome;
  competitionCode: string;
  season: string;
}

export interface EvaluationSummary {
  count: number;
  /** Mean multiclass log loss over all samples. */
  logLoss: number;
  /** Mean multiclass Brier score over all samples. */
  brier: number;
  /** Share of matches where the highest-probability outcome actually occurred. */
  accuracy: number;
  /** Mean probability assigned to the observed outcome (higher is better calibrated). */
  meanProbabilityOfOutcome: number;
  /** Mean of the 3-way probability sums (should be 1.0 for a normalised model). */
  meanProbabilitySum: number;
  /** One-vs-rest calibration per class (home, draw, away). */
  calibration: {
    home: CalibrationResult;
    draw: CalibrationResult;
    away: CalibrationResult;
  };
}

/**
 * Aggregates metrics over a set of samples. Returns zeros for an empty set so callers
 * must inspect `count` and never treat an empty evaluation as a valid score.
 */
export function evaluateSamples(samples: EvaluationSample[], binCount = 10): EvaluationSummary {
  if (samples.length === 0) {
    const empty = calibrationForClass([], [], 0, binCount);
    return {
      count: 0,
      logLoss: 0,
      brier: 0,
      accuracy: 0,
      meanProbabilityOfOutcome: 0,
      meanProbabilitySum: 0,
      calibration: { home: empty, draw: empty, away: empty },
    };
  }

  let logLossSum = 0;
  let brierSum = 0;
  let correct = 0;
  let pOutcomeSum = 0;
  let pSumSum = 0;

  const homeProbs: number[] = [];
  const drawProbs: number[] = [];
  const awayProbs: number[] = [];
  const outcomes: Outcome[] = [];

  for (const s of samples) {
    logLossSum += multiclassLogLoss(s.probabilities, s.outcome);
    brierSum += multiclassBrier(s.probabilities, s.outcome);
    pOutcomeSum += probabilityOfOutcome(s.probabilities, s.outcome);
    pSumSum += probabilitySum(s.probabilities);

    const p = [s.probabilities.homeWin, s.probabilities.draw, s.probabilities.awayWin];
    let argmax = 0;
    if (p[1] > p[argmax]) argmax = 1;
    if (p[2] > p[argmax]) argmax = 2;
    if (argmax === s.outcome) correct++;

    homeProbs.push(p[0]);
    drawProbs.push(p[1]);
    awayProbs.push(p[2]);
    outcomes.push(s.outcome);
  }

  const n = samples.length;
  return {
    count: n,
    logLoss: logLossSum / n,
    brier: brierSum / n,
    accuracy: correct / n,
    meanProbabilityOfOutcome: pOutcomeSum / n,
    meanProbabilitySum: pSumSum / n,
    calibration: {
      home: calibrationForClass(homeProbs, outcomes, 0, binCount),
      draw: calibrationForClass(drawProbs, outcomes, 1, binCount),
      away: calibrationForClass(awayProbs, outcomes, 2, binCount),
    },
  };
}

/** Groups samples by an arbitrary key, preserving deterministic insertion order. */
export function groupSamples<T>(samples: T[], keyFn: (s: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const s of samples) {
    const key = keyFn(s);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return map;
}
