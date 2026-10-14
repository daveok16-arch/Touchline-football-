import { describe, it, expect, vi } from 'vitest';
import {
  adaptFootballDataMatch,
  adaptFootballDataMatchesResponse,
  adaptFootballDataStandingsResponse,
  FREE_PROVIDER_COMPETITIONS,
  mapFootballDataStatus,
  SUPPORTED_COMPETITION_CODES,
} from '../src/services/footballDataAdapter';
import { FixtureService } from '../src/services/fixtureService';
import { FootballDataMatch } from '../src/types/footballData';

describe('Football-Data.org Free Provider Adapter & Isolation', () => {
  it('correctly maps all 4 prioritized competitions and identifies CAF as unsupported', () => {
    expect(SUPPORTED_COMPETITION_CODES).toContain('PL');
    expect(SUPPORTED_COMPETITION_CODES).toContain('CL');
    expect(SUPPORTED_COMPETITION_CODES).toContain('PD');
    expect(SUPPORTED_COMPETITION_CODES).toContain('SA');

    const pl = FREE_PROVIDER_COMPETITIONS.find((c) => c.code === 'PL');
    expect(pl).toBeDefined();
    expect(pl?.isSupported).toBe(true);
    expect(pl?.country).toBe('England');

    const cl = FREE_PROVIDER_COMPETITIONS.find((c) => c.code === 'CL');
    expect(cl).toBeDefined();
    expect(cl?.isSupported).toBe(true);

    const pd = FREE_PROVIDER_COMPETITIONS.find((c) => c.code === 'PD');
    expect(pd).toBeDefined();
    expect(pd?.isSupported).toBe(true);

    const sa = FREE_PROVIDER_COMPETITIONS.find((c) => c.code === 'SA');
    expect(sa).toBeDefined();
    expect(sa?.isSupported).toBe(true);

    // CAF Champions League MUST be explicitly marked as not supported
    const caf = FREE_PROVIDER_COMPETITIONS.find((c) => c.code === 'CAF');
    expect(caf).toBeDefined();
    expect(caf?.isSupported).toBe(false);
    expect(caf?.unsupportedReason).toMatch(/not covered/i);
  });

  it('adapts raw football-data.org match to Fixture type contract accurately', () => {
    const rawMatch: FootballDataMatch = {
      id: 435987,
      utcDate: '2025-01-15T20:00:00Z',
      status: 'FINISHED',
      matchday: 21,
      area: { id: 2072, name: 'England', code: 'ENG' },
      competition: {
        id: 2021,
        name: 'Premier League',
        code: 'PL',
        type: 'LEAGUE',
      },
      homeTeam: {
        id: 57,
        name: 'Arsenal FC',
        shortName: 'Arsenal',
        tla: 'ARS',
      },
      awayTeam: {
        id: 61,
        name: 'Chelsea FC',
        shortName: 'Chelsea',
        tla: 'CHE',
      },
      score: {
        winner: 'HOME_TEAM',
        duration: 'REGULAR',
        fullTime: { home: 3, away: 1 },
        halfTime: { home: 1, away: 0 },
      },
      venue: 'Emirates Stadium',
      referees: [{ id: 11585, name: 'Michael Oliver', type: 'REFEREE', nationality: 'England' }],
      head2head: {
        numberOfMatches: 8,
        homeTeam: { id: 57, name: 'Arsenal FC', wins: 4, draws: 2, losses: 2 },
        awayTeam: { id: 61, name: 'Chelsea FC', wins: 2, draws: 2, losses: 4 },
      },
    };

    const fixture = adaptFootballDataMatch(rawMatch);
    expect(fixture.id).toBe('fd-435987');
    expect(fixture.utcKickoffTime).toBe('2025-01-15T20:00:00Z');
    expect(fixture.status).toBe('FINISHED');
    expect(fixture.homeTeam.name).toBe('Arsenal FC');
    expect(fixture.homeTeam.tla).toBe('ARS');
    expect(fixture.awayTeam.name).toBe('Chelsea FC');
    expect(fixture.score?.home).toBe(3);
    expect(fixture.score?.away).toBe(1);
    expect(fixture.score?.halftime?.home).toBe(1);
    expect(fixture.venue?.name).toBe('Emirates Stadium');
    expect(fixture.referee?.name).toBe('Michael Oliver');
    expect(fixture.h2h?.matchesPlayed).toBe(8);
    expect(fixture.h2h?.homeWins).toBe(4);
    // Free tier metadata: real, delayed, and NO fabricated stats
    expect(fixture.isDemo).toBe(false);
    expect(fixture.isDelayed).toBe(true);
    expect(fixture.stats).toBeNull();
    expect(fixture.homeForm).toBeNull();
    expect(fixture.awayForm).toBeNull();
  });

  it('maps all football-data.org match status strings correctly without guessing', () => {
    expect(mapFootballDataStatus('SCHEDULED')).toBe('SCHEDULED');
    expect(mapFootballDataStatus('TIMED')).toBe('TIMED');
    expect(mapFootballDataStatus('IN_PLAY')).toBe('IN_PLAY');
    expect(mapFootballDataStatus('PAUSED')).toBe('PAUSED');
    expect(mapFootballDataStatus('FINISHED')).toBe('FINISHED');
    expect(mapFootballDataStatus('POSTPONED')).toBe('POSTPONED');
    expect(mapFootballDataStatus('CANCELLED')).toBe('CANCELLED');
    expect(mapFootballDataStatus('AWARDED')).toBe('FINISHED');
  });

  it('CAF Champions League query returns an empty list and never falls back to mock data', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ configured: true, count: 0, matches: [] }),
    } as any);

    const results = await FixtureService.getFixtures({ competitionId: 'CAF' });
    expect(results).toEqual([]);
    expect(results.length).toBe(0);

    globalThis.fetch = originalFetch;
  });

  it('adapts raw football-data.org standings to CompetitionStandings contract accurately', () => {
    const rawStandings = {
      competition: { id: 2021, name: 'Premier League', code: 'PL', type: 'LEAGUE' },
      season: { id: 1564, startDate: '2024-08-16', endDate: '2025-05-25', currentMatchday: 28 },
      standings: [
        {
          stage: 'REGULAR_SEASON',
          type: 'TOTAL',
          table: [
            {
              position: 1,
              team: { id: 64, name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
              playedGames: 28,
              won: 21,
              draw: 4,
              lost: 3,
              points: 67,
              goalsFor: 68,
              goalsAgainst: 26,
              goalDifference: 42,
            },
          ],
        },
      ],
    };

    const standings = adaptFootballDataStandingsResponse(rawStandings as any);
    expect(standings).not.toBeNull();
    expect(standings?.competition.code).toBe('PL');
    expect(standings?.table).toHaveLength(1);
    expect(standings?.table[0].position).toBe(1);
    expect(standings?.table[0].team.name).toBe('Liverpool FC');
    expect(standings?.table[0].points).toBe(67);
  });
});
