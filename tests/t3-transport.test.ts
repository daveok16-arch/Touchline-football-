/**
 * Project Touchline – Phase T3 tests (OFFLINE, deterministic)
 *
 * Covers the approved transport work:
 *  1. Durable daily request budget: persisted in the atomic bundle, restored on restart, so a
 *     restart cannot bypass the per-day ceiling.
 *  2. HTTP collector transport + standings source over same-origin endpoints, with strict
 *     validation, timeout, bounded retries, Retry-After parsing and error mapping.
 *  3. Fixture identity quarantine and forward-clock anomaly recording.
 *
 * No network I/O: the transport takes an injected mock fetch; sleep is a no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ShadowCollector,
  RequestBudget,
  emptyCollectorState,
  TransportFixture,
  TransportResult,
  CollectorTransport,
  ForecastProvider,
  DEFAULT_BUDGET,
} from '../src/services/shadowCollector';
import { CollectorBundleStore } from '../src/services/shadowCollectorPersistence';
import { EMPTY_SHADOW, ShadowSnapshot } from '../src/services/shadowLedger';
import {
  HttpShadowTransport,
  HttpStandingsSource,
  createShadowHttpAdapters,
  checkTransportConfig,
  parseRetryAfterMs,
  toTransportFixture,
} from '../src/services/shadowHttpTransport';
import { CAPTURE_TARGET_LEAD_MS } from '../src/services/shadowCapturePolicy';
import { ProbabilityTriplet } from '../src/services/predictionMetrics';

const HOUR = 60 * 60 * 1000;
const KICKOFF_MS = Date.parse('2025-09-10T15:00:00Z');
const GEN_MS = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS;
const FROZEN: ProbabilityTriplet = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };

function tf(overrides: Partial<TransportFixture> = {}): TransportFixture {
  return {
    fixtureId: 'fd-1', competitionCode: 'PL', season: '2025/26',
    homeTeamId: 'H', awayTeamId: 'A', kickoffTime: new Date(KICKOFF_MS).toISOString(),
    status: 'SCHEDULED', providerLastUpdated: new Date(KICKOFF_MS - 48 * HOUR).toISOString(),
    ...overrides,
  };
}

class ScriptedTransport implements CollectorTransport {
  listCalls = 0;
  matchCalls = 0;
  constructor(public fixtures: TransportFixture[], public matches: Map<string, TransportResult<TransportFixture>>) {}
  async listFixtures(): Promise<TransportResult<TransportFixture[]>> { this.listCalls++; return { ok: true, data: this.fixtures }; }
  async getMatch(id: string): Promise<TransportResult<TransportFixture>> { this.matchCalls++; return this.matches.get(id) ?? { ok: false, error: 'NOT_FOUND' }; }
}

const provider: ForecastProvider = {
  frozenProbabilities: () => FROZEN,
  calibrationHistory: () => [],
  calibrationFor: () => null,
  sourceInfo: () => ({ provider: 'football-data.org' }),
};

// ---------- 1. Durable daily budget ----------

describe('T3 – durable daily request budget', () => {
  it('RequestBudget round-trips its daily counter via toPersisted/restorePersisted', () => {
    const cfg = { perMinute: 100, perDay: 5 };
    const b1 = new RequestBudget(cfg);
    const now = KICKOFF_MS;
    for (let i = 0; i < 3; i++) expect(b1.tryConsume(now).allowed).toBe(true);
    const p = b1.toPersisted(now);

    const b2 = new RequestBudget(cfg);
    b2.restorePersisted(p, now);
    // Two more allowed, then the ceiling is hit at 5 (not 3+5=8).
    expect(b2.tryConsume(now).allowed).toBe(true);
    expect(b2.tryConsume(now).allowed).toBe(true);
    expect(b2.tryConsume(now).allowed).toBe(false);
    expect(b2.canConsume(now).reason).toBe('PER_DAY');
  });

  it('ignores a counter from a previous day and clamps a corrupt counter to the ceiling', () => {
    const cfg = { perMinute: 100, perDay: 5 };
    const b = new RequestBudget(cfg);
    b.restorePersisted({ dayKey: '2000-01-01', dayCount: 999 }, KICKOFF_MS);
    expect(b.snapshot(KICKOFF_MS).usedToday).toBe(0); // previous day -> fresh
    b.restorePersisted({ dayKey: new Date(KICKOFF_MS).toISOString().slice(0, 10), dayCount: 999 }, KICKOFF_MS);
    expect(b.snapshot(KICKOFF_MS).usedToday).toBe(5); // clamped, never widened
  });

  it('adoptPersisted is monotonic (never lowers an in-process count)', () => {
    const cfg = { perMinute: 100, perDay: 10 };
    const b = new RequestBudget(cfg);
    const day = new Date(KICKOFF_MS).toISOString().slice(0, 10);
    for (let i = 0; i < 6; i++) b.tryConsume(KICKOFF_MS);
    b.adoptPersisted({ dayKey: day, dayCount: 4 }, KICKOFF_MS); // lower -> ignored
    expect(b.snapshot(KICKOFF_MS).usedToday).toBe(6);
    b.adoptPersisted({ dayKey: day, dayCount: 9 }, KICKOFF_MS); // higher -> adopted
    expect(b.snapshot(KICKOFF_MS).usedToday).toBe(9);
  });

  it('a collector restart cannot bypass the daily ceiling (persisted state)', async () => {
    const cfg = { perMinute: 100, perDay: 2 };
    const fixtures = [tf({ fixtureId: 'fd-1' }), tf({ fixtureId: 'fd-2' }), tf({ fixtureId: 'fd-3' })];
    const t = new ScriptedTransport(fixtures, new Map());

    const c1 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, resultPollIntervalMs: 0, budget: cfg });
    const o1 = await c1.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o1.state.pending.length).toBe(3);
    expect(o1.state.budget).toMatchObject({ dayKey: new Date(GEN_MS).toISOString().slice(0, 10), dayCount: 1 });
    expect(o1.state.budget?.minuteStamps?.length).toBe(1);

    // Persist the carried state and "restart" with a fresh collector.
    const c2 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, resultPollIntervalMs: 0, budget: cfg });
    const o2 = await c2.runOnce(KICKOFF_MS + 1 * HOUR, o1.state, o1.snapshot, true);
    // Ceiling of 2 reached after one more request; further polls denied.
    expect(o2.diagnostic.requestsDenied).toBeGreaterThan(0);

    const o3 = await c2.runOnce(KICKOFF_MS + 2 * HOUR, o2.state, o2.snapshot, true);
    expect(o3.diagnostic.requestsDenied).toBeGreaterThan(0);
    expect(o3.diagnostic.requestsAttempted).toBe(0);
  });

  it('round-trips the budget counter through the atomic bundle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-budget-'));
    try {
      const store = new CollectorBundleStore(path.join(dir, 'b.json'));
      const day = new Date(KICKOFF_MS).toISOString().slice(0, 10);
      const state = { ...emptyCollectorState(), budget: { dayKey: day, dayCount: 17 } };
      expect(store.save(state, EMPTY_SHADOW).ok).toBe(true);
      const loaded = store.load().bundle;
      expect(loaded.state.budget).toMatchObject({ dayKey: day, dayCount: 17 });
      const b = new RequestBudget(DEFAULT_BUDGET);
      b.restorePersisted(loaded.state.budget, KICKOFF_MS);
      expect(b.snapshot(KICKOFF_MS).usedToday).toBe(17);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a large forward clock jump halts the tick (no silent advance of research state)', async () => {
    const t = new ScriptedTransport([tf()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, clockJumpToleranceMs: 60_000, maxForwardJumpMs: 60_000, discoveryIntervalMs: 0 });
    const state = { ...emptyCollectorState(), lastTickMs: KICKOFF_MS };
    const out = await c.runOnce(KICKOFF_MS + 2 * HOUR, state, EMPTY_SHADOW, true);
    expect(out.diagnostic.skipped).toBe('CLOCK_FORWARD_JUMP');
    expect(out.diagnostic.notes.some((n) => n.startsWith('CLOCK_FORWARD_JUMP'))).toBe(true);
    expect(t.listCalls).toBe(0); // no request issued
    expect(out.state).toBe(state); // state untouched
  });
});

// ---------- 2. Fixture identity quarantine ----------

describe('T3 – fixture identity quarantine', () => {
  it('quarantines a same-id record with conflicting teams and persists the quarantine', async () => {
    const a = tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 12 * HOUR).toISOString(), homeTeamId: 'H' });
    const b = tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 12 * HOUR).toISOString(), homeTeamId: 'Z' });
    const t = new ScriptedTransport([a, b], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0 });
    const out = await c.runOnce(KICKOFF_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.notes.some((n) => n.startsWith('PROVIDER_CONFLICT:dup'))).toBe(true);
    expect(out.diagnostic.notes.some((n) => n.startsWith('QUARANTINED:dup'))).toBe(true);
    expect(out.state.pending.some((p) => p.fixtureId === 'dup')).toBe(false);
    expect(out.state.quarantined).toContain('dup');

    // A later clean record for the same id is still refused (quarantine is sticky).
    t.fixtures = [tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 12 * HOUR).toISOString(), homeTeamId: 'H' })];
    const o2 = await c.runOnce(KICKOFF_MS + 1 * HOUR, out.state, out.snapshot, true);
    expect(o2.state.pending.some((p) => p.fixtureId === 'dup')).toBe(false);
    expect(o2.diagnostic.notes.some((n) => n.startsWith('QUARANTINE_SKIP:dup'))).toBe(true);
  });

  it('a pure reschedule (same teams, new kickoff) is NOT treated as a conflict', async () => {
    const t = new ScriptedTransport([tf({ fixtureId: 'fd-9' })], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0 });
    const o1 = await c.runOnce(KICKOFF_MS - 27 * HOUR, emptyCollectorState(), EMPTY_SHADOW, true);
    t.fixtures = [tf({ fixtureId: 'fd-9', kickoffTime: new Date(KICKOFF_MS + 3 * 24 * HOUR).toISOString() })];
    const o2 = await c.runOnce(KICKOFF_MS - 26 * HOUR, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.notes.some((n) => n.startsWith('RESCHEDULED:fd-9'))).toBe(true);
    expect(o2.diagnostic.notes.some((n) => n.startsWith('QUARANTINED'))).toBe(false);
  });
});

// ---------- 3. HTTP transport (mocked fetch) ----------

interface MockCall { url: string; signal?: AbortSignal }

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { impl: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const impl = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal ?? undefined });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

describe('T3 – HTTP transport error mapping and validation', () => {
  it('maps 404 to NOT_FOUND, 429 to RATE_LIMITED with Retry-After, 500 to SERVER_ERROR', async () => {
    const cases: Array<{ status: number; headers?: Record<string, string>; error: string; retryAfterMs?: number }> = [
      { status: 404, error: 'NOT_FOUND' },
      { status: 429, headers: { 'retry-after': '30' }, error: 'RATE_LIMITED', retryAfterMs: 30_000 },
      { status: 500, error: 'SERVER_ERROR' },
    ];
    for (const c of cases) {
      const { impl } = mockFetch(() => jsonResponse({ error: 'x' }, c.status, c.headers));
      const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep, maxRetries: 0 });
      const res = await tx.getMatch('fd-1', KICKOFF_MS);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe(c.error);
        if (c.retryAfterMs !== undefined) expect(res.retryAfterMs).toBe(c.retryAfterMs);
      }
    }
  });

  it('retries NETWORK/SERVER_ERROR up to maxRetries, then gives up (429/404 are not retried)', async () => {
    let n = 0;
    const { impl, calls } = mockFetch(() => { n++; return n < 3 ? jsonResponse({}, 500) : jsonResponse({ configured: true, match: { id: 'fd-1', utcKickoffTime: tf().kickoffTime, homeTeam: { id: 'H' }, awayTeam: { id: 'A' }, competition: { code: 'PL' }, status: 'FINISHED', score: { home: 1, away: 0 } } }); });
    const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
    const res = await tx.getMatch('fd-1', KICKOFF_MS);
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(3); // two failures + one success

    let m = 0;
    const { impl: impl429, calls: calls429 } = mockFetch(() => { m++; return jsonResponse({}, 429, { 'retry-after': '5' }); });
    const tx2 = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl429, sleep: noSleep, maxRetries: 3 });
    const res2 = await tx2.getMatch('fd-1', KICKOFF_MS);
    expect(res2.ok).toBe(false);
    expect(calls429.length).toBe(1); // never retried
  });

  it('treats a malformed body as SERVER_ERROR (no fabricated fixture)', async () => {
    const { impl } = mockFetch(() => jsonResponse({ configured: true, match: { id: 123 } }, 200));
    const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep, maxRetries: 0 });
    const res = await tx.getMatch('fd-1', KICKOFF_MS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('SERVER_ERROR');
  });

  it('parses Retry-After as delta-seconds and as an HTTP-date', () => {
    const now = Date.parse('2025-09-10T12:00:00Z');
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now)).toBe(12_000);
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs('garbage', now)).toBeUndefined();
  });
});

describe('T3 – HTTP transport happy paths and mapping', () => {
  it('lists fixtures from /api/fixtures and maps fields, skipping malformed rows', async () => {
    const body = {
      configured: true, count: 3,
      matches: [
        { id: 'fd-1', utcKickoffTime: tf().kickoffTime, status: 'FINISHED', lastUpdated: '2025-09-10T17:00:00Z', competition: { code: 'PL', season: '2025/26' }, homeTeam: { id: '10' }, awayTeam: { id: '20' }, score: { home: 2, away: 1 } },
        { id: 'fd-2', utcKickoffTime: tf().kickoffTime, status: 'SCHEDULED', competition: { code: 'pl', season: '2025/26' }, homeTeam: { id: '11' }, awayTeam: { id: '21' } },
        { id: 'fd-3' }, // malformed -> skipped
      ],
    };
    const { impl, calls } = mockFetch(() => jsonResponse(body));
    const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep });
    const res = await tx.listFixtures(KICKOFF_MS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls[0].url).toBe('http://local/api/fixtures?competition=ALL');
    expect(res.data.length).toBe(2);
    expect(res.data[0]).toMatchObject({ fixtureId: 'fd-1', competitionCode: 'PL', homeTeamId: '10', awayTeamId: '20', homeGoals: 2, awayGoals: 1, providerLastUpdated: '2025-09-10T17:00:00Z' });
    expect(res.data[1].competitionCode).toBe('PL'); // upper-cased
    expect(res.data[1].homeGoals).toBeNull();
  });

  it('maps a single match from /api/matches/:id', async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({ configured: true, match: { id: 'fd-77', utcKickoffTime: tf().kickoffTime, status: 'FINISHED', competition: { code: 'PD', season: '2025/26' }, homeTeam: { id: '5' }, awayTeam: { id: '6' }, score: { home: 0, away: 0 } } }));
    const tx = new HttpShadowTransport({ baseUrl: 'http://local/', fetchImpl: impl, sleep: noSleep });
    const res = await tx.getMatch('fd-77', KICKOFF_MS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls[0].url).toBe('http://local/api/matches/fd-77');
    expect(res.data).toMatchObject({ fixtureId: 'fd-77', competitionCode: 'PD', homeGoals: 0, awayGoals: 0 });
  });

  it('returns standings from /api/standings and null when the provider has none', async () => {
    const table = { competition: { code: 'PL' }, season: { startDate: '', endDate: '' }, table: [{ position: 1 }] };
    const ok = mockFetch(() => jsonResponse({ configured: true, standings: table }));
    const src = new HttpStandingsSource({ baseUrl: 'http://local', fetchImpl: ok.impl, sleep: noSleep });
    const r1 = await src.getStandings('pl', KICKOFF_MS);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data).not.toBeNull();

    const none = mockFetch(() => jsonResponse({ configured: true, standings: null }));
    const src2 = new HttpStandingsSource({ baseUrl: 'http://local', fetchImpl: none.impl, sleep: noSleep });
    const r2 = await src2.getStandings('PL', KICKOFF_MS);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data).toBeNull();
  });

  it('toTransportFixture rejects a record missing identity', () => {
    expect(toTransportFixture({ id: 'fd-1' })).toBeNull();
    expect(toTransportFixture({ id: 'fd-1', utcKickoffTime: 'nope', homeTeam: { id: 'a' }, awayTeam: { id: 'b' } })).toBeNull();
  });
});

// ---------- 4. Fail-closed configuration ----------

describe('T3 – fail-closed startup configuration', () => {
  it('refuses to build adapters when no fixtures provider credential is configured', () => {
    const check = checkTransportConfig({});
    expect(check.ok).toBe(false);
    expect(() => createShadowHttpAdapters({ baseUrl: 'http://local' }, {})).toThrow(/refused to start/);
  });

  it('builds adapters when a credential is present', () => {
    const env = { FOOTBALL_DATA_API_KEY: 'x' };
    expect(checkTransportConfig(env).ok).toBe(true);
    const a = createShadowHttpAdapters({ baseUrl: 'http://local', fetchImpl: mockFetch(() => jsonResponse({})).impl }, env);
    expect(typeof a.transport.listFixtures).toBe('function');
    expect(typeof a.standings.getStandings).toBe('function');
  });
});

// ---------- 5. End-to-end (mocked fetch -> collector) ----------

describe('T3 – collector over the mocked HTTP transport (offline)', () => {
  it('discovers, captures and settles using only mocked same-origin responses', async () => {
    const now = GEN_MS;
    const { impl } = mockFetch((url) => {
      if (url.includes('/api/fixtures')) {
        return jsonResponse({ configured: true, matches: [{ id: 'fd-1', utcKickoffTime: new Date(KICKOFF_MS).toISOString(), status: 'SCHEDULED', competition: { code: 'PL', season: '2025/26' }, homeTeam: { id: 'H' }, awayTeam: { id: 'A' } }] });
      }
      if (url.includes('/api/matches/fd-1')) {
        return jsonResponse({ configured: true, match: { id: 'fd-1', utcKickoffTime: new Date(KICKOFF_MS).toISOString(), status: 'FINISHED', competition: { code: 'PL', season: '2025/26' }, homeTeam: { id: 'H' }, awayTeam: { id: 'A' }, score: { home: 2, away: 1 } } });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep });
    const c = new ShadowCollector({ transport: tx, forecasts: provider, discoveryIntervalMs: 0, resultPollIntervalMs: 0, budget: { perMinute: 100, perDay: 100 } });

    let snap: ShadowSnapshot = EMPTY_SHADOW;
    let out = await c.runOnce(now, emptyCollectorState(), snap, true);
    expect(out.state.pending.length).toBe(1);
    snap = out.snapshot;
    expect(snap.forecasts.length).toBe(1);

    out = await c.runOnce(KICKOFF_MS + 2 * HOUR, out.state, snap, true);
    expect(out.diagnostic.settlements).toBe(1);
    expect(out.snapshot.results.length).toBe(1);
    expect(out.snapshot.results[0].revisions[0]).toMatchObject({ homeGoals: 2, awayGoals: 1 });
  });
});
