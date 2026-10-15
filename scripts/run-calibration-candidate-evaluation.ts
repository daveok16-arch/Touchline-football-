/**
 * Project Touchline – Phase P calibration-candidate evaluation (RESEARCH ONLY)
 *
 * Chronological walk-forward comparison of:
 *   1. Frozen model (T = 1).
 *   2. Frozen model + calibration candidate (this phase), using the IMPLEMENTED policy:
 *      one global temperature refit per calendar month from observations whose outcome
 *      was known STRICTLY before the month's start.
 *
 * Both models are scored on IDENTICAL eligible fixtures. RPS is primary; log loss,
 * Brier and calibration diagnostics are secondary; paired chronological block bootstrap
 * gives uncertainty intervals.
 *
 * WINDOW DISCLOSURE (required): seasons 2023–2025 have already influenced Phase M/N/O
 * model and policy selection. This runner does NOT claim an untouched holdout. A future
 * season is still required for a clean prospective test.
 *
 * Usage: npx tsx scripts/run-calibration-candidate-evaluation.ts
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { Fixture } from '../src/types/football';
import { runBacktest } from '../src/services/predictionBacktest';
import { evaluateSamples, Outcome, ProbabilityTriplet } from '../src/services/predictionMetrics';
import {
  fitCandidateCalibration,
  calibrateTriplet,
  CalibrationObservation,
  MIN_CALIBRATION_SAMPLES,
  CALIBRATION_CANDIDATE_ID,
} from '../src/services/calibrationCandidate';
import {
  PairedObservation,
  pairedBlockBootstrapFromScores,
  rankedProbabilityScore,
} from '../src/services/research/researchMetrics';

const CACHE_DIR = path.resolve(process.cwd(), '.phase3-cache');
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;

// Conservative settlement delay: results treated as known one day after kickoff,
// which exceeds the provider's stated <=15-minute delay.
const SETTLEMENT_DELAY_MS = 24 * 60 * 60 * 1000;

// Evaluation window: seasons 2024 & 2025 (already influenced by earlier phases).
const EVAL_SEASON_PREFIXES = ['2024', '2025'];

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
type Getter = (r: Rec) => ProbabilityTriplet;

function meanOf(recs: Rec[], get: Getter, m: (p: ProbabilityTriplet, o: Outcome) => number): number {
  if (recs.length === 0) return NaN;
  let s = 0;
  for (const r of recs) s += m(get(r), r.outcome);
  return s / recs.length;
}

function ece(recs: Rec[], get: Getter): number {
  const s = evaluateSamples(recs.map((r) => ({ probabilities: get(r), outcome: r.outcome, competitionCode: r.competitionCode, season: r.season })));
  return (s.calibration.home.expectedCalibrationError + s.calibration.draw.expectedCalibrationError + s.calibration.away.expectedCalibrationError) / 3;
}

function compare(recs: Rec[], getA: Getter, getB: Getter, metric: (p: ProbabilityTriplet, o: Outcome) => number, label: string, blockSize = BOOTSTRAP_BLOCK): void {
  const obs: PairedObservation[] = recs.map((r) => ({ probabilities: getA(r), outcome: r.outcome, kickoffMs: r.kickoffMs, competitionCode: r.competitionCode }));
  const a = recs.map((r) => metric(getA(r), r.outcome));
  const b = recs.map((r) => metric(getB(r), r.outcome));
  const res = pairedBlockBootstrapFromScores(obs, a, b, { seed: BOOTSTRAP_SEED, resamples: BOOTSTRAP_RESAMPLES, blockSize });
  const verdict = res.ciHigh < 0 ? 'improvement' : res.ciLow > 0 ? 'worse' : 'CI includes 0';
  console.log(`    ${label.padEnd(30)} n=${res.n}  meanDiff=${fmt(res.meanDifference, 5)}  95%CI=[${fmt(res.ciLow, 5)}, ${fmt(res.ciHigh, 5)}]  P(A better)=${fmt(res.probABetter, 3)}  ${verdict}`);
}

function monthKey(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}
function monthStartMs(mk: number): number {
  return Date.UTC(Math.floor(mk / 12), mk % 12, 1);
}

function main(): void {
  const fixtures = loadAll();
  console.log('====================================================================');
  console.log('PHASE P — CALIBRATION CANDIDATE EVALUATION (walk-forward, research only)');
  console.log(`Candidate: ${CALIBRATION_CANDIDATE_ID}  (cold-start threshold ${MIN_CALIBRATION_SAMPLES})`);
  console.log('====================================================================\n');

  const { records: raw, exclusions, totalConsidered } = runBacktest(fixtures, { minHistory: 3 });
  const records: Rec[] = [];
  for (const r of raw) {
    if (!r.eligible || r.outcome == null || !r.model) continue;
    records.push({ fixtureId: r.fixtureId, competitionCode: r.competitionCode, season: r.season, kickoffMs: r.kickoffMs, outcome: r.outcome, frozen: r.model });
  }
  records.sort((a, b) => a.kickoffMs - b.kickoffMs || a.fixtureId.localeCompare(b.fixtureId));
  console.log(`Eligible predictions: ${records.length} (considered ${totalConsidered})`);
  console.log(`Exclusions: ${JSON.stringify(exclusions)}`);

  // Observations for fitting: outcome known strictly after kickoff + settlement delay.
  const observations: CalibrationObservation[] = records.map((r) => ({
    probabilities: r.frozen,
    outcome: r.outcome,
    outcomeKnownAtMs: r.kickoffMs + SETTLEMENT_DELAY_MS,
  }));

  // Refit per calendar month using ONLY strictly-prior observations (implemented policy).
  const evalRecs = records.filter((r) => EVAL_SEASON_PREFIXES.some((p) => r.season.startsWith(p)));
  const months = [...new Set(evalRecs.map((r) => monthKey(r.kickoffMs)))].sort((a, b) => a - b);
  const calByMonth = new Map<number, ReturnType<typeof fitCandidateCalibration>>();
  console.log('\nMonthly candidate temperature (strictly-prior refit):');
  for (const mk of months) {
    const asOf = monthStartMs(mk);
    const cal = fitCandidateCalibration(observations, asOf);
    const priorN = observations.filter((o) => o.outcomeKnownAtMs < asOf).length;
    calByMonth.set(mk, cal);
    console.log(`  ${new Date(asOf).toISOString().slice(0, 7)}  priorKnownN=${String(priorN).padStart(4)}  T=${fmt(cal ? cal.temperature : 1, 4)}${cal ? '' : '  (cold start -> T=1)'}`);
  }

  const getCal: Getter = (r) => calibrateTriplet(r.frozen, calByMonth.get(monthKey(r.kickoffMs)));

  console.log('\n--- Held-out-style window (seasons 2024 & 2025; ALREADY INFLUENCED by Phase M/N/O) ---');
  console.log(`  window n=${evalRecs.length}`);
  console.log('  Model                       RPS      logLoss  brier    ECE');
  console.log(`  frozen (T=1)               ${fmt(meanOf(evalRecs, (r) => r.frozen, rps), 5)}  ${fmt(meanOf(evalRecs, (r) => r.frozen, logLoss), 4)}  ${fmt(meanOf(evalRecs, (r) => r.frozen, brier), 4)}  ${fmt(ece(evalRecs, (r) => r.frozen), 4)}`);
  console.log(`  candidate (calibrated)     ${fmt(meanOf(evalRecs, getCal, rps), 5)}  ${fmt(meanOf(evalRecs, getCal, logLoss), 4)}  ${fmt(meanOf(evalRecs, getCal, brier), 4)}  ${fmt(ece(evalRecs, getCal), 4)}`);

  console.log('\n  Paired comparisons (candidate vs frozen):');
  compare(evalRecs, getCal, (r) => r.frozen, rps, 'RPS');
  compare(evalRecs, getCal, (r) => r.frozen, logLoss, 'logLoss');
  compare(evalRecs, getCal, (r) => r.frozen, brier, 'Brier');

  console.log('\n--- By season ---');
  for (const sp of EVAL_SEASON_PREFIXES) {
    const recs = evalRecs.filter((r) => r.season.startsWith(sp));
    if (!recs.length) continue;
    console.log(`  ${sp} (n=${recs.length}): frozen RPS=${fmt(meanOf(recs, (r) => r.frozen, rps), 5)} -> candidate RPS=${fmt(meanOf(recs, getCal, rps), 5)}`);
    compare(recs, getCal, (r) => r.frozen, rps, `${sp} RPS`);
  }

  console.log('\n--- By competition ---');
  for (const comp of COMPETITIONS) {
    const recs = evalRecs.filter((r) => r.competitionCode === comp);
    if (!recs.length) continue;
    console.log(`  ${comp} (n=${recs.length}): frozen RPS=${fmt(meanOf(recs, (r) => r.frozen, rps), 5)} -> candidate RPS=${fmt(meanOf(recs, getCal, rps), 5)}`);
    compare(recs, getCal, (r) => r.frozen, rps, `${comp} RPS`);
  }

  console.log('\n--- Bootstrap block-size sensitivity (RPS) ---');
  for (const bs of [1, 5, 10, 20, 40, 80]) compare(evalRecs, getCal, (r) => r.frozen, rps, `block=${bs}`, bs);

  console.log('\n====================================================================');
  console.log('WINDOW DISCLOSURE: 2023-2025 have all influenced prior model/policy');
  console.log('selection. This is NOT a clean holdout. A future season remains required.');
  console.log('====================================================================');
}

main();
