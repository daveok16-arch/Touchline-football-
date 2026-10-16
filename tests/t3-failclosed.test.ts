/**
 * Project Touchline – fail-closed persistence regression tests (OFFLINE, deterministic)
 *
 * Contract under test: no provider request may be issued when budget accounting cannot be durably
 * recorded. When both the write-ahead budget sink and the atomic bundle commit fail, the collector
 * latches `persistenceFailed`, issues no further requests, does not advance research state, and the
 * latch survives a restart (so it cannot re-burn the ceiling).
 *
 * No network I/O: mocked transport; no-op sleep.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  BudgetPersisted,
  BudgetSink,
  BundleSink,
  CollectorState,
} from '../src/services/shadowCollector';
import { CollectorBundleStore, FileBudgetSink } from '../src/services/shadowCollectorPersistence';
import { EMPTY_SHADOW, ShadowSnapshot } from '../src/services/shadowLedger';
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
  constructor(public fixtures: TransportFixture[], public matches: Map<string, TransportResult<TransportFixture>> = new Map()) {}
  async listFixtures(): Promise<TransportResult<TransportFixture[]>> { this.listCalls++; return { ok: true, data: this.fixtures }; }
  async getMatch(id: string): Promise<TransportResult<TransportFixture>> { this.matchCalls++; return this.matches.get(id) ?? { ok: false, error: 'NOT_FOUND' }; }
}

const provider: ForecastProvider = {
  frozenProbabilities: () => FROZEN,
  calibrationHistory: () => [],
  calibrationFor: () => null,
  sourceInfo: () => ({ provider: 'football-data.org' }),
};

/** Toggleable budget sink: can be made to fail, and records whether it was written. */
class FlakyBudgetSink implements BudgetSink {
  fail = false;
  writes = 0;
  store: BudgetPersisted | null = null;
  save(b: BudgetPersisted): boolean {
    if (this.fail) return false;
    this.writes++;
    this.store = b;
    return true;
  }
  load(): BudgetPersisted | null { return this.store; }
}

/** Bundle sink that always reports a failed commit. */
class FailingBundleSink implements BundleSink {
  calls = 0;
  save(_state: CollectorState, _snapshot: ShadowSnapshot): boolean { this.calls++; return false; }
}

describe('T3 fail-closed – sink write failure', () => {
  it('refuses the request, latches, and persists the latch', async () => {
    const t = new ScriptedTransport([tf()]);
    const sink = new FlakyBudgetSink();
    sink.fail = true;
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink });
    const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(0); // no request issued
    expect(t.listCalls).toBe(0);
    expect(out.diagnostic.persistenceFailed).toBe(true);
    expect(out.diagnostic.notes.some((n) => n.startsWith('PERSISTENCE_FAILED'))).toBe(true);
    expect(out.state.persistenceFailed).toBe(true); // latch persisted in state
  });

  it('issues no further requests while latched, even if the sink recovers', async () => {
    const t = new ScriptedTransport([tf()]);
    const sink = new FlakyBudgetSink();
    sink.fail = true;
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink });
    const o1 = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    sink.fail = false; // sink recovers, but the latch must still hold
    const o2 = await c.runOnce(GEN_MS + HOUR, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.skipped).toBe('PERSISTENCE_FAILED');
    expect(o2.diagnostic.requestsAttempted).toBe(0);
    expect(t.listCalls).toBe(0);
    expect(o2.state).toBe(o1.state);
  });

  it('latch survives a restart (fresh collector, persisted state)', async () => {
    const t = new ScriptedTransport([tf()]);
    const sink = new FlakyBudgetSink();
    sink.fail = true;
    const c1 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink });
    const o1 = await c1.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o1.state.persistenceFailed).toBe(true);

    const sink2 = new FlakyBudgetSink(); // healthy on restart
    const c2 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink2 });
    const o2 = await c2.runOnce(GEN_MS + HOUR, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.skipped).toBe('PERSISTENCE_FAILED');
    expect(t.listCalls).toBe(0);
  });

  it('the operator reset clears the latch and resumes collection', async () => {
    const t = new ScriptedTransport([tf()]);
    const sink = new FlakyBudgetSink();
    sink.fail = true;
    const c1 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink });
    const o1 = await c1.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(o1.state.persistenceFailed).toBe(true);

    sink.fail = false; // persistence restored before the operator reset
    const c2 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink, resetPersistenceFailure: true });
    const o2 = await c2.runOnce(GEN_MS + HOUR, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.skipped).toBeUndefined();
    expect(o2.state.persistenceFailed).toBe(false);
    expect(t.listCalls).toBe(1); // one request now that persistence is healthy
  });
});

describe('T3 fail-closed – bundle write failure (no sink)', () => {
  it('latches when the end-of-tick bundle commit cannot be recorded', async () => {
    const t = new ScriptedTransport([tf()]);
    const bundle = new FailingBundleSink();
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, bundleSink: bundle });
    const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    // The request is attempted (durability was deferred to the commit) but the commit failed.
    expect(out.diagnostic.requestsAttempted).toBe(1);
    expect(t.listCalls).toBe(1);
    expect(out.diagnostic.persistenceFailed).toBe(true);
    expect(out.diagnostic.requestsUnpersisted).toBe(1);
    expect(out.state.persistenceFailed).toBe(true);
  });

  it('issues no further requests on the next tick', async () => {
    const t = new ScriptedTransport([tf()]);
    const bundle = new FailingBundleSink();
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, bundleSink: bundle });
    const o1 = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    const o2 = await c.runOnce(GEN_MS + HOUR, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.skipped).toBe('PERSISTENCE_FAILED');
    expect(t.listCalls).toBe(1); // no additional request
  });

  it('bundleWriteFailed flag latches without a bundle sink', async () => {
    const t = new ScriptedTransport([tf()]);
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, bundleWriteFailed: true });
    const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(1);
    expect(out.state.persistenceFailed).toBe(true);
  });

  it('both stores failing latches (sink fails and bundle cannot commit)', async () => {
    const t = new ScriptedTransport([tf()]);
    const sink = new FlakyBudgetSink();
    sink.fail = true;
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink, bundleWriteFailed: true });
    const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(0);
    expect(t.listCalls).toBe(0);
    expect(out.state.persistenceFailed).toBe(true);
  });
});

describe('T3 fail-closed – durable success paths do not latch', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-fc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a healthy file sink records the counter and does not latch', async () => {
    const t = new ScriptedTransport([tf()]);
    const sink = new FileBudgetSink(path.join(dir, 'budget.json'));
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink, budget: { perMinute: 100, perDay: 10 } });
    const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(1);
    expect(out.state.persistenceFailed).toBe(false);
    expect(sink.load()?.dayCount).toBe(1); // durable write-ahead includes this charge
  });

  it('a healthy bundle sink commit does not latch', async () => {
    const t = new ScriptedTransport([tf()]);
    const store = new CollectorBundleStore(path.join(dir, 'b.json'));
    const bundle: BundleSink = { save: (s, snap) => store.save(s, snap).ok };
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, bundleSink: bundle });
    const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.requestsAttempted).toBe(1);
    expect(out.state.persistenceFailed).toBe(false);
    expect(store.load().bundle.state.budget?.dayCount).toBe(1);
  });

  it('the sink counter is durable BEFORE the request is observed (write-ahead ordering)', async () => {
    // The transport records the sink value at the moment the request is made.
    let sinkValueAtRequest = -1;
    const sink = new FlakyBudgetSink();
    const t: CollectorTransport = {
      listFixtures: async () => { sinkValueAtRequest = sink.store?.dayCount ?? -1; return { ok: true, data: [tf()] }; },
      getMatch: async () => ({ ok: false, error: 'NOT_FOUND' }),
    };
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink });
    await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(sinkValueAtRequest).toBe(1); // the charge was durable before the request went out
  });
});

describe('T3 fail-closed – latch does not corrupt research state', () => {
  it('the latch is persisted to the bundle (survives restart), and the bundle commit still happens', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 't3-latch-'));
    try {
      const t = new ScriptedTransport([tf()]);
      const store = new CollectorBundleStore(path.join(dir2, 'b.json'));
      const sink = new FlakyBudgetSink();
      sink.fail = true;
      const bundle: BundleSink = { save: (s, snap) => store.save(s, snap).ok };
      const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink, bundleSink: bundle });
      const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
      expect(out.state.persistenceFailed).toBe(true);
      // The latch must be on disk, not just in memory.
      expect(store.load().bundle.state.persistenceFailed).toBe(true);

      // A fresh collector reading the persisted state refuses without a reset.
      const c2 = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: new FlakyBudgetSink(), bundleSink: bundle });
      const o2 = await c2.runOnce(GEN_MS + HOUR, store.load().bundle.state, store.load().bundle.snapshot, true);
      expect(o2.diagnostic.skipped).toBe('PERSISTENCE_FAILED');
      expect(t.listCalls).toBe(0);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('a latched tick leaves the snapshot and pending untouched', async () => {
    const t = new ScriptedTransport([tf()]);
    const sink = new FlakyBudgetSink();
    sink.fail = true;
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 0, budgetSink: sink });
    const out = await c.runOnce(GEN_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.snapshot).toBe(EMPTY_SHADOW);
    expect(out.state.pending.length).toBe(0);
    expect(out.state.quarantined ?? []).toEqual([]);
  });
});
