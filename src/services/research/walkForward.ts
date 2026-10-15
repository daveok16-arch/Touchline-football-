/**
 * Project Touchline – Phase M walk-forward harness (RESEARCH ONLY)
 *
 * Runs four forecasters over the same historical matches with strictly-prior
 * features and produces per-fixture probabilities for paired comparison:
 *   1. POISSON_V1_FROZEN  (via the existing, untouched runBacktest)
 *   2. League-frequency baseline (via the existing, untouched runBacktest)
 *   3. Dixon–Coles challenger (this module, warm-started per-day refit)
 *   4. Dixon–Coles + temperature calibration (fitted on a separate earlier window)
 *
 * Leakage discipline:
 *   - Matches are processed strictly by kickoff time within each competition+season.
 *   - Frozen/baseline features come from runBacktest (strictly-prior rolling tables).
 *   - DC parameters are fitted ONLY on matches whose kickoff is strictly before the
 *     calendar day being predicted. No same-day information is used by DC (a strictly
 *     conservative choice relative to the frozen per-match cutoff).
 *   - The temperature calibrator is fitted ONLY on development-period predictions.
 */

import { Fixture } from '../../types/football';
import { Outcome, ProbabilityTriplet } from '../predictionMetrics';
import {
  runBacktest,
  toHistoricalRecords,
  HistoricalMatchRecord,
  ExclusionReason,
} from '../predictionBacktest';
import {
  DCConfig,
  DCMatch,
  DCParams,
  DEFAULT_DC_CONFIG,
  fitDixonColes,
  predictDixonColes,
} from './dixonColes';
import { TemperatureFit, fitTemperature } from './calibration';

export interface WalkForwardRecord {
  fixtureId: string;
  competitionCode: string;
  season: string;
  kickoffMs: number;
  outcome: Outcome;
  frozen?: ProbabilityTriplet;
  baseline?: ProbabilityTriplet;
  dc?: ProbabilityTriplet;
  /** Which models failed to produce a valid prediction for this fixture. */
  failures: string[];
}

export interface WalkForwardResult {
  records: WalkForwardRecord[];
  exclusions: Record<ExclusionReason, number>;
  totalConsidered: number;
  dcFitFailures: number;
  dcNonConverged: number;
}

export interface HarnessOptions {
  dcConfig?: DCConfig;
  /** Refit DC once per calendar day (UTC) inside each bucket. */
  minHistory?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * Produces DC predictions for every finished match with strictly-prior history.
 * A fresh deterministic fit is performed once per calendar day (UTC) using only
 * matches that kicked off strictly before that day, keeping the cost bounded while
 * remaining leakage-free.
 */
export function runDixonColesWalkForward(
  fixtures: Fixture[],
  config: DCConfig
): { predictions: Map<string, ProbabilityTriplet>; fitFailures: number; nonConverged: number } {
  const allRecords = toHistoricalRecords(fixtures);
  const byBucket = new Map<string, HistoricalMatchRecord[]>();
  for (const rec of allRecords) {
    const key = `${rec.competitionCode}::${rec.season}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key)!.push(rec);
  }

  const predictions = new Map<string, ProbabilityTriplet>();
  let fitFailures = 0;
  let nonConverged = 0;

  for (const bucketKey of [...byBucket.keys()].sort()) {
    const bucket = byBucket.get(bucketKey)!; // chronological (toHistoricalRecords sorts)
    const usable = bucket.filter(
      (r) => !isNaN(r.kickoffMs) && r.fixture.status === 'FINISHED' && r.outcome != null
    );

    // Group usable matches by UTC day; fit once per day on all strictly-prior matches.
    const byDay = new Map<number, HistoricalMatchRecord[]>();
    for (const r of usable) {
      const k = dayKey(r.kickoffMs);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(r);
    }

    const dayKeys = [...byDay.keys()].sort((a, b) => a - b);

    let params: DCParams | null = null;

    for (const dk of dayKeys) {
      const dayStartMs = dk * DAY_MS;
      const trainMatches: DCMatch[] = usable
        .filter((r) => r.kickoffMs < dayStartMs)
        .map((r) => ({
          homeTeamId: r.homeTeamId,
          awayTeamId: r.awayTeamId,
          homeGoals: r.homeGoals as number,
          awayGoals: r.awayGoals as number,
          kickoffMs: r.kickoffMs,
        }));

      if (trainMatches.length > 0) {
        try {
          params = fitDixonColes(trainMatches, dayStartMs, config);
          if (!params.converged) nonConverged++;
        } catch {
          fitFailures++;
          params = null;
        }
      }

      const dayRecords = byDay.get(dk)!;
      for (const r of dayRecords) {
        if (!params) continue;
        const pred = predictDixonColes(params, r.homeTeamId, r.awayTeamId, config);
        if (pred) {
          predictions.set(r.fixture.id, {
            homeWin: pred.homeWin,
            draw: pred.draw,
            awayWin: pred.awayWin,
          });
        }
      }
    }
  }

  return { predictions, fitFailures, nonConverged };
}

/**
 * Runs all four forecasters over the same fixtures. The frozen model and baseline
 * come from the untouched runBacktest; DC is added on top. Every finished match with
 * a score is a candidate; per-model failures are recorded rather than hidden.
 */
export function runWalkForward(fixtures: Fixture[], options: HarnessOptions = {}): WalkForwardResult {
  const dcConfig = options.dcConfig ?? DEFAULT_DC_CONFIG;
  const { records: frozenRecords, exclusions, totalConsidered } = runBacktest(fixtures, {
    minHistory: options.minHistory ?? dcConfig.minHistory,
  });

  const { predictions: dcPreds, fitFailures, nonConverged } = runDixonColesWalkForward(
    fixtures,
    dcConfig
  );

  const records: WalkForwardRecord[] = [];
  for (const r of frozenRecords) {
    if (!r.eligible || r.outcome == null) continue;
    const failures: string[] = [];
    if (!r.model) failures.push('frozen');
    if (!r.leagueFrequency) failures.push('baseline');
    const dc = dcPreds.get(r.fixtureId);
    if (!dc) failures.push('dc');
    records.push({
      fixtureId: r.fixtureId,
      competitionCode: r.competitionCode,
      season: r.season,
      kickoffMs: r.kickoffMs,
      outcome: r.outcome,
      frozen: r.model,
      baseline: r.leagueFrequency,
      dc,
      failures,
    });
  }

  return {
    records,
    exclusions,
    totalConsidered,
    dcFitFailures: fitFailures,
    dcNonConverged: nonConverged,
  };
}

/** Returns only records where every named model produced a prediction (paired set). */
export function pairedSubset(
  records: WalkForwardRecord[],
  models: (keyof Pick<WalkForwardRecord, 'frozen' | 'baseline' | 'dc'>)[]
): WalkForwardRecord[] {
  return records.filter((r) => models.every((m) => r[m] !== undefined));
}

export interface DCTuningResult {
  decay: number;
  regularization: number;
  rho: number;
  meanRps: number;
  meanLogLoss: number;
  count: number;
}

/**
 * Small, predeclared grid over decay, regularization and rho, scored by mean RPS on
 * a development slice only. Returns every grid point so sensitivity can be reported.
 * Only the DC walk-forward is run per grid point (the frozen/baseline models do not
 * depend on these hyperparameters).
 */
export function tuneDixonColes(
  fixtures: Fixture[],
  grid: { decay: number[]; regularization: number[]; rho: number[] },
  selectDevelopment: (rec: WalkForwardRecord[]) => WalkForwardRecord[],
  baseConfig: DCConfig = DEFAULT_DC_CONFIG,
  onPoint?: (r: DCTuningResult) => void
): DCTuningResult[] {
  // Precompute the full record skeleton once; DC predictions are filled per grid point.
  const { records: frozenRecords } = runBacktest(fixtures, { minHistory: baseConfig.minHistory });
  const base: WalkForwardRecord[] = [];
  for (const r of frozenRecords) {
    if (!r.eligible || r.outcome == null) continue;
    base.push({
      fixtureId: r.fixtureId,
      competitionCode: r.competitionCode,
      season: r.season,
      kickoffMs: r.kickoffMs,
      outcome: r.outcome,
      frozen: r.model,
      baseline: r.leagueFrequency,
      failures: [],
    });
  }

  const results: DCTuningResult[] = [];
  for (const decay of grid.decay) {
    for (const regularization of grid.regularization) {
      for (const rho of grid.rho) {
        const cfg: DCConfig = { ...baseConfig, decay, regularization, rho };
        const { predictions } = runDixonColesWalkForward(fixtures, cfg);
        const withDc = base.map((r) => ({ ...r, dc: predictions.get(r.fixtureId) }));
        const dev = selectDevelopment(withDc).filter((r) => r.dc);
        if (dev.length === 0) continue;
        let rps = 0;
        let ll = 0;
        for (const r of dev) {
          rps += rpsOf(r.dc!, r.outcome);
          ll += logLossOf(r.dc!, r.outcome);
        }
        results.push({
          decay,
          regularization,
          rho,
          meanRps: rps / dev.length,
          meanLogLoss: ll / dev.length,
          count: dev.length,
        });
        if (onPoint) onPoint(results[results.length - 1]);
      }
    }
  }
  return results;
}

// Local, dependency-free scoring used only inside tuning (avoids a circular import).
function rpsOf(p: ProbabilityTriplet, outcome: Outcome): number {
  const ph = p.homeWin;
  const pd = p.draw;
  const yh = outcome === 0 ? 1 : 0;
  const yd = outcome === 1 ? 1 : 0;
  return 0.5 * ((ph - yh) ** 2 + (ph + pd - yh - yd) ** 2);
}

function logLossOf(p: ProbabilityTriplet, outcome: Outcome): number {
  const probs = [p.homeWin, p.draw, p.awayWin];
  return -Math.log(Math.max(probs[outcome], 1e-15));
}

export { fitTemperature };
export type { TemperatureFit };
