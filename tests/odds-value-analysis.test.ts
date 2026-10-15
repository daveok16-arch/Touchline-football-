/**
 * Phase 4 – Odds integration and value analysis
 *
 * All fixtures and odds below are TEST DATA constructed to exercise the maths and the
 * safeguards. They are NOT live bookmaker prices and must never be presented as such.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  impliedProbability,
  impliedProbabilities,
  overround,
  devigProportional,
  probabilityDifferencePp,
  expectedReturn,
  analyzeValue,
  DEVIG_METHOD,
} from '../src/services/oddsValue';
import {
  validateOddsObservation,
  validateOddsBatch,
  matchesFixture,
  oddsObservationKey,
  SUPPORTED_ODDS_MARKET,
  OddsObservation,
} from '../src/services/oddsSchema';
import {
  adaptFiveDollarOdds,
  fetchFiveDollarOdds,
  classifyOddsError,
} from '../src/services/oddsAdapter';
import { buildOddsPayload, ODDS_CAVEATS } from '../src/services/oddsEligibility';

const NOW = new Date('2026-10-14T12:00:00Z');

/** TEST DATA: a valid 1X2 observation. Not a real bookmaker price. */
function testObservation(overrides: Partial<OddsObservation> = {}): OddsObservation {
  return {
    fixtureId: 'fd-100',
    competitionCode: 'PL',
    provider: '5dollarfootballapi',
    bookmaker: 'bet365',
    market: SUPPORTED_ODDS_MARKET,
    phase: 'closing',
    observedAt: '2026-10-14T11:30:00Z',
    period: 'FULL_TIME',
    selection: { home: 2.0, draw: 3.5, away: 4.0 },
    ...overrides,
  };
}

const MODEL = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };

describe('Phase 4 – implied probability and overround', () => {
  it('computes raw implied probability as 1/odds', () => {
    expect(impliedProbability(2.0)).toBeCloseTo(0.5, 10);
    expect(impliedProbability(4.0)).toBeCloseTo(0.25, 10);
    expect(Number.isNaN(impliedProbability(0))).toBe(true);
    expect(Number.isNaN(impliedProbability(-2))).toBe(true);
    expect(Number.isNaN(impliedProbability(NaN))).toBe(true);
  });

  it('computes booksum and overround', () => {
    // 1/2 + 1/3.5 + 1/4 = 0.5 + 0.285714... + 0.25 = 1.035714...
    const o = overround({ home: 2.0, draw: 3.5, away: 4.0 });
    expect(o.booksum).toBeCloseTo(1.0357142857, 9);
    expect(o.overround).toBeCloseTo(0.0357142857, 9);
  });

  it('a fair book (no margin) has zero overround', () => {
    const o = overround({ home: 2.0, draw: 4.0, away: 4.0 });
    expect(o.overround).toBeCloseTo(0, 10);
  });
});

describe('Phase 4 – de-vigging', () => {
  it('proportionally normalises implied probabilities to sum to 1', () => {
    const d = devigProportional({ home: 2.0, draw: 3.5, away: 4.0 })!;
    expect(d.homeWin + d.draw + d.awayWin).toBeCloseTo(1, 10);
    const raw = impliedProbabilities({ home: 2.0, draw: 3.5, away: 4.0 });
    expect(d.homeWin).toBeCloseTo(raw.home / 1.0357142857, 9);
  });

  it('returns null for a non-positive booksum', () => {
    expect(devigProportional({ home: NaN, draw: 3.5, away: 4.0 })).toBeNull();
  });

  it('documents the proportional method', () => {
    expect(DEVIG_METHOD).toBe('proportional');
  });
});

describe('Phase 4 – probability difference and expected return', () => {
  it('reports the probability difference in percentage points', () => {
    expect(probabilityDifferencePp(0.5, 0.45)).toBeCloseTo(5, 10);
    expect(probabilityDifferencePp(0.3, 0.3)).toBeCloseTo(0, 10);
    expect(probabilityDifferencePp(0.2, 0.25)).toBeCloseTo(-5, 10);
  });

  it('computes expected return from the offered decimal odds', () => {
    // model 0.5 at odds 2.5 -> 0.5*2.5 - 1 = 0.25
    expect(expectedReturn(0.5, 2.5)).toBeCloseTo(0.25, 10);
    // model 0.5 at odds 2.0 -> 0.0 (fair)
    expect(expectedReturn(0.5, 2.0)).toBeCloseTo(0, 10);
    // model 0.2 at odds 4.0 -> -0.2
    expect(expectedReturn(0.2, 4.0)).toBeCloseTo(-0.2, 10);
  });

  it('keeps market prob, model prob, difference and EV as separate fields', () => {
    const a = analyzeValue(testObservation(), MODEL);
    const home = a.selections.find((s) => s.selection === 'HOME')!;
    expect(home.decimalOdds).toBe(2.0);
    expect(home.rawImpliedProbability).toBeCloseTo(0.5, 10);
    expect(home.marketProbability).not.toBe(home.modelProbability); // distinct
    expect(home.probabilityDifferencePp).toBeCloseTo((0.5 - home.marketProbability) * 100, 10);
    expect(home.expectedReturn).toBeCloseTo(0.5 * 2.0 - 1, 10);
    expect(a.disclaimer).toMatch(/not a guaranteed or proven profit/i);
  });
});

describe('Phase 4 – odds validation', () => {
  it('accepts a well-formed observation', () => {
    expect(validateOddsObservation(testObservation(), { now: NOW })).toHaveLength(0);
  });

  it('rejects non-finite or non-positive decimal odds', () => {
    const bad = testObservation({ selection: { home: 0, draw: 3.5, away: 4.0 } });
    const issues = validateOddsObservation(bad, { now: NOW });
    expect(issues.map((i) => i.reason)).toContain('INVALID_ODDS');
    const bad2 = testObservation({ selection: { home: 2, draw: NaN, away: 4 } });
    expect(validateOddsObservation(bad2, { now: NOW }).map((i) => i.reason)).toContain('INVALID_ODDS');
    const bad3 = testObservation({ selection: { home: 2, draw: 1.0, away: 4 } });
    expect(validateOddsObservation(bad3, { now: NOW }).map((i) => i.reason)).toContain('INVALID_ODDS');
  });

  it('rejects missing selections', () => {
    const bad = testObservation({ selection: { home: 2.0 } as any });
    expect(validateOddsObservation(bad, { now: NOW }).map((i) => i.reason)).toContain('MISSING_SELECTION');
  });

  it('rejects stale observations beyond the freshness limit', () => {
    const stale = testObservation({ observedAt: '2026-10-12T00:00:00Z' }); // 60h old
    const issues = validateOddsObservation(stale, { now: NOW });
    expect(issues.map((i) => i.reason)).toContain('EXPIRED_OBSERVATION');
    // custom limit
    const fresh = testObservation({ observedAt: '2026-10-14T11:00:00Z' });
    expect(validateOddsObservation(fresh, { now: NOW, maxAgeMs: 30 * 60 * 1000 }).map((i) => i.reason)).toContain('EXPIRED_OBSERVATION');
  });

  it('rejects observations without a timestamp', () => {
    const bad = testObservation({ observedAt: undefined as any });
    expect(validateOddsObservation(bad, { now: NOW }).map((i) => i.reason)).toContain('MISSING_TIMESTAMP');
  });

  it('rejects unsupported markets and periods', () => {
    expect(validateOddsObservation(testObservation({ market: 'OVER_UNDER_2_5' as any }), { now: NOW }).map((i) => i.reason)).toContain('INVALID_MARKET');
    expect(validateOddsObservation(testObservation({ period: 'HALF_TIME' as any }), { now: NOW }).map((i) => i.reason)).toContain('INVALID_PERIOD');
  });

  it('rejects duplicate observations for the same fixture+bookmaker+market+phase', () => {
    const existing = [testObservation()];
    const dup = testObservation();
    expect(validateOddsObservation(dup, { now: NOW, existing }).map((i) => i.reason)).toContain('DUPLICATE_OBSERVATION');
    // A different phase is not a duplicate.
    const opening = testObservation({ phase: 'opening' });
    expect(validateOddsObservation(opening, { now: NOW, existing })).toHaveLength(0);
    expect(oddsObservationKey(testObservation())).toBe(oddsObservationKey(dup));
  });

  it('batch validation flags duplicates within the batch', () => {
    const results = validateOddsBatch([testObservation(), testObservation()], { now: NOW });
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
    expect(results[1].issues.map((i) => i.reason)).toContain('DUPLICATE_OBSERVATION');
  });

  it('matches fixtures by canonical id', () => {
    expect(matchesFixture(testObservation(), 'fd-100')).toBe(true);
    expect(matchesFixture(testObservation(), 'fd-999')).toBe(false);
  });
});

describe('Phase 4 – 5Dollar adapter and provider failure classification', () => {
  it('maps the real 1X2 payload shape into canonical observations', () => {
    const payload = {
      success: 1,
      data: {
        fixture_id: 197590518,
        bookmakers: [
          {
            id: 281,
            name: 'Bet 365',
            slug: 'bet365',
            odds: {
              '1x2': {
                opening: { home: 1.53, draw: 3.75, away: 5 },
                closing: { home: 1.18, draw: 5.5, away: 15 },
                inplay: null,
              },
            },
          },
        ],
      },
    };
    const obs = adaptFiveDollarOdds(payload, 'fd-197590518', 'PL', '2026-10-14T11:00:00Z');
    expect(obs).toHaveLength(2); // opening + closing (inplay null)
    expect(obs.map((o) => o.phase).sort()).toEqual(['closing', 'opening']);
    expect(obs[0].selection.home).toBe(1.53);
    expect(obs[0].market).toBe(SUPPORTED_ODDS_MARKET);
    expect(obs[0].period).toBe('FULL_TIME');
    expect(obs[0].openingAt).toBeUndefined(); // never invented
  });

  it('returns no observations when the 1X2 market is absent', () => {
    expect(adaptFiveDollarOdds({ success: 1, data: { bookmakers: [{ slug: 'bet365', odds: {} }] } }, 'fd-1', 'PL', '2026-10-14T11:00:00Z')).toHaveLength(0);
  });

  it('classifies HTTP statuses and error codes', () => {
    expect(classifyOddsError(401, { error: { code: 'invalid_api_key' } })).toBe('auth_error');
    expect(classifyOddsError(403, { error: { code: 'plan_required' } })).toBe('plan_restricted');
    expect(classifyOddsError(404, {})).toBe('fixture_not_found');
    expect(classifyOddsError(429, {})).toBe('rate_limited');
    expect(classifyOddsError(500, {})).toBe('network_error');
  });

  it('returns not_configured without a key and never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const r = await fetchFiveDollarOdds(null, 'fd-1', 'PL', { fetchImpl: fetchImpl as any });
    expect(r.status).toBe('not_configured');
    expect(r.observations).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports auth_error honestly on HTTP 401 (the observed real-world case)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({ success: 0, error: { code: 'invalid_api_key', message: 'invalid' } }),
    });
    const r = await fetchFiveDollarOdds('bad-key', 'fd-1', 'PL', { fetchImpl: fetchImpl as any });
    expect(r.status).toBe('auth_error');
    expect(r.observations).toHaveLength(0);
    expect(r.notice).toMatch(/HTTP 401/);
    expect(r.notice).not.toMatch(/bad-key/); // never leaks the key
  });

  it('classifies rate limits, plan restrictions and network failures', async () => {
    const mk = (status: number, body: any, headers?: any) =>
      vi.fn().mockResolvedValue({ ok: false, status, headers: { get: (h: string) => headers?.[h] ?? null }, json: async () => body });

    expect((await fetchFiveDollarOdds('k', 'fd-1', 'PL', { fetchImpl: mk(429, {}, { 'Retry-After': '30' }) as any })).status).toBe('rate_limited');
    expect((await fetchFiveDollarOdds('k', 'fd-1', 'PL', { fetchImpl: mk(403, { error: { code: 'plan_required' } }) as any })).status).toBe('plan_restricted');
    expect((await fetchFiveDollarOdds('k', 'fd-1', 'PL', { fetchImpl: mk(404, {}) as any })).status).toBe('fixture_not_found');

    const netErr = vi.fn().mockRejectedValue(new Error('boom'));
    expect((await fetchFiveDollarOdds('k', 'fd-1', 'PL', { fetchImpl: netErr as any })).status).toBe('network_error');
  });

  it('reports market_unavailable for a successful but empty response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: 1, data: { fixture_id: 1, bookmakers: [] } }),
    });
    const r = await fetchFiveDollarOdds('k', 'fd-1', 'PL', { fetchImpl: fetchImpl as any });
    expect(r.status).toBe('market_unavailable');
    expect(r.observations).toHaveLength(0);
  });
});

describe('Phase 4 – eligibility and safeguards', () => {
  const validFetch = { status: 'ok' as const, observations: [], provider: '5dollarfootballapi' as const, notice: 'OK' };

  it('produces an analysis only when odds are valid and a model prediction exists', () => {
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: validFetch,
      validated: [{ observation: testObservation(), valid: true, issues: [] }],
      modelProbabilities: MODEL,
    });
    expect(p.eligibility.eligible).toBe(true);
    expect(p.analysis).toBeDefined();
    expect(p.analysis!.selections).toHaveLength(3);
    expect(p.caveats.length).toBeGreaterThan(0);
  });

  it('is ineligible when the provider is unavailable', () => {
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: { status: 'auth_error', observations: [], provider: '5dollarfootballapi', notice: 'HTTP 401' },
      validated: [],
      modelProbabilities: MODEL,
    });
    expect(p.eligibility.eligible).toBe(false);
    expect(p.analysis).toBeUndefined();
    expect(p.eligibility.reasons).toContain('PROVIDER_UNAVAILABLE');
  });

  it('is ineligible when no model prediction exists (never fabricates one)', () => {
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: validFetch,
      validated: [{ observation: testObservation(), valid: true, issues: [] }],
      modelProbabilities: null,
    });
    expect(p.eligibility.eligible).toBe(false);
    expect(p.eligibility.reasons).toContain('MODEL_PREDICTION_UNAVAILABLE');
    expect(p.analysis).toBeUndefined();
  });

  it('is ineligible when odds are stale or invalid', () => {
    const stale = buildOddsPayload({
      matchId: 'fd-100',
      fetch: validFetch,
      validated: [{ observation: testObservation(), valid: false, issues: [{ reason: 'EXPIRED_OBSERVATION', detail: 'old' }] }],
      modelProbabilities: MODEL,
    });
    expect(stale.eligibility.eligible).toBe(false);
    expect(stale.eligibility.reasons).toContain('STALE_ODDS');

    const invalid = buildOddsPayload({
      matchId: 'fd-100',
      fetch: validFetch,
      validated: [{ observation: testObservation(), valid: false, issues: [{ reason: 'INVALID_ODDS', detail: 'bad' }] }],
      modelProbabilities: MODEL,
    });
    expect(invalid.eligibility.reasons).toContain('INVALID_ODDS');
  });

  it('is ineligible on a fixture mismatch', () => {
    const p = buildOddsPayload({
      matchId: 'fd-999',
      fetch: validFetch,
      validated: [{ observation: testObservation({ fixtureId: 'fd-100' }), valid: true, issues: [] }],
      modelProbabilities: MODEL,
    });
    expect(p.eligibility.eligible).toBe(false);
    expect(p.eligibility.reasons).toContain('FIXTURE_MISMATCH');
  });

  it('never turns model overconfidence into a recommendation or a thresholded signal', () => {
    // Extreme model probability, absurd price: still no "recommendation"/"bet"/"sure" language.
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: validFetch,
      validated: [{ observation: testObservation({ selection: { home: 2, draw: 3.5, away: 60 } }), valid: true, issues: [] }],
      modelProbabilities: { homeWin: 0.95, draw: 0.03, awayWin: 0.02 },
    });
    const blob = JSON.stringify(p).toLowerCase();
    // Every occurrence of a risky phrase must be negated ("not a recommendation",
    // "not a guaranteed ... profit"). There must be no affirmative betting language.
    const negated = (phrase: RegExp) => {
      for (const m of blob.matchAll(phrase)) {
        const before = blob.slice(Math.max(0, m.index! - 40), m.index!);
        expect(before).toMatch(/\bnot\b|\bnever\b|\bno\b/);
      }
    };
    negated(/\brecommend\w*/g);
    negated(/\bguaranteed\b/g);
    negated(/\bproven profit\b/g);
    expect(blob).not.toMatch(/\bsure bet\b/);
    expect(blob).not.toMatch(/\bvalue bet\b/);
    expect(blob).not.toMatch(/\bwe recommend\b/);
    expect(blob).not.toMatch(/\bbet on\b/);
    // Expected return is still just an expectation.
    expect(p.analysis!.selections.find((s) => s.selection === 'AWAY')!.expectedReturn).toBeGreaterThan(0);
  });

  it('always states the known model limitations', () => {
    const blob = ODDS_CAVEATS.join(' ');
    expect(blob).toMatch(/overconfident in the high-probability tail/i);
    expect(blob).toMatch(/Champions League/i);
  });
});
