/**
 * Project Touchline – Phase T2 corrective tests (OFFLINE, deterministic)
 *
 * Covers the Phase T corrective design:
 *  - Standings-aware ForecastProvider (frozen engine inputs, cache, budget, eligibility).
 *  - Provider result corrections (post-settlement verification, lastUpdated, finality rule).
 *  - Crash-safe combined persistence (atomic commit, .bak recovery, schema rejection).
 *  - Request budgets (per-tick cap, verification accounting, exhaustion).
 *  - Rescheduling, duplicate ids / provider conflicts, stale season, clock jumps, retries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StandingsForecastProvider, StandingsSource, buildEngineFixture } from '../src/services/shadowForecastProvider';
import { CollectorBundleStore, emptyBundle, BUNDLE_SCHEMA_VERSION } from '../src/services/shadowCollectorPersistence';
import {
  ShadowCollector,
  RequestBudget,
  CollectorState,
  emptyCollectorState,
  TransportFixture,
  TransportResult,
  CollectorTransport,
  ForecastProvider,
  DEFAULT_BUDGET,
} from '../src/services/shadowCollector';
import { EMPTY_SHADOW, ShadowSnapshot } from '../src/services/shadowLedger';
import { CAPTURE_TARGET_LEAD_MS } from '../src/services/shadowCapturePolicy';
import { CompetitionStandings } from '../src/types/football';
import { ProbabilityTriplet } from '../src/services/predictionMetrics';

const HOUR = 60 * 60 * 1000;
const KICKOFF_MS = Date.parse('2025-09-10T15:00:00Z');
const FROZEN: ProbabilityTriplet = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };

function standings(code: string, played = 10): CompetitionStandings {
  const team = (id: string) => ({ id, name: id, shortName: id, tla: id, playedGames: played });
  return {
    competition: { id: code, name: code, code, type: 'LEAGUE', country: '', season: '2025/26' },
    season: { startDate: '2025-08-01', endDate: '2026-05-01', currentMatchday: 8 },
    table: [
      { position: 1, team: team('H'), playedGames: played, form: 'W,W,D', won: 6, draw: 2, lost: 2, points: 20, goalsFor: 18, goalsAgainst: 10, goalDifference: 8 },
      { position: 2, team: team('A'), playedGames: played, form: 'L,W,W', won: 5, draw: 3, lost: 2, points: 18, goalsFor: 15, goalsAgainst: 11, goalDifference: 4 },
      { position: 3, team: team('X'), playedGames: played, form: 'D,D,L', won: 3, draw: 3, lost: 4, points: 12, goalsFor: 10, goalsAgainst: 14, goalDifference: -4 },
    ],
  } as CompetitionStandings;
}

function tf(overrides: Partial<TransportFixture> = {}): TransportFixture {
  return {
    fixtureId: 'fd-1', competitionCode: 'PL', season: '2025/26',
    homeTeamId: 'H', awayTeamId: 'A', kickoffTime: new Date(KICKOFF_MS).toISOString(),
    status: 'SCHEDULED', providerLastUpdated: new Date(KICKOFF_MS - 48 * HOUR).toISOString(),
    ...overrides,
  };
}

class StubStandingsSource implements StandingsSource {
  calls: string[] = [];
  constructor(private readonly data: Record<string, CompetitionStandings | null>, private readonly fail?: boolean) {}
  async getStandings(code: string): Promise<TransportResult<CompetitionStandings | null>> {
    this.calls.push(code);
    if (this.fail) return { ok: false, error: 'SERVER_ERROR' };
    return { ok: true, data: this.data[code] ?? null };
  }
}

describe('standings-aware ForecastProvider', () => {
  it('primes standings, caches them, and computes frozen probabilities via the engine', async () => {
    const src = new StubStandingsSource({ PL: standings('PL') });
    const p = new StandingsForecastProvider({ standings: src, budget: new RequestBudget(DEFAULT_BUDGET) });
    const now = KICKOFF_MS - 30 * HOUR;
    const r = await p.primeStandings(['PL', 'pl'], now);
    expect(r.fetched).toEqual(['PL']);
    expect(src.calls.length).toBe(1); // deduped
    const probs = p.frozenProbabilities(tf());
    expect(probs).not.toBeNull();
    expect(probs!.homeWin + probs!.draw + probs!.awayWin).toBeCloseTo(1, 2);
    // Cached: a second prime within TTL does not refetch.
    await p.primeStandings(['PL'], now + 1000);
    expect(src.calls.length).toBe(1);
  });

  it('returns null when standings are not primed', () => {
    const p = new StandingsForecastProvider({ standings: new StubStandingsSource({ PL: standings('PL') }) });
    expect(p.frozenProbabilities(tf())).toBeNull();
  });

  it('returns null for an unsupported competition', async () => {
    const src = new StubStandingsSource({ EK: standings('EK') });
    const p = new StandingsForecastProvider({ standings: src });
    await p.primeStandings(['EK'], KICKOFF_MS - 30 * HOUR);
    expect(p.frozenProbabilities(tf({ competitionCode: 'EK' }))).toBeNull();
  });

  it('returns null on cold start (fewer than 3 games played)', async () => {
    const src = new StubStandingsSource({ PL: standings('PL', 2) });
    const p = new StandingsForecastProvider({ standings: src });
    await p.primeStandings(['PL'], KICKOFF_MS - 30 * HOUR);
    expect(p.frozenProbabilities(tf())).toBeNull();
  });

  it('returns null when a team is unranked in the table', async () => {
    const src = new StubStandingsSource({ PL: standings('PL') });
    const p = new StandingsForecastProvider({ standings: src });
    await p.primeStandings(['PL'], KICKOFF_MS - 30 * HOUR);
    expect(p.frozenProbabilities(tf({ homeTeamId: 'NOPE' }))).toBeNull();
  });

  it('respects the budget: a denied prime leaves standings uncached', async () => {
    const src = new StubStandingsSource({ PL: standings('PL') });
    const budget = new RequestBudget({ perMinute: 10, perDay: 1 });
    const p = new StandingsForecastProvider({ standings: src, budget });
    await p.primeStandings(['PL'], KICKOFF_MS - 30 * HOUR); // consumes the single slot
    const r2 = await p.primeStandings(['PD'], KICKOFF_MS - 30 * HOUR + 1000);
    expect(r2.denied).toEqual(['PD']);
    expect(src.calls).toEqual(['PL']);
    expect(p.frozenProbabilities(tf({ competitionCode: 'PD' }))).toBeNull();
  });

  it('reports an error without caching when the source fails', async () => {
    const p = new StandingsForecastProvider({ standings: new StubStandingsSource({ PL: standings('PL') }, true) });
    const r = await p.primeStandings(['PL'], KICKOFF_MS - 30 * HOUR);
    expect(r.errors.length).toBe(1);
    expect(p.frozenProbabilities(tf())).toBeNull();
  });

  it('buildEngineFixture produces a SCHEDULED fixture with the given identity', () => {
    const f = buildEngineFixture(tf());
    expect(f.status).toBe('SCHEDULED');
    expect(f.id).toBe('fd-1');
    expect(f.homeTeam.id).toBe('H');
    expect(f.competition.code).toBe('PL');
  });

  it('calibrationFor returns null during cold start and reports minSamples', () => {
    const p = new StandingsForecastProvider({ standings: new StubStandingsSource({}), snapshot: () => EMPTY_SHADOW, minSamples: 500 });
    expect(p.calibrationFor(KICKOFF_MS)).toBeNull();
    expect(p.calibrationHistory(KICKOFF_MS)).toEqual([]);
  });
});

// ---------- collector-level fixtures ----------

class ScriptedTransport implements CollectorTransport {
  listCalls = 0;
  matchCalls = 0;
  constructor(public fixtures: TransportFixture[], public matches: Map<string, TransportResult<TransportFixture>>) {}
  async listFixtures(): Promise<TransportResult<TransportFixture[]>> { this.listCalls++; return { ok: true, data: this.fixtures }; }
  async getMatch(id: string): Promise<TransportResult<TransportFixture>> { this.matchCalls++; return this.matches.get(id) ?? { ok: false, error: 'NOT_FOUND' }; }
}

function provider(): ForecastProvider {
  return {
    frozenProbabilities: () => FROZEN,
    calibrationHistory: () => [],
    calibrationFor: () => ({ temperature: 1.4, sampleCount: 900, fittedThroughMs: KICKOFF_MS - 10 * 24 * HOUR, fallback: false, minSamples: 500 }),
    sourceInfo: () => ({ provider: 'football-data.org' }),
  };
}

describe('correction handling and finality', () => {
  it('re-polls a settled fixture and appends a correction when the score changes', async () => {
    const t = new ScriptedTransport([tf()], new Map([
      ['fd-1', { ok: true, data: tf({ status: 'FINISHED', homeGoals: 2, awayGoals: 1, providerLastUpdated: new Date(KICKOFF_MS + 2 * HOUR).toISOString() }) }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0, correctionPollIntervalMs: 0, correctionVerificationWindowMs: 48 * HOUR });
    let state = emptyCollectorState();
    let snap: ShadowSnapshot = EMPTY_SHADOW;
    let out = await c.runOnce(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS, state, snap, true);
    state = out.state; snap = out.snapshot;
    // First settlement.
    out = await c.runOnce(KICKOFF_MS + 2 * HOUR, state, snap, true);
    state = out.state; snap = out.snapshot;
    expect(out.diagnostic.settlements).toBe(1);
    expect(snap.results[0].revisions.length).toBe(1);
    // Provider corrects the score; a later tick re-verifies and appends a revision.
    t.matches.set('fd-1', { ok: true, data: tf({ status: 'FINISHED', homeGoals: 0, awayGoals: 0, providerLastUpdated: new Date(KICKOFF_MS + 5 * HOUR).toISOString() }) });
    out = await c.runOnce(KICKOFF_MS + 5 * HOUR, state, snap, true);
    expect(out.diagnostic.corrections).toBe(1);
    expect(out.snapshot.results[0].revisions.length).toBe(2);
    expect(out.diagnostic.verifications).toBeGreaterThan(0);
  });

  it('finalizes a settled fixture after the verification window and stops re-polling', async () => {
    const t = new ScriptedTransport([tf()], new Map([
      ['fd-1', { ok: true, data: tf({ status: 'FINISHED', homeGoals: 1, awayGoals: 0 }) }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0, correctionPollIntervalMs: 0, correctionVerificationWindowMs: 2 * HOUR });
    let state = emptyCollectorState();
    let snap: ShadowSnapshot = EMPTY_SHADOW;
    let out = await c.runOnce(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS, state, snap, true);
    state = out.state; snap = out.snapshot;
    out = await c.runOnce(KICKOFF_MS + 1 * HOUR, state, snap, true);
    state = out.state; snap = out.snapshot;
    expect(state.pending[0].settled).toBe(true);
    const callsAfterSettle = t.matchCalls;
    // Past the window: finalized, no further polls.
    out = await c.runOnce(KICKOFF_MS + 4 * HOUR, state, snap, true);
    expect(out.state.pending[0].final).toBe(true);
    expect(out.diagnostic.notes.some((n) => n.startsWith('FINALIZED'))).toBe(true);
    out = await c.runOnce(KICKOFF_MS + 6 * HOUR, out.state, out.snapshot, true);
    expect(t.matchCalls).toBe(callsAfterSettle);
  });
});

describe('request budgets and per-tick cap', () => {
  it('caps requests per tick', async () => {
    const fixtures = Array.from({ length: 40 }, (_, i) => tf({ fixtureId: `fd-${i}`, kickoffTime: new Date(KICKOFF_MS + 1 * HOUR).toISOString() }));
    const matches = new Map(fixtures.map((f) => [f.fixtureId, { ok: true, data: { ...f, status: 'FINISHED', homeGoals: 1, awayGoals: 0 } } as TransportResult<TransportFixture>]));
    const t = new ScriptedTransport(fixtures, matches);
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0, resultPollIntervalMs: 0, maxRequestsPerTick: 5 });
    // Discovery tick (1 request) registers the fixtures.
    const o1 = await c.runOnce(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    // Past kickoff: 40 result polls, but the per-tick cap allows only 5.
    const out = await c.runOnce(KICKOFF_MS + 2 * HOUR, o1.state, o1.snapshot, true);
    expect(out.diagnostic.requestsAttempted).toBeLessThanOrEqual(5);
    expect(out.diagnostic.requestsCapped).toBeGreaterThan(0);
  });

  it('counts verification polls against the budget and stops at the per-day ceiling', async () => {
    const fixtures = [tf({ fixtureId: 'fd-1' }), tf({ fixtureId: 'fd-2' })];
    const t = new ScriptedTransport(fixtures, new Map([
      ['fd-1', { ok: true, data: tf({ fixtureId: 'fd-1', status: 'FINISHED', homeGoals: 1, awayGoals: 0 }) }],
      ['fd-2', { ok: true, data: tf({ fixtureId: 'fd-2', status: 'FINISHED', homeGoals: 2, awayGoals: 2 }) }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0, correctionPollIntervalMs: 0, correctionVerificationWindowMs: 48 * HOUR, budget: { perMinute: 100, perDay: 3 } });
    let state: CollectorState = emptyCollectorState();
    let snap: ShadowSnapshot = EMPTY_SHADOW;
    let denied = 0;
    for (let i = 0; i < 4; i++) {
      const out = await c.runOnce(KICKOFF_MS + i * 30 * 60 * 1000, state, snap, true);
      state = out.state; snap = out.snapshot;
      denied += out.diagnostic.requestsDenied;
    }
    expect(denied).toBeGreaterThan(0);
  });
});

describe('crash-safe combined persistence', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2-bundle-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips state and snapshot together', () => {
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    const state: CollectorState = { ...emptyCollectorState(), lastDiscoveryMs: 42 };
    const r = store.save(state, EMPTY_SHADOW, 'tick');
    expect(r.ok).toBe(true);
    const loaded = store.load();
    expect(loaded.bundle.state.lastDiscoveryMs).toBe(42);
    expect(loaded.bundle.commit).toBe(1);
    expect(loaded.diagnostic.source).toBe('main');
  });

  it('recovers the previous good bundle from .bak after a corrupt main write', () => {
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    store.save({ ...emptyCollectorState(), lastDiscoveryMs: 1 }, EMPTY_SHADOW);
    store.save({ ...emptyCollectorState(), lastDiscoveryMs: 2 }, EMPTY_SHADOW); // writes .bak of #1
    fs.writeFileSync(store.mainPath, '{ truncated');
    const loaded = store.load();
    expect(loaded.diagnostic.source).toBe('bak');
    expect(loaded.bundle.state.lastDiscoveryMs).toBe(1);
  });

  it('rejects a bundle with an incompatible schema version', () => {
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    store.save(emptyCollectorState(), EMPTY_SHADOW);
    const raw = JSON.parse(fs.readFileSync(store.mainPath, 'utf8'));
    raw.shadowSchemaVersion = 999;
    fs.writeFileSync(store.mainPath, JSON.stringify(raw));
    const loaded = store.load();
    expect(loaded.diagnostic.source).toBe('empty');
    expect(loaded.bundle.bundleSchemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
  });

  it('an interrupted write (tmp file only) leaves the last good bundle intact', () => {
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    store.save({ ...emptyCollectorState(), lastDiscoveryMs: 7 }, EMPTY_SHADOW);
    // Simulate a crash mid-write: a stale temp file exists, main is untouched.
    fs.writeFileSync(`${store.mainPath}.tmp-999`, '{ partial');
    const loaded = store.load();
    expect(loaded.diagnostic.source).toBe('main');
    expect(loaded.bundle.state.lastDiscoveryMs).toBe(7);
  });
});

describe('discovery edge cases', () => {
  it('flags conflicting provider records for the same id', async () => {
    const a = tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 12 * HOUR).toISOString() });
    const b = tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 30 * HOUR).toISOString(), homeTeamId: 'Z' });
    const t = new ScriptedTransport([a, b], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0 });
    const out = await c.runOnce(KICKOFF_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.notes.some((n) => n.startsWith('PROVIDER_CONFLICT:dup'))).toBe(true);
  });

  it('ignores fixtures beyond the discovery horizon', async () => {
    const t = new ScriptedTransport([tf({ fixtureId: 'far', kickoffTime: new Date(KICKOFF_MS + 30 * 24 * HOUR).toISOString() })], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0 });
    const out = await c.runOnce(KICKOFF_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.state.pending.length).toBe(0);
  });

  it('detects a backward clock jump and stops recording', async () => {
    const t = new ScriptedTransport([tf()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), clockJumpToleranceMs: 60_000 });
    const state: CollectorState = { ...emptyCollectorState(), lastTickMs: KICKOFF_MS };
    const out = await c.runOnce(KICKOFF_MS - 10 * 60_000, state, EMPTY_SHADOW, true);
    expect(out.diagnostic.skipped).toBe('CLOCK_JUMP');
    expect(t.listCalls).toBe(0);
  });

  it('exhausts retries with backoff on repeated provider errors without settling', async () => {
    const t = new ScriptedTransport([tf()], new Map([
      ['fd-1', { ok: false, error: 'SERVER_ERROR' }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0, budget: { perMinute: 100, perDay: 100 } });
    let state = emptyCollectorState();
    let snap: ShadowSnapshot = EMPTY_SHADOW;
    let out = await c.runOnce(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS, state, snap, true);
    state = out.state; snap = out.snapshot;
    for (let i = 0; i < 3; i++) {
      out = await c.runOnce(KICKOFF_MS + 2 * HOUR + i * HOUR, state, snap, true);
      state = out.state; snap = out.snapshot;
    }
    expect(snap.results.length).toBe(0);
    expect(out.diagnostic.notes.some((n) => n.includes('backoff='))).toBe(true);
    expect(state.pending[0].attempts).toBeGreaterThan(0);
  });

  it('records a reschedule as a new version and supersedes the old', async () => {
    const t = new ScriptedTransport([tf()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0 });
    const discoverAt = KICKOFF_MS - 27 * HOUR;
    const o1 = await c.runOnce(discoverAt, emptyCollectorState(), EMPTY_SHADOW, true);
    t.fixtures = [tf({ kickoffTime: new Date(KICKOFF_MS + 3 * 24 * HOUR).toISOString() })];
    const o2 = await c.runOnce(discoverAt + HOUR, o1.state, o1.snapshot, true);
    expect(o2.state.pending.filter((p) => p.superseded).length).toBe(1);
    expect(o2.state.pending.some((p) => !p.superseded)).toBe(true);
  });

  it('stores the provider season verbatim (stale metadata is visible, not silently corrected)', async () => {
    const t = new ScriptedTransport([tf({ season: '2024/25' })], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0 });
    const out = await c.runOnce(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.state.pending[0].season).toBe('2024/25');
    expect(out.snapshot.forecasts[0].season).toBe('2024/25');
  });

  it('records the provider minSamples in the capture (calibration reporting fix)', async () => {
    const t = new ScriptedTransport([tf()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0 });
    const out = await c.runOnce(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.snapshot.forecasts[0].calibration.minSamples).toBe(500);
  });
});
