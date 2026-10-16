/**
 * Project Touchline – collector purity & preregistration regression tests (OFFLINE, deterministic)
 *
 * Locks in two guarantees that the multi-day observation depends on:
 *   1. `runOnce` must NOT mutate its inputs. An operator "peek" tick or a replayed tick must not
 *      corrupt the state snapshot it was handed (a shallow copy leaked in-place pending/observed
 *      mutations back into the caller's object).
 *   2. Capture selection respects the preregistered kickoff-24h target window at the collector
 *      level (boundaries inclusive at +-2h).
 *
 * No network I/O: mocked transport; no-op sleep.
 */

import { describe, it, expect } from 'vitest';
import {
  ShadowCollector,
  emptyCollectorState,
  TransportFixture,
  TransportResult,
  CollectorTransport,
  ForecastProvider,
  CollectorState,
} from '../src/services/shadowCollector';
import { EMPTY_SHADOW, shadowCalibrationHistory } from '../src/services/shadowLedger';
import {
  CAPTURE_TARGET_LEAD_MS,
  CAPTURE_TOLERANCE_MS,
} from '../src/services/shadowCapturePolicy';
import { ProbabilityTriplet } from '../src/services/predictionMetrics';

const HOUR = 60 * 60 * 1000;
const KICKOFF_MS = Date.parse('2025-09-10T15:00:00Z');
const TARGET_MS = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS;
const OPEN_MS = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS - CAPTURE_TOLERANCE_MS;
const CLOSE_MS = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + CAPTURE_TOLERANCE_MS;
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

describe('T3 purity – runOnce never mutates its inputs', () => {
  it('a capture tick does not mutate the caller state object', async () => {
    const t = new ScriptedTransport([tf()]);
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 12 * HOUR });
    const s1 = emptyCollectorState();
    const o1 = await c.runOnce(TARGET_MS, s1, EMPTY_SHADOW, true); // within window -> capture
    expect(o1.diagnostic.captures).toBe(1);
    expect(s1.pending.length).toBe(0); // caller state untouched
  });

  it('a past-kickoff poll tick does not leak lastPolledMs/attempts into the caller state', async () => {
    const t = new ScriptedTransport([tf()], {
      ok: true,
      data: tf({ status: 'FINISHED', homeGoals: 2, awayGoals: 1 }),
    });
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 12 * HOUR });

    // Tick 1 discovers the fixture into o1.state.
    const o1 = await c.runOnce(TARGET_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    const before = o1.state.pending[0];
    expect(before.lastPolledMs).toBe(0);
    expect(before.attempts).toBe(0);

    // Tick 2 polls past kickoff. The caller's o1.state must remain as it was.
    const o2 = await c.runOnce(KICKOFF_MS + 2 * HOUR, o1.state, o1.snapshot, true);
    expect(o2.diagnostic.settlements).toBe(1);
    expect(o1.state.pending[0].lastPolledMs).toBe(0);
    expect(o1.state.pending[0].attempts).toBe(0);
    expect(o1.state.pending[0].settled).toBe(false);
    expect(o2.state.pending[0].settled).toBe(true);
  });

  it('is deterministic: replaying the same input state yields identical output', async () => {
    const mk = () => new ScriptedTransport([tf()], { ok: true, data: tf({ status: 'FINISHED', homeGoals: 1, awayGoals: 1 }) });
    const c1 = new ShadowCollector({ transport: mk(), forecasts: provider, discoveryIntervalMs: 12 * HOUR });
    const c2 = new ShadowCollector({ transport: mk(), forecasts: provider, discoveryIntervalMs: 12 * HOUR });

    const base = await c1.runOnce(TARGET_MS, emptyCollectorState(), EMPTY_SHADOW, true);
    // Reuse the SAME input object for two independent ticks; neither may perturb it.
    const a = await c1.runOnce(KICKOFF_MS + 2 * HOUR, base.state, base.snapshot, true);
    const b = await c2.runOnce(KICKOFF_MS + 2 * HOUR, base.state, base.snapshot, true);
    expect(a.state).toEqual(b.state);
    expect(a.snapshot).toEqual(b.snapshot);
    expect(shadowCalibrationHistory(a.snapshot, { mode: 'prospective' }).length).toBe(1);
  });
});

describe('T3 purity – capture respects the preregistered 24h target window', () => {
  async function tickAt(nowMs: number) {
    const t = new ScriptedTransport([tf()]);
    const c = new ShadowCollector({ transport: t, forecasts: provider, discoveryIntervalMs: 12 * HOUR });
    return c.runOnce(nowMs, emptyCollectorState(), EMPTY_SHADOW, true); // discovery + capture in one tick
  }

  it('captures at the target instant (kickoff - 24h)', async () => {
    const out = await tickAt(TARGET_MS);
    expect(out.diagnostic.captures).toBe(1);
    expect(out.snapshot.forecasts[0].isPrimary).toBe(true);
  });

  it('captures at the inclusive window boundaries (+-2h)', async () => {
    expect((await tickAt(OPEN_MS)).diagnostic.captures).toBe(1);
    expect((await tickAt(CLOSE_MS)).diagnostic.captures).toBe(1);
  });

  it('does not capture before the window opens', async () => {
    const out = await tickAt(OPEN_MS - 24 * HOUR);
    expect(out.diagnostic.captures).toBe(0);
    expect(out.state.pending[0].captured).toBe(false);
  });

  it('records a late discovery as audit-only (ineligible, not primary)', async () => {
    const out = await tickAt(CLOSE_MS + 60_000); // discovered after close
    expect(out.diagnostic.captures).toBe(1); // recorded for audit
    const f = out.snapshot.forecasts[0];
    expect(f.eligibility.eligible).toBe(false);
    expect(f.isPrimary).toBe(false);
    expect(shadowCalibrationHistory(out.snapshot, { mode: 'prospective' }).length).toBe(0);
  });
});
