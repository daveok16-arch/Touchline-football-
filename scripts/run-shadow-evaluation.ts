/**
 * Project Touchline – Phase Q prospective shadow evaluation (RESEARCH ONLY)
 *
 * Scores the paired shadow forecasts (frozen vs calibration candidate) against attached,
 * verified outcomes. Identical eligible fixtures only. RPS is primary; log loss, Brier
 * and calibration diagnostics are secondary; paired chronological block bootstrap gives
 * uncertainty intervals. Reports aggregate, competition, season and fallback results,
 * plus sample size and missing-outcome rate.
 *
 * It reads a shadow snapshot produced by `shadowRecording.ts`. It does NOT tune anything
 * on the data it scores, and makes no betting claim.
 *
 * Usage:
 *   npx tsx scripts/run-shadow-evaluation.ts [path-to-snapshot.json]
 */

import {
  ShadowSnapshot,
  currentShadowResult,
  primaryShadowForecast,
  snapshotModes,
} from '../src/services/shadowLedger';
import { loadShadowSnapshot, SHADOW_DEFAULT_PATH } from '../src/services/shadowRecording';
import { evaluateSamples, Outcome, ProbabilityTriplet } from '../src/services/predictionMetrics';
import {
  PairedObservation,
  pairedBlockBootstrapFromScores,
  rankedProbabilityScore,
} from '../src/services/research/researchMetrics';
import { SHADOW_PROTOCOL, computeProtocolHash } from '../src/services/research/shadowProtocol';

// ---- Predeclared protocol (documented BEFORE examining comparative performance) ----
const PREDECLARED = {
  primaryMetric: 'RPS',
  secondaryMetrics: ['logLoss', 'Brier', 'per-class calibration (ECE + bands)'],
  minimumObservationPeriodWeeks: 8,
  sampleTarget: 500,
  rationale:
    'Paired RPS differences observed in prior offline work are ~0.003. Detecting a shift of ' +
    'that size with a paired block bootstrap needs several hundred paired matches; 500 settled ' +
    'forecasts is the minimum, with >=1000 preferred before drawing conclusions.',
  limitations:
    'Prospective fixtures arrive at the provider cadence; small subgroups (esp. CL) are ' +
    'underpowered. No odds benchmark exists, so no betting claim is possible.',
};
const BOOTSTRAP_SEED = 20261015;
const BOOTSTRAP_BLOCK = 20;
const BOOTSTRAP_RESAMPLES = 2000;

interface Row {
  fixtureId: string;
  competitionCode: string;
  season: string;
  kickoffMs: number;
  outcome: Outcome;
  frozen: ProbabilityTriplet;
  candidate: ProbabilityTriplet;
  fallback: boolean;
  temperature: number;
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
type Getter = (r: Row) => ProbabilityTriplet;

function meanOf(rows: Row[], get: Getter, m: (p: ProbabilityTriplet, o: Outcome) => number): number {
  if (!rows.length) return NaN;
  let s = 0;
  for (const r of rows) s += m(get(r), r.outcome);
  return s / rows.length;
}
function ece(rows: Row[], get: Getter): number {
  const s = evaluateSamples(rows.map((r) => ({ probabilities: get(r), outcome: r.outcome, competitionCode: r.competitionCode, season: r.season })));
  return (s.calibration.home.expectedCalibrationError + s.calibration.draw.expectedCalibrationError + s.calibration.away.expectedCalibrationError) / 3;
}
function compare(rows: Row[], getA: Getter, getB: Getter, metric: (p: ProbabilityTriplet, o: Outcome) => number, label: string, blockSize = BOOTSTRAP_BLOCK): void {
  if (rows.length < 2) {
    console.log(`    ${label.padEnd(30)} n=${rows.length}  (too few to compare)`);
    return;
  }
  const obs: PairedObservation[] = rows.map((r) => ({ probabilities: getA(r), outcome: r.outcome, kickoffMs: r.kickoffMs, competitionCode: r.competitionCode }));
  const a = rows.map((r) => metric(getA(r), r.outcome));
  const b = rows.map((r) => metric(getB(r), r.outcome));
  const res = pairedBlockBootstrapFromScores(obs, a, b, { seed: BOOTSTRAP_SEED, resamples: BOOTSTRAP_RESAMPLES, blockSize });
  const verdict = res.ciHigh < 0 ? 'improvement' : res.ciLow > 0 ? 'worse' : 'CI includes 0';
  console.log(`    ${label.padEnd(30)} n=${res.n}  meanDiff=${fmt(res.meanDifference, 5)}  95%CI=[${fmt(res.ciLow, 5)}, ${fmt(res.ciHigh, 5)}]  ${verdict}`);
}

function buildRows(snapshot: ShadowSnapshot): { rows: Row[]; settledTotal: number; missingOutcome: number } {
  const byFixture = new Map<string, ShadowSnapshot['forecasts']>();
  for (const f of snapshot.forecasts) {
    const arr = byFixture.get(f.fixtureId) ?? [];
    arr.push(f);
    byFixture.set(f.fixtureId, arr);
  }
  const rows: Row[] = [];
  let settledTotal = 0;
  let missingOutcome = 0;
  for (const [fixtureId] of byFixture) {
    const forecast = primaryShadowForecast(snapshot, fixtureId);
    if (!forecast) continue;
    const result = currentShadowResult(snapshot, fixtureId);
    if (!result) {
      missingOutcome++;
      continue;
    }
    settledTotal++;
    rows.push({
      fixtureId,
      competitionCode: forecast.competitionCode,
      season: forecast.season,
      kickoffMs: new Date(forecast.kickoffTime).getTime(),
      outcome: result.outcome,
      frozen: forecast.frozen,
      candidate: forecast.candidate,
      fallback: forecast.calibration.fallback,
      temperature: forecast.calibration.temperature,
    });
  }
  rows.sort((a, b) => a.kickoffMs - b.kickoffMs || a.fixtureId.localeCompare(b.fixtureId));
  return { rows, settledTotal, missingOutcome };
}

function main(): void {
  const filePath = process.argv[2] || SHADOW_DEFAULT_PATH;
  console.log('====================================================================');
  console.log('PHASE Q — PROSPECTIVE SHADOW EVALUATION (research only)');
  console.log('====================================================================');
  console.log(`Snapshot: ${filePath}\n`);
  console.log('Predeclared protocol:');
  console.log(`  primary=${PREDECLARED.primaryMetric}  secondary=${PREDECLARED.secondaryMetrics.join(', ')}`);
  console.log(`  min observation period=${PREDECLARED.minimumObservationPeriodWeeks} weeks  sample target=${PREDECLARED.sampleTarget}`);
  console.log(`  rationale: ${PREDECLARED.rationale}`);
  console.log(`  limitations: ${PREDECLARED.limitations}\n`);

  const { snapshot, diagnostic } = loadShadowSnapshot(filePath);
  if (!diagnostic.ok) {
    console.log(`PERSISTENCE DIAGNOSTIC: could not read snapshot (${diagnostic.error}).`);
    console.log('No shadow data available yet. Nothing to evaluate.');
    return;
  }

  // Mode separation: reject mixed-mode datasets and refuse replay-as-evidence.
  const modes = snapshotModes(snapshot);
  console.log(`Protocol hash: ${computeProtocolHash()}`);
  console.log(`Collection modes present: ${modes.length ? modes.join(', ') : '(none)'}`);
  if (modes.length > 1) {
    console.log('MIXED-MODE DATASET: refusing to evaluate. Replay and prospective records must not be combined.');
    return;
  }
  if (modes.length === 1 && modes[0] === 'replay') {
    console.log('REPLAY-ONLY DATASET: infrastructure smoke test only — NOT prospective evidence.');
    console.log('Scores below must not be reported as prospective confirmation.');
  }

  const { rows, settledTotal, missingOutcome } = buildRows(snapshot);
  const totalForecastFixtures = new Set(snapshot.forecasts.map((f) => f.fixtureId)).size;
  const missRate = totalForecastFixtures ? missingOutcome / totalForecastFixtures : 0;

  console.log(`Forecast fixtures: ${totalForecastFixtures}  settled: ${settledTotal}  missing outcome: ${missingOutcome} (${fmt(missRate * 100, 1)}%)`);
  if (rows.length) {
    const start = new Date(rows[0].kickoffMs).toISOString().slice(0, 10);
    const end = new Date(rows[rows.length - 1].kickoffMs).toISOString().slice(0, 10);
    console.log(`Settled window: ${start} .. ${end}`);
  }
  const fallbackCount = rows.filter((r) => r.fallback).length;
  console.log(`Fallback forecasts (T=1): ${fallbackCount} / ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('No settled forecasts yet. Run a controlled shadow test (see Phase Q report) and re-run.');
    return;
  }

  console.log('--- Aggregate (identical fixtures) ---');
  console.log('  Model        RPS      logLoss  brier    ECE');
  console.log(`  frozen      ${fmt(meanOf(rows, (r) => r.frozen, rps), 5)}  ${fmt(meanOf(rows, (r) => r.frozen, logLoss), 4)}  ${fmt(meanOf(rows, (r) => r.frozen, brier), 4)}  ${fmt(ece(rows, (r) => r.frozen), 4)}`);
  console.log(`  candidate   ${fmt(meanOf(rows, (r) => r.candidate, rps), 5)}  ${fmt(meanOf(rows, (r) => r.candidate, logLoss), 4)}  ${fmt(meanOf(rows, (r) => r.candidate, brier), 4)}  ${fmt(ece(rows, (r) => r.candidate), 4)}`);
  console.log('\n  Paired (candidate vs frozen; negative = candidate better):');
  compare(rows, (r) => r.candidate, (r) => r.frozen, rps, 'RPS');
  compare(rows, (r) => r.candidate, (r) => r.frozen, logLoss, 'logLoss');
  compare(rows, (r) => r.candidate, (r) => r.frozen, brier, 'Brier');

  console.log('\n--- By competition ---');
  for (const comp of [...new Set(rows.map((r) => r.competitionCode))].sort()) {
    const sub = rows.filter((r) => r.competitionCode === comp);
    console.log(`  ${comp} (n=${sub.length}): frozen RPS=${fmt(meanOf(sub, (r) => r.frozen, rps), 5)} -> candidate RPS=${fmt(meanOf(sub, (r) => r.candidate, rps), 5)}`);
    compare(sub, (r) => r.candidate, (r) => r.frozen, rps, `${comp} RPS`);
  }

  console.log('\n--- By season ---');
  for (const season of [...new Set(rows.map((r) => r.season))].sort()) {
    const sub = rows.filter((r) => r.season === season);
    console.log(`  ${season} (n=${sub.length}): frozen RPS=${fmt(meanOf(sub, (r) => r.frozen, rps), 5)} -> candidate RPS=${fmt(meanOf(sub, (r) => r.candidate, rps), 5)}`);
  }

  console.log('\n--- Fallback vs active calibration ---');
  const fb = rows.filter((r) => r.fallback);
  const act = rows.filter((r) => !r.fallback);
  console.log(`  fallback (T=1) n=${fb.length}: frozen RPS=${fmt(meanOf(fb, (r) => r.frozen, rps), 5)} candidate RPS=${fmt(meanOf(fb, (r) => r.candidate, rps), 5)} (identical by construction)`);
  console.log(`  active  n=${act.length}: frozen RPS=${fmt(meanOf(act, (r) => r.frozen, rps), 5)} -> candidate RPS=${fmt(meanOf(act, (r) => r.candidate, rps), 5)}`);
  compare(act, (r) => r.candidate, (r) => r.frozen, rps, 'active RPS');

  console.log('\n--- Bootstrap block-size sensitivity (RPS) ---');
  for (const bs of [1, 5, 10, 20, 40, 80]) compare(rows, (r) => r.candidate, (r) => r.frozen, rps, `block=${bs}`, bs);

  console.log('\n--- Preregistered stopping gate ---');
  const isProspective = modes.length === 1 && modes[0] === 'prospective';
  if (!isProspective) {
    console.log('  NOT a prospective dataset: no stopping-rule decision applies.');
  } else if (rows.length < SHADOW_PROTOCOL.requirements.minSettledSamples) {
    console.log(`  n=${rows.length} < minimum ${SHADOW_PROTOCOL.requirements.minSettledSamples}: DO NOT INTERPRET (single preregistered analysis at target).`);
  } else {
    console.log(`  n=${rows.length} >= minimum ${SHADOW_PROTOCOL.requirements.minSettledSamples}: preregistered analysis may be run ONCE.`);
  }
  console.log('  Interim significance checks are prohibited; corrections are handled by re-scoring only.');
  console.log('\nNo betting-profitability claim is made; no odds benchmark exists.');
}

main();
