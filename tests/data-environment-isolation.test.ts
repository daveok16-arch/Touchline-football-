import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FixtureService } from '../src/services/fixtureService';
import { Fixture } from '../src/types/football';

describe('Data Environment Isolation & Provider Communication', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('Missing provider key (503) throws PROVIDER_NOT_CONFIGURED with honest message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      json: async () => ({
        configured: false,
        status: 'not_configured',
        message: 'Football-Data.org API token is not configured.',
      }),
    } as any);

    await expect(FixtureService.getFixtures({})).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: 'Football data is not connected yet.',
    });
  });

  it('Successful provider response returns strictly normalized provider data and no mock leakage', async () => {
    const mockRealFixture: Fixture = {
      id: 'fd-12345',
      utcKickoffTime: '2026-10-15T19:00:00Z',
      status: 'SCHEDULED',
      competition: {
        id: 'PL',
        name: 'Premier League',
        code: 'PL',
        type: 'LEAGUE',
        country: 'England',
        season: '2024/25',
        isSupported: true,
      },
      homeTeam: { id: '1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: '2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        configured: true,
        count: 1,
        matches: [mockRealFixture],
      }),
    } as any);

    const fixtures = await FixtureService.getFixtures({});
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].id).toBe('fd-12345');
    expect(fixtures[0].homeTeam.name).toBe('Arsenal FC');
    expect((fixtures[0] as any).isDemo).toBeFalsy();
  });

  it('Upstream error and rate-limit responses throw clean user-facing error', async () => {
    // 429 Rate limit
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      json: async () => ({ error: 'Rate limit reached' }),
    } as any);

    await expect(FixtureService.getFixtures({})).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Football data is temporarily unavailable. Try again.',
    });

    // 502 Bad Gateway
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 502,
      ok: false,
      json: async () => ({ error: 'Gateway timeout' }),
    } as any);

    await expect(FixtureService.getFixtures({})).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Football data is temporarily unavailable. Try again.',
    });
  });

  it('Missing, malformed, or blank match IDs return null safely without dispatching requests', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    expect(await FixtureService.getFixtureById('')).toBeNull();
    expect(await FixtureService.getFixtureById('   ')).toBeNull();
    expect(await FixtureService.getFixtureById(null as any)).toBeNull();
    expect(await FixtureService.getFixtureById(undefined as any)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Match lookup by ID handles 404, 503, and valid records properly', async () => {
    // 404 Not Found returns null
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    } as any);

    expect(await FixtureService.getFixtureById('fd-999999')).toBeNull();

    // 503 Provider unconfigured throws PROVIDER_NOT_CONFIGURED
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      json: async () => ({ configured: false }),
    } as any);

    await expect(FixtureService.getFixtureById('fd-12345')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: 'Football data is not connected yet.',
    });

    // 200 Success returns match
    const mockMatch: Fixture = {
      id: 'fd-12345',
      utcKickoffTime: '2026-10-15T19:00:00Z',
      status: 'FINISHED',
      score: { home: 2, away: 1 },
      competition: { id: 'PL', name: 'Premier League', code: 'PL', type: 'LEAGUE', country: 'England', season: '2024/25' },
      homeTeam: { id: '1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: '2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ configured: true, match: mockMatch }),
    } as any);

    const match = await FixtureService.getFixtureById('fd-12345');
    expect(match).not.toBeNull();
    expect(match?.id).toBe('fd-12345');
    expect(match?.score?.home).toBe(2);
  });

  it('Standings lookup returns real table and handles unconfigured provider honestly', async () => {
    // 503 Unconfigured
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      json: async () => ({ configured: false }),
    } as any);

    await expect(FixtureService.getStandings('PL')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: 'Football data is not connected yet.',
    });

    // 200 Success
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        configured: true,
        standings: {
          competition: { id: 'PL', name: 'Premier League', code: 'PL', type: 'LEAGUE', country: 'England', season: '2024/25' },
          season: { startDate: '2024-08-16', endDate: '2025-05-25' },
          table: [
            {
              position: 1,
              team: { id: '64', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
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
      }),
    } as any);

    const standings = await FixtureService.getStandings('PL');
    expect(standings).not.toBeNull();
    expect(standings?.table).toHaveLength(1);
    expect(standings?.table[0].team.name).toBe('Liverpool FC');
    expect(standings?.table[0].points).toBe(67);
  });
});
