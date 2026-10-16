/**
 * Project Touchline – Phase T3 pre-activation safety audit tests (OFFLINE, deterministic)
 *
 * Regression coverage for the audit fixes:
 *  1. Durable budget restored BEFORE any request, incl. crash-between-charge-and-commit (sink),
 *     corrupt state, backup recovery, interrupted writes.
 *  2. Per-minute window survives restart (no immediate over-limit burst).
 *  3. Forward-clock jumps cannot reset limits or advance capture/settlement/finality.
 *  4. Identity-conflict quarantine is persistent and cannot re-enter via another discovery path.
 *  5. HTTP retries cannot multiply requests beyond the shared budget; timeout is bounded.
 *
 * No network I/O: mocked fetch; no-op sleep.
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
} from '../src/services/shadowCollector';
import { CollectorBundleStore, FileBudgetSink } from '../src/services/shadowCollectorPersistence';
import { EMPTY_SHADOW, ShadowSnapshot } from '../src/services/shadowLedger';
import { HttpShadowTransport, HTTP_TRANSPORT_DEFAULTS } from '../src/services/shadowHttpTransport';
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

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---------- 1 & 2. Budget durability ----------

describe('T3 audit – durable budget restored before any request', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-audit-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('per-minute window survives restart: no immediate over-limit burst', () => {
    const cfg = { perMinute: 3, perDay: 100 };
    const b1 = new RequestBudget(cfg);
    for (let i = 0; i < 3; i++) expect(b1.tryConsume(GEN_MS).allowed).toBe(true);
    const p = b1.toPersisted(GEN_MS);

    const b2 = new RequestBudget(cfg);
    b2.restorePersisted(p, GEN_MS);
    // Immediately after restart the window is still full.
    expect(b2.tryConsume(GEN_MS).allowed).toBe(false);
    expect(b2.canConsume(GEN_MS).reason).toBe('PER_MINUTE');
    // After the window slides, allowed again.
    expect(b2.tryConsume(GEN_MS + 61_000).allowed).toBe(true);
  });

  it('collector restart does not immediately exceed the per-minute limit', async () => {
    const cfg = { perMinute: 1, perDay: 100 };
    const t = new ScriptedTransport([tf({ fixtureId: 'fd-1' }), tf({ fixtureId: 'fd-2' })], new Map());
    const c1 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budget: cfg });
    const o1 = await c1.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o1.diagnostic.requestsAttempted).toBe(1);

    const c2 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budget: cfg });
    const o2 = await c2.runOnce(GEN_MS + 1_000, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.requestsAttempted).toBe(0); // window restored -> denied
    expect(o2.diagnostic.requestsDenied).toBeGreaterThan(0);
  });

  it('write-ahead sink prevents a restart bypassing the ceiling after a crash before commit', async () => {
    const cfg = { perMinute: 100, perDay: 3 };
    const sink = new FileBudgetSink(path.join(dir, 'budget.json'));
    const fixtures = [tf({ fixtureId: 'fd-1' }), tf({ fixtureId: 'fd-2' }), tf({ fixtureId: 'fd-3' })];
    const t = new ScriptedTransport(fixtures, new Map());

    // Tick 1 charges the discovery request and write-aheads the sink.
    const c1 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budget: cfg, budgetSink: sink });
    const o1 = await c1.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o1.diagnostic.requestsAttempted).toBe(1);
    expect(sink.load()?.dayCount).toBe(1);

    // Simulated crash: the bundle commit never happened, so we restart from an EMPTY state.
    const c2 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budget: cfg, budgetSink: sink });
    const o2 = await c2.runOnce(GEN_MS + 1_000, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o2.diagnostic.requestsAttempted).toBe(1); // sink said 1 used -> one more allowed
    expect(sink.load()?.dayCount).toBe(2);

    const c3 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budget: cfg, budgetSink: sink });
    const o3 = await c3.runOnce(GEN_MS + 2_000, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o3.diagnostic.requestsAttempted).toBe(1); // third and final allowed
    expect(sink.load()?.dayCount).toBe(3);

    // Fourth restart: the ceiling is reached; the sink prevents a reset.
    const c4 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budget: cfg, budgetSink: sink });
    const o4 = await c4.runOnce(GEN_MS + 3_000, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o4.diagnostic.requestsAttempted).toBe(0);
    expect(o4.diagnostic.requestsDenied).toBeGreaterThan(0);
  });

  it('a corrupt sink is ignored and the bundle counter still applies', async () => {
    const sinkPath = path.join(dir, 'budget.json');
    fs.writeFileSync(sinkPath, '{ not valid json');
    const sink = new FileBudgetSink(sinkPath);
    const t = new ScriptedTransport([tf()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budget: { perMinute: 100, perDay: 2 }, budgetSink: sink });
    const state = { ...emptyCollectorState(), budget: { dayKey: day(GEN_MS), dayCount: 2 } };
    const out = await c.runOnce(GEN_MS, state, EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(0);
    expect(out.diagnostic.requestsDenied).toBeGreaterThan(0);
  });

  it('budget is restored from the bundle after .bak recovery', async () => {
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    store.save({ ...emptyCollectorState(), budget: { dayKey: day(GEN_MS), dayCount: 1 } }, EMPTY_SHADOW);
    store.save({ ...emptyCollectorState(), budget: { dayKey: day(GEN_MS), dayCount: 2 } }, EMPTY_SHADOW);
    fs.writeFileSync(store.mainPath, '{ truncated'); // corrupt main -> recover .bak (#1, dayCount 1)
    const loaded = store.load();
    expect(loaded.diagnostic.source).toBe('bak');
    expect(loaded.bundle.state.budget?.dayCount).toBe(1);
  });

  it('an interrupted write leaves the last good budget in the bundle', () => {
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    store.save({ ...emptyCollectorState(), budget: { dayKey: day(GEN_MS), dayCount: 4 } }, EMPTY_SHADOW);
    fs.writeFileSync(`${store.mainPath}.tmp-999`, '{ partial');
    const loaded = store.load();
    expect(loaded.diagnostic.source).toBe('main');
    expect(loaded.bundle.state.budget?.dayCount).toBe(4);
  });
});

// ---------- 3. Forward-clock jumps ----------

describe('T3 audit – forward-clock jumps cannot reset limits or advance state', () => {
  it('a forward jump across a UTC-day boundary halts the tick (budget not reset)', async () => {
    const t = new ScriptedTransport([tf()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, clockJumpToleranceMs: 60_000, maxForwardJumpMs: 60_000, budget: { perMinute: 100, perDay: 2 } });
    const state = { ...emptyCollectorState(), lastTickMs: KICKOFF_MS, budget: { dayKey: day(KICKOFF_MS), dayCount: 2 } };
    const out = await c.runOnce(KICKOFF_MS + 3 * 24 * HOUR, state, EMPTY_SHADOW, true);
    expect(out.diagnostic.skipped).toBe('CLOCK_FORWARD_JUMP');
    expect(t.listCalls).toBe(0);
    expect(out.state).toBe(state); // untouched: no rollover, no request
  });

  it('a forward jump does not capture, settle, correct, or finalize', async () => {
    const t = new ScriptedTransport([tf()], new Map([
      ['fd-1', { ok: true, data: tf({ status: 'FINISHED', homeGoals: 1, awayGoals: 0 }) }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, resultPollIntervalMs: 0, correctionPollIntervalMs: 0, clockJumpToleranceMs: 60_000, maxForwardJumpMs: 60_000 });
    const pending = [{
      fixtureId: 'fd-1', competitionCode: 'PL', season: '2025/26', homeTeamId: 'H', awayTeamId: 'A',
      kickoffTime: new Date(KICKOFF_MS).toISOString(), kickoffVersionMs: KICKOFF_MS, firstSeenMs: GEN_MS,
      lastPolledMs: 0, attempts: 0, captured: true, settled: false,
    }];
    // lastTick 25h before kickoff; the next tick jumps 27h forward (past kickoff + into window).
    const state = { ...emptyCollectorState(), lastTickMs: KICKOFF_MS - 25 * HOUR, pending };
    const out = await c.runOnce(KICKOFF_MS + 2 * HOUR, state, EMPTY_SHADOW, true);
    expect(out.diagnostic.skipped).toBe('CLOCK_FORWARD_JUMP');
    expect(out.diagnostic.captures).toBe(0);
    expect(out.diagnostic.settlements).toBe(0);
    expect(out.diagnostic.corrections).toBe(0);
    expect(out.diagnostic.verifications).toBe(0);
    expect(out.snapshot).toBe(EMPTY_SHADOW); // no forecast, no result
    expect(out.state.pending[0].final).toBeUndefined();
    expect(t.matchCalls).toBe(0);
  });

  it('a normal (within-tolerance) forward step still processes', async () => {
    const t = new ScriptedTransport([tf()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, clockJumpToleranceMs: 5 * 60_000 });
    const o1 = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    const o2 = await c.runOnce(GEN_MS + 60_000, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.skipped).toBeUndefined();
  });
});

// ---------- 4. Persistent identity quarantine ----------

describe('T3 audit – persistent identity quarantine', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-quar-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a quarantined id survives a bundle round-trip and cannot re-enter capture', async () => {
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    store.save({ ...emptyCollectorState(), quarantined: ['dup'] }, EMPTY_SHADOW);
    const loaded = store.load().bundle;
    expect(loaded.state.quarantined).toContain('dup');

    // A clean discovery record for the quarantined id is still refused, and never polled.
    const t = new ScriptedTransport([tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 12 * HOUR).toISOString() })], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, resultPollIntervalMs: 0 });
    const out = await c.runOnce(KICKOFF_MS, loaded.state, loaded.snapshot, true);
    expect(out.state.pending.some((p) => p.fixtureId === 'dup')).toBe(false);
    expect(out.diagnostic.notes.some((n) => n.startsWith('QUARANTINE_SKIP:dup'))).toBe(true);
    expect(t.matchCalls).toBe(0);
  });

  it('quarantine is not re-added when the same conflict reappears', async () => {
    const a = tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 12 * HOUR).toISOString(), homeTeamId: 'H' });
    const b = tf({ fixtureId: 'dup', kickoffTime: new Date(KICKOFF_MS + 12 * HOUR).toISOString(), homeTeamId: 'Z' });
    const t = new ScriptedTransport([a, b], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0 });
    const o1 = await c.runOnce(KICKOFF_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    const o2 = await c.runOnce(KICKOFF_MS + 1 * HOUR, o1.state, o1.snapshot, true);
    expect(o2.state.quarantined).toEqual(['dup']); // exactly one entry, no growth
    // A reappearing conflict is still flagged, but the id is not re-quarantined.
    expect(o2.diagnostic.notes.some((n) => n.startsWith('PROVIDER_CONFLICT:dup'))).toBe(true);
    expect(o2.diagnostic.notes.filter((n) => n.startsWith('QUARANTINED:dup')).length).toBe(0);
  });
});

// ---------- 5. HTTP retry cannot exceed the budget; bounded timeout ----------

interface MockCall { url: string }
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body } as unknown as Response;
}
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: MockCall[] = [];
  const impl = (async (input: any, init?: RequestInit) => { calls.push({ url: String(input) }); return handler(String(input), init); }) as unknown as typeof fetch;
  return { impl, calls };
}
const noSleep = async () => {};

describe('T3 audit – HTTP retry and timeout are budget-bounded', () => {
  it('in-transport retries are OFF by default', () => {
    expect(HTTP_TRANSPORT_DEFAULTS.maxRetries).toBe(0);
  });

  it('a default transport does not multiply requests on a 5xx', async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({}, 500));
    const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep });
    const res = await tx.listFixtures(KICKOFF_MS);
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('collector charges exactly one budget unit per transport call even when the transport errors', async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({}, 500));
    const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep });
    const c = new ShadowCollector({ transport: tx, forecasts: provider, discoveryIntervalMs: 0, budget: { perMinute: 100, perDay: 1 } });
    const o1 = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o1.diagnostic.requestsAttempted).toBe(1);
    expect(calls.length).toBe(1);
    expect(o1.diagnostic.notes.some((n) => n.startsWith('DISCOVERY_ERROR'))).toBe(true);
    const o2 = await c.runOnce(GEN_MS + 1_000, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.requestsAttempted).toBe(0);
    expect(o2.diagnostic.requestsDenied).toBeGreaterThan(0);
    expect(calls.length).toBe(1); // no additional request
  });

  it('a request exceeding the timeout is aborted and mapped to NETWORK (bounded)', async () => {
    const impl = ((_url: any, init?: RequestInit) =>
      new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); })) as unknown as typeof fetch;
    const tx = new HttpShadowTransport({ baseUrl: 'http://local', fetchImpl: impl, sleep: noSleep, timeoutMs: 20, maxRetries: 0 });
    const res = await tx.getMatch('fd-1', KICKOFF_MS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('NETWORK');
  });
});
