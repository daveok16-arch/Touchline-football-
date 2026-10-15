/**
 * Project Touchline – Phase M walk-forward evaluation runner (RESEARCH ONLY)
 *
 * Compares four forecasters over the local historical cache:
 *   frozen Poisson, league-frequency baseline, Dixon–Coles, Dixon–Coles + calibration.
 *
 * Read-only with respect to the app: it never changes production code paths and never
 * touches the frozen model. Deterministic and reproducible.
 *
 * Usage:
 *   npx tsx scripts/run-walkforward-evaluation.ts
 *   npx tsx scripts/run-walkforward-evaluation.ts --tune
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { Fixture } from '../src/types/football';
import { evaluateSamples, EvaluationSummary, ProbabilityTriplet, Outcome } from '../src/services/predictionMetrics';
import { DCConfig, DEFAULT_DC_CONFIG } from '../src/services/research/dixonColes';
import { runWalkForward, WalkForwardRecord, pairedSubset, tuneDixonColes } from '../src/services/research/walkForward';
import { fitTemperature, applyTemperature, TemperatureFit } from '../src/services/research/calibration';
import {
  PairedObservation,
  pairedBlockBootstrapFromScores,
  rankedProbabilityScore,
  scoreAll,
  rpsScorer,
  PairedComparison,
} from '../src/services/research/researchMetrics';

const CACHE_DIR = path.resolve(process.cwd(), '.phase3-cache');
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;

const DEV_SEASON_PREFIX = '2023'; // development period
const CALIBRATION_FRACTION_OF_DEV = 0.6; // earliest 60% of dev predictions calibrate
const BOOTSTRAP_SEED = 20261015;
const BOOTSTRAP_BLOCK = 20;
const BOOTSTRAP_RESAMPLES = 2000;

type ModelKey = 'frozen' | 'baseline' | 'dc' | 'dcCal' | 'frozenCal';

function probsOf(r: WalkForwardRecord, key: ModelKey): ProbabilityTriplet | undefined {
  const extra = r as unknown as Record<string, ProbabilityTriplet>;
  if (key === 'dcCal') return extra.dcCal;
  if (key === 'frozenCal') return extra.frozenCal;
  return r[key] as ProbabilityTriplet | undefined;
}

function logLossOf(p: ProbabilityTriplet, outcome: Outcome): number {
  const probs = [p.homeWin, p.draw, p.awayWin];
  return -Math.log(Math.max(probs[outcome], 1e-15));
}

function brierOf(p: ProbabilityTriplet, outcome: Outcome): number {
  const probs = [p.homeWin, p.draw, p.awayWin];
  let s = 0;
  for (let k = 0; k < 3; k++) s += (probs[k] - (k === outcome ? 1 : 0)) ** 2;
  return s;
}

type Metric = 'rps' | 'logloss' | 'brier';
function scorerFor(metric: Metric) {
  if (metric === 'rps') return (p: ProbabilityTriplet, o: Outcome) => rankedProbabilityScore(p, o);
  if (metric === 'logloss') return logLossOf;
  return brierOf;
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

function toSamples(records: WalkForwardRecord[], key: ModelKey) {
  const out = [];
  for (const r of records) {
    const p = probsOf(r, key);
    if (!p) continue;
    out.push({ probabilities: p, outcome: r.outcome, competitionCode: r.competitionCode, season: r.season });
  }
  return out;
}

function meanRps(records: WalkForwardRecord[], key: ModelKey): number {
  let s = 0;
  let n = 0;
  for (const r of records) {
    const p = probsOf(r, key);
    if (!p) continue;
    s += rankedProbabilityScore(p, r.outcome);
    n++;
  }
  return n > 0 ? s / n : NaN;
}

function printCalibration(label: string, s: EvaluationSummary): void {
  console.log(
    `  Calibration (${label}) — ECE home=${fmt(s.calibration.home.expectedCalibrationError, 3)} draw=${fmt(s.calibration.draw.expectedCalibrationError, 3)} away=${fmt(s.calibration.away.expectedCalibrationError, 3)}`
  );
  for (const [name, cal] of [['home', s.calibration.home], ['draw', s.calibration.draw], ['away', s.calibration.away]] as const) {
    const rows = cal.bins
      .filter((b) => b.count > 0)
      .map((b) => `${b.lower.toFixed(1)}-${b.upper.toFixed(1)}:n=${b.count},pred=${fmt(b.meanPredicted, 2)},obs=${fmt(b.observedFrequency, 2)}`);
    console.log(`    ${name.padEnd(5)} ${rows.join('  ')}`);
  }
}

function printComparison(label: string, cmp: PairedComparison): void {
  const verdict =
    cmp.ciHigh < 0
      ? 'CI excludes 0 -> improvement'
      : cmp.ciLow > 0
      ? 'CI excludes 0 -> worse'
      : 'CI includes 0 -> no reliable difference';
  console.log(
    `${label.padEnd(20)} n=${cmp.n}  meanDiff(A-B)=${fmt(cmp.meanDifference, 5)}  95%CI=[${fmt(cmp.ciLow, 5)}, ${fmt(cmp.ciHigh, 5)}]  P(A better)=${fmt(cmp.probABetter, 3)}  ${verdict}`
  );
}

function comparePair(
  paired: WalkForwardRecord[],
  aKey: ModelKey,
  bKey: ModelKey,
  label: string,
  metric: Metric = 'rps'
): PairedComparison {
  const scorer = scorerFor(metric);
  const observations: PairedObservation[] = paired.map((r) => ({
    probabilities: probsOf(r, aKey)!,
    outcome: r.outcome,
    kickoffMs: r.kickoffMs,
    competitionCode: r.competitionCode,
  }));
  const scoreA = observations.map((o) => scorer(o.probabilities, o.outcome));
  const scoreB = paired.map((r) => scorer(probsOf(r, bKey)!, r.outcome));
  const res = pairedBlockBootstrapFromScores(observations, scoreA, scoreB, {
    seed: BOOTSTRAP_SEED,
    resamples: BOOTSTRAP_RESAMPLES,
    blockSize: BOOTSTRAP_BLOCK,
  });
  printComparison(`${label} [${metric}]`, res);
  return res;
}

function main(): void {
  const doTune = process.argv.includes('--tune');
  const fixtures = loadAll();
  console.log(`Loaded ${fixtures.length} historical fixtures from cache.`);
  console.log(`Split: development = season year ${DEV_SEASON_PREFIX}; held-out test = 2024 & 2025.\n`);

  let dcConfig: DCConfig = { ...DEFAULT_DC_CONFIG };

  if (doTune) {
    console.log('=== HYPERPARAMETER TUNING (development period only: season year 2023) ===');
    // Small, predeclared grid. Only the DC walk-forward is re-run per point.
    const grid = {
      decay: [0, 0.0018, 0.0037, 0.0055, 0.011],
      regularization: [0.01, 0.05],
      rho: [-0.05, 0.0],
    };
    // The 2023 season is the earliest bucket, so restricting the tuning fixtures to it
    // yields identical development predictions while cutting the search cost.
    const devFixtures = fixtures.filter((f) => (f.competition?.season || '').startsWith(DEV_SEASON_PREFIX));
    const tuneStart = Date.now();
    let pointsDone = 0;
    const total = grid.decay.length * grid.regularization.length * grid.rho.length;
    const results = tuneDixonColes(devFixtures, grid, (recs) => recs, dcConfig, (r) => {
      pointsDone++;
      console.log(`    [${pointsDone}/${total}] decay=${r.decay} reg=${r.regularization} rho=${r.rho} devRPS=${fmt(r.meanRps, 5)} n=${r.count}`);
    });
    console.log(`  grid points evaluated: ${results.length}  (elapsed ${((Date.now() - tuneStart) / 1000).toFixed(1)}s)`);
    results.sort((a, b) => a.meanRps - b.meanRps);
    console.log('  top 5 by development RPS:');
    for (const r of results.slice(0, 5)) {
      console.log(`    decay=${r.decay} reg=${r.regularization} rho=${r.rho}  devRPS=${fmt(r.meanRps, 5)}  devLogLoss=${fmt(r.meanLogLoss, 4)}  n=${r.count}`);
    }
    const best = results[0];
    if (best) {
      dcConfig = { ...dcConfig, decay: best.decay, regularization: best.regularization, rho: best.rho };
      console.log(`  selected: decay=${best.decay} reg=${best.regularization} rho=${best.rho}\n`);
    }
  } else {
    // Frozen, predeclared hyperparameters selected on the development period only
    // (see --tune). Hard-coded here so the default run is reproducible.
    dcConfig = { ...dcConfig, decay: 0, regularization: 0.05, rho: -0.05 };
    console.log(`Using predeclared tuned DC config (selected on dev period 2023): decay=${dcConfig.decay} reg=${dcConfig.regularization} rho=${dcConfig.rho}\n`);
  }

  const t0 = Date.now();
  const wf = runWalkForward(fixtures, { dcConfig });
  console.log(`Walk-forward complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  records: ${wf.records.length}  dcFitFailures: ${wf.dcFitFailures}  dcNonConverged: ${wf.dcNonConverged}`);
  console.log('  exclusions:', JSON.stringify(wf.exclusions));

  // Fit temperature on the EARLIEST part of the development period only.
  const devRecords = wf.records.filter((r) => r.season.startsWith(DEV_SEASON_PREFIX) && r.dc && r.frozen);
  devRecords.sort((a, b) => a.kickoffMs - b.kickoffMs || a.fixtureId.localeCompare(b.fixtureId));
  const calN = Math.floor(devRecords.length * CALIBRATION_FRACTION_OF_DEV);
  const calibSet = devRecords.slice(0, calN);
  const tempFitDC: TemperatureFit = fitTemperature(
    calibSet.map((r) => r.dc!),
    calibSet.map((r) => r.outcome)
  );
  // CONTROL: fit the identical calibrator on the frozen model's own dev predictions.
  const tempFitFrozen: TemperatureFit = fitTemperature(
    calibSet.map((r) => r.frozen!),
    calibSet.map((r) => r.outcome)
  );
  console.log(`\nCalibration (temperature scaling) fitted on ${tempFitDC.calibrationCount} development predictions (earliest ${Math.round(CALIBRATION_FRACTION_OF_DEV * 100)}% of season 2023)`);
  console.log(`  DC:     T=${fmt(tempFitDC.temperature, 4)}  calibLogLoss before=${fmt(tempFitDC.logLossBefore, 5)} after=${fmt(tempFitDC.logLossAfter, 5)}`);
  console.log(`  Frozen: T=${fmt(tempFitFrozen.temperature, 4)}  calibLogLoss before=${fmt(tempFitFrozen.logLossBefore, 5)} after=${fmt(tempFitFrozen.logLossAfter, 5)}\n`);

  for (const r of wf.records) {
    const extra = r as unknown as Record<string, ProbabilityTriplet>;
    if (r.dc) extra.dcCal = applyTemperature(r.dc, tempFitDC.temperature);
    if (r.frozen) extra.frozenCal = applyTemperature(r.frozen, tempFitFrozen.temperature);
  }

  const testRecords = wf.records.filter((r) => !r.season.startsWith(DEV_SEASON_PREFIX));
  const paired = pairedSubset(testRecords, ['frozen', 'baseline', 'dc']);
  console.log('=== HELD-OUT TEST (season years 2024 & 2025) ===');
  console.log(`  test records: ${testRecords.length}  paired (frozen+baseline+dc): ${paired.length}\n`);

  console.log('--- Metric summary (RPS is primary; identical paired fixtures) ---');
  for (const [label, key] of [
    ['Frozen Poisson V1', 'frozen'],
    ['Frozen + calibration (control)', 'frozenCal'],
    ['League-frequency baseline', 'baseline'],
    ['Dixon-Coles (raw)', 'dc'],
    ['Dixon-Coles + calibration', 'dcCal'],
  ] as const) {
    const s = evaluateSamples(toSamples(paired, key));
    console.log(
      `${label.padEnd(30)} n=${String(s.count).padStart(5)}  RPS=${fmt(meanRps(paired, key), 5)}  logLoss=${fmt(s.logLoss)}  brier=${fmt(s.brier)}  acc=${fmt(s.accuracy, 3)}  pOutcome=${fmt(s.meanProbabilityOfOutcome, 3)}  sumP=${fmt(s.meanProbabilitySum, 4)}`
    );
  }

  console.log(`\n--- Paired comparisons (chronological block bootstrap seed=${BOOTSTRAP_SEED}, block=${BOOTSTRAP_BLOCK}, resamples=${BOOTSTRAP_RESAMPLES}) ---`);
  console.log('    meanDiff = A - B; negative means A scores better (lower is worse metric).');
  comparePair(paired, 'dc', 'frozen', 'DC vs Frozen', 'rps');
  comparePair(paired, 'dcCal', 'frozen', 'DC+Cal vs Frozen', 'rps');
  comparePair(paired, 'dcCal', 'dc', 'DC+Cal vs DC', 'rps');
  comparePair(paired, 'dcCal', 'frozenCal', 'DC+Cal vs Frozen+Cal (control)', 'rps');
  comparePair(paired, 'dcCal', 'frozen', 'DC+Cal vs Frozen', 'logloss');
  comparePair(paired, 'dcCal', 'frozenCal', 'DC+Cal vs Frozen+Cal (control)', 'logloss');
  comparePair(paired, 'dc', 'baseline', 'DC vs Baseline', 'rps');
  comparePair(paired, 'frozen', 'baseline', 'Frozen vs Baseline', 'rps');

  console.log('\n--- Block-size sensitivity (DC vs Frozen) ---');
  const obsDc: PairedObservation[] = paired.map((r) => ({
    probabilities: probsOf(r, 'dc')!,
    outcome: r.outcome,
    kickoffMs: r.kickoffMs,
    competitionCode: r.competitionCode,
  }));
  const sDc = scoreAll(obsDc, rpsScorer);
  const sFrozen = paired.map((r) => rankedProbabilityScore(probsOf(r, 'frozen')!, r.outcome));
  for (const bs of [1, 5, 10, 20, 40, 80]) {
    const res = pairedBlockBootstrapFromScores(obsDc, sDc, sFrozen, { seed: BOOTSTRAP_SEED, resamples: BOOTSTRAP_RESAMPLES, blockSize: bs });
    console.log(`    block=${String(bs).padStart(2)}  meanDiff=${fmt(res.meanDifference, 5)}  95%CI=[${fmt(res.ciLow, 5)}, ${fmt(res.ciHigh, 5)}]  P(A better)=${fmt(res.probABetter, 3)}`);
  }

  console.log('\n--- By competition (held-out, paired) ---');
  for (const comp of ['PL', 'PD', 'SA', 'CL']) {
    const compRecords = paired.filter((r) => r.competitionCode === comp);
    if (compRecords.length === 0) continue;
    console.log(`  ${comp} (n=${compRecords.length}):`);
    for (const [label, key] of [['frozen', 'frozen'], ['frozenCal', 'frozenCal'], ['baseline', 'baseline'], ['dc', 'dc'], ['dcCal', 'dcCal']] as const) {
      const s = evaluateSamples(toSamples(compRecords, key));
      console.log(`    ${label.padEnd(10)} RPS=${fmt(meanRps(compRecords, key), 5)}  logLoss=${fmt(s.logLoss)}  brier=${fmt(s.brier)}  acc=${fmt(s.accuracy, 3)}`);
    }
  }

  console.log('\n--- By competition + season (held-out, paired) ---');
  const keys = [...new Set(paired.map((r) => `${r.competitionCode} ${r.season}`))].sort();
  for (const k of keys) {
    const recs = paired.filter((r) => `${r.competitionCode} ${r.season}` === k);
    console.log(`  ${k} (n=${recs.length}): frozen RPS=${fmt(meanRps(recs, 'frozen'), 5)}  baseline RPS=${fmt(meanRps(recs, 'baseline'), 5)}  dc RPS=${fmt(meanRps(recs, 'dc'), 5)}  dcCal RPS=${fmt(meanRps(recs, 'dcCal'), 5)}`);
  }

  console.log('\n--- Calibration diagnostics (held-out) ---');
  printCalibration('frozen', evaluateSamples(toSamples(paired, 'frozen')));
  printCalibration('dc raw', evaluateSamples(toSamples(paired, 'dc')));
  printCalibration('dc calibrated', evaluateSamples(toSamples(paired, 'dcCal')));
}

main();
