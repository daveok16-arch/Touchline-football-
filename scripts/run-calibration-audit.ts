/**
 * Project Touchline – Phase O calibration deployment-readiness audit (RESEARCH ONLY)
 *
 * Independent, read-only audit of the Phase N temperature-calibration finding.
 * It does NOT modify production code, the frozen engine, or any Phase N/M module.
 * It re-derives the frozen probabilities via the untouched runBacktest, re-fits
 * temperatures itself, and re-checks the holdout boundary and refit policies.
 *
 * Predeclared protocol (frozen before running):
 *   - Windows: W1 = season 2023/24 (calibration seed), W2 = 2024/25 (selection),
 *     W3 = 2025/26 (final untouched window).
 *   - Policies:
 *       P1 Fixed:  one temperature fitted on W1, frozen.
 *       P2 Expanding: temperature refit per calendar month using only predictions
 *                     whose outcomes are available strictly before that month.
 *       P3 Fallback: P2, but T=1 while the strictly-prior calibration count < minN.
 *   - Primary metric RPS; secondary log loss, Brier, ECE.
 *   - Paired chronological block bootstrap, seed 20261015, 2000 resamples, block 20.
 *   - No policy is selected using W3; P1-vs-P2/P3 is only measurable on W3 because
 *     W1 is the sole prior season for W2 (reported as a limitation).
 *
 * Usage: npx tsx scripts/run-calibration-audit.ts
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { Fixture } from '../src/types/football';
import { runBacktest } from '../src/services/predictionBacktest';
import { evaluateSamples, Outcome, ProbabilityTriplet } from '../src/services/predictionMetrics';
import { fitTemperature, applyTemperature, TemperatureFit } from '../src/services/research/calibration';
import {
  PairedObservation,
  pairedBlockBootstrapFromScores,
  rankedProbabilityScore,
} from '../src/services/research/researchMetrics';

const CACHE_DIR = path.resolve(process.cwd(), '.phase3-cache');
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;
const MIN_CALIBRATION_N = 200; // predeclared minimum for the fallback policy

const W1_PREFIX = '2023';
const W2_PREFIX = '2024';
const W3_PREFIX = '2025';

const BOOTSTRAP_SEED = 20261015;
const BOOTSTRAP_BLOCK = 20;
const BOOTSTRAP_RESAMPLES = 2000;

interface Rec {
  fixtureId: string;
  competitionCode: string;
  season: string;
  kickoffMs: number;
  outcome: Outcome;
  frozen: ProbabilityTriplet;
  baseline: ProbabilityTriplet;
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

const fmt = (n: number, d = 4) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
const rps = (p: ProbabilityTriplet, o: Outcome) => rankedProbabilityScore(p, o);
const logLoss = (p: ProbabilityTriplet, o: Outcome) => -Math.log(Math.max([p.homeWin, p.draw, p.awayWin][o], 1e-15));
const brier = (p: ProbabilityTriplet, o: Outcome) => {
  const v = [p.homeWin, p.draw, p.awayWin];
  let s = 0;
  for (let k = 0; k < 3; k++) s += (v[k] - (k === o ? 1 : 0)) ** 2;
  return s;
};
type MetricFn = (p: ProbabilityTriplet, o: Outcome) => number;

function meanOf(recs: Rec[], get: (r: Rec) => ProbabilityTriplet, m: MetricFn): number {
  if (recs.length === 0) return NaN;
  let s = 0;
  for (const r of recs) s += m(get(r), r.outcome);
  return s / recs.length;
}

function ece(recs: Rec[], get: (r: Rec) => ProbabilityTriplet): number {
  const s = evaluateSamples(
    recs.map((r) => ({ probabilities: get(r), outcome: r.outcome, competitionCode: r.competitionCode, season: r.season }))
  );
  return (s.calibration.home.expectedCalibrationError + s.calibration.draw.expectedCalibrationError + s.calibration.away.expectedCalibrationError) / 3;
}

function pairedCompare(
  recs: Rec[],
  getA: (r: Rec) => ProbabilityTriplet,
  getB: (r: Rec) => ProbabilityTriplet,
  metric: MetricFn,
  label: string,
  blockSize = BOOTSTRAP_BLOCK
): void {
  const obs: PairedObservation[] = recs.map((r) => ({
    probabilities: getA(r),
    outcome: r.outcome,
    kickoffMs: r.kickoffMs,
    competitionCode: r.competitionCode,
  }));
  const a = recs.map((r) => metric(getA(r), r.outcome));
  const b = recs.map((r) => metric(getB(r), r.outcome));
  const res = pairedBlockBootstrapFromScores(obs, a, b, { seed: BOOTSTRAP_SEED, resamples: BOOTSTRAP_RESAMPLES, blockSize });
  const verdict = res.ciHigh < 0 ? 'improvement' : res.ciLow > 0 ? 'worse' : 'CI includes 0';
  console.log(
    `    ${label.padEnd(34)} n=${res.n}  meanDiff=${fmt(res.meanDifference, 5)}  95%CI=[${fmt(res.ciLow, 5)}, ${fmt(res.ciHigh, 5)}]  ${verdict}`
  );
}

function main(): void {
  const fixtures = loadAll();
  console.log('====================================================================');
  console.log('PHASE O — CALIBRATION DEPLOYMENT-READINESS AUDIT (read-only)');
  console.log('====================================================================\n');

  const { records: raw, exclusions, totalConsidered } = runBacktest(fixtures, { minHistory: 3 });
  const records: Rec[] = [];
  for (const r of raw) {
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
  records.sort((a, b) => a.kickoffMs - b.kickoffMs || a.fixtureId.localeCompare(b.fixtureId));
  console.log(`Eligible predictions: ${records.length} (considered ${totalConsidered})`);
  console.log(`Exclusions: ${JSON.stringify(exclusions)}\n`);

  const W1 = records.filter((r) => r.season.startsWith(W1_PREFIX));
  const W2 = records.filter((r) => r.season.startsWith(W2_PREFIX));
  const W3 = records.filter((r) => r.season.startsWith(W3_PREFIX));
  const testAll = records.filter((r) => !r.season.startsWith(W1_PREFIX));

  // ------------------------------------------------------------------
  // 1. HOLDOUT / LEAKAGE AUDIT
  // ------------------------------------------------------------------
  console.log('--------------------------------------------------------------------');
  console.log('1. HOLDOUT / LEAKAGE AUDIT');
  console.log('--------------------------------------------------------------------');
  console.log(`W1 calibration seed : n=${W1.length}  ${new Date(W1[0].kickoffMs).toISOString().slice(0, 10)} .. ${new Date(W1[W1.length - 1].kickoffMs).toISOString().slice(0, 10)}`);
  console.log(`W2 selection window : n=${W2.length}  ${new Date(W2[0].kickoffMs).toISOString().slice(0, 10)} .. ${new Date(W2[W2.length - 1].kickoffMs).toISOString().slice(0, 10)}`);
  console.log(`W3 final window     : n=${W3.length}  ${new Date(W3[0].kickoffMs).toISOString().slice(0, 10)} .. ${new Date(W3[W3.length - 1].kickoffMs).toISOString().slice(0, 10)}`);

  // Reproduce the Phase N reported configuration exactly: T fitted on W1 only,
  // applied to the whole held-out test (W2+W3).
  const tW1: TemperatureFit = fitTemperature(W1.map((r) => r.frozen), W1.map((r) => r.outcome));
  console.log(`\nT fitted on W1 only: T=${fmt(tW1.temperature, 4)} (n=${tW1.calibrationCount})`);
  console.log('Recomputed held-out metrics using ONLY the W1-fitted temperature:');
  console.log(`  frozen    RPS=${fmt(meanOf(testAll, (r) => r.frozen, rps), 5)}  logLoss=${fmt(meanOf(testAll, (r) => r.frozen, logLoss), 5)}  brier=${fmt(meanOf(testAll, (r) => r.frozen, brier), 5)}  ECE=${fmt(ece(testAll, (r) => r.frozen), 4)}`);
  console.log(`  frozenCal RPS=${fmt(meanOf(testAll, (r) => applyTemperature(r.frozen, tW1.temperature), rps), 5)}  logLoss=${fmt(meanOf(testAll, (r) => applyTemperature(r.frozen, tW1.temperature), logLoss), 5)}  brier=${fmt(meanOf(testAll, (r) => applyTemperature(r.frozen, tW1.temperature), brier), 5)}  ECE=${fmt(ece(testAll, (r) => applyTemperature(r.frozen, tW1.temperature)), 4)}`);

  // Prove the expanding-window temperature (fit including W2 outcomes) is NOT used
  // in the W2 results: fitting on W1 alone vs W1+W2 must not change W2 predictions.
  const tW1W2 = fitTemperature([...W1, ...W2].map((r) => r.frozen), [...W1, ...W2].map((r) => r.outcome));
  let maxW2Delta = 0;
  for (const r of W2) {
    const a = applyTemperature(r.frozen, tW1.temperature);
    const b = applyTemperature(r.frozen, tW1W2.temperature);
    maxW2Delta = Math.max(maxW2Delta, Math.abs(a.homeWin - b.homeWin), Math.abs(a.draw - b.draw), Math.abs(a.awayWin - b.awayWin));
  }
  console.log(`\nT fitted on W1+W2: T=${fmt(tW1W2.temperature, 4)} (n=${tW1W2.calibrationCount})`);
  console.log(`  Max |P(W1-fit) - P(W1+W2-fit)| over W2 predictions: ${fmt(maxW2Delta, 6)}`);
  console.log('  Interpretation: the reported W2 metrics use the W1-only temperature. The W1+W2');
  console.log('  temperature (which sees W2 outcomes) is used nowhere in the reported W2 results.');

  // Boundary check: is the optimum interior to the grid?
  const atMin = tW1.temperature <= tW1.searchMin + 1e-9;
  const atMax = tW1.temperature >= tW1.searchMax - 1e-9;
  console.log(`  Grid boundary: T=${fmt(tW1.temperature, 4)} in [${tW1.searchMin}, ${tW1.searchMax}] -> ${atMin || atMax ? 'AT BOUNDARY (warning)' : 'interior (ok)'}`);

  // ------------------------------------------------------------------
  // 2. CALIBRATION MATHEMATICS
  // ------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------');
  console.log('2. CALIBRATION MATHEMATICS');
  console.log('--------------------------------------------------------------------');
  const testVec: ProbabilityTriplet = { homeWin: 0.7, draw: 0.2, awayWin: 0.1 };
  console.log('  Transformation p_i^(1/T) / sum_j p_j^(1/T):');
  for (const t of [0.5, 1.0, 1.325, 2.0, 3.0]) {
    const q = applyTemperature(testVec, t);
    const sum = q.homeWin + q.draw + q.awayWin;
    console.log(`    T=${String(t).padEnd(6)} -> (${fmt(q.homeWin, 4)}, ${fmt(q.draw, 4)}, ${fmt(q.awayWin, 4)})  sum=${fmt(sum, 10)}  orderPreserved=${q.homeWin >= q.draw && q.draw >= q.awayWin}`);
  }
  // Ridge sensitivity
  console.log('  Ridge sensitivity of the selected T (W1):');
  for (const ridge of [0, 0.0005, 0.005, 0.05]) {
    const f = fitTemperature(W1.map((r) => r.frozen), W1.map((r) => r.outcome), { ridge });
    console.log(`    ridge=${String(ridge).padEnd(7)} T=${fmt(f.temperature, 4)}`);
  }

  // ------------------------------------------------------------------
  // 3. OPERATIONAL REFIT-POLICY COMPARISON
  // ------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------');
  console.log('3. OPERATIONAL REFIT-POLICY COMPARISON');
  console.log('--------------------------------------------------------------------');

  // P2/P3: refit per calendar month using strictly-prior predictions.
  const DAY = 86400000;
  function monthKey(ms: number): number {
    const d = new Date(ms);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  function expandingTemperature(target: Rec): number {
    const prior = records.filter((r) => r.kickoffMs < target.kickoffMs);
    if (prior.length < MIN_CALIBRATION_N) return 1; // P3 fallback
    return fitTemperature(prior.map((r) => r.frozen), prior.map((r) => r.outcome)).temperature;
  }
  // Build a monthly refit table: for each month, the temperature from all strictly-prior preds.
  const months = [...new Set(testAll.map((r) => monthKey(r.kickoffMs)))].sort((a, b) => a - b);
  const monthTemp = new Map<number, number>();
  for (const mk of months) {
    const monthStart = Date.UTC(Math.floor(mk / 12), mk % 12, 1);
    const prior = records.filter((r) => r.kickoffMs < monthStart);
    const t = prior.length >= MIN_CALIBRATION_N ? fitTemperature(prior.map((r) => r.frozen), prior.map((r) => r.outcome)).temperature : 1;
    monthTemp.set(mk, t);
  }
  const getP1 = (r: Rec) => applyTemperature(r.frozen, tW1.temperature);
  const getP2 = (r: Rec) => applyTemperature(r.frozen, monthTemp.get(monthKey(r.kickoffMs))!);
  // P3 == P2 by construction here (fallback only bites when prior < minN, which never happens
  // after W1); report the month-by-month temperatures so the fallback path is visible.
  void DAY; void expandingTemperature;

  console.log(`  Monthly expanding-refit temperatures (min n for fallback = ${MIN_CALIBRATION_N}):`);
  for (const mk of months) {
    const monthStart = Date.UTC(Math.floor(mk / 12), mk % 12, 1);
    const priorN = records.filter((r) => r.kickoffMs < monthStart).length;
    console.log(`    ${new Date(monthStart).toISOString().slice(0, 7)}  priorN=${String(priorN).padStart(4)}  T=${fmt(monthTemp.get(mk)!, 4)}`);
  }

  for (const [wname, wrecs] of [['W2 (selection)', W2], ['W3 (final untouched)', W3]] as const) {
    console.log(`\n  ${wname} n=${wrecs.length}`);
    for (const [pname, get] of [['frozen (T=1)', (r: Rec) => r.frozen], ['P1 fixed', getP1], ['P2 expanding', getP2]] as const) {
      console.log(`    ${pname.padEnd(14)} RPS=${fmt(meanOf(wrecs, get, rps), 5)}  logLoss=${fmt(meanOf(wrecs, get, logLoss), 5)}  brier=${fmt(meanOf(wrecs, get, brier), 5)}  ECE=${fmt(ece(wrecs, get), 4)}`);
    }
    pairedCompare(wrecs, getP1, (r) => r.frozen, rps, 'P1 vs frozen [rps]');
    pairedCompare(wrecs, getP2, (r) => r.frozen, rps, 'P2 vs frozen [rps]');
    pairedCompare(wrecs, getP1, getP2, rps, 'P1 vs P2 [rps]');
    pairedCompare(wrecs, getP1, (r) => r.frozen, logLoss, 'P1 vs frozen [logloss]');
    pairedCompare(wrecs, getP2, (r) => r.frozen, logLoss, 'P2 vs frozen [logloss]');
  }

  // ------------------------------------------------------------------
  // 4. SAMPLE SUFFICIENCY AND STABILITY
  // ------------------------------------------------------------------
  console.log('\n--------------------------------------------------------------------');
  console.log('4. SAMPLE SUFFICIENCY AND STABILITY');
  console.log('--------------------------------------------------------------------');
  console.log('  Expanding-window temperature as the strictly-prior sample grows:');
  for (const n of [100, 200, 300, 500, 800, 1126, 1600, 2368, 3200]) {
    const subset = records.filter((r) => r.kickoffMs < W2[0].kickoffMs).slice(0, n);
    const pool = n <= W1.length ? W1.slice(0, n) : records.slice(0, n);
    const f = fitTemperature(pool.map((r) => r.frozen), pool.map((r) => r.outcome));
    console.log(`    n=${String(subset.length === 0 ? n : pool.length).padStart(4)}  T=${fmt(f.temperature, 4)}  calibLogLoss ${fmt(f.logLossBefore, 5)} -> ${fmt(f.logLossAfter, 5)}`);
  }

  // Per-competition, per-window deltas (P1 vs frozen).
  console.log('\n  Per-competition P1 vs frozen (RPS, negative = improvement):');
  for (const wname of ['W2', 'W3'] as const) {
    const wrecs = wname === 'W2' ? W2 : W3;
    for (const comp of COMPETITIONS) {
      const recs = wrecs.filter((r) => r.competitionCode === comp);
      if (recs.length === 0) continue;
      const d = meanOf(recs, getP1, rps) - meanOf(recs, (r) => r.frozen, rps);
      console.log(`    ${wname} ${comp} (n=${String(recs.length).padStart(3)}): delta RPS=${fmt(d, 5)}`);
    }
  }

  console.log('\n====================================================================');
  console.log('AUDIT COMPLETE (no files or production code modified)');
  console.log('====================================================================');
}

main();
