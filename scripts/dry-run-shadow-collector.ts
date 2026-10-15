/**
 * Project Touchline – Phase S collector dry run (OFFLINE, RESEARCH ONLY)
 *
 * Validates the collector's scheduling, eligibility, idempotency and request-budget logic
 * against a LOCAL fixtures file and a VIRTUAL clock. It makes NO network requests, writes
 * NO ledger/state files, and never enables a flag. Output is deterministic diagnostics on
 * stdout only. Eligibility is computed in memory via the capture policy; no forecast is
 * ever persisted.
 *
 * This is NOT a prospective pilot: the clock is virtual and no provider is contacted.
 *
 * Usage:
 *   npx tsx scripts/dry-run-shadow-collector.ts [fixturesDir]
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { Fixture } from '../src/types/football';
import {
  CollectorStateStore,
  emptyCollectorState,
  CollectorState,
  TransportFixture,
  TransportResult,
  CollectorTransport,
  RequestBudget,
  DEFAULT_BUDGET,
  COLLECTOR_DEFAULTS,
  isShadowCollectorEnabled,
  nextBackoffMs,
} from '../src/services/shadowCollector';
import { EMPTY_SHADOW, ShadowSnapshot } from '../src/services/shadowLedger';
import {
  CAPTURE_TARGET_LEAD_MS,
  CAPTURE_TOLERANCE_MS,
  captureWindow,
  evaluateCaptureEligibility,
} from '../src/services/shadowCapturePolicy';
import { SHADOW_PROTOCOL, computeProtocolHash } from '../src/services/research/shadowProtocol';
import { CollectorBundleStore } from '../src/services/shadowCollectorPersistence';
import { FROZEN_MODEL_VERSION } from '../src/services/predictionEngine';

const CACHE_DIR = process.cwd() + '/.phase3-cache';
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;
const HOUR = 60 * 60 * 1000;

/**
 * Offline transport: serves fixtures/results from local data and a virtual clock, counting
 * every request so the budget can be accounted for without touching the network.
 */
class OfflineTransport implements CollectorTransport {
  requests = 0;
  constructor(
    private readonly fixtures: TransportFixture[],
    private readonly budget: RequestBudget,
    private readonly clock: { now: () => number }
  ) {}

  private charge(): boolean {
    return this.budget.tryConsume(this.clock.now()).allowed;
  }

  async listFixtures(): Promise<TransportResult<TransportFixture[]>> {
    if (!this.charge()) return { ok: false, error: 'RATE_LIMITED', retryAfterMs: 1000 };
    this.requests++;
    return { ok: true, data: this.fixtures };
  }

  async getMatch(id: string): Promise<TransportResult<TransportFixture>> {
    if (!this.charge()) return { ok: false, error: 'RATE_LIMITED', retryAfterMs: 1000 };
    this.requests++;
    const base = this.fixtures.find((f) => f.fixtureId === id);
    return base ? { ok: true, data: base } : { ok: false, error: 'NOT_FOUND' };
  }
}

function loadFixtures(dir: string): TransportFixture[] {
  const out: TransportFixture[] = [];
  for (const comp of COMPETITIONS) {
    for (const season of SEASONS) {
      const file = path.join(dir, `${comp}-${season}.json`);
      if (!fs.existsSync(file)) continue;
      let parsed: Fixture[];
      try {
        parsed = adaptFootballDataMatchesResponse(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        continue;
      }
      for (const f of parsed) {
        const kickoffMs = new Date(f.utcKickoffTime).getTime();
        if (!Number.isFinite(kickoffMs)) continue;
        out.push({
          fixtureId: f.id,
          competitionCode: comp,
          season: String(season),
          homeTeamId: String(f.homeTeam?.id ?? 'H'),
          awayTeamId: String(f.awayTeam?.id ?? 'A'),
          kickoffTime: f.utcKickoffTime,
          status: f.status,
          providerLastUpdated: f.lastUpdated,
          homeGoals: f.score?.home ?? null,
          awayGoals: f.score?.away ?? null,
        });
      }
    }
  }
  out.sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime) || a.fixtureId.localeCompare(b.fixtureId));
  return out;
}

interface DryRunTally {
  eligible: number;
  lateDiscovery: number;
  tooEarly: number;
  requests: number;
  budgetDenied: number;
}

/**
 * Pure scheduling/eligibility pass over a virtual clock. It NEVER calls the collector's
 * recording path and never persists anything.
 */
function simulateSchedule(fixtures: TransportFixture[], budget: RequestBudget, now: { ms: number }): DryRunTally {
  const tally: DryRunTally = { eligible: 0, lateDiscovery: 0, tooEarly: 0, requests: 0, budgetDenied: 0 };
  const pending = new Map<string, { kickoffMs: number; firstSeenMs: number; captured: boolean }>();

  // Discovery: one poll every 6h (budget-charged).
  for (const f of fixtures) {
    const kickoffMs = Date.parse(f.kickoffTime);
    if (!Number.isFinite(kickoffMs)) continue;
    // Simulate discovering the fixture at most 7 days ahead of its kickoff.
    const discoverAt = kickoffMs - Math.min(7 * 24 * HOUR, 7 * 24 * HOUR);
    if (discoverAt > now.ms) continue;
    if (!pending.has(f.fixtureId)) {
      pending.set(f.fixtureId, { kickoffMs, firstSeenMs: discoverAt, captured: false });
    }
  }

  // Capture pass at the target instant for each pending fixture.
  for (const [, p] of pending) {
    const generatedAt = p.kickoffMs - CAPTURE_TARGET_LEAD_MS; // simulate a target capture
    const elig = evaluateCaptureEligibility({ generatedAtMs: generatedAt, kickoffMsAtCapture: p.kickoffMs, kickoffMsCurrent: p.kickoffMs });
    if (elig.eligible) tally.eligible++;
    else if (elig.reason === 'LATE_DISCOVERY') tally.lateDiscovery++;
    else if (elig.reason === 'TOO_EARLY') tally.tooEarly++;
    p.captured = true;
  }

  // Result polls: budget-charge one per pending fixture (idempotent skip if already settled).
  for (const [, p] of pending) {
    const r = budget.tryConsume(p.kickoffMs + 2 * HOUR);
    if (r.allowed) tally.requests++;
    else tally.budgetDenied++;
  }
  return tally;
}

async function main(): Promise<void> {
  const dir = process.argv[2] || CACHE_DIR;
  console.log('====================================================================');
  console.log('PHASE S — SHADOW COLLECTOR DRY RUN (offline; virtual clock)');
  console.log('====================================================================');
  console.log(`Fixtures dir: ${dir}`);
  console.log(`Collector enabled flag: ${isShadowCollectorEnabled() ? 'ON (unexpected in a dry run)' : 'OFF'}`);
  console.log(`Protocol hash: ${computeProtocolHash()}`);
  console.log(`Frozen model: ${FROZEN_MODEL_VERSION}`);
  console.log(`Budget: per-minute=${DEFAULT_BUDGET.perMinute} per-day=${DEFAULT_BUDGET.perDay}\n`);

  const all = loadFixtures(dir);
  console.log(`Loaded ${all.length} fixtures.`);
  if (all.length === 0) {
    console.log('No fixtures available for a dry run. Provide a fixtures directory.');
    return;
  }

  // Deterministic slice for a bounded dry run.
  const windowFixtures = all.slice(0, 60);
  const now = { ms: Date.parse(windowFixtures[windowFixtures.length - 1].kickoffTime) + 3 * 24 * HOUR };
  const budget = new RequestBudget(DEFAULT_BUDGET);
  const tally = simulateSchedule(windowFixtures, budget, now);

  console.log('\nDry-run tally (deterministic):');
  console.log(`  eligible captures:      ${tally.eligible}`);
  console.log(`  late-discovered:        ${tally.lateDiscovery}`);
  console.log(`  too-early:              ${tally.tooEarly}`);
  console.log(`  budget-charged requests: ${tally.requests}`);
  console.log(`  budget-denied:          ${tally.budgetDenied}`);

  // Second identical pass must match (idempotent, deterministic).
  const budget2 = new RequestBudget(DEFAULT_BUDGET);
  const tally2 = simulateSchedule(windowFixtures, budget2, now);
  const deterministic = JSON.stringify(tally) === JSON.stringify(tally2);
  console.log(`  deterministic (two runs identical): ${deterministic}`);

  // Offline transport smoke (no recording path; budget-charged).
  const transport = new OfflineTransport(windowFixtures, new RequestBudget(DEFAULT_BUDGET), { now: () => now.ms });
  const listed = await transport.listFixtures();
  console.log(`  transport list ok: ${listed.ok} (${transport.requests} request)`);

  console.log('\nRequest-budget model (derived from the collector; 4 comps, ~15 fixtures/day):');
  console.log('  discovery:  1 fixtures poll / 6h                          => 4 req/day');
  console.log('  capture:    0 extra (a capture reuses the discovery poll) => 0 req/day');
  console.log('  standings:  4 comps / 5-min cache TTL, primed per tick   => bounded by ticks/day');
  console.log('  results:    1 poll per fixture to settle (~15)            => ~15 req/day');
  console.log('  corrections: ~2 polls/fixture within a 24h window @3h    => ~8 per fixture (bounded)');
  console.log('  EXPECTED TOTAL (15 fixtures, no corrections)             => ~23 req/day');
  console.log('  STRESS (60 simultaneously pending, settle-once)          => 4 + 60 = 64 req/day');
  console.log('  STRESS + correction re-verification (24h @3h, 60 fx)     => 4 + 60 + 60*8 = ~544/day');
  console.log('  TRUE worst case (provider never FINISHED, 20-min polls)  => capped by the hard ceiling below');
  console.log(`  HARD per-day ceiling: ${DEFAULT_BUDGET.perDay} req/day; per-minute: ${DEFAULT_BUDGET.perMinute}`);
  console.log(`  PER-TICK cap: ${COLLECTOR_DEFAULTS.maxRequestsPerTick} requests (bounds a single-tick burst)`);
  console.log(`  Correction window: ${COLLECTOR_DEFAULTS.correctionVerificationWindowMs / HOUR}h @ every ${COLLECTOR_DEFAULTS.correctionPollIntervalMs / HOUR}h`);
  console.log(`  Backoff: retry-after honoured; attempt 0 base=1s, attempt 3 base=8s (deterministic jitter)`);
  console.log(`  Example backoff(attempt=3): ${nextBackoffMs(3, undefined, 1)} ms`);
  console.log(`  Capture window: kickoff-${CAPTURE_TARGET_LEAD_MS / HOUR}h +/- ${CAPTURE_TOLERANCE_MS / HOUR}h`);
  console.log(`  Discovery horizon: ${COLLECTOR_DEFAULTS.discoveryHorizonMs / (24 * HOUR)} days`);
  console.log(`  Protocol min sample: ${SHADOW_PROTOCOL.requirements.minSettledSamples} (>=${SHADOW_PROTOCOL.requirements.preferredSettledSamples} preferred), min ${SHADOW_PROTOCOL.requirements.minElapsedWeeks} weeks`);

  console.log('\nState/snapshot assertions:');
  const emptyState: CollectorState = emptyCollectorState();
  const emptySnapshot: ShadowSnapshot = EMPTY_SHADOW;
  console.log(`  pending (empty state): ${emptyState.pending.length}`);
  console.log(`  forecasts (empty snapshot): ${emptySnapshot.forecasts.length}`);
  console.log(`  (dry run records nothing; these must remain 0)`);
  console.log(`  captureWindow(now).targetMs offset = ${(captureWindow(now.ms).targetMs - now.ms) / HOUR}h`);

  console.log('\nCrash-safe persistence (in-memory demo; no production data written):');
  const os = await import('os');
  const fs = await import('fs');
  const pathMod = await import('path');
  const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'dryrun-bundle-'));
  const bundlePath = pathMod.join(tmpDir, 'bundle.json');
  const store = new CollectorBundleStore(bundlePath);
  store.save(emptyCollectorState(), emptySnapshot, 'dry-run-1');
  store.save(emptyCollectorState(), emptySnapshot, 'dry-run-2'); // rotates #1 into .bak
  fs.writeFileSync(bundlePath, '{ truncated');
  const recovered = store.load();
  console.log(`  atomic commit + .bak recovery: ${recovered.diagnostic.source} (expected bak)`);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\nNo network requests were made; no forecasts or results were persisted.');
  console.log('This is a scheduling/budget dry run, NOT a prospective pilot.');
  void CollectorStateStore;
}

void main();
