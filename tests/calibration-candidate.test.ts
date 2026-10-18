/**
 * Project Touchline – Phase P calibration-candidate tests (RESEARCH ONLY)
 *
 * Covers: exact parity when disabled; T=1 identity; normalization/finiteness/[0,1];
 * ordering preservation; cold-start fallback below 500; no target/future leakage;
 * strict ordering at equal timestamps; determinism; safe fallback on malformed data
 * or fit failure; flag OFF by default; frozen model version/contract preservation.
 */

import { describe, it, expect } from 'vitest';
import { Outcome, ProbabilityTriplet } from '../src/services/predictionMetrics';
import {
  CALIBRATION_FLAG_ENV,
  MIN_CALIBRATION_SAMPLES,
  CALIBRATION_CANDIDATE_ID,
  CALIBRATION_ACTIVATION_STATUS,
  isCalibrationEnabled,
  fitCandidateCalibration,
  calibrateTriplet,
  calibrateIfEnabled,
  fitAndCalibrateIfEnabled,
  CalibrationObservation,
} from '../src/services/calibrationCandidate';
import { FROZEN_MODEL_VERSION, MODEL_REGISTRY_ID } from '../src/services/predictionEngine';

const OFF: Record<string, string | undefined> = {};
const ON: Record<string, string | undefined> = { [CALIBRATION_FLAG_ENV]: 'true' };

/** Deterministic overconfident history with a controllable size. */
function makeHistory(n: number, knownAt = 0): CalibrationObservation[] {
  const obs: CalibrationObservation[] = [];
  for (let i = 0; i < n; i++) {
    // Home over-predicted at 0.85; true home rate ~60%.
    obs.push({
      probabilities: { homeWin: 0.85, draw: 0.1, awayWin: 0.05 },
      outcome: (i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : 2) as Outcome,
      outcomeKnownAtMs: knownAt + i,
    });
  }
  return obs;
}

describe('Phase P – feature flag', () => {
  it('is OFF by default (undefined env)', () => {
    expect(isCalibrationEnabled({})).toBe(false);
    expect(isCalibrationEnabled({ [CALIBRATION_FLAG_ENV]: 'false' })).toBe(false);
    expect(isCalibrationEnabled({ [CALIBRATION_FLAG_ENV]: '1' })).toBe(false);
  });

  it('is ON only for the exact string "true"', () => {
    expect(isCalibrationEnabled({ [CALIBRATION_FLAG_ENV]: 'true' })).toBe(true);
  });

  it('exposes the documented candidate id and threshold', () => {
    expect(CALIBRATION_CANDIDATE_ID).toBe('TEMP_SCALE_CANDIDATE_V1');
    expect(MIN_CALIBRATION_SAMPLES).toBe(500);
  });
});

describe('Phase P – exact parity when disabled', () => {
  const p: ProbabilityTriplet = { homeWin: 0.512, draw: 0.267, awayWin: 0.221 };

  it('calibrateIfEnabled returns the identical object when disabled', () => {
    const history = makeHistory(1000);
    const cal = fitCandidateCalibration(history, 100000);
    expect(cal).not.toBeNull();
    const out = calibrateIfEnabled(p, cal, OFF);
    expect(out).toBe(p); // reference equality -> exact parity
  });

  it('fitAndCalibrateIfEnabled returns the input verbatim when disabled', () => {
    const out = fitAndCalibrateIfEnabled(p, makeHistory(1000), 100000, OFF);
    expect(out).toBe(p);
  });

  it('calibrateTriplet returns the input reference when the calibrator is null', () => {
    expect(calibrateTriplet(p, null)).toBe(p);
    expect(calibrateTriplet(p, undefined)).toBe(p);
  });

  it('calibrateTriplet returns the input reference at T=1', () => {
    const cal = fitCandidateCalibration(makeHistory(1000), 100000)!;
    expect(calibrateTriplet(p, { ...cal, temperature: 1 })).toBe(p);
  });
});

describe('Phase P – T=1 identity and normalization', () => {
  it('applyTemperature via calibrateTriplet at T=1 preserves the vector exactly', () => {
    const p: ProbabilityTriplet = { homeWin: 0.4, draw: 0.3, awayWin: 0.3 };
    const cal = fitCandidateCalibration(makeHistory(1000), 100000)!;
    const out = calibrateTriplet(p, { ...cal, temperature: 1 });
    expect(out.homeWin).toBe(0.4);
    expect(out.draw).toBe(0.3);
    expect(out.awayWin).toBe(0.3);
  });

  it('a fitted (T>1) transform yields finite probabilities in [0,1] summing to 1', () => {
    const cal = fitCandidateCalibration(makeHistory(1000), 100000)!;
    expect(cal.temperature).toBeGreaterThan(1);
    for (const p of [
      { homeWin: 0.9, draw: 0.06, awayWin: 0.04 },
      { homeWin: 0.34, draw: 0.33, awayWin: 0.33 },
      { homeWin: 0.05, draw: 0.15, awayWin: 0.8 },
    ]) {
      const q = calibrateTriplet(p, cal);
      expect(Number.isFinite(q.homeWin)).toBe(true);
      expect(Number.isFinite(q.draw)).toBe(true);
      expect(Number.isFinite(q.awayWin)).toBe(true);
      expect(q.homeWin).toBeGreaterThanOrEqual(0);
      expect(q.draw).toBeGreaterThanOrEqual(0);
      expect(q.awayWin).toBeGreaterThanOrEqual(0);
      expect(q.homeWin).toBeLessThanOrEqual(1);
      expect(q.draw).toBeLessThanOrEqual(1);
      expect(q.awayWin).toBeLessThanOrEqual(1);
      expect(q.homeWin + q.draw + q.awayWin).toBeCloseTo(1, 12);
    }
  });

  it('preserves outcome ordering (monotone transform)', () => {
    const cal = fitCandidateCalibration(makeHistory(1000), 100000)!;
    const p: ProbabilityTriplet = { homeWin: 0.6, draw: 0.25, awayWin: 0.15 };
    const q = calibrateTriplet(p, cal);
    expect(q.homeWin).toBeGreaterThanOrEqual(q.draw);
    expect(q.draw).toBeGreaterThanOrEqual(q.awayWin);
  });
});

describe('Phase P – cold-start fallback', () => {
  it('returns null (=> T=1) below the 500-sample threshold', () => {
    expect(fitCandidateCalibration(makeHistory(499), 100000)).toBeNull();
    expect(fitCandidateCalibration(makeHistory(0), 100000)).toBeNull();
  });

  it('fits once at or above the threshold', () => {
    const cal = fitCandidateCalibration(makeHistory(500), 100000);
    expect(cal).not.toBeNull();
    expect(cal!.sampleCount).toBe(500);
  });

  it('applies the fallback in the gated entry point when history is short', () => {
    const p: ProbabilityTriplet = { homeWin: 0.8, draw: 0.12, awayWin: 0.08 };
    const out = fitAndCalibrateIfEnabled(p, makeHistory(100), 100000, ON);
    expect(out).toBe(p); // insufficient history -> unchanged
  });
});

describe('Phase P – leakage discipline', () => {
  it('never uses observations whose outcome is known at or after the forecast time', () => {
    // All 1000 observations become known at the same instant t=5000.
    const history = makeHistory(1000).map((o) => ({ ...o, outcomeKnownAtMs: 5000 }));
    expect(fitCandidateCalibration(history, 5000)).toBeNull(); // strictly prior -> none eligible
    const cal = fitCandidateCalibration(history, 5001);
    expect(cal).not.toBeNull();
    expect(cal!.sampleCount).toBe(1000);
  });

  it('strict ordering: an outcome known exactly at the forecast time is excluded', () => {
    const history = makeHistory(600, 1000); // known at 1000..1599
    // asOf = 1000: none strictly prior -> null.
    expect(fitCandidateCalibration(history, 1000)).toBeNull();
    // asOf = 1600: all 600 strictly prior -> fits.
    expect(fitCandidateCalibration(history, 1600)).not.toBeNull();
  });

  it('a future observation cannot change an earlier fit (additivity of the prior window)', () => {
    const early = makeHistory(600, 0); // known at 0..599
    const earlyFit = fitCandidateCalibration(early, 1000)!;
    // Append a later observation known at t=2000; a forecast at t=1000 must be unaffected.
    const withFuture = [...early, { probabilities: { homeWin: 0.2, draw: 0.3, awayWin: 0.5 }, outcome: 2 as Outcome, outcomeKnownAtMs: 2000 }];
    const earlyFit2 = fitCandidateCalibration(withFuture, 1000)!;
    expect(earlyFit2.temperature).toBe(earlyFit.temperature);
    expect(earlyFit2.sampleCount).toBe(earlyFit.sampleCount);
    // And the applied output is identical.
    const p: ProbabilityTriplet = { homeWin: 0.7, draw: 0.2, awayWin: 0.1 };
    expect(calibrateTriplet(p, earlyFit2)).toEqual(calibrateTriplet(p, earlyFit));
  });
});

describe('Phase P – determinism and safe fallback', () => {
  it('fitting is deterministic for identical input', () => {
    const h = makeHistory(800);
    expect(fitCandidateCalibration(h, 100000)!.temperature).toBe(fitCandidateCalibration(h, 100000)!.temperature);
  });

  it('prediction is deterministic for identical input', () => {
    const cal = fitCandidateCalibration(makeHistory(800), 100000)!;
    const p: ProbabilityTriplet = { homeWin: 0.62, draw: 0.24, awayWin: 0.14 };
    expect(calibrateTriplet(p, cal)).toEqual(calibrateTriplet(p, cal));
  });

  it('skips malformed observations and still fits from the valid remainder', () => {
    const good = makeHistory(600);
    const bad = [
      { probabilities: { homeWin: NaN, draw: 0.1, awayWin: 0.1 }, outcome: 0 as Outcome, outcomeKnownAtMs: 1 },
      { probabilities: { homeWin: 0.5, draw: 0.5, awayWin: 0 }, outcome: 9 as unknown as Outcome, outcomeKnownAtMs: 2 },
      { probabilities: null as unknown as ProbabilityTriplet, outcome: 0 as Outcome, outcomeKnownAtMs: 3 },
    ];
    const cal = fitCandidateCalibration([...bad, ...good], 100000);
    expect(cal).not.toBeNull();
    expect(cal!.sampleCount).toBe(600); // only the valid ones counted
  });

  it('returns null (safe fallback) on malformed container input', () => {
    expect(fitCandidateCalibration(null as unknown as CalibrationObservation[], 1000)).toBeNull();
    expect(fitCandidateCalibration(makeHistory(600), NaN)).toBeNull();
  });
});

describe('Phase P – frozen model contract preserved', () => {
  it('the frozen version and registry id are unchanged', () => {
    expect(FROZEN_MODEL_VERSION).toBe('POISSON_V1_FROZEN');
    expect(MODEL_REGISTRY_ID).toBe('touchline-canonical-poisson');
  });
});

describe('Phase P – activation status is honest', () => {
  it('reports calibration as validated but NOT wired', () => {
    expect(CALIBRATION_ACTIVATION_STATUS.wired).toBe(false);
    expect(CALIBRATION_ACTIVATION_STATUS.validatedImprovement).toBe(true);
    expect(CALIBRATION_ACTIVATION_STATUS.requiredBeforeActivation).toMatch(/shadow validation/i);
  });

  it('the flag reflects intent only, and defaults off', () => {
    // Enabling the flag is a declaration of intent; it does not itself change any output.
    expect(isCalibrationEnabled({ [CALIBRATION_FLAG_ENV]: 'true' })).toBe(true);
    expect(isCalibrationEnabled({})).toBe(false);
  });
});

