/**
 * Project Touchline – Phase 3 evaluation runner (manual, read-only)
 *
 * Reads the gitignored historical cache under `.phase3-cache/`, replays the FROZEN
 * Poisson model chronologically, and prints log loss / Brier / accuracy / calibration
 * against baselines. It does not modify the model or any app code.
 *
 * Usage:  npx tsx scripts/run-evaluation.ts
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { runBacktest, toEvaluationSamples } from '../src/services/predictionBacktest';
import { evaluateSamples, groupSamples, EvaluationSummary } from '../src/services/predictionMetrics';
import { Fixture } from '../src/types/football';

const CACHE_DIR = path.resolve(process.cwd(), '.phase3-cache');
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;

function loadAll(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const comp of COMPETITIONS) {
    for (const season of [2023, 2024, 2025]) {
      const f = path.join(CACHE_DIR, `${comp}-${season}.json`);
      if (!fs.existsSync(f)) continue;
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      fixtures.push(...adaptFootballDataMatchesResponse(data));
    }
  }
  return fixtures;
}

function fmt(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function printSummary(label: string, s: EvaluationSummary) {
  console.log(
    `${label.padEnd(26)} n=${String(s.count).padStart(5)}  logLoss=${fmt(s.logLoss)}  brier=${fmt(
      s.brier
    )}  acc=${fmt(s.accuracy, 3)}  pOutcome=${fmt(s.meanProbabilityOfOutcome, 3)}  sumP=${fmt(
      s.meanProbabilitySum,
      4
    )}`
  );
}

function printCalibration(label: string, s: EvaluationSummary) {
  console.log(`\n  Calibration (${label}) — ECE home=${fmt(s.calibration.home.expectedCalibrationError, 3)} draw=${fmt(
    s.calibration.draw.expectedCalibrationError,
    3
  )} away=${fmt(s.calibration.away.expectedCalibrationError, 3)}`);
  for (const [name, cal] of [
    ['home', s.calibration.home],
    ['draw', s.calibration.draw],
    ['away', s.calibration.away],
  ] as const) {
    const rows = cal.bins
      .filter((b) => b.count > 0)
      .map((b) => `${b.lower.toFixed(1)}-${b.upper.toFixed(1)}:n=${b.count},pred=${fmt(b.meanPredicted, 2)},obs=${fmt(b.observedFrequency, 2)}`);
    console.log(`    ${name.padEnd(5)} ${rows.join('  ')}`);
  }
}

function main() {
  const fixtures = loadAll();
  console.log(`Loaded ${fixtures.length} historical fixtures from cache.\n`);

  const { records, exclusions, totalConsidered } = runBacktest(fixtures, { minHistory: 3 });

  console.log('Exclusions (chronological backtest, per-competition rolling tables):');
  console.log(`  total considered: ${totalConsidered}`);
  for (const [k, v] of Object.entries(exclusions)) {
    console.log(`    ${k.padEnd(18)} ${v}`);
  }
  const eligible = records.filter((r) => r.eligible);
  console.log(`  eligible (model produced a prediction): ${eligible.length}\n`);

  // Independent probability-validity audit over every eligible prediction.
  let finite = 0;
  let inRange = 0;
  let sumToOne = 0;
  let maxDev = 0;
  for (const r of eligible) {
    const p = r.model!;
    const vals = [p.homeWin, p.draw, p.awayWin];
    if (vals.every((v) => Number.isFinite(v))) finite++;
    if (vals.every((v) => v >= 0 && v <= 1)) inRange++;
    const dev = Math.abs(vals[0] + vals[1] + vals[2] - 1);
    maxDev = Math.max(maxDev, dev);
    if (dev <= 1e-3) sumToOne++;
  }
  console.log('=== PROBABILITY VALIDITY AUDIT (all eligible predictions) ===');
  console.log(`  finite:      ${finite}/${eligible.length}`);
  console.log(`  within [0,1]: ${inRange}/${eligible.length}`);
  console.log(`  sum to 1 (tol 1e-3): ${sumToOne}/${eligible.length}  (max deviation ${fmt(maxDev, 6)})\n`);

  const modelSamples = toEvaluationSamples(records, 'model');
  const baseSamples = toEvaluationSamples(records, 'leagueFrequency');

  console.log('=== OVERALL (out-of-sample, strictly-prior features) ===');
  printSummary('Frozen Poisson V1', evaluateSamples(modelSamples));
  printSummary('League-frequency base', evaluateSamples(baseSamples));

  console.log('\n=== BY COMPETITION ===');
  const byComp = groupSamples(modelSamples, (s) => s.competitionCode);
  const byCompBase = groupSamples(baseSamples, (s) => s.competitionCode);
  for (const comp of [...byComp.keys()].sort()) {
    const ms = byComp.get(comp)!;
    printSummary(`Poisson ${comp}`, evaluateSamples(ms));
    const bs = byCompBase.get(comp);
    if (bs) printSummary(`Baseline ${comp}`, evaluateSamples(bs));
  }

  console.log('\n=== BY COMPETITION + SEASON (model) ===');
  const bySeason = groupSamples(modelSamples, (s) => `${s.competitionCode} ${s.season}`);
  for (const key of [...bySeason.keys()].sort()) {
    printSummary(key, evaluateSamples(bySeason.get(key)!));
  }

  console.log('\n=== CALIBRATION (overall model) ===');
  printCalibration('overall model', evaluateSamples(modelSamples));

  // Strictly chronological split. The frozen model has no trainable parameters, so
  // there is no fit step; the earliest season is the validation fold and the later
  // seasons are the held-out test folds. Every prediction still uses only prior matches.
  console.log('\n=== CHRONOLOGICAL SPLIT (validation vs held-out test) ===');
  const validation = modelSamples.filter((s) => s.season.startsWith('2023'));
  const test = modelSamples.filter((s) => !s.season.startsWith('2023'));
  printSummary('Validation 2023/24', evaluateSamples(validation));
  printSummary('Test 2024/25+25/26', evaluateSamples(test));
  const baseValidation = baseSamples.filter((s) => s.season.startsWith('2023'));
  const baseTest = baseSamples.filter((s) => !s.season.startsWith('2023'));
  printSummary('Base validation 2023/24', evaluateSamples(baseValidation));
  printSummary('Base test 2024/25+25/26', evaluateSamples(baseTest));

  console.log('\n=== MARKET-IMPLIED BASELINE ===');
  console.log('  Unavailable: no odds feed is active (5dollarfootballapi auth failed; The Odds API disabled by config).');
  console.log('  No market-implied baseline is reported rather than fabricating one.');
}

main();
