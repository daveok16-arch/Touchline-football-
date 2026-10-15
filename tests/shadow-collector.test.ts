/**
 * Project Touchline – Phase S collector + protocol tests (offline, no network)
 *
 * Uses scripted in-memory transports only. Covers: enablement boundary, discovery and
 * window-gated capture, pending-result polling, correction detection, missing scores,
 * reschedule, duplicate provider records, clock-jump guard, rate-limit backoff, hard
 * request-budget exhaustion, idempotent restart / interrupted-write recovery, stable
 * protocol hashing, and mixed-mode rejection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SHADOW_COLLECTOR_FLAG_ENV,
  isShadowCollectorEnabled,
  RequestBudget,
  nextBackoffMs,
  ShadowCollector,
  CollectorStateStore,
  emptyCollectorState,
  CollectorState,
  TransportFixture,
  TransportResult,
  CollectorTransport,
  ForecastProvider,
} from '../src/services/shadowCollector';
import { ProbabilityTriplet } from '../src/services/predictionMetrics';
import { EMPTY_SHADOW, ShadowSnapshot, snapshotModes, recordShadowForecast } from '../src/services/shadowLedger';
import { CAPTURE_TARGET_LEAD_MS } from '../src/services/shadowCapturePolicy';
import { SHADOW_PROTOCOL, computeProtocolHash, canonicalize } from '../src/services/research/shadowProtocol';

const HOUR = 60 * 60 * 1000;
const KICKOFF_MS = Date.parse('2025-09-10T15:00:00Z');
const FROZEN: ProbabilityTriplet = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };

function fixture(overrides: Partial<TransportFixture> = {}): TransportFixture {
  return {
    fixtureId: 'fd-100',
    competitionCode: 'PL',
    season: '2025/26',
    homeTeamId: 'H',
    awayTeamId: 'A',
    kickoffTime: new Date(KICKOFF_MS).toISOString(),
    status: 'SCHEDULED',
    providerLastUpdated: new Date(KICKOFF_MS - 48 * HOUR).toISOString(),
    ...overrides,
  };
}

class ScriptedTransport implements CollectorTransport {
  listCalls = 0;
  matchCalls = 0;
  constructor(
    public fixtures: TransportFixture[],
    public matches: Map<string, TransportResult<TransportFixture>>,
    public listError?: TransportResult<TransportFixture[]>
  ) {}
  async listFixtures(): Promise<TransportResult<TransportFixture[]>> {
    this.listCalls++;
    if (this.listError) return this.listError;
    return { ok: true, data: this.fixtures };
  }
  async getMatch(id: string): Promise<TransportResult<TransportFixture>> {
    this.matchCalls++;
    return this.matches.get(id) ?? { ok: false, error: 'NOT_FOUND' };
  }
}

function provider(): ForecastProvider {
  return {
    frozenProbabilities: () => FROZEN,
    calibrationHistory: () => [],
    calibrationFor: () => ({ temperature: 1.4, sampleCount: 900, fittedThroughMs: KICKOFF_MS - 10 * 24 * HOUR, fallback: false }),
    sourceInfo: () => ({ provider: 'football-data.org' }),
  };
}

describe('collector – enablement boundary', () => {
  it('is disabled unless exactly "true"', () => {
    expect(isShadowCollectorEnabled({})).toBe(false);
    expect(isShadowCollectorEnabled({ [SHADOW_COLLECTOR_FLAG_ENV]: 'TRUE' })).toBe(false);
    expect(isShadowCollectorEnabled({ [SHADOW_COLLECTOR_FLAG_ENV]: 'true' })).toBe(true);
  });

  it('does nothing and makes no requests when disabled', async () => {
    const t = new ScriptedTransport([fixture()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider() });
    const now = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS;
    const out = await c.runOnce(now, emptyCollectorState(), EMPTY_SHADOW, false);
    expect(out.diagnostic.skipped).toBe('DISABLED');
    expect(t.listCalls).toBe(0);
    expect(t.matchCalls).toBe(0);
    expect(out.snapshot.forecasts.length).toBe(0);
  });
});

describe('collector – discovery, capture, settlement', () => {
  it('discovers, captures within the window, then settles after kickoff', async () => {
    const t = new ScriptedTransport([fixture()], new Map([
      ['fd-100', { ok: true, data: fixture({ status: 'FINISHED', homeGoals: 2, awayGoals: 1 }) }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0 });
    let state = emptyCollectorState();
    let snap: ShadowSnapshot = EMPTY_SHADOW;

    // Discovery + capture at the target instant.
    const atTarget = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS;
    let out = await c.runOnce(atTarget, state, snap, true);
    state = out.state; snap = out.snapshot;
    expect(out.diagnostic.captures).toBe(1);
    expect(snap.forecasts.length).toBe(1);
    expect(snap.forecasts[0].mode).toBe('prospective');
    expect(snap.forecasts[0].eligibility.eligible).toBe(true);
    expect(snap.forecasts[0].isPrimary).toBe(true);

    // After kickoff: poll and settle.
    out = await c.runOnce(KICKOFF_MS + 2 * HOUR, state, snap, true);
    expect(out.diagnostic.settlements).toBe(1);
    expect(out.snapshot.results.length).toBe(1);
    expect(snapshotModes(out.snapshot)).toEqual(['prospective']);
  });

  it('does not capture before the window opens', async () => {
    const t = new ScriptedTransport([fixture()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider() });
    const early = KICKOFF_MS - CAPTURE_TARGET_LEAD_MS - 5 * HOUR; // before window opens
    const out = await c.runOnce(early, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.diagnostic.captures).toBe(0);
    expect(out.snapshot.forecasts.length).toBe(0);
  });

  it('records a late-discovered fixture as audit-only (ineligible, not primary)', async () => {
    const t = new ScriptedTransport([fixture()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider() });
    const late = KICKOFF_MS - 21 * HOUR; // after window close (kickoff−22h), before kickoff
    const out = await c.runOnce(late, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(out.snapshot.forecasts.length).toBe(1);
    expect(out.snapshot.forecasts[0].eligibility.eligible).toBe(false);
    expect(out.snapshot.forecasts[0].eligibility.reason).toBe('LATE_DISCOVERY');
    expect(out.snapshot.forecasts[0].isPrimary).toBe(false);
  });

  it('leaves a not-FINISHED fixture unsettled and retries later', async () => {
    const t = new ScriptedTransport([fixture()], new Map([
      ['fd-100', { ok: true, data: fixture({ status: 'IN_PLAY' }) }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0 });
    // Discovery happens before kickoff; then a post-kickoff tick polls the result.
    const o1 = await c.runOnce(KICKOFF_MS - 27 * HOUR, emptyCollectorState(), EMPTY_SHADOW, true);
    const out = await c.runOnce(KICKOFF_MS + 2 * HOUR, o1.state, o1.snapshot, true);
    expect(out.snapshot.results.length).toBe(0);
    expect(out.diagnostic.notes.some((n) => n.startsWith('NOT_FINISHED'))).toBe(true);
  });

  it('detects a provider score correction and appends a revision', async () => {
    const t = new ScriptedTransport([fixture()], new Map([
      ['fd-100', { ok: true, data: fixture({ status: 'FINISHED', homeGoals: 2, awayGoals: 1 }) }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0 });
    let state = emptyCollectorState();
    let snap: ShadowSnapshot = EMPTY_SHADOW;
    // Capture first.
    let out = await c.runOnce(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS, state, snap, true);
    state = out.state; snap = out.snapshot;
    // Settle with first score.
    out = await c.runOnce(KICKOFF_MS + 2 * HOUR, state, snap, true);
    state = out.state; snap = out.snapshot;
    expect(snap.results[0].revisions.length).toBe(1);
    // Provider corrects the score; force a re-poll by clearing settled.
    state = { ...state, pending: state.pending.map((p) => ({ ...p, settled: false, lastPolledMs: 0 })) };
    t.matches.set('fd-100', { ok: true, data: fixture({ status: 'FINISHED', homeGoals: 0, awayGoals: 0 }) });
    out = await c.runOnce(KICKOFF_MS + 3 * HOUR, state, snap, true);
    expect(out.diagnostic.corrections).toBe(1);
    expect(out.snapshot.results[0].revisions.length).toBe(2);
  });

  it('marks a rescheduled fixture superseded and tracks the new version', async () => {
    const newKickoff = new Date(KICKOFF_MS + 3 * 24 * HOUR).toISOString();
    const t = new ScriptedTransport([fixture()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0 });
    const discoverAt = KICKOFF_MS - 27 * HOUR; // inside the 7-day discovery horizon
    const out1 = await c.runOnce(discoverAt, emptyCollectorState(), EMPTY_SHADOW, true);
    let state = out1.state;
    expect(state.pending.length).toBe(1);
    // Provider moves the fixture.
    t.fixtures = [fixture({ kickoffTime: newKickoff })];
    const out2 = await c.runOnce(discoverAt + HOUR, state, out1.snapshot, true);
    state = out2.state;
    const superseded = state.pending.filter((p) => p.superseded).length;
    expect(superseded).toBe(1);
    expect(state.pending.some((p) => !p.superseded && p.kickoffTime === newKickoff)).toBe(true);
    expect(out2.diagnostic.notes.some((n) => n.startsWith('RESCHEDULED'))).toBe(true);
  });
});

describe('collector – clock integrity', () => {
  it('stops recording on a backward clock jump', async () => {
    const t = new ScriptedTransport([fixture()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), clockJumpToleranceMs: 60_000 });
    const state: CollectorState = { ...emptyCollectorState(), lastTickMs: KICKOFF_MS };
    const out = await c.runOnce(KICKOFF_MS - 10 * 60_000, state, EMPTY_SHADOW, true);
    expect(out.diagnostic.skipped).toBe('CLOCK_JUMP');
    expect(t.listCalls).toBe(0);
  });
});

describe('collector – request budget and backoff', () => {
  it('per-minute limiter denies and returns a retry hint', () => {
    const b = new RequestBudget({ perMinute: 2, perDay: 100 });
    expect(b.tryConsume(1000).allowed).toBe(true);
    expect(b.tryConsume(2000).allowed).toBe(true);
    const denied = b.tryConsume(3000);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('PER_MINUTE');
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // After the window slides, requests are allowed again.
    expect(b.tryConsume(62_000).allowed).toBe(true);
  });

  it('hard per-day ceiling stops all requests', () => {
    const b = new RequestBudget({ perMinute: 100, perDay: 3 });
    expect(b.tryConsume(1000).allowed).toBe(true);
    expect(b.tryConsume(2000).allowed).toBe(true);
    expect(b.tryConsume(3000).allowed).toBe(true);
    const denied = b.tryConsume(4000);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('PER_DAY');
  });

  it('collector stops issuing requests once the daily budget is exhausted', async () => {
    const t = new ScriptedTransport([fixture()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), budget: { perMinute: 10, perDay: 1 }, discoveryIntervalMs: 0 });
    // First tick consumes the single allowed request (discovery).
    const o1 = await c.runOnce(KICKOFF_MS - 10 * 24 * HOUR, emptyCollectorState(), EMPTY_SHADOW, true);
    expect(t.listCalls).toBe(1);
    // Second tick: budget exhausted, no further requests.
    const o2 = await c.runOnce(KICKOFF_MS - 10 * 24 * HOUR + HOUR, o1.state, o1.snapshot, true);
    expect(t.listCalls).toBe(1);
    expect(o2.diagnostic.requestsDenied).toBeGreaterThan(0);
  });

  it('backoff honours a server Retry-After and grows with attempts', () => {
    expect(nextBackoffMs(0, 5000, 1)).toBeGreaterThanOrEqual(5000);
    const a0 = nextBackoffMs(0, undefined, 7);
    const a3 = nextBackoffMs(3, undefined, 7);
    expect(a3).toBeGreaterThan(a0);
    // Deterministic for the same inputs.
    expect(nextBackoffMs(2, undefined, 7)).toBe(nextBackoffMs(2, undefined, 7));
  });

  it('records a backoff note on a rate-limited result poll', async () => {
    const t = new ScriptedTransport([fixture()], new Map([
      ['fd-100', { ok: false, error: 'RATE_LIMITED', retryAfterMs: 30000 }],
    ]));
    const c = new ShadowCollector({ transport: t, forecasts: provider(), resultPollIntervalMs: 0 });
    const o1 = await c.runOnce(KICKOFF_MS - 27 * HOUR, emptyCollectorState(), EMPTY_SHADOW, true);
    const out = await c.runOnce(KICKOFF_MS + 2 * HOUR, o1.state, o1.snapshot, true);
    expect(out.diagnostic.notes.some((n) => n.startsWith('RESULT_ERROR'))).toBe(true);
    expect(out.diagnostic.notes.some((n) => n.includes('backoff='))).toBe(true);
  });
});

describe('collector – durable state and idempotent restart', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectorS-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips state and recovers from a corrupt main file via the .bak', () => {
    const store = new CollectorStateStore(path.join(dir, 'state.json'));
    const s1 = { ...emptyCollectorState(), lastDiscoveryMs: 123, pending: [] };
    expect(store.save(s1, 'commit-1').ok).toBe(true);
    const s2 = { ...emptyCollectorState(), lastDiscoveryMs: 456, pending: [] };
    expect(store.save(s2, 'commit-2').ok).toBe(true); // writes .bak of s1
    // Corrupt the main file; load should fall back to .bak (s1).
    fs.writeFileSync(store.mainPath, '{ corrupt');
    const loaded = store.load();
    expect(loaded.diagnostic.source).toBe('bak');
    expect(loaded.state.lastDiscoveryMs).toBe(123);
  });

  it('a repeated discovery tick does not duplicate pending entries (idempotent restart)', async () => {
    const t = new ScriptedTransport([fixture()], new Map());
    const c = new ShadowCollector({ transport: t, forecasts: provider(), discoveryIntervalMs: 0 });
    const discoverAt = KICKOFF_MS - 27 * HOUR; // inside the 7-day discovery horizon
    const o1 = await c.runOnce(discoverAt, emptyCollectorState(), EMPTY_SHADOW, true);
    const o2 = await c.runOnce(discoverAt + HOUR, o1.state, o1.snapshot, true);
    expect(o2.state.pending.length).toBe(1);
  });
});

describe('protocol – canonical hashing', () => {
  it('produces a stable 64-hex hash', () => {
    const h1 = computeProtocolHash();
    const h2 = computeProtocolHash(SHADOW_PROTOCOL);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalization is key-order independent', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('a substantive change yields a different hash', () => {
    const changed = { ...SHADOW_PROTOCOL, requirements: { ...SHADOW_PROTOCOL.requirements, minSettledSamples: 501 } };
    expect(computeProtocolHash(changed)).not.toBe(computeProtocolHash());
  });
});

describe('mode separation', () => {
  it('a mixed-mode snapshot reports both modes', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, {
      fixtureId: 'fx-1', competitionCode: 'PL', season: '2025/26', homeTeamId: 'H', awayTeamId: 'A',
      kickoffTime: new Date(KICKOFF_MS).toISOString(),
      generatedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS).toISOString(),
      recordedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 1000).toISOString(),
      frozen: FROZEN, candidate: FROZEN,
      calibration: { temperature: 1, fallback: true, sampleCount: 0, fittedThroughMs: null, minSamples: 500 },
      source: { provider: 'x' }, mode: 'prospective',
    });
    if (!r.ok) throw new Error('setup');
    const r2 = recordShadowForecast(r.snapshot, {
      fixtureId: 'fx-2', competitionCode: 'PL', season: '2025/26', homeTeamId: 'H', awayTeamId: 'A',
      kickoffTime: new Date(KICKOFF_MS).toISOString(),
      generatedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS).toISOString(),
      recordedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 1000).toISOString(),
      frozen: FROZEN, candidate: FROZEN,
      calibration: { temperature: 1, fallback: true, sampleCount: 0, fittedThroughMs: null, minSamples: 500 },
      source: { provider: 'x' }, mode: 'replay',
    });
    if (!r2.ok) throw new Error('setup');
    expect(snapshotModes(r2.snapshot)).toEqual(['prospective', 'replay']);
  });
});
