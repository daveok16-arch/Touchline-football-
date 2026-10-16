/**
 * Project Touchline – operator driver fail-closed preflight tests (OFFLINE, deterministic)
 *
 * Proves the operator driver refuses to run — and issues NO provider request — when either
 * durable store is missing, uninitialized, or cannot be durably written, and that the explicit
 * per-tick request cap (<= 3) is layered on top of the shared daily/per-minute budget.
 *
 * No network I/O: counting mock transport; no-op clocks.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ShadowCollector,
  emptyCollectorState,
  TransportFixture,
  TransportResult,
  CollectorTransport,
  ForecastProvider,
  CollectorState,
  BudgetPersisted,
  BudgetSink,
  RequestBudget,
} from '../src/services/shadowCollector';
import { CollectorBundleStore, emptyBundle, CollectorBundle } from '../src/services/shadowCollectorPersistence';
import { EMPTY_SHADOW, ShadowSnapshot } from '../src/services/shadowLedger';
import {
  createOperatorDriver,
  verifyDurableStores,
  DurableStoreUnavailableError,
  OPERATOR_MAX_REQUESTS_PER_TICK,
  BundleStoreLike,
} from '../src/services/shadowOperatorDriver';
import { CAPTURE_TARGET_LEAD_MS } from '../src/services/shadowCapturePolicy';
import { ProbabilityTriplet } from '../src/services/predictionMetrics';

const HOUR = 60 * 60 * 1000;
const KICKOFF_MS = Date.parse('2025-09-10T15:00:00Z');
const TARGET_MS = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS;
const FROZEN: ProbabilityTriplet = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };

function tf(overrides: Partial<TransportFixture> = {}): TransportFixture {
  return {
    fixtureId: 'fd-1', competitionCode: 'PL', season: '2025/26',
    homeTeamId: 'H', awayTeamId: 'A', kickoffTime: new Date(KICKOFF_MS).toISOString(),
    status: 'SCHEDULED', providerLastUpdated: new Date(KICKOFF_MS - 48 * HOUR).toISOString(),
    ...overrides,
  };
}

class CountingTransport implements CollectorTransport {
  listCalls = 0;
  matchCalls = 0;
  constructor(public fixtures: TransportFixture[], public match: TransportResult<TransportFixture> = { ok: false, error: 'NOT_FOUND' }) {}
  async listFixtures(): Promise<TransportResult<TransportFixture[]>> { this.listCalls++; return { ok: true, data: this.fixtures }; }
  async getMatch(): Promise<TransportResult<TransportFixture>> { this.matchCalls++; return this.match; }
}

const provider: ForecastProvider = {
  frozenProbabilities: () => FROZEN,
  calibrationHistory: () => [],
  calibrationFor: () => null,
  sourceInfo: () => ({ provider: 'football-data.org' }),
};

class MemoryBundleStore implements BundleStoreLike {
  private bundle: CollectorBundle = emptyBundle();
  failSave = false;
  loadCount = 0;
  load() {
    this.loadCount++;
    return { bundle: this.bundle, diagnostic: { ok: true, source: 'main' as const } };
  }
  save(state: CollectorState, snapshot: ShadowSnapshot, _journalLine?: string) {
    if (this.failSave) return { ok: false, error: 'injected bundle failure' };
    this.bundle = { ...this.bundle, commit: this.bundle.commit + 1, state, snapshot };
    return { ok: true, commit: this.bundle.commit };
  }
}

class FailBudgetSink implements BudgetSink {
  save(): boolean { return false; }
  load(): BudgetPersisted | null { return null; }
}

class MemoryBudgetSink implements BudgetSink {
  store: BudgetPersisted | null = null;
  save(b: BudgetPersisted): boolean { this.store = b; return true; }
  load(): BudgetPersisted | null { return this.store; }
}

describe('Operator driver – durable-store preflight refuses with no request', () => {
  it('rejects when the budget sink is missing', async () => {
    const t = new CountingTransport([tf()]);
    const d = createOperatorDriver({ transport: t, forecasts: provider, bundleStore: new MemoryBundleStore(), budgetSink: null, now: () => TARGET_MS });
    await expect(d.runOnce(true)).rejects.toBeInstanceOf(DurableStoreUnavailableError);
    expect(t.listCalls).toBe(0);
  });

  it('rejects when the bundle store is missing', async () => {
    const t = new CountingTransport([tf()]);
    const d = createOperatorDriver({ transport: t, forecasts: provider, bundleStore: null, budgetSink: new MemoryBudgetSink(), now: () => TARGET_MS });
    await expect(d.runOnce(true)).rejects.toBeInstanceOf(DurableStoreUnavailableError);
    expect(t.listCalls).toBe(0);
  });

  it('rejects when the budget sink write probe fails (uninitialized/unwritable)', async () => {
    const t = new CountingTransport([tf()]);
    const d = createOperatorDriver({ transport: t, forecasts: provider, bundleStore: new MemoryBundleStore(), budgetSink: new FailBudgetSink(), now: () => TARGET_MS });
    await expect(d.runOnce(true)).rejects.toBeInstanceOf(DurableStoreUnavailableError);
    expect(t.listCalls).toBe(0);
  });

  it('rejects when the bundle store write probe fails', async () => {
    const t = new CountingTransport([tf()]);
    const store = new MemoryBundleStore();
    store.failSave = true;
    const d = createOperatorDriver({ transport: t, forecasts: provider, bundleStore: store, budgetSink: new MemoryBudgetSink(), now: () => TARGET_MS });
    await expect(d.runOnce(true)).rejects.toBeInstanceOf(DurableStoreUnavailableError);
    expect(t.listCalls).toBe(0);
    expect(t.matchCalls).toBe(0);
  });

  it('the preflight error names every failed reason', () => {
    const check = verifyDurableStores({ bundleStore: null, budgetSink: null });
    expect(check.ok).toBe(false);
    expect(check.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('verifies cleanly when both real durable stores are present and writable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-op-'));
    try {
      const store = new CollectorBundleStore(path.join(dir, 'b.json'));
      const sink = new MemoryBudgetSink();
      const check = verifyDurableStores({ bundleStore: store, budgetSink: sink });
      expect(check.ok).toBe(true);
      // The bundle probe commits exactly once and preserves the (empty) state.
      expect(store.load().bundle.commit).toBe(1);
      expect(store.load().bundle.state.pending.length).toBe(0);
      expect(sink.store?.dayCount).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs one bounded tick when both stores are verified, and persists the capture', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-op-'));
    try {
      const store = new CollectorBundleStore(path.join(dir, 'b.json'));
      const sink = new MemoryBudgetSink();
      const t = new CountingTransport([tf()]);
      const d = createOperatorDriver({ transport: t, forecasts: provider, bundleStore: store, budgetSink: sink, now: () => TARGET_MS });
      const out = await d.runOnce(true);
      expect(out.diagnostic.captures).toBe(1);
      expect(t.listCalls).toBe(1);
      expect(store.load().bundle.snapshot.forecasts.length).toBe(1);
      expect(store.load().bundle.state.persistenceFailed).toBeFalsy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Operator driver – explicit per-tick cap cannot bypass daily/per-minute budget', () => {
  it('defaults to at most 3 charged requests', async () => {
    const t = new CountingTransport([tf()]);
    const d = createOperatorDriver({ transport: t, forecasts: provider, bundleStore: new MemoryBundleStore(), budgetSink: new MemoryBudgetSink(), now: () => TARGET_MS });
    expect(d.maxRequestsPerTick).toBe(OPERATOR_MAX_REQUESTS_PER_TICK);
    expect(OPERATOR_MAX_REQUESTS_PER_TICK).toBeLessThanOrEqual(3);
  });

  it('clamps a larger requested cap down to 3', () => {
    const d = createOperatorDriver({ transport: new CountingTransport([]), forecasts: provider, bundleStore: new MemoryBundleStore(), budgetSink: new MemoryBudgetSink(), maxRequestsPerTick: 99 });
    expect(d.maxRequestsPerTick).toBe(OPERATOR_MAX_REQUESTS_PER_TICK);
  });

  it('collector honours the cap: no more than 3 charged requests in one tick', async () => {
    // 8 pending fixtures already past kickoff (discovered earlier); all due for a result poll.
    const t = new CountingTransport([], { ok: true, data: tf({ status: 'SCHEDULED' }) });
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 48 * HOUR, maxRequestsPerTick: OPERATOR_MAX_REQUESTS_PER_TICK });
    const nowMs = KICKOFF_MS + 2 * HOUR;
    const state = emptyCollectorState();
    state.lastDiscoveryMs = nowMs; // no discovery this tick
    for (let i = 0; i < 8; i++) {
      state.pending.push({
        fixtureId: `fd-${i}`, competitionCode: 'PL', season: '2025/26', homeTeamId: 'H', awayTeamId: 'A',
        kickoffTime: new Date(KICKOFF_MS - 3 * HOUR).toISOString(), kickoffVersionMs: KICKOFF_MS - 3 * HOUR,
        firstSeenMs: 0, lastPolledMs: 0, attempts: 0, captured: true, settled: false,
      });
    }
    const out = await c.runOnce(nowMs, state, EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(OPERATOR_MAX_REQUESTS_PER_TICK); // exactly the cap
    expect(t.listCalls + t.matchCalls).toBe(OPERATOR_MAX_REQUESTS_PER_TICK);
    expect(out.diagnostic.requestsCapped).toBeGreaterThan(0); // further polls refused by the cap
  });

  it('the cap never widens the shared per-day budget (denial still wins)', async () => {
    // A pre-exhausted daily budget must still refuse, even though the tick cap has room.
    const t = new CountingTransport([tf()], { ok: true, data: tf({ status: 'FINISHED', homeGoals: 1, awayGoals: 0 }) });
    const c = new ShadowCollector({
      transport: t,
      forecasts: provider,
      discoveryIntervalMs: 0,
      maxRequestsPerTick: OPERATOR_MAX_REQUESTS_PER_TICK,
      budget: { perMinute: 10, perDay: 0 },
    });
    const out = await c.runOnce(TARGET_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(0);
    expect(out.diagnostic.requestsDenied).toBeGreaterThan(0);
    expect(t.listCalls).toBe(0);
    expect(t.matchCalls).toBe(0);
  });

  it('the cap never widens the shared per-minute budget (denial still wins)', async () => {
    const t = new CountingTransport([tf()]);
    const c = new ShadowCollector({
      transport: t,
      forecasts: provider,
      discoveryIntervalMs: 0,
      maxRequestsPerTick: OPERATOR_MAX_REQUESTS_PER_TICK,
      budget: { perMinute: 0, perDay: 500 },
    });
    const out = await c.runOnce(TARGET_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(0);
    expect(out.diagnostic.requestsDenied).toBeGreaterThan(0);
    expect(t.listCalls).toBe(0);
  });
});

describe('Operator driver – one shared budget governs provider and collector', () => {
  const budgetCfg = { perMinute: 10, perDay: 500 };

  it('the collector charges the supplied budgetInstance, not a private counter', async () => {
    const shared = new RequestBudget(budgetCfg);
    const t = new CountingTransport([tf()]);
    const c = new ShadowCollector({ transport: t, forecasts: provider, budgetInstance: shared, discoveryIntervalMs: 0, maxRequestsPerTick: 3 });
    const out = await c.runOnce(TARGET_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(1);
    expect(shared.snapshot(TARGET_MS).usedToday).toBe(1); // the collector charged the shared counter
  });

  it('provider standings charges and collector charges appear in the SAME persisted counter', async () => {
    const shared = new RequestBudget(budgetCfg);
    const nowMs = TARGET_MS;
    // Simulate the standings source charging the shared budget (as primeStandings does).
    shared.tryConsume(nowMs);
    shared.tryConsume(nowMs + 1);
    const t = new CountingTransport([tf()]);
    const c = new ShadowCollector({ transport: t, forecasts: provider, budgetInstance: shared, discoveryIntervalMs: 0, maxRequestsPerTick: 3 });
    const out = await c.runOnce(nowMs + 2, emptyCollectorState(), EMPTY_SHADOW, true);
    // 2 standings + 1 discovery, all durable in one counter.
    expect(out.state.budget?.dayCount).toBe(3);
  });

  it('a shared per-day budget exhausted by standings still blocks the collector request', async () => {
    const shared = new RequestBudget({ perMinute: 10, perDay: 1 });
    shared.tryConsume(TARGET_MS); // standings consumes the only slot
    const t = new CountingTransport([tf()]);
    const c = new ShadowCollector({ transport: t, forecasts: provider, budgetInstance: shared, discoveryIntervalMs: 0, maxRequestsPerTick: 3 });
    const out = await c.runOnce(TARGET_MS + 1, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(0);
    expect(out.diagnostic.requestsDenied).toBeGreaterThan(0);
    expect(t.listCalls).toBe(0);
  });

  it('the driver shares one instance between the provider and the collector', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-op-'));
    try {
      const shared = new RequestBudget(budgetCfg);
      shared.tryConsume(TARGET_MS); // pretend standings were primed on the shared instance
      const store = new CollectorBundleStore(path.join(dir, 'b.json'));
      const sink = new MemoryBudgetSink();
      const t = new CountingTransport([tf()]);
      const d = createOperatorDriver({ transport: t, forecasts: provider, bundleStore: store, budgetSink: sink, budgetInstance: shared, now: () => TARGET_MS + 1 });
      const out = await d.runOnce(true);
      expect(out.diagnostic.captures).toBe(1);
      // 1 standings + 1 discovery persisted together.
      expect(store.load().bundle.state.budget?.dayCount).toBe(2);
      expect(sink.store?.dayCount).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
