/**
 * Project Touchline – xG clamp ablation (RESEARCH ONLY)
 *
 * The frozen V1 engine clamps expected goals to [0.3, 4.5]. The ceiling binds for
 * high-scoring favourites, which is visible in the UI as "xG: 4.50 - 0.76".
 *
 * This measures whether removing that clamp actually helps or hurts out-of-sample
 * accuracy. It runs the SAME frozen model with two clamp settings over the local
 * historical cache and compares them on identical paired fixtures:
 *
 *   V1 clamp   – the frozen [0.3, 4.5] bounds (production behaviour)
 *   Wide clamp – [0.0, 12.0], i.e. effectively unclamped
 *
 * Nothing here changes production. Read-only, deterministic, reproducible.
 *
 * Usage:
 *   npx tsx scripts/run-xg-clamp-evaluation.ts
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { Fixture } from '../src/types/football';
import { runBacktest, BacktestRecord } from '../src/services/predictionBacktest';
import { Outcome, ProbabilityTriplet } from '../src/services/predictionMetrics';
import {
  PairedObservation,
  pairedBlockBootstrapFromScores,
  rankedProbabilityScore,
} from '../src/services/research/researchMetrics';

const CACHE_DIR = path.resolve(process.cwd(), '.phase3-cache');
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;

const DEV_SEASON_PREFIX = '2023';
const BOOTSTRAP_SEED = 20261015;
const BOOTSTRAP_BLOCK = 20;
const BOOTSTRAP_RESAMPLES = 2000;

const V1_BOUNDS = [0.3, 4.5] as const;
const WIDE_BOUNDS = [0.0, 12.0] as const;

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

function logLoss(p: ProbabilityTriplet, o: Outcome): number {
  return -Math.log(Math.max([p.homeWin, p.draw, p.awayWin][o], 1e-15));
}

function brier(p: ProbabilityTriplet, o: Outcome): number {
  const y = [o === 0 ? 1 : 0, o === 1 ? 1 : 0, o === 2 ? 1 : 0];
  return ((p.homeWin - y[0]) ** 2 + (p.draw - y[1]) ** 2 + (p.awayWin - y[2]) ** 2) / 3;
}

function fmt(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

type Metric = 'rps' | 'logloss' | 'brier';
function scorerFor(metric: Metric): (p: ProbabilityTriplet, o: Outcome) => number {
  if (metric === 'rps') return (p, o) => rankedProbabilityScore(p, o);
  if (metric === 'logloss') return logLoss;
  return brier;
}

interface Row {
  record: BacktestRecord;
  v1: ProbabilityTriplet;
  wide: ProbabilityTriplet;
}

/** Pairs the two runs on fixtures where both produced a prediction. */
function pairRuns(fixtures: Fixture[]): Row[] {
  const a = runBacktest(fixtures, { poisson: { expectedGoalsBounds: V1_BOUNDS } });
  const b = runBacktest(fixtures, { poisson: { expectedGoalsBounds: WIDE_BOUNDS } });

  const byId = new Map<string, BacktestRecord>();
  for (const r of b.records) byId.set(r.fixtureId, r);

  const rows: Row[] = [];
  for (const r of a.records) {
    if (!r.eligible || r.model == null || r.outcome == null) continue;
    const other = byId.get(r.fixtureId);
    if (!other?.model || other.outcome == null) continue;
    rows.push({ record: r, v1: r.model, wide: other.model });
  }
  rows.sort((x, y) => x.record.kickoffMs - y.record.kickoffMs);
  return rows;
}

function summarise(label: string, rows: Row[], pick: (r: Row) => ProbabilityTriplet): void {
  let rps = 0, ll = 0, br = 0, acc = 0;
  for (const r of rows) {
    const p = pick(r);
    const o = r.record.outcome as Outcome;
    rps += rankedProbabilityScore(p, o);
    ll += logLoss(p, o);
    br += brier(p, o);
    const argmax = [p.homeWin, p.draw, p.awayWin].indexOf(Math.max(p.homeWin, p.draw, p.awayWin));
    if (argmax === o) acc++;
  }
  const n = rows.length;
  console.log(
    `${label.padEnd(28)} n=${String(n).padStart(4)}  RPS=${fmt(rps / n)}  logLoss=${fmt(ll / n)}  brier=${fmt(br / n)}  acc=${fmt(acc / n, 3)}`
  );
}

function compare(rows: Row[], metric: Metric, label: string): void {
  const scorer = scorerFor(metric);
  const observations: PairedObservation[] = rows.map((r) => ({
    probabilities: r.v1,
    outcome: r.record.outcome as Outcome,
    kickoffMs: r.record.kickoffMs,
    competitionCode: r.record.competitionCode,
  }));
  const scoreA = rows.map((r) => scorer(r.v1, r.record.outcome as Outcome));
  const scoreB = rows.map((r) => scorer(r.wide, r.record.outcome as Outcome));
  const res = pairedBlockBootstrapFromScores(observations, scoreA, scoreB, {
    seed: BOOTSTRAP_SEED,
    resamples: BOOTSTRAP_RESAMPLES,
    blockSize: BOOTSTRAP_BLOCK,
  });
  const verdict =
    res.ciHigh < 0
      ? 'CI excludes 0 -> V1 clamp BETTER'
      : res.ciLow > 0
      ? 'CI excludes 0 -> wide clamp BETTER'
      : 'CI includes 0 -> no reliable difference';
  console.log(
    `${label.padEnd(24)} [${metric}]  meanDiff(V1-wide)=${fmt(res.meanDifference, 5)}  95%CI=[${fmt(res.ciLow, 5)}, ${fmt(res.ciHigh, 5)}]  P(V1 better)=${fmt(res.probABetter, 3)}  ${verdict}`
  );
}

function main(): void {
  const fixtures = loadAll();
  console.log(`Loaded ${fixtures.length} historical fixtures from cache.`);
  console.log(`Split: development = season year ${DEV_SEASON_PREFIX}; held-out test = 2024 & 2025.`);
  console.log(`V1 bounds = [${V1_BOUNDS}], wide bounds = [${WIDE_BOUNDS}] (effectively unclamped).\n`);

  const all = pairRuns(fixtures);
  const dev = all.filter((r) => r.record.season.startsWith(DEV_SEASON_PREFIX));
  const test = all.filter((r) => !r.record.season.startsWith(DEV_SEASON_PREFIX));

  // How often does the clamp actually change the prediction at all?
  let changed = 0;
  let maxDelta = 0;
  for (const r of all) {
    const d = Math.abs(r.v1.homeWin - r.wide.homeWin) + Math.abs(r.v1.draw - r.wide.draw) + Math.abs(r.v1.awayWin - r.wide.awayWin);
    if (d > 1e-9) changed++;
    maxDelta = Math.max(maxDelta, d);
  }
  console.log(`Predictions affected by the clamp: ${changed}/${all.length} (${fmt((changed / all.length) * 100, 1)}%)  max total-variation delta=${fmt(maxDelta, 4)}\n`);

  console.log('=== DEVELOPMENT (season 2023) ===');
  summarise('V1 clamp', dev, (r) => r.v1);
  summarise('Wide clamp', dev, (r) => r.wide);

  console.log('\n=== HELD-OUT TEST (season years 2024 & 2025) ===');
  summarise('V1 clamp', test, (r) => r.v1);
  summarise('Wide clamp', test, (r) => r.wide);

  console.log('\n--- Paired comparisons on held-out test (block bootstrap seed=' + BOOTSTRAP_SEED + ', block=' + BOOTSTRAP_BLOCK + ', resamples=' + BOOTSTRAP_RESAMPLES + ') ---');
  compare(test, 'rps', 'V1 vs Wide');
  compare(test, 'logloss', 'V1 vs Wide');
  compare(test, 'brier', 'V1 vs Wide');

  console.log('\n--- By competition (held-out, paired) ---');
  for (const comp of COMPETITIONS) {
    const sub = test.filter((r) => r.record.competitionCode === comp);
    if (sub.length === 0) continue;
    console.log(`${comp} (n=${sub.length}):`);
    summarise('  V1 clamp', sub, (r) => r.v1);
    summarise('  Wide clamp', sub, (r) => r.wide);
  }
}

main();
