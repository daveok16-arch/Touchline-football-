/**
 * Project Touchline – Phase M probability calibration (RESEARCH ONLY)
 *
 * Temperature scaling for three mutually exclusive outcomes. A single temperature
 * T reshapes a probability vector as p_i^(1/T) / sum_j p_j^(1/T). This is a
 * one-parameter, monotone transform: it preserves the ordering and the sum-to-one
 * constraint, keeps every value in [0, 1], and directly targets overconfidence
 * (T > 1 flattens an overconfident distribution; T < 1 sharpens it).
 *
 * The temperature is chosen by minimizing multiclass log loss on a calibration set
 * that must contain only predictions generated from data preceding the targets it
 * will later be applied to. A small ridge term pulls T toward 1.0 so a tiny or
 * uninformative calibration set does not overfit.
 */

import { Outcome, ProbabilityTriplet, multiclassLogLoss } from '../predictionMetrics';

export interface TemperatureFit {
  temperature: number;
  calibrationCount: number;
  /** Log loss on the calibration set before scaling. */
  logLossBefore: number;
  /** Log loss on the calibration set after scaling (at the chosen T). */
  logLossAfter: number;
  searchMin: number;
  searchMax: number;
  steps: number;
  ridge: number;
}

/** Applies temperature scaling and re-normalizes. Falls back to the input on invalid input. */
export function applyTemperature(p: ProbabilityTriplet, temperature: number): ProbabilityTriplet {
  if (!Number.isFinite(temperature) || temperature <= 0) {
    return { homeWin: p.homeWin, draw: p.draw, awayWin: p.awayWin };
  }
  const raw = [p.homeWin, p.draw, p.awayWin].map((v) =>
    v <= 0 ? 0 : Math.pow(v, 1 / temperature)
  );
  const sum = raw[0] + raw[1] + raw[2];
  if (!Number.isFinite(sum) || sum <= 0) {
    return { homeWin: p.homeWin, draw: p.draw, awayWin: p.awayWin };
  }
  return { homeWin: raw[0] / sum, draw: raw[1] / sum, awayWin: raw[2] / sum };
}

export interface TemperatureOptions {
  searchMin?: number;
  searchMax?: number;
  steps?: number;
  ridge?: number;
}

/**
 * Fits a single temperature on a calibration set by grid search over [searchMin, searchMax].
 * Objective = mean calibration log loss + ridge * (T - 1)^2. Deterministic.
 */
export function fitTemperature(
  probs: ProbabilityTriplet[],
  outcomes: Outcome[],
  options: TemperatureOptions = {}
): TemperatureFit {
  const searchMin = options.searchMin ?? 0.5;
  const searchMax = options.searchMax ?? 3.0;
  const steps = options.steps ?? 500;
  const ridge = options.ridge ?? 0.0005;

  const n = Math.min(probs.length, outcomes.length);
  const logLossAt = (t: number): number => {
    if (n === 0) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += multiclassLogLoss(applyTemperature(probs[i], t), outcomes[i]);
    }
    return s / n;
  };

  let bestT = 1;
  let bestObj = Infinity;
  for (let k = 0; k <= steps; k++) {
    const t = searchMin + ((searchMax - searchMin) * k) / steps;
    const obj = logLossAt(t) + ridge * (t - 1) * (t - 1);
    if (obj < bestObj) {
      bestObj = obj;
      bestT = t;
    }
  }

  const before = logLossAt(1);
  const after = logLossAt(bestT);
  return {
    temperature: bestT,
    calibrationCount: n,
    logLossBefore: before,
    logLossAfter: after,
    searchMin,
    searchMax,
    steps,
    ridge,
  };
}

/** Convenience wrapper: fit on (probs, outcomes) and return a calibrated copy of `target`. */
export function calibrateTriplets(
  target: ProbabilityTriplet[],
  fit: TemperatureFit
): ProbabilityTriplet[] {
  return target.map((p) => applyTemperature(p, fit.temperature));
}
