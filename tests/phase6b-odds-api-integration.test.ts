/**
 * Project Touchline – Phase 6B Integration Tests
 *
 * These tests exercise the *real* decision path of the odds integration:
 *   - adapter parsing of genuine The Odds API response shapes (the shapes captured from a
 *     live 200 response in Phase 6A),
 *   - fixture matching with ambiguity / kickoff rejection,
 *   - the monthly budget guard and provider quota tracking,
 *   - end-to-end orchestration via `resolveOddsForFixture`.
 *
 * NO network calls are made: `fetch` is injected everywhere. The response bodies below are
 * real-shaped fixtures (copied from a live response), never invented prices presented as live.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  adaptTheOddsApiEvent,
  fetchTheOddsApiOdds,
  COMPETITION_TO_ODDS_SPORT_KEY,
  classifyOddsError,
} from '../src/services/oddsAdapter';
import { matchEventToFixture, MatchCandidate } from '../src/services/oddsFixtureMatch';
import {
  createQuotaSnapshot,
  canSpend,
  refusalReason,
  recordRequest,
  isExhausted,
  monthKeyOf,
} from '../src/services/oddsQuota';
import { resolveOddsForFixture } from '../src/services/oddsService';
import { validateOddsBatch } from '../src/services/oddsSchema';

// ---------------------------------------------------------------------------------------
// A genuine-shaped event (structure captured from a live The Odds API /v4 response).
// ---------------------------------------------------------------------------------------
const genuineEvent = {
  id: 'evt-epl-1',
  sport_key: 'soccer_epl',
  sport_title: 'EPL',
  commence_time: '2026-10-17T11:30:00Z',
  home_team: 'Everton',
  away_team: 'Chelsea',
  bookmakers: [
    {
      key: 'betfred_uk',
      title: 'Betfred (UK)',
      last_update: '2026-10-14T23:10:11Z',
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Chelsea', price: 2.15 },
            { name: 'Everton', price: 3.1 },
            { name: 'Draw', price: 3.75 },
          ],
        },
      ],
    },
    {
      key: 'skybet',
      title: 'Sky Bet',
      last_update: '2026-10-14T23:11:00Z',
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Chelsea', price: 2.1 },
            { name: 'Everton', price: 3.1 },
            { name: 'Draw', price: 3.5 },
          ],
        },
      ],
    },
  ],
};

const candidates: MatchCandidate[] = [
  { fixtureId: 'fd-1001', homeName: 'Everton FC', awayName: 'Chelsea FC', kickoffIso: '2026-10-17T11:30:00Z' },
  { fixtureId: 'fd-1002', homeName: 'Arsenal', awayName: 'Liverpool', kickoffIso: '2026-10-17T14:00:00Z' },
];

function quotaHeaders(map: Record<string, string>): any {
  return { get: (h: string) => map[h] ?? null };
}

function okResponse(body: any, headers: Record<string, string> = {}): any {
  return { ok: true, status: 200, headers: quotaHeaders(headers), json: async () => body };
}

// ---------------------------------------------------------------------------------------
// 1. Adapter parsing of real-provider response shapes
// ---------------------------------------------------------------------------------------
describe('Phase 6B – The Odds API adapter (real response shapes)', () => {
  it('maps every bookmaker h2h line into a canonical FULL_TIME observation', () => {
    const obs = adaptTheOddsApiEvent(genuineEvent, 'fd-1001', 'PL');
    expect(obs).toHaveLength(2);
    expect(obs.map((o) => o.bookmaker).sort()).toEqual(['betfred_uk', 'skybet']);
    const bf = obs.find((o) => o.bookmaker === 'betfred_uk')!;
    expect(bf.selection).toEqual({ home: 3.1, draw: 3.75, away: 2.15 });
    expect(bf.market).toBe('1X2_FULL_TIME');
    expect(bf.period).toBe('FULL_TIME');
    expect(bf.phase).toBe('closing');
    expect(bf.provider).toBe('the-odds-api');
    // Genuine provider timestamp is preserved; no opening line is invented.
    expect(bf.observedAt).toBe('2026-10-14T23:10:11Z');
    expect(bf.openingAt).toBeUndefined();
  });

  it('accepts the genuine line through the canonical validator', () => {
    const obs = adaptTheOddsApiEvent(genuineEvent, 'fd-1001', 'PL');
    const validated = validateOddsBatch(obs, { now: new Date('2026-10-14T23:30:00Z') });
    expect(validated.every((v) => v.valid)).toBe(true);
  });

  it('returns no observations when a bookmaker lacks a complete 1X2 line', () => {
    const partial = {
      home_team: 'Everton',
      away_team: 'Chelsea',
      bookmakers: [{ key: 'x', markets: [{ key: 'h2h', outcomes: [{ name: 'Everton', price: 3.1 }, { name: 'Draw', price: 3.7 }] }] }],
    };
    expect(adaptTheOddsApiEvent(partial, 'fd-1001', 'PL')).toHaveLength(0);
  });

  it('never invents prices when the h2h market is missing', () => {
    const noMarket = { home_team: 'A', away_team: 'B', bookmakers: [{ key: 'x', markets: [{ key: 'spreads', outcomes: [] }] }] };
    expect(adaptTheOddsApiEvent(noMarket, 'fd-1', 'PL')).toHaveLength(0);
  });

  it('rejects non-positive or non-finite prices rather than accepting them', () => {
    const bad = {
      home_team: 'A',
      away_team: 'B',
      bookmakers: [{ key: 'x', markets: [{ key: 'h2h', outcomes: [{ name: 'A', price: 0 }, { name: 'B', price: 2.0 }, { name: 'Draw', price: 3.0 }] }] }],
    };
    expect(adaptTheOddsApiEvent(bad, 'fd-1', 'PL')).toHaveLength(0);
  });

  it('maps only verified competitions to sport keys', () => {
    expect(COMPETITION_TO_ODDS_SPORT_KEY.PL).toBe('soccer_epl');
    expect(COMPETITION_TO_ODDS_SPORT_KEY.CL).toBe('soccer_uefa_champs_league');
    // An unmapped competition must not silently resolve to something.
    expect(COMPETITION_TO_ODDS_SPORT_KEY['SP-999']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// 2. Fixture matching – reject ambiguous team or kickoff matches
// ---------------------------------------------------------------------------------------
describe('Phase 6B – event → canonical fixture matching', () => {
  it('matches a single unambiguous fixture with a tolerant kickoff', () => {
    const m = matchEventToFixture(
      { homeName: 'Everton', awayName: 'Chelsea', commenceIso: '2026-10-17T11:31:00Z' },
      candidates
    );
    expect(m.status).toBe('matched');
    expect(m.fixtureId).toBe('fd-1001');
  });

  it('refuses when two fixtures share the same two clubs (ambiguous)', () => {
    const dup: MatchCandidate[] = [
      { fixtureId: 'fd-1', homeName: 'Everton', awayName: 'Chelsea', kickoffIso: '2026-10-17T11:30:00Z' },
      { fixtureId: 'fd-2', homeName: 'Everton FC', awayName: 'Chelsea FC', kickoffIso: '2026-10-17T11:30:00Z' },
    ];
    const m = matchEventToFixture({ homeName: 'Everton', awayName: 'Chelsea', commenceIso: '2026-10-17T11:30:00Z' }, dup);
    expect(m.status).toBe('ambiguous');
    expect(m.fixtureId).toBeNull();
    expect(m.candidates.sort()).toEqual(['fd-1', 'fd-2']);
  });

  it('rejects a name match whose kickoff is outside tolerance', () => {
    const m = matchEventToFixture(
      { homeName: 'Everton', awayName: 'Chelsea', commenceIso: '2026-10-18T11:30:00Z' },
      candidates
    );
    expect(m.status).toBe('kickoff_mismatch');
    expect(m.fixtureId).toBeNull();
  });

  it('returns no_candidate when no club names match', () => {
    const m = matchEventToFixture({ homeName: 'Everton', awayName: 'Chelsea', commenceIso: '2026-10-17T11:30:00Z' }, [
      { fixtureId: 'fd-9', homeName: 'Arsenal', awayName: 'Liverpool', kickoffIso: '2026-10-17T11:30:00Z' },
    ]);
    expect(m.status).toBe('no_candidate');
    expect(m.fixtureId).toBeNull();
  });

  it('honours a custom tolerance', () => {
    const m = matchEventToFixture(
      { homeName: 'Everton', awayName: 'Chelsea', commenceIso: '2026-10-17T11:44:00Z' },
      candidates,
      5 * 60 * 1000
    );
    expect(m.status).toBe('kickoff_mismatch');
  });
});

// ---------------------------------------------------------------------------------------
// 3. Monthly budget + provider quota tracking
// ---------------------------------------------------------------------------------------
describe('Phase 6B – monthly budget and quota guard', () => {
  const now = new Date('2026-10-14T12:00:00Z');

  it('allows spending below the budget and refuses at the limit', () => {
    const q = createQuotaSnapshot(2, now);
    expect(canSpend(q, now)).toBe(true);
    const q1 = recordRequest(q, now, 1, quotaHeaders({ 'x-requests-remaining': '498', 'x-requests-used': '2', 'x-requests-last': '1' }));
    expect(q1.requestsUsed).toBe(1);
    expect(q1.providerRemaining).toBe(498);
    expect(q1.lastCost).toBe(1);
    const q2 = recordRequest(q1, now, 1, quotaHeaders({ 'x-requests-remaining': '497' }));
    expect(canSpend(q2, now)).toBe(false);
    expect(isExhausted(q2, now)).toBe(true);
    expect(refusalReason(q2, now)).toBe('local_budget_exhausted');
  });

  it('refuses when the provider reports zero remaining even if the local budget allows', () => {
    const q = recordRequest(createQuotaSnapshot(300, now), now, 1, quotaHeaders({ 'x-requests-remaining': '0' }));
    expect(canSpend(q, now)).toBe(false);
    expect(refusalReason(q, now)).toBe('provider_quota_exhausted');
  });

  it('resets the local counter when the UTC month changes', () => {
    const q = recordRequest(createQuotaSnapshot(1, now), now, 1, quotaHeaders({ 'x-requests-remaining': '499' }));
    expect(canSpend(q, now)).toBe(false);
    const nextMonth = new Date('2026-11-01T00:00:01Z');
    expect(canSpend(q, nextMonth)).toBe(true);
    expect(monthKeyOf(now)).toBe('2026-10');
    expect(monthKeyOf(nextMonth)).toBe('2026-11');
  });

  it('keeps the previous provider value when a later response omits the header', () => {
    const q1 = recordRequest(createQuotaSnapshot(300, now), now, 1, quotaHeaders({ 'x-requests-remaining': '400' }));
    const q2 = recordRequest(q1, now, 1, quotaHeaders({}));
    expect(q2.providerRemaining).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------
// 4. Adapter fetch classification (failures, quota exhaustion, auth)
// ---------------------------------------------------------------------------------------
describe('Phase 6B – The Odds API fetch classification', () => {
  it('returns not_configured and never calls fetch without a key', async () => {
    const fetchImpl = vi.fn();
    const r = await fetchTheOddsApiOdds(null, 'soccer_epl', 'PL', { fetchImpl: fetchImpl as any });
    expect(r.status).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns market_unavailable (no request) when the competition has no sport key', async () => {
    const fetchImpl = vi.fn();
    const r = await fetchTheOddsApiOdds('key', null, 'SP-999', { fetchImpl: fetchImpl as any });
    expect(r.status).toBe('market_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns budget_exhausted without sending when allowRequest is false', async () => {
    const fetchImpl = vi.fn();
    const r = await fetchTheOddsApiOdds('key', 'soccer_epl', 'PL', { fetchImpl: fetchImpl as any, allowRequest: false });
    expect(r.status).toBe('budget_exhausted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('captures quota headers on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([genuineEvent], { 'x-requests-remaining': '497', 'x-requests-used': '3', 'x-requests-last': '1' }));
    const r = await fetchTheOddsApiOdds('key', 'soccer_epl', 'PL', { fetchImpl: fetchImpl as any });
    expect(r.status).toBe('ok');
    expect(r.events).toHaveLength(1);
    expect(r.quota?.remaining).toBe(497);
    expect(r.costCredits).toBe(1);
  });

  it('classifies 401, 403, 429, 5xx and network failures', async () => {
    const mk = (status: number, body: any, headers: Record<string, string> = {}) =>
      vi.fn().mockResolvedValue({ ok: false, status, headers: quotaHeaders(headers), json: async () => body });

    expect((await fetchTheOddsApiOdds('k', 'soccer_epl', 'PL', { fetchImpl: mk(401, { message: 'unauthorized' }) as any })).status).toBe('auth_error');
    expect((await fetchTheOddsApiOdds('k', 'soccer_epl', 'PL', { fetchImpl: mk(403, { message: 'forbidden' }) as any })).status).toBe('plan_restricted');
    const rl = await fetchTheOddsApiOdds('k', 'soccer_epl', 'PL', { fetchImpl: mk(429, {}, { 'Retry-After': '30' }) as any });
    expect(rl.status).toBe('rate_limited');
    expect(rl.retryAfterSeconds).toBe(30);
    expect((await fetchTheOddsApiOdds('k', 'soccer_epl', 'PL', { fetchImpl: mk(500, {}) as any })).status).toBe('network_error');

    const netErr = vi.fn().mockRejectedValue(new Error('boom'));
    expect((await fetchTheOddsApiOdds('k', 'soccer_epl', 'PL', { fetchImpl: netErr as any })).status).toBe('network_error');
  });

  it('reports invalid_response for a non-array body and never leaks the key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ unexpected: true }));
    const r = await fetchTheOddsApiOdds('super-secret-key', 'soccer_epl', 'PL', { fetchImpl: fetchImpl as any });
    expect(r.status).toBe('invalid_response');
    expect(r.notice).not.toMatch(/super-secret-key/);
  });

  it('classifyOddsError maps HTTP statuses', () => {
    expect(classifyOddsError(401, {})).toBe('auth_error');
    expect(classifyOddsError(403, {})).toBe('plan_restricted');
    expect(classifyOddsError(429, {})).toBe('rate_limited');
    expect(classifyOddsError(503, {})).toBe('network_error');
  });
});

// ---------------------------------------------------------------------------------------
// 5. End-to-end orchestration
// ---------------------------------------------------------------------------------------
describe('Phase 6B – resolveOddsForFixture orchestration', () => {
  const now = new Date('2026-10-14T23:30:00Z');
  const config = { oddsApiKey: 'key', oddsApiEnabled: true, monthlyBudget: 300 };
  const deps = (fetchImpl: any) => ({ now, fetchImpl, loadCandidates: async () => candidates });

  it('produces a matched, valid observation for the requested fixture', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([genuineEvent], { 'x-requests-remaining': '497' }));
    const { result, quota } = await resolveOddsForFixture('fd-1001', 'PL', config, createQuotaSnapshot(300, now), deps(fetchImpl));
    expect(result.status).toBe('ok');
    expect(result.observations).toHaveLength(2);
    expect(result.observations.every((o) => o.fixtureId === 'fd-1001')).toBe(true);
    expect(quota.requestsUsed).toBe(1);
    expect(quota.providerRemaining).toBe(497);
  });

  it('does not attach odds to a different fixture (mismatch)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([genuineEvent]));
    const { result } = await resolveOddsForFixture('fd-1002', 'PL', config, createQuotaSnapshot(300, now), deps(fetchImpl));
    expect(result.status).toBe('fixture_mismatch');
    expect(result.observations).toHaveLength(0);
  });

  it('refuses ambiguous matches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([genuineEvent]));
    const dupCandidates: MatchCandidate[] = [
      { fixtureId: 'fd-1001', homeName: 'Everton', awayName: 'Chelsea', kickoffIso: '2026-10-17T11:30:00Z' },
      { fixtureId: 'fd-1001b', homeName: 'Everton FC', awayName: 'Chelsea FC', kickoffIso: '2026-10-17T11:30:00Z' },
    ];
    const { result } = await resolveOddsForFixture('fd-1001', 'PL', config, createQuotaSnapshot(300, now), {
      now,
      fetchImpl,
      loadCandidates: async () => dupCandidates,
    });
    expect(result.status).toBe('fixture_mismatch');
    expect(result.notice).toMatch(/ambiguous/i);
  });

  it('sends no request when disabled or unconfigured', async () => {
    const fetchImpl = vi.fn();
    const disabled = await resolveOddsForFixture('fd-1001', 'PL', { ...config, oddsApiEnabled: false }, createQuotaSnapshot(300, now), deps(fetchImpl));
    expect(disabled.result.status).toBe('not_configured');
    const noKey = await resolveOddsForFixture('fd-1001', 'PL', { ...config, oddsApiKey: null }, createQuotaSnapshot(300, now), deps(fetchImpl));
    expect(noKey.result.status).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to send when the local budget is exhausted', async () => {
    const fetchImpl = vi.fn();
    const spent = createQuotaSnapshot(1, now);
    const used = recordRequest(spent, now, 1, quotaHeaders({ 'x-requests-remaining': '499' }));
    const { result } = await resolveOddsForFixture('fd-1001', 'PL', config, used, deps(fetchImpl));
    expect(result.status).toBe('budget_exhausted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to send when the provider quota is exhausted', async () => {
    const fetchImpl = vi.fn();
    const used = recordRequest(createQuotaSnapshot(300, now), now, 1, quotaHeaders({ 'x-requests-remaining': '0' }));
    const { result } = await resolveOddsForFixture('fd-1001', 'PL', config, used, deps(fetchImpl));
    expect(result.status).toBe('budget_exhausted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never returns stale prices as current (validator rejects aged observations)', async () => {
    const staleEvent = { ...genuineEvent, bookmakers: genuineEvent.bookmakers.map((b) => ({ ...b, last_update: '2026-10-10T00:00:00Z' })) };
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([staleEvent]));
    const { result } = await resolveOddsForFixture('fd-1001', 'PL', config, createQuotaSnapshot(300, now), deps(fetchImpl));
    expect(result.status).toBe('ok'); // adapter returns them...
    const validated = validateOddsBatch(result.observations, { now });
    // ...but the canonical layer refuses to present them as usable odds.
    expect(validated.every((v) => v.valid)).toBe(false);
    expect(validated[0].issues.some((i) => i.reason === 'EXPIRED_OBSERVATION')).toBe(true);
  });
});
