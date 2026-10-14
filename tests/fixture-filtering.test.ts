import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FixtureService } from '../src/services/fixtureService';
import { Fixture } from '../src/types/football';

describe('Fixture Filtering & Search', () => {
  const originalFetch = globalThis.fetch;

  const TEST_FIXTURES: Fixture[] = [
    {
      id: 'test-101',
      utcKickoffTime: '2026-10-11T15:30:00Z',
      status: 'FINISHED',
      score: { home: 3, away: 1 },
      competition: { id: 'PL', name: 'Premier League', code: 'PL', type: 'LEAGUE', country: 'England', season: '2024/25' },
      homeTeam: { id: 't1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: 't2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
      venue: { name: 'Emirates Stadium', city: 'London' },
    },
    {
      id: 'test-102',
      utcKickoffTime: '2026-10-11T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'PL', name: 'Premier League', code: 'PL', type: 'LEAGUE', country: 'England', season: '2024/25' },
      homeTeam: { id: 't3', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
      awayTeam: { id: 't4', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
      venue: { name: 'Anfield', city: 'Liverpool' },
    },
    {
      id: 'test-103',
      utcKickoffTime: '2026-10-12T20:00:00Z',
      status: 'IN_PLAY',
      minute: 68,
      score: { home: 1, away: 1 },
      competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2024/25' },
      homeTeam: { id: 't5', name: 'Real Madrid CF', shortName: 'Real Madrid', tla: 'RMA' },
      awayTeam: { id: 't6', name: 'FC Bayern München', shortName: 'Bayern', tla: 'BAY' },
      venue: { name: 'Santiago Bernabéu', city: 'Madrid' },
    },
    {
      id: 'test-104',
      utcKickoffTime: '2026-10-12T18:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'PD', name: 'La Liga', code: 'PD', type: 'LEAGUE', country: 'Spain', season: '2024/25' },
      homeTeam: { id: 't7', name: 'FC Barcelona', shortName: 'Barcelona', tla: 'BAR' },
      awayTeam: { id: 't8', name: 'Club Atlético de Madrid', shortName: 'Atlético', tla: 'ATM' },
    },
  ];

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        configured: true,
        count: TEST_FIXTURES.length,
        matches: TEST_FIXTURES,
      }),
    } as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns all fixtures when no filters are applied', async () => {
    const fixtures = await FixtureService.getFixtures({});
    expect(fixtures).toHaveLength(TEST_FIXTURES.length);
  });

  it('filters accurately by competition ID', async () => {
    const plFixtures = await FixtureService.getFixtures({ competitionId: 'PL' });
    expect(plFixtures.length).toBe(2);
    plFixtures.forEach((f) => {
      expect(f.competition.id).toBe('PL');
    });

    const clFixtures = await FixtureService.getFixtures({ competitionId: 'CL' });
    expect(clFixtures.length).toBe(1);
    expect(clFixtures[0].competition.id).toBe('CL');
  });

  it('filters accurately by match status', async () => {
    const liveFixtures = await FixtureService.getFixtures({ status: 'LIVE' });
    expect(liveFixtures).toHaveLength(1);
    expect(liveFixtures[0].status).toBe('IN_PLAY');

    const finishedFixtures = await FixtureService.getFixtures({ status: 'FINISHED' });
    expect(finishedFixtures).toHaveLength(1);
    expect(finishedFixtures[0].status).toBe('FINISHED');

    const scheduledFixtures = await FixtureService.getFixtures({ status: 'SCHEDULED' });
    expect(scheduledFixtures).toHaveLength(2);
    scheduledFixtures.forEach((f) => {
      expect(['SCHEDULED', 'TIMED']).toContain(f.status);
    });
  });

  it('searches by team name, short name, and TLA case-insensitively', async () => {
    // By team name
    const arsenalSearch = await FixtureService.getFixtures({ searchQuery: 'arsenal' });
    expect(arsenalSearch).toHaveLength(1);
    expect(arsenalSearch[0].homeTeam.name).toContain('Arsenal');

    // By short name
    const chelseaSearch = await FixtureService.getFixtures({ searchQuery: 'chelsea' });
    expect(chelseaSearch).toHaveLength(1);

    // By TLA
    const tlaSearch = await FixtureService.getFixtures({ searchQuery: 'ARS' });
    expect(tlaSearch).toHaveLength(1);
  });

  it('searches by venue name', async () => {
    const venueSearch = await FixtureService.getFixtures({ searchQuery: 'Anfield' });
    expect(venueSearch).toHaveLength(1);
    expect(venueSearch[0].venue?.name).toBe('Anfield');
  });

  it('filters by date key in active timezone', async () => {
    // 2026-10-11
    const oct11 = await FixtureService.getFixtures({
      dateKey: '2026-10-11',
      timezoneId: 'Africa/Lagos',
    });
    expect(oct11).toHaveLength(2);

    // 2026-10-12
    const oct12 = await FixtureService.getFixtures({
      dateKey: '2026-10-12',
      timezoneId: 'Africa/Lagos',
    });
    expect(oct12).toHaveLength(2);
  });

  it('combines competition, status, and search filters correctly', async () => {
    const combined = await FixtureService.getFixtures({
      competitionId: 'PL',
      status: 'FINISHED',
      searchQuery: 'Arsenal',
    });
    expect(combined).toHaveLength(1);
    expect(combined[0].id).toBe('test-101');
    expect(combined[0].status).toBe('FINISHED');
    expect(combined[0].homeTeam.name).toContain('Arsenal');
  });

  it('explains the 88 vs 90 match count difference across timezone boundaries', async () => {
    // Construct a synthetic 90-match pool matching the real SportAPI + Football-Data date pattern:
    // 88 matches kick off before 23:00 UTC on 2026-10-13 (which is same day in both UTC and Africa/Lagos WAT UTC+1)
    // 2 matches kick off at 23:00 UTC and 23:30 UTC on 2026-10-13 (which cross midnight to 2026-10-14 00:00 and 00:30 WAT)
    const mock90Fixtures: Fixture[] = [];
    for (let i = 1; i <= 88; i++) {
      mock90Fixtures.push({
        id: `mock-${i}`,
        utcKickoffTime: '2026-10-13T15:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', name: 'Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: `h-${i}`, name: `Home ${i}`, shortName: `H${i}`, tla: `H${i}` },
        awayTeam: { id: `a-${i}`, name: `Away ${i}`, shortName: `A${i}`, tla: `A${i}` },
      });
    }
    // Add the 2 late-night fixtures
    mock90Fixtures.push({
      id: 'sp-13596845',
      utcKickoffTime: '2026-10-13T23:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'INT', name: 'Internationals Women', code: 'INT', type: 'CUP', country: 'World', season: '2026' },
      homeTeam: { id: 'us', name: 'United States', shortName: 'USA', tla: 'USA' },
      awayTeam: { id: 'es', name: 'Spain', shortName: 'Spain', tla: 'ESP' },
    });
    mock90Fixtures.push({
      id: 'sp-13596807',
      utcKickoffTime: '2026-10-13T23:30:00Z',
      status: 'SCHEDULED',
      competition: { id: 'INT', name: 'Internationals Women', code: 'INT', type: 'CUP', country: 'World', season: '2026' },
      homeTeam: { id: 'br', name: 'Brazil', shortName: 'Brazil', tla: 'BRA' },
      awayTeam: { id: 'ar', name: 'Argentina', shortName: 'Argentina', tla: 'ARG' },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        configured: true,
        count: mock90Fixtures.length,
        matches: mock90Fixtures,
      }),
    } as any);

    // 1. Overview (HomeView) default: dateKey = '2026-10-13' in Africa/Lagos (WAT, UTC+1)
    const homeViewMatches = await FixtureService.getFixtures({
      dateKey: '2026-10-13',
      timezoneId: 'Africa/Lagos',
    });
    // Exactly 88 matches kick off on 2026-10-13 in Africa/Lagos
    expect(homeViewMatches).toHaveLength(88);

    // 2. FixturesView default: dateKey = 'ALL'
    const fixturesViewAllMatches = await FixtureService.getFixtures({
      dateKey: 'ALL',
      timezoneId: 'Africa/Lagos',
    });
    // All 90 matches are returned when dateKey is 'ALL'
    expect(fixturesViewAllMatches).toHaveLength(90);

    // 3. When FixturesView applies the same filter ('2026-10-13' in Africa/Lagos), it also returns exactly 88 matches
    const fixturesViewTodayMatches = await FixtureService.getFixtures({
      dateKey: '2026-10-13',
      timezoneId: 'Africa/Lagos',
    });
    expect(fixturesViewTodayMatches).toHaveLength(88);

    // 4. In UTC, the UTC date '2026-10-13' includes all 90 matches
    const utcTodayMatches = await FixtureService.getFixtures({
      dateKey: '2026-10-13',
      timezoneId: 'UTC',
    });
    expect(utcTodayMatches).toHaveLength(90);

    // 5. In Africa/Lagos, the 2 late-night matches kick off on '2026-10-14' (Tomorrow)
    const lagosTomorrowMatches = await FixtureService.getFixtures({
      dateKey: '2026-10-14',
      timezoneId: 'Africa/Lagos',
    });
    expect(lagosTomorrowMatches).toHaveLength(2);
    expect(lagosTomorrowMatches.map((m) => m.id)).toEqual(['sp-13596845', 'sp-13596807']);
    expect(homeViewMatches.length + lagosTomorrowMatches.length).toBe(90);
  });
});

