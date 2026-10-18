/**
 * Project Touchline – Phase P probability-calibration candidate (RESEARCH CANDIDATE)
 *
 * A thin, OPTIONAL layer that wraps the FROZEN engine's output probabilities with a
 * single global temperature scaling. It does NOT re-implement the engine, touch its
 * parameters, or alter its output contract: it consumes the home/draw/away triplet the
 * engine already produced and (only when explicitly enabled) reshapes it.
 *
 * Integration point: the probability triplet returned by the frozen engine
 * (`evaluatePoissonProbabilities` / `runBacktest`). Callers pass that triplet in;
 * when the flag is off the input object is returned verbatim (exact parity).
 *
 * Reuse: the audited transform and fitter live in `src/services/research/calibration.ts`.
 * This module deliberately does not define a second implementation.
 *
 * Policy:
 *   - Flag: `ENABLE_PROBABILITY_CALIBRATION`, default OFF (must equal "true" to enable).
 *   - Cold start: T = 1 until at least MIN_CALIBRATION_SAMPLES eligible historical
 *     predictions with known outcomes are available.
 *   - Leakage: a calibrator for a forecast at time `asOfMs` uses ONLY observations whose
 *     outcome was known strictly before `asOfMs` (outcomeKnownAtMs < asOfMs).
 *   - Fallback: insufficient / malformed / failed fit -> T = 1 (input returned unchanged).
 *   - One global temperature; no per-competition temperatures.
 */

import { Outcome, ProbabilityTriplet } from './predictionMetrics';
import { applyTemperature, fitTemperature, TemperatureFit, TemperatureOptions } from './research/calibration';

/** Environment variable that gates the candidate. Off unless exactly "true". */
export const CALIBRATION_FLAG_ENV = 'ENABLE_PROBABILITY_CALIBRATION';

/** Cold-start threshold: below this many eligible prior observations, T is fixed at 1. */
export const MIN_CALIBRATION_SAMPLES = 500;

/** Label appended to a calibrated prediction's provenance (research only). */
export const CALIBRATION_CANDIDATE_ID = 'TEMP_SCALE_CANDIDATE_V1';

/**
 * True only when the calibration flag is explicitly enabled.
 * Defaults to disabled so production behaviour is unchanged.
 *
 * NOTE: this reports intent, it does not activate anything. No production or API path
 * reads this flag yet — the frozen engine does not import calibration, and `server.ts`
 * reads only `ENABLE_ODDS_API`. Setting the env var changes no user-facing probability.
 * See {@link CALIBRATION_ACTIVATION_STATUS} and the calibration findings in AGENTS.md.
 */
export function isCalibrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CALIBRATION_FLAG_ENV] === 'true';
}

/** Machine-readable statement of whether the calibration candidate is live. */
export const CALIBRATION_ACTIVATION_STATUS = {
  /** Calibration is not applied anywhere in the prediction path. */
  wired: false,
  /** Validation verdict on held-out data. */
  validatedImprovement: true,
  /** What must happen before the displayed probabilities may change. */
  requiredBeforeActivation:
    'Fit from strictly-prior settled results and run prospective shadow validation; ' +
    'activation changes user-facing probabilities.',
} as const;

/**
 * One historical observation available for fitting. `outcomeKnownAtMs` is the instant the
 * result became known (e.g. kickoff plus the provider's settlement delay); it is the value
 * the strictly-prior rule is applied to, NOT the kickoff time.
 */
export interface CalibrationObservation {
  probabilities: ProbabilityTriplet;
  outcome: Outcome;
  outcomeKnownAtMs: number;
}

export interface CandidateCalibration {
  temperature: number;
  sampleCount: number;
  /** Latest outcomeKnownAtMs among the observations that were used. */
  fittedThroughMs: number;
  /** Underlying fit diagnostics from the audited fitter. */
  fit: TemperatureFit;
}

function isValidTriplet(p: ProbabilityTriplet | null | undefined): p is ProbabilityTriplet {
  if (!p) return false;
  return (
    Number.isFinite(p.homeWin) &&
    Number.isFinite(p.draw) &&
    Number.isFinite(p.awayWin) &&
    p.homeWin >= 0 &&
    p.draw >= 0 &&
    p.awayWin >= 0 &&
    p.homeWin + p.draw + p.awayWin > 0
  );
}

export interface FitCandidateOptions {
  /** Minimum eligible observations required; defaults to MIN_CALIBRATION_SAMPLES. */
  minSamples?: number;
  /** Grid/ridge options forwarded to the audited fitter. */
  temperature?: TemperatureOptions;
}

/** Why a candidate calibrator fell back to T = 1. */
export type CalibrationFallbackReason = 'INVALID_INPUT' | 'INSUFFICIENT_SAMPLES' | 'FIT_FAILED';

export interface CalibrationBuildResult {
  calibration: CandidateCalibration | null;
  /** Present exactly when `calibration` is null. */
  fallbackReason?: CalibrationFallbackReason;
}

/**
 * Builds a candidate calibrator for a forecast made at `asOfMs`, using ONLY observations
 * whose outcome was known strictly before `asOfMs`. Returns the reason when it falls back.
 */
export function buildCandidateCalibration(
  history: CalibrationObservation[],
  asOfMs: number,
  options: FitCandidateOptions = {}
): CalibrationBuildResult {
  const minSamples = options.minSamples ?? MIN_CALIBRATION_SAMPLES;
  if (!Number.isFinite(asOfMs) || !Array.isArray(history)) {
    return { calibration: null, fallbackReason: 'INVALID_INPUT' };
  }

  const eligible: CalibrationObservation[] = [];
  for (const obs of history) {
    if (!obs || !isValidTriplet(obs.probabilities)) continue;
    if (obs.outcome !== 0 && obs.outcome !== 1 && obs.outcome !== 2) continue;
    if (!Number.isFinite(obs.outcomeKnownAtMs)) continue;
    // Strictly prior: an outcome known exactly at the forecast time is NOT usable.
    if (obs.outcomeKnownAtMs >= asOfMs) continue;
    eligible.push(obs);
  }

  if (eligible.length < minSamples) return { calibration: null, fallbackReason: 'INSUFFICIENT_SAMPLES' };

  let fit: TemperatureFit;
  try {
    fit = fitTemperature(
      eligible.map((o) => o.probabilities),
      eligible.map((o) => o.outcome),
      options.temperature
    );
  } catch {
    return { calibration: null, fallbackReason: 'FIT_FAILED' };
  }
  if (!Number.isFinite(fit.temperature) || fit.temperature <= 0) {
    return { calibration: null, fallbackReason: 'FIT_FAILED' };
  }

  let fittedThroughMs = -Infinity;
  for (const o of eligible) fittedThroughMs = Math.max(fittedThroughMs, o.outcomeKnownAtMs);

  return {
    calibration: {
      temperature: fit.temperature,
      sampleCount: eligible.length,
      fittedThroughMs,
      fit,
    },
  };
}

/**
 * Convenience wrapper returning the calibrator or null. Fits a candidate calibrator for a
 * forecast made at `asOfMs`, using ONLY observations whose outcome was known strictly before
 * `asOfMs`. Returns null when there are fewer than `minSamples` eligible observations
 * (cold start) or when fitting fails.
 */
export function fitCandidateCalibration(
  history: CalibrationObservation[],
  asOfMs: number,
  options: FitCandidateOptions = {}
): CandidateCalibration | null {
  return buildCandidateCalibration(history, asOfMs, options).calibration;
}

/**
 * Applies a fitted calibrator to a probability triplet. Returns the input unchanged when the
 * calibrator is absent, degenerate, or T = 1. Never reorders outcomes; always finite.
 */
export function calibrateTriplet(
  probabilities: ProbabilityTriplet,
  calibration: CandidateCalibration | null | undefined
): ProbabilityTriplet {
  if (!calibration || !Number.isFinite(calibration.temperature) || calibration.temperature === 1) {
    return probabilities;
  }
  return applyTemperature(probabilities, calibration.temperature);
}

/**
 * The gated entry point. When the flag is off, returns the input verbatim (exact parity with
 * the frozen path). When on, applies the supplied calibrator (falling back to the input when
 * the calibrator is absent).
 */
export function calibrateIfEnabled(
  probabilities: ProbabilityTriplet,
  calibration: CandidateCalibration | null | undefined,
  env: Record<string, string | undefined> = process.env
): ProbabilityTriplet {
  if (!isCalibrationEnabled(env)) return probabilities;
  return calibrateTriplet(probabilities, calibration);
}

/**
 * Convenience: fit from history as of `asOfMs` and apply, all gated by the flag.
 * Returns the input verbatim when disabled or when the fit is unavailable.
 */
export function fitAndCalibrateIfEnabled(
  probabilities: ProbabilityTriplet,
  history: CalibrationObservation[],
  asOfMs: number,
  env: Record<string, string | undefined> = process.env,
  options: FitCandidateOptions = {}
): ProbabilityTriplet {
  if (!isCalibrationEnabled(env)) return probabilities;
  const calibration = fitCandidateCalibration(history, asOfMs, options);
  return calibrateTriplet(probabilities, calibration);
}
