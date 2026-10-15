import { describe, it, expect } from 'vitest';
import { Fixture } from '../src/types/football';
import {
  mergeFixtureMetadata,
  deduplicateFixtures,
  areFixturesEquivalent,
} from '../src/utils/matchIdentity';
import { mapFootballDataStatus, adaptFootballDataMatch } from '../src/services/footballDataAdapter';
import { mapSportApiStatus, adaptSportApiFixture, SportApiFixture } from '../src/services/sportApiAdapter';
import { isFixtureStale, LIVE_STALE_THRESHOLD_MS } from '../src/utils/freshness';
import { summarizeFixtureFetch, resolveFixtureDateWindow, MAX_FD_WINDOW_DAYS } from '../src/services/fixtureAvailability';
import { formatKickoffTime, getDateKeyInTimezone, formatKickoffFull } from '../src/utils/timezone';

const PL = { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE' as const, country: 'England', season: '2026/27' };
const CL = { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP' as const, country: 'Europe', season: '2026/27' };

const fx = (o: Partial<Fixture>): Fixture => ({
  id: 'x-1',
  utcKickoffTime: '2026-10-14T19:00:00Z',
  status: 'SCHEDULED',
  competition: PL,
  homeTeam: { id: '1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
  awayTeam: { id: '2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
  ...o,
});

describe('Phase 2 – Provider status mapping (lifecycle states)', () => {
  it('maps football-data.org statuses without inventing new states', () => {
    expect(mapFootballDataStatus('SCHEDULED')).toBe('SCHEDULED');
    expect(mapFootballDataStatus('TIMED')).toBe('TIMED');
    expect(mapFootballDataStatus('IN_PLAY')).toBe('IN_PLAY');
    expect(mapFootballDataStatus('PAUSED')).toBe('PAUSED');
    expect(mapFootballDataStatus('FINISHED')).toBe('FINISHED');
    expect(mapFootballDataStatus('AWARDED')).toBe('FINISHED');
    expect(mapFootballDataStatus('POSTPONED')).toBe('POSTPONED');
    expect(mapFootballDataStatus('SUSPENDED')).toBe('SUSPENDED');
    expect(mapFootballDataStatus('CANCELLED')).toBe('CANCELLED');
    // Unknown values fall back safely to SCHEDULED rather than a fabricated state
    expect(mapFootballDataStatus('SOMETHING_NEW')).toBe('SCHEDULED');
  });

  it('maps SportAPI.ai statuses including halftime, postponed, cancelled and suspended', () => {
    expect(mapSportApiStatus('live')).toBe('IN_PLAY');
    expect(mapSportApiStatus('in_play')).toBe('IN_PLAY');
    expect(mapSportApiStatus('ht')).toBe('PAUSED');
    expect(mapSportApiStatus('paused')).toBe('PAUSED');
    expect(mapSportApiStatus('ft')).toBe('FINISHED');
    expect(mapSportApiStatus('aet')).toBe('FINISHED');
    expect(mapSportApiStatus('pens')).toBe('FINISHED');
    expect(mapSportApiStatus('postp.')).toBe('POSTPONED');
    expect(mapSportApiStatus('susp.')).toBe('SUSPENDED');
    expect(mapSportApiStatus('canc.')).toBe('CANCELLED');
    expect(mapSportApiStatus('scheduled')).toBe('SCHEDULED');
    expect(mapSportApiStatus('unknown-value')).toBe('SCHEDULED');
  });
});

describe('Phase 2 – Provider field omission handling', () => {
  it('football-data.org: omitted score is preserved as undefined, never fabricated', () => {
    const adapted = adaptFootballDataMatch({
      id: 1,
      utcDate: '2026-10-14T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 2021, code: 'PL', name: 'Premier League', type: 'LEAGUE' },
      homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
    } as any);
    expect(adapted.score).toBeUndefined();
    expect(adapted.isDelayed).toBe(true);
    expect(adapted.lastUpdated).toBeUndefined();
  });

  it('football-data.org: halftime with null values is not presented as a real score', () => {
    const adapted = adaptFootballDataMatch({
      id: 2,
      utcDate: '2026-10-14T19:00:00Z',
      status: 'IN_PLAY',
      minute: 30,
      competition: { id: 2021, code: 'PL', name: 'Premier League', type: 'LEAGUE' },
      homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
      score: { fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    } as any);
    expect(adapted.score?.home).toBeNull();
    expect(adapted.score?.away).toBeNull();
  });

  it('sportapi.ai: null scores yield no score object (incomplete data preserved)', () => {
    const raw: SportApiFixture = {
      id: 9001,
      home_id: 1,
      away_id: 2,
      date: '2026-10-14',
      datetime: '2026-10-14T19:00:00Z',
      kickoff_utc: '2026-10-14T19:00:00Z',
      updated_at: '2026-10-14T19:40:00Z',
      home_score: null,
      away_score: null,
      result: null,
      status: 'live',
      minute: 40,
      league_id: 24,
      league_name: 'Premier League',
      home_team: 'Arsenal',
      away_team: 'Chelsea',
    };
    const adapted = adaptSportApiFixture(raw);
    expect(adapted.score).toBeUndefined();
    expect(adapted.status).toBe('IN_PLAY');
    expect(adapted.minute).toBe(40);
    expect(adapted.lastUpdated).toBe('2026-10-14T19:40:00Z');
    expect(adapted.isDelayed).toBe(false);
  });

  it('sportapi.ai: partial score (one side null) is not treated as a complete score', () => {
    const raw: SportApiFixture = {
      id: 9002,
      home_id: 1,
      away_id: 2,
      date: '2026-10-14',
      datetime: '2026-10-14T19:00:00Z',
      kickoff_utc: '2026-10-14T19:00:00Z',
      updated_at: '2026-10-14T19:40:00Z',
      home_score: 1,
      away_score: null,
      result: null,
      status: 'live',
      minute: 40,
      league_id: 24,
      league_name: 'Premier League',
      home_team: 'Arsenal',
      away_team: 'Chelsea',
    };
    expect(adaptSportApiFixture(raw).score).toBeUndefined();
  });
});

describe('Phase 2 – Live score merging and provider fallback', () => {
  it('prefers a fresher non-delayed live score over a stale delayed score (even with fewer goals)', () => {
    const delayedFd = fx({ id: 'fd-1', status: 'IN_PLAY', isDelayed: true, minute: 70, score: { home: 2, away: 1 } });
    const liveSp = fx({ id: 'sp-1', status: 'IN_PLAY', isDelayed: false, minute: 70, score: { home: 1, away: 1 } });

    // Canonical is the delayed primary; incoming is the fresher secondary.
    const merged = mergeFixtureMetadata(delayedFd, liveSp);
    expect(merged.score).toEqual({ home: 1, away: 1, halftime: undefined });
    expect(merged.isDelayed).toBe(false);

    // Reverse argument order must reach the same result.
    const mergedReverse = mergeFixtureMetadata(liveSp, delayedFd);
    expect(mergedReverse.score).toEqual({ home: 1, away: 1, halftime: undefined });
    expect(mergedReverse.isDelayed).toBe(false);
  });

  it('never labels a delayed provider score as real-time when the secondary has no score', () => {
    const delayedFd = fx({ id: 'fd-2', status: 'IN_PLAY', isDelayed: true, minute: 70, score: { home: 2, away: 1 } });
    const liveSpNoScore = fx({ id: 'sp-2', status: 'IN_PLAY', isDelayed: false, minute: 70, score: undefined });

    const merged = mergeFixtureMetadata(delayedFd, liveSpNoScore);
    expect(merged.score).toEqual({ home: 2, away: 1, halftime: undefined });
    expect(merged.isDelayed).toBe(true);

    const deduped = deduplicateFixtures([delayedFd, liveSpNoScore]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].score?.home).toBe(2);
    expect(deduped[0].isDelayed).toBe(true);
  });

  it('a FINISHED final score wins over a lagging live score', () => {
    const finished = fx({ id: 'fd-3', status: 'FINISHED', isDelayed: true, score: { home: 3, away: 1 } });
    const laggingLive = fx({ id: 'sp-3', status: 'IN_PLAY', isDelayed: false, minute: 88, score: { home: 2, away: 1 } });
    const merged = mergeFixtureMetadata(laggingLive, finished);
    expect(merged.status).toBe('FINISHED');
    expect(merged.score?.home).toBe(3);
    expect(merged.score?.away).toBe(1);
  });

  it('preserves a valid live score when the secondary returns incomplete (no score) data', () => {
    const live = fx({ id: 'fd-4', status: 'IN_PLAY', isDelayed: true, minute: 55, score: { home: 1, away: 0 } });
    const incomplete = fx({ id: 'sp-4', status: 'IN_PLAY', isDelayed: false, score: undefined, minute: 55 });
    const merged = mergeFixtureMetadata(live, incomplete);
    expect(merged.score).toEqual({ home: 1, away: 0, halftime: undefined });
  });

  it('advances a live score when the same provider reports more goals', () => {
    const early = fx({ id: 'fd-5', status: 'IN_PLAY', isDelayed: true, minute: 20, score: { home: 1, away: 0 } });
    const later = fx({ id: 'fd-5b', status: 'IN_PLAY', isDelayed: true, minute: 60, score: { home: 2, away: 0 } });
    const merged = mergeFixtureMetadata(early, later);
    expect(merged.score?.home).toBe(2);
    expect(merged.minute).toBe(60);
  });
});

describe('Phase 2 – Lifecycle transition integrity', () => {
  it('does not revert a suspended match to scheduled when a stale record arrives', () => {
    const suspended = fx({ id: 'fd-6', status: 'SUSPENDED' });
    const staleScheduled = fx({ id: 'sp-6', status: 'SCHEDULED' });
    expect(mergeFixtureMetadata(suspended, staleScheduled).status).toBe('SUSPENDED');
    expect(mergeFixtureMetadata(staleScheduled, suspended).status).toBe('SUSPENDED');
  });

  it('promotes scheduled -> in-play -> finished and never regresses', () => {
    const scheduled = fx({ id: 'fd-7', status: 'SCHEDULED' });
    const inPlay = fx({ id: 'sp-7', status: 'IN_PLAY', minute: 10, score: { home: 0, away: 0 } });
    const step1 = mergeFixtureMetadata(scheduled, inPlay);
    expect(step1.status).toBe('IN_PLAY');

    const finished = fx({ id: 'fd-7', status: 'FINISHED', score: { home: 1, away: 0 } });
    const step2 = mergeFixtureMetadata(step1, finished);
    expect(step2.status).toBe('FINISHED');

    // A late scheduled copy must not regress the finished state.
    expect(mergeFixtureMetadata(step2, scheduled).status).toBe('FINISHED');
  });

  it('does not let a postponed/cancelled state be overwritten by a live copy', () => {
    const postponed = fx({ id: 'fd-8', status: 'POSTPONED' });
    const live = fx({ id: 'sp-8', status: 'IN_PLAY', minute: 5, score: { home: 0, away: 0 } });
    expect(mergeFixtureMetadata(live, postponed).status).toBe('POSTPONED');
    expect(mergeFixtureMetadata(postponed, live).status).toBe('POSTPONED');
  });
});

describe('Phase 2 – Cross-provider deduplication safety', () => {
  it('never merges fixtures from different competitions that share teams and kickoff', () => {
    const plFixture = fx({ id: 'fd-10', competition: PL });
    const clFixture = fx({ id: 'fd-11', competition: CL });
    expect(areFixturesEquivalent(plFixture, clFixture)).toBe(false);
    expect(deduplicateFixtures([plFixture, clFixture])).toHaveLength(2);
  });

  it('never merges fixtures with reversed home/away', () => {
    const a = fx({ id: 'fd-12', homeTeam: { id: '1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' }, awayTeam: { id: '2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' } });
    const b = fx({ id: 'fd-13', homeTeam: { id: '2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' }, awayTeam: { id: '1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' } });
    expect(areFixturesEquivalent(a, b)).toBe(false);
    expect(deduplicateFixtures([a, b])).toHaveLength(2);
  });

  it('deduplicates the same fixture across providers while keeping one card', () => {
    const fd = fx({ id: 'fd-14', homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' } });
    const sp = fx({ id: 'sp-14', homeTeam: { id: '10', name: 'Arsenal', shortName: 'Arsenal', tla: 'ARS' }, venue: { name: 'Emirates', city: 'London' } });
    const deduped = deduplicateFixtures([fd, sp]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe('fd-14');
    expect(deduped[0].venue?.name).toBe('Emirates');
  });

  it('does not merge two distinct fixtures that share teams but kick off on different days', () => {
    const day1 = fx({ id: 'fd-15', utcKickoffTime: '2026-10-14T19:00:00Z' });
    const day2 = fx({ id: 'fd-16', utcKickoffTime: '2026-10-20T19:00:00Z' });
    expect(areFixturesEquivalent(day1, day2)).toBe(false);
    expect(deduplicateFixtures([day1, day2])).toHaveLength(2);
  });
});

describe('Phase 2 – Timezone boundaries (Africa/Lagos)', () => {
  it('converts UTC kickoff to WAT (UTC+1) and rolls the date at the boundary', () => {
    expect(formatKickoffTime('2026-10-14T19:00:00Z', 'Africa/Lagos')).toBe('20:00 WAT');
    // 23:30 UTC on the 14th is 00:30 WAT on the 15th
    expect(getDateKeyInTimezone('2026-10-14T23:30:00Z', 'Africa/Lagos')).toBe('2026-10-15');
    expect(formatKickoffTime('2026-10-14T23:30:00Z', 'Africa/Lagos')).toBe('00:30 WAT');
    // 22:59 UTC stays on the 14th
    expect(getDateKeyInTimezone('2026-10-14T22:59:00Z', 'Africa/Lagos')).toBe('2026-10-14');
  });

  it('renders a full kickoff label with the Lagos weekday and offset', () => {
    const label = formatKickoffFull('2026-10-14T19:00:00Z', 'Africa/Lagos');
    expect(label).toContain('20:00 WAT');
    expect(label).toContain('14 October 2026');
  });

  it('returns safe placeholders for missing or invalid kickoff values', () => {
    expect(formatKickoffTime(undefined, 'Africa/Lagos')).toBe('TBD');
    expect(formatKickoffTime('not-a-date', 'Africa/Lagos')).toBe('TBD');
    expect(getDateKeyInTimezone(undefined, 'Africa/Lagos')).toBe('');
    expect(getDateKeyInTimezone('garbage', 'Africa/Lagos')).toBe('');
  });
});

describe('Phase 2 – Stale live data handling', () => {
  const now = Date.parse('2026-10-14T20:00:00Z');

  it('flags a live fixture whose provider update is older than the threshold', () => {
    const stale = fx({
      status: 'IN_PLAY',
      minute: 70,
      lastUpdated: new Date(now - LIVE_STALE_THRESHOLD_MS - 60_000).toISOString(),
    });
    expect(isFixtureStale(stale, now)).toBe(true);
  });

  it('does not flag a live fixture updated within the threshold', () => {
    const fresh = fx({ status: 'IN_PLAY', minute: 70, lastUpdated: new Date(now - 30_000).toISOString() });
    expect(isFixtureStale(fresh, now)).toBe(false);
  });

  it('never flags a non-live fixture, and never flags when no timestamp is present', () => {
    const finished = fx({ status: 'FINISHED', lastUpdated: new Date(now - 10 * 60_000).toISOString() });
    expect(isFixtureStale(finished, now)).toBe(false);
    const liveNoTs = fx({ status: 'IN_PLAY', minute: 12 });
    expect(isFixtureStale(liveNoTs, now)).toBe(false);
    expect(isFixtureStale(null, now)).toBe(false);
  });
});

describe('Phase 2 – Provider failure modes and health vs availability', () => {
  it('reports a healthy fetch with no degradation', () => {
    const s = summarizeFixtureFetch({
      footballDataConfigured: true,
      sportApiConfigured: true,
      footballDataRateLimited: false,
      footballDataError: null,
      sportApiError: null,
    });
    expect(s.degraded).toBe(false);
    expect(s.notice).toBeUndefined();
    expect(s.soleProviderRateLimited).toBe(false);
  });

  it('surfaces an authentication/upstream failure as degradation, not an empty success', () => {
    const s = summarizeFixtureFetch({
      footballDataConfigured: true,
      sportApiConfigured: false,
      footballDataRateLimited: false,
      footballDataError: 'football-data.org responded HTTP 403',
      sportApiError: null,
    });
    expect(s.degraded).toBe(true);
    expect(s.notice).toContain('403');
    // A 403 on the sole provider is a provider error, not a rate limit.
    expect(s.soleProviderRateLimited).toBe(false);
  });

  it('flags sole-provider rate limiting so the endpoint can answer 429', () => {
    const s = summarizeFixtureFetch({
      footballDataConfigured: true,
      sportApiConfigured: false,
      footballDataRateLimited: true,
      footballDataError: null,
      sportApiError: null,
    });
    expect(s.soleProviderRateLimited).toBe(true);
    expect(s.degraded).toBe(true);
  });

  it('keeps serving when the secondary provider fails but the primary succeeded', () => {
    const s = summarizeFixtureFetch({
      footballDataConfigured: true,
      sportApiConfigured: true,
      footballDataRateLimited: false,
      footballDataError: null,
      sportApiError: 'sportapi.ai responded HTTP 500',
    });
    expect(s.degraded).toBe(true);
    expect(s.notice).toContain('sportapi.ai');
    expect(s.soleProviderRateLimited).toBe(false);
  });

  it('distinguishes a timeout/unreachable error from a rate limit', () => {
    const s = summarizeFixtureFetch({
      footballDataConfigured: true,
      sportApiConfigured: true,
      footballDataRateLimited: false,
      footballDataError: 'football-data.org unreachable: fetch failed',
      sportApiError: 'sportapi.ai unreachable: The operation was aborted',
    });
    expect(s.degraded).toBe(true);
    expect(s.notice).toContain('unreachable');
    expect(s.soleProviderRateLimited).toBe(false);
  });
});

describe('Phase 2 – football-data.org date window (HTTP 400 guard)', () => {
  const now = new Date('2026-10-14T12:00:00Z');

  it('always sends an explicit window when the caller supplies none, covering yesterday and the next 8 days', () => {
    const w = resolveFixtureDateWindow(null, null, now);
    expect(w.dateFrom).toBe('2026-10-13');
    expect(w.dateTo).toBe('2026-10-22');
    const spanDays = (Date.parse(w.dateTo) - Date.parse(w.dateFrom)) / 86_400_000;
    expect(spanDays).toBe(9); // 10 inclusive days
    expect(spanDays).toBeLessThanOrEqual(MAX_FD_WINDOW_DAYS - 1);
  });

  it('fills a missing dateTo from dateFrom within the 10-day limit', () => {
    const w = resolveFixtureDateWindow('2026-10-01', null, now);
    expect(w.dateFrom).toBe('2026-10-01');
    expect(w.dateTo).toBe('2026-10-10');
  });

  it('passes through a fully specified window unchanged', () => {
    const w = resolveFixtureDateWindow('2026-10-05', '2026-10-08', now);
    expect(w).toEqual({ dateFrom: '2026-10-05', dateTo: '2026-10-08' });
  });

  it('never produces an empty or inverted window for a malformed dateFrom', () => {
    const w = resolveFixtureDateWindow('not-a-date', null, now);
    expect(w.dateFrom).toBe('not-a-date');
    expect(w.dateTo).toBe('not-a-date');
  });
});
