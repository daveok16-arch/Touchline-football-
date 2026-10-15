/**
 * Project Touchline – Phase N calibration-only validation (RESEARCH ONLY)
 *
 * Question: does a single temperature scaling of POISSON_V1_FROZEN improve its
 * probability quality on unseen matches? Phase N does NOT touch Dixon–Coles, Elo,
 * xG, ensembles, bookmakers, or any new data source. It only calibrates the frozen
 * model's already-produced probabilities.
 *
 * Predeclared protocol (frozen BEFORE inspecting held-out results):
 *   - Prediction source: the untouched frozen engine via runBacktest (strictly-prior
 *     rolling tables per competition+season). No re-implementation.
 *   - Calibration window: season year 2023 (the earliest season) — every eligible
 *     frozen prediction. Its outcomes all precede every held-out forecast.
 *   - Held-out test: season years 2024 and 2025 — untouched during method selection.
 *   - Calibrator: ONE global temperature, grid search minimizing calibration log loss
 *     with a small ridge toward T=1. Range [0.5, 3.0], 500 steps, ridge 5e-4.
 *     No per-competition or per-season temperatures.
 *   - Primary metric RPS; secondary log loss, Brier, accuracy.
 *   - Paired chronological block bootstrap, seed 20261015, 2000 resamples, block 20,
 *     stratified by competition; block-size sensitivity reported.
 *
 * Usage: npx tsx scripts/run-calibration-validation.ts
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { Fixture } from '../src/types/football';
import { runBacktest } from '../src/services/predictionBacktest';
import {
  evaluateSamples,
  EvaluationSummary,
  Outcome,
  ProbabilityTriplet,
} from '../src/services/predictionMetrics';
import { fitTemperature, applyTemperature, TemperatureFit } from '../src/services/research/calibration';
import {
  PairedObservation,
  pairedBlockBootstrapFromScores,
  rankedProbabilityScore,
  PairedComparison,
} from '../src/services/research/researchMetrics';

const CACHE_DIR = path.resolve(process.cwd(), '.phase3-cache');
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;

const CALIBRATION_SEASON_PREFIX = '2023';
const BOOTSTRAP_SEED = 20261015;
const BOOTSTRAP_BLOCK = 20;
const BOOTSTRAP_RESAMPLES = 2000;

type ModelKey = 'frozen' | 'frozenCal' | 'baseline';

interface Rec {
  fixtureId: string;
  competitionCode: string;
  season: string;
  kickoffMs: number;
  outcome: Outcome;
  frozen: ProbabilityTriplet;
  baseline: ProbabilityTriplet;
  frozenCal?: ProbabilityTriplet;
}

function loadAll(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const comp of COMPETITIONS) {
    for (const season of SEASONS) {
      const f = path.join(CACHE_DIR, `${comp}-${season}.json`);
      if (!fs.existsSync(f)) continue;
      fixtures.push(...adaptFootballDataMatchesResponse(JSON.parse(fs.readFileSync(f, 'utf8'))));
    }
  }
  return fixtures;
}

function fmt(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function probsOf(r: Rec, key: ModelKey): ProbabilityTriplet {
  if (key === 'frozenCal') return r.frozenCal!;
  return r[key];
}

const rps = (p: ProbabilityTriplet, o: Outcome) => rankedProbabilityScore(p, o);
const logLoss = (p: ProbabilityTriplet, o: Outcome) =>
  -Math.log(Math.max([p.homeWin, p.draw, p.awayWin][o], 1e-15));
const brier = (p: ProbabilityTriplet, o: Outcome) => {
  const v = [p.homeWin, p.draw, p.awayWin];
  let s = 0;
  for (let k = 0; k < 3; k++) s += (v[k] - (k === o ? 1 : 0)) ** 2;
  return s;
};

function toSamples(records: Rec[], key: ModelKey) {
  return records.map((r) => ({
    probabilities: probsOf(r, key),
    outcome: r.outcome,
    competitionCode: r.competitionCode,
    season: r.season,
  }));
}

function meanMetric(records: Rec[], key: ModelKey, m: (p: ProbabilityTriplet, o: Outcome) => number): number {
  if (records.length === 0) return NaN;
  let s = 0;
  for (const r of records) s += m(probsOf(r, key), r.outcome);
  return s / records.length;
}

function printSummary(label: string, records: Rec[], key: ModelKey): void {
  const s = evaluateSamples(toSamples(records, key));
  console.log(
    `${label.padEnd(30)} n=${String(s.count).padStart(5)}  RPS=${fmt(meanMetric(records, key, rps), 5)}  logLoss=${fmt(s.logLoss)}  brier=${fmt(s.brier)}  acc=${fmt(s.accuracy, 3)}  pOutcome=${fmt(s.meanProbabilityOfOutcome, 3)}  sumP=${fmt(s.meanProbabilitySum, 4)}`
  );
}

function toPaired(records: Rec[], key: ModelKey): PairedObservation[] {
  return records.map((r) => ({
    probabilities: probsOf(r, key),
    outcome: r.outcome,
    kickoffMs: r.kickoffMs,
    competitionCode: r.competitionCode,
  }));
}

function compare(
  records: Rec[],
  aKey: ModelKey,
  bKey: ModelKey,
  metric: (p: ProbabilityTriplet, o: Outcome) => number,
  metricName: string,
  blockSize = BOOTSTRAP_BLOCK
): PairedComparison {
  const obs = toPaired(records, aKey);
  const scoreA = records.map((r) => metric(probsOf(r, aKey), r.outcome));
  const scoreB = records.map((r) => metric(probsOf(r, bKey), r.outcome));
  const res = pairedBlockBootstrapFromScores(obs, scoreA, scoreB, {
    seed: BOOTSTRAP_SEED,
    resamples: BOOTSTRAP_RESAMPLES,
    blockSize,
  });
  const verdict =
    res.ciHigh < 0 ? 'CI excludes 0 -> improvement' : res.ciLow > 0 ? 'CI excludes 0 -> worse' : 'CI includes 0 -> no reliable difference';
  console.log(
    `  ${`${aKey} vs ${bKey} [${metricName}]`.padEnd(30)} n=${res.n}  meanDiff=${fmt(res.meanDifference, 5)}  95%CI=[${fmt(res.ciLow, 5)}, ${fmt(res.ciHigh, 5)}]  P(A better)=${fmt(res.probABetter, 3)}  ${verdict}`
  );
  return res;
}

function printBands(label: string, records: Rec[], key: ModelKey): void {
  const s = evaluateSamples(toSamples(records, key));
  console.log(
    `  ${label} — ECE home=${fmt(s.calibration.home.expectedCalibrationError, 3)} draw=${fmt(s.calibration.draw.expectedCalibrationError, 3)} away=${fmt(s.calibration.away.expectedCalibrationError, 3)}`
  );
  for (const [name, cal] of [['home', s.calibration.home], ['draw', s.calibration.draw], ['away', s.calibration.away]] as const) {
    const rows = cal.bins
      .filter((b) => b.count > 0)
      .map((b) => `${b.lower.toFixed(1)}-${b.upper.toFixed(1)}:n=${b.count},pred=${fmt(b.meanPredicted, 2)},obs=${fmt(b.observedFrequency, 2)}`);
    console.log(`    ${name.padEnd(5)} ${rows.join('  ')}`);
  }
}

function main(): void {
  const fixtures = loadAll();
  console.log(`Loaded ${fixtures.length} historical fixtures from cache.`);
  console.log('Predeclared protocol: calibration on season 2023; held-out test on 2024 & 2025.');
  console.log('Model under test: POISSON_V1_FROZEN (untouched) + one global temperature.\n');

  const { records: rawRecords, exclusions, totalConsidered } = runBacktest(fixtures, { minHistory: 3 });
  const records: Rec[] = [];
  for (const r of rawRecords) {
    if (!r.eligible || r.outcome == null || !r.model || !r.leagueFrequency) continue;
    records.push({
      fixtureId: r.fixtureId,
      competitionCode: r.competitionCode,
      season: r.season,
      kickoffMs: r.kickoffMs,
      outcome: r.outcome,
      frozen: r.model,
      baseline: r.leagueFrequency,
    });
  }
  console.log('Exclusions (identical eligible set for all models):', JSON.stringify(exclusions));
  console.log(`  total considered: ${totalConsidered}  eligible: ${records.length}\n`);

  const calibRecords = records.filter((r) => r.season.startsWith(CALIBRATION_SEASON_PREFIX));
  const testRecords = records.filter((r) => !r.season.startsWith(CALIBRATION_SEASON_PREFIX));
  calibRecords.sort((a, b) => a.kickoffMs - b.kickoffMs || a.fixtureId.localeCompare(b.fixtureId));
  testRecords.sort((a, b) => a.kickoffMs - b.kickoffMs || a.fixtureId.localeCompare(b.fixtureId));

  const calibStart = new Date(calibRecords[0].kickoffMs).toISOString().slice(0, 10);
  const calibEnd = new Date(calibRecords[calibRecords.length - 1].kickoffMs).toISOString().slice(0, 10);
  const testStart = new Date(testRecords[0].kickoffMs).toISOString().slice(0, 10);
  const testEnd = new Date(testRecords[testRecords.length - 1].kickoffMs).toISOString().slice(0, 10);
  console.log(`Calibration window: ${calibRecords.length} predictions, ${calibStart} .. ${calibEnd}`);
  console.log(`Held-out test:      ${testRecords.length} predictions, ${testStart} .. ${testEnd}\n`);

  // --- Fit ONE global temperature on the calibration window only ---
  const fit: TemperatureFit = fitTemperature(
    calibRecords.map((r) => r.frozen),
    calibRecords.map((r) => r.outcome)
  );
  console.log('=== FITTED CALIBRATOR (frozen model) ===');
  console.log(`  temperature T=${fmt(fit.temperature, 4)}  (range [${fit.searchMin}, ${fit.searchMax}], ${fit.steps} steps, ridge ${fit.ridge})`);
  console.log(`  calibration n=${fit.calibrationCount}  logLoss before=${fmt(fit.logLossBefore, 5)} after=${fmt(fit.logLossAfter, 5)}\n`);

  for (const r of records) r.frozenCal = applyTemperature(r.frozen, fit.temperature);

  // --- Held-out metrics ---
  console.log('=== HELD-OUT TEST (2024 & 2025), identical eligible fixtures ===');
  printSummary('Frozen (uncalibrated)', testRecords, 'frozen');
  printSummary('Frozen + temperature', testRecords, 'frozenCal');
  printSummary('League-frequency base', testRecords, 'baseline');

  console.log('\n=== PAIRED COMPARISONS (calibrated vs uncalibrated frozen) ===');
  compare(testRecords, 'frozenCal', 'frozen', rps, 'rps');
  compare(testRecords, 'frozenCal', 'frozen', logLoss, 'logloss');
  compare(testRecords, 'frozenCal', 'frozen', brier, 'brier');

  console.log('\n=== BY COMPETITION (held-out) ===');
  for (const comp of COMPETITIONS) {
    const recs = testRecords.filter((r) => r.competitionCode === comp);
    if (recs.length === 0) continue;
    console.log(`  ${comp} (n=${recs.length}):`);
    printSummary('    frozen', recs, 'frozen');
    printSummary('    frozenCal', recs, 'frozenCal');
    printSummary('    baseline', recs, 'baseline');
    compare(recs, 'frozenCal', 'frozen', rps, 'rps');
    compare(recs, 'frozenCal', 'frozen', logLoss, 'logloss');
  }

  console.log('\n=== BY HELD-OUT SEASON ===');
  for (const season of ['2024/25', '2025/26']) {
    const recs = testRecords.filter((r) => r.season === season);
    if (recs.length === 0) continue;
    console.log(`  ${season} (n=${recs.length}):`);
    printSummary('    frozen', recs, 'frozen');
    printSummary('    frozenCal', recs, 'frozenCal');
    compare(recs, 'frozenCal', 'frozen', rps, 'rps');
    compare(recs, 'frozenCal', 'frozen', logLoss, 'logloss');
  }

  console.log('\n=== CALIBRATION BANDS (held-out) ===');
  printBands('frozen', testRecords, 'frozen');
  printBands('frozenCal', testRecords, 'frozenCal');

  console.log('\n=== HIGH-PROBABILITY BAND 0.8-1.0 (held-out) ===');
  console.log('  (a) Re-binned after calibration (composition changes):');
  for (const key of ['frozen', 'frozenCal'] as ModelKey[]) {
    const s = evaluateSamples(toSamples(testRecords, key));
    for (const [name, cal] of [['home', s.calibration.home], ['draw', s.calibration.draw], ['away', s.calibration.away]] as const) {
      const hi = cal.bins.filter((b) => b.lower >= 0.8 && b.count > 0);
      const count = hi.reduce((a, b) => a + b.count, 0);
      const gap = hi.reduce((a, b) => a + b.count * (b.meanPredicted - b.observedFrequency), 0);
      console.log(`    ${key.padEnd(9)} ${name.padEnd(5)} n>=0.8: ${count}  mean(pred-obs)=${count > 0 ? fmt(gap / count, 3) : 'n/a'}`);
    }
  }

  // (b) Fixed-set analysis: the same fixtures the UNCALIBRATED model rated >= 0.8.
  // This isolates the calibration effect from the composition change caused by re-binning.
  console.log('  (b) Fixed set: fixtures the uncalibrated model rated >= 0.8, before vs after calibration:');
  const classes: [string, (p: ProbabilityTriplet) => number, Outcome][] = [
    ['home', (p) => p.homeWin, 0],
    ['draw', (p) => p.draw, 1],
    ['away', (p) => p.awayWin, 2],
  ];
  for (const [name, get, cls] of classes) {
    const subset = testRecords.filter((r) => get(r.frozen) >= 0.8);
    if (subset.length === 0) {
      console.log(`    ${name.padEnd(5)} n>=0.8: 0`);
      continue;
    }
    let frozenPred = 0;
    let calPred = 0;
    let observed = 0;
    for (const r of subset) {
      frozenPred += get(r.frozen);
      calPred += get(r.frozenCal!);
      observed += r.outcome === cls ? 1 : 0;
    }
    const n = subset.length;
    console.log(
      `    ${name.padEnd(5)} n=${n}  observed=${fmt(observed / n, 3)}  frozenPred=${fmt(frozenPred / n, 3)} (gap ${fmt((frozenPred - observed) / n, 3)})  calPred=${fmt(calPred / n, 3)} (gap ${fmt((calPred - observed) / n, 3)})`
    );
  }

  // Paired RPS restricted to the high-confidence fixtures (frozen max prob >= 0.8).
  const highConf = testRecords.filter((r) => Math.max(r.frozen.homeWin, r.frozen.draw, r.frozen.awayWin) >= 0.8);
  if (highConf.length > 0) {
    console.log(`  Paired RPS on high-confidence fixtures (n=${highConf.length}):`);
    compare(highConf, 'frozenCal', 'frozen', rps, 'rps');
    compare(highConf, 'frozenCal', 'frozen', logLoss, 'logloss');
  }

  console.log('\n=== BOOTSTRAP BLOCK-SIZE SENSITIVITY (RPS, frozenCal vs frozen) ===');
  for (const bs of [1, 5, 10, 20, 40, 80]) {
    compare(testRecords, 'frozenCal', 'frozen', rps, 'rps', bs);
  }

  console.log('\n=== CALIBRATION STABILITY: temperature by chronological fold within 2023 ===');
  const nFolds = 4;
  for (let i = 0; i < nFolds; i++) {
    const lo = Math.floor((calibRecords.length * i) / nFolds);
    const hi = Math.floor((calibRecords.length * (i + 1)) / nFolds);
    const fold = calibRecords.slice(lo, hi);
    const f = fitTemperature(fold.map((r) => r.frozen), fold.map((r) => r.outcome));
    const fs = new Date(fold[0].kickoffMs).toISOString().slice(0, 10);
    const fe = new Date(fold[fold.length - 1].kickoffMs).toISOString().slice(0, 10);
    console.log(`  fold ${i + 1} (n=${fold.length}, ${fs}..${fe}): T=${fmt(f.temperature, 4)}  logLoss ${fmt(f.logLossBefore, 5)} -> ${fmt(f.logLossAfter, 5)}`);
  }

  console.log('\n=== EXPANDING-WINDOW REFIT (stability check; calibrator always strictly earlier) ===');
  // Fold A: fit on 2023 -> test 2024/25
  const tA = fitTemperature(calibRecords.map((r) => r.frozen), calibRecords.map((r) => r.outcome));
  const s24 = testRecords.filter((r) => r.season === '2024/25');
  const s25 = testRecords.filter((r) => r.season === '2025/26');
  const tB = fitTemperature(
    [...calibRecords, ...s24].map((r) => r.frozen),
    [...calibRecords, ...s24].map((r) => r.outcome)
  );
  console.log(`  fit on 2023            -> T=${fmt(tA.temperature, 4)}  applied to 2024/25`);
  console.log(`  fit on 2023+2024/25    -> T=${fmt(tB.temperature, 4)}  applied to 2025/26`);
  const applyAndScore = (recs: Rec[], t: number, key: 'frozen' | 'cal') => {
    let rp = 0;
    let ll = 0;
    for (const r of recs) {
      const p = key === 'cal' ? applyTemperature(r.frozen, t) : r.frozen;
      rp += rps(p, r.outcome);
      ll += logLoss(p, r.outcome);
    }
    return { rps: rp / recs.length, ll: ll / recs.length };
  };
  const a24 = applyAndScore(s24, tA.temperature, 'cal');
  const a25 = applyAndScore(s25, tB.temperature, 'cal');
  console.log(`  2024/25 out-of-sample: RPS ${fmt(a24.rps, 5)}  logLoss ${fmt(a24.ll, 5)}`);
  console.log(`  2025/26 out-of-sample: RPS ${fmt(a25.rps, 5)}  logLoss ${fmt(a25.ll, 5)}`);

  console.log('\n=== REPRODUCIBILITY ANCHOR ===');
  console.log(`  seed=${BOOTSTRAP_SEED} block=${BOOTSTRAP_BLOCK} resamples=${BOOTSTRAP_RESAMPLES} T=${fmt(fit.temperature, 6)}`);
}

main();
