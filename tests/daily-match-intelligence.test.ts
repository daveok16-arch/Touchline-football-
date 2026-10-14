import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  calculatePoissonProbability,
  calculateLeagueAverages,
  evaluatePoissonProbabilities,
  evaluateMatchIntelligence,
  rankEligibleMatches,
  findTeamInStandings,
  FROZEN_MODEL_VERSION,
  MODEL_REGISTRY_ID,
  PredictionModelRegistry,
  SUPPORTED_INTELLIGENCE_COMPETITIONS,
} from '../src/services/predictionEngine';
import { FixtureService } from '../src/services/fixtureService';
import {
  getDateKeyInTimezone,
  formatKickoffTime,
  DEFAULT_TIMEZONE,
} from '../src/utils/timezone';
import {
  CompetitionStandings,
  Fixture,
  MatchIntelligence,
  StandingEntry,
} from '../src/types/football';
import { mapFootballDataStatus } from '../src/services/footballDataAdapter';

describe('Daily Match Intelligence & Poisson Prediction Engine', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Sample league standings with real data structure
  const samplePlStandings: CompetitionStandings = {
    competition: {
      id: 'PL',
      name: 'Premier League',
      code: 'PL',
      type: 'LEAGUE',
      country: 'England',
      season: '2024/25',
      isSupported: true,
    },
    season: {
      startDate: '2024-08-16',
      endDate: '2025-05-25',
      currentMatchday: 10,
    },
    table: [
      {
        position: 1,
        team: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        playedGames: 10,
        won: 8,
        draw: 1,
        lost: 1,
        points: 25,
        goalsFor: 22,
        goalsAgainst: 6,
        goalDifference: 16,
        form: 'W,W,D,W,W',
      },
      {
        position: 2,
        team: { id: '65', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
        playedGames: 10,
        won: 7,
        draw: 2,
        lost: 1,
        points: 23,
        goalsFor: 20,
        goalsAgainst: 8,
        goalDifference: 12,
        form: 'W,D,W,W,L',
      },
      {
        position: 6,
        team: { id: '61', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
        playedGames: 10,
        won: 5,
        draw: 2,
        lost: 3,
        points: 17,
        goalsFor: 16,
        goalsAgainst: 12,
        goalDifference: 4,
        form: 'W,L,W,D,W',
      },
      {
        position: 18,
        team: { id: '354', name: 'Crystal Palace FC', shortName: 'Crystal Palace', tla: 'CRY' },
        playedGames: 10,
        won: 1,
        draw: 3,
        lost: 6,
        points: 6,
        goalsFor: 7,
        goalsAgainst: 18,
        goalDifference: -11,
        form: 'L,L,D,L,W',
      },
    ],
  };

  const sampleStandingsMap: Record<string, CompetitionStandings | null> = {
    PL: samplePlStandings,
    CL: null, // tournament stage: no table
    PD: null,
    SA: null,
  };

  // 1. WAT Date boundaries and kickoff formatting
  describe('1. WAT Date boundaries and kickoff formatting', () => {
    it('accurately rolls over 23:30 UTC on day D to day D+1 in Africa/Lagos (WAT, UTC+1)', () => {
      // 2026-10-11 at 23:30 UTC is 2026-10-12 at 00:30 WAT
      const utcTimestamp = '2026-10-11T23:30:00Z';
      const watDateKey = getDateKeyInTimezone(utcTimestamp, 'Africa/Lagos');
      const utcDateKey = getDateKeyInTimezone(utcTimestamp, 'UTC');

      expect(utcDateKey).toBe('2026-10-11');
      expect(watDateKey).toBe('2026-10-12');

      const formattedWat = formatKickoffTime(utcTimestamp, 'Africa/Lagos');
      expect(formattedWat).toBe('00:30 WAT');
    });

    it('formats standard daytime kickoffs into WAT accurately', () => {
      // 16:30 UTC -> 17:30 WAT
      const afternoonUtc = '2026-10-12T16:30:00Z';
      expect(formatKickoffTime(afternoonUtc, DEFAULT_TIMEZONE)).toBe('17:30 WAT');
    });

    it('handles exact UTC midnight (00:00 UTC) as 01:00 WAT on the same date', () => {
      const midnightUtc = '2026-10-12T00:00:00Z';
      expect(getDateKeyInTimezone(midnightUtc, 'Africa/Lagos')).toBe('2026-10-12');
      expect(formatKickoffTime(midnightUtc, 'Africa/Lagos')).toBe('01:00 WAT');
    });
  });

  // 2. Filtering fixtures to selected date and four supported competitions
  describe('2. Filtering fixtures to selected date and 4 supported competitions', () => {
    it('restricts intelligence scope strictly to PL, CL, PD, SA', () => {
      expect(SUPPORTED_INTELLIGENCE_COMPETITIONS).toEqual(['PL', 'CL', 'PD', 'SA']);
    });

    it('marks fixture from unsupported competition (e.g. CAF) as ineligible', () => {
      const cafFixture: Fixture = {
        id: 'caf-1',
        utcKickoffTime: '2026-10-12T18:00:00Z',
        status: 'SCHEDULED',
        competition: {
          id: 'CAF',
          code: 'CAF',
          name: 'CAF Champions League',
          type: 'CUP',
          country: 'Africa',
          season: '2024/25',
          isSupported: false,
        },
        homeTeam: { id: 'c1', name: 'Al Ahly SC', shortName: 'Al Ahly', tla: 'AHL' },
        awayTeam: { id: 'c2', name: 'Espérance ST', shortName: 'Espérance', tla: 'EST' },
      };

      const result = evaluateMatchIntelligence(cafFixture, sampleStandingsMap);
      expect(result.isEligible).toBe(false);
      expect(result.ineligibilityReason).toContain('not supported');
    });

    it('filters client fixtures by dateKey in target timezone', async () => {
      const matches: Fixture[] = [
        {
          id: 'm-1',
          utcKickoffTime: '2026-10-11T23:30:00Z', // 2026-10-12 in WAT
          status: 'SCHEDULED',
          competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
          homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
          awayTeam: { id: '61', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
        },
        {
          id: 'm-2',
          utcKickoffTime: '2026-10-11T14:00:00Z', // 2026-10-11 in WAT
          status: 'SCHEDULED',
          competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
          homeTeam: { id: '65', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
          awayTeam: { id: '354', name: 'Crystal Palace FC', shortName: 'Crystal Palace', tla: 'CRY' },
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ configured: true, count: 2, matches }),
      } as any);

      // Filtering for 2026-10-12 WAT must return ONLY m-1
      const watDayFixtures = await FixtureService.getFixtures({
        dateKey: '2026-10-12',
        timezoneId: 'Africa/Lagos',
      });

      expect(watDayFixtures).toHaveLength(1);
      expect(watDayFixtures[0].id).toBe('m-1');
    });
  });

  // 3. Ranking eligible matches deterministically
  describe('3. Ranking eligible matches deterministically', () => {
    it('ranks matches with higher outcome decisiveness margin above closer contests', () => {
      const decisiveFixture: Fixture = {
        id: 'fx-decisive',
        utcKickoffTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' }, // Top team
        awayTeam: { id: '354', name: 'Crystal Palace FC', shortName: 'Crystal Palace', tla: 'CRY' }, // Bottom team
      };

      const closeFixture: Fixture = {
        id: 'fx-close',
        utcKickoffTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '65', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' }, // Top vs Top
      };

      const evalDecisive = evaluateMatchIntelligence(decisiveFixture, sampleStandingsMap);
      const evalClose = evaluateMatchIntelligence(closeFixture, sampleStandingsMap);

      expect(evalDecisive.isEligible).toBe(true);
      expect(evalClose.isEligible).toBe(true);
      expect((evalDecisive.rankingScore ?? 0)).toBeGreaterThan(evalClose.rankingScore ?? 0);

      // Deterministic ranking
      const ranked = rankEligibleMatches([evalClose, evalDecisive]);
      expect(ranked[0].fixtureId).toBe('fx-decisive');
      expect(ranked[0].rank).toBe(1);
      expect(ranked[1].fixtureId).toBe('fx-close');
      expect(ranked[1].rank).toBe(2);
    });

    it('breaks ties deterministically by total games played, then kickoff time, then fixtureId', () => {
      const matchA: MatchIntelligence = {
        fixtureId: 'a-tie',
        fixture: {
          id: 'a-tie',
          utcKickoffTime: '2026-10-12T15:00:00Z',
          status: 'SCHEDULED',
          competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
          homeTeam: { id: '1', name: 'Team 1', shortName: 'T1', tla: 'T1' },
          awayTeam: { id: '2', name: 'Team 2', shortName: 'T2', tla: 'T2' },
        },
        isEligible: true,
        probabilities: { homeWin: 0.5, draw: 0.3, awayWin: 0.2, expectedGoalsHome: 1.5, expectedGoalsAway: 0.8 },
        rankingScore: 0.2,
        totalEvidenceGames: 20,
        isColdStart: false,
        evidenceLevel: 'HIGH',
        evidenceDescription: 'High',
        dataFreshness: 'Current',
        conciseExplanation: 'Match A',
        validationNotice: 'Notice',
        disclaimer: 'Disclaimer',
      };

      const matchB: MatchIntelligence = {
        fixtureId: 'b-tie',
        fixture: {
          id: 'b-tie',
          utcKickoffTime: '2026-10-12T17:00:00Z',
          status: 'SCHEDULED',
          competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
          homeTeam: { id: '3', name: 'Team 3', shortName: 'T3', tla: 'T3' },
          awayTeam: { id: '4', name: 'Team 4', shortName: 'T4', tla: 'T4' },
        },
        isEligible: true,
        probabilities: { homeWin: 0.5, draw: 0.3, awayWin: 0.2, expectedGoalsHome: 1.5, expectedGoalsAway: 0.8 },
        rankingScore: 0.2,
        totalEvidenceGames: 20, // same score & games, but later kickoff
        isColdStart: false,
        evidenceLevel: 'HIGH',
        evidenceDescription: 'High',
        dataFreshness: 'Current',
        conciseExplanation: 'Match B',
        validationNotice: 'Notice',
        disclaimer: 'Disclaimer',
      };

      const ranked = rankEligibleMatches([matchB, matchA]);
      // Match A has earlier kickoff (15:00 vs 17:00), so it must be rank 1
      expect(ranked[0].fixtureId).toBe('a-tie');
      expect(ranked[0].rank).toBe(1);
      expect(ranked[1].fixtureId).toBe('b-tie');
      expect(ranked[1].rank).toBe(2);
    });
  });

  // 4. Invalid or missing model outputs
  describe('4. Invalid or missing model outputs', () => {
    it('returns 0 safely for negative lambda, NaN, or infinite Poisson inputs', () => {
      expect(calculatePoissonProbability(-1.5, 2)).toBe(0);
      expect(calculatePoissonProbability(NaN, 2)).toBe(0);
      expect(calculatePoissonProbability(1.5, -1)).toBe(0);
      expect(calculatePoissonProbability(Infinity, 2)).toBe(0);
    });

    it('returns null safely when standings entries are incomplete or missing', () => {
      const incompleteStanding: StandingEntry = {
        position: 1,
        team: { id: '99', name: 'Ghost FC', shortName: 'Ghost', tla: 'GHO' },
        playedGames: 1, // < 3 games
        won: 1,
        draw: 0,
        lost: 0,
        points: 3,
        goalsFor: 2,
        goalsAgainst: 0,
        goalDifference: 2,
      };

      const result = evaluatePoissonProbabilities(incompleteStanding, samplePlStandings.table[0], 2.7);
      expect(result).toBeNull();
    });

    it('excludes live (IN_PLAY) or completed (FINISHED) matches from pre-match predictions', () => {
      const finishedFixture: Fixture = {
        id: 'fx-done',
        utcKickoffTime: '2026-10-10T15:00:00Z',
        status: 'FINISHED',
        score: { home: 2, away: 1 },
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '61', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
      };

      const evalResult = evaluateMatchIntelligence(finishedFixture, sampleStandingsMap);
      expect(evalResult.isEligible).toBe(false);
      expect(evalResult.ineligibilityReason).toContain('FINISHED');
    });
  });

  // 5. Missing data, stale data, and cold-start flags
  describe('5. Missing data, stale data, and cold-start flags', () => {
    it('visibly flags cold-start teams with < 3 league matches played and marks them ineligible', () => {
      const earlySeasonStandings: CompetitionStandings = {
        ...samplePlStandings,
        table: [
          {
            ...samplePlStandings.table[0],
            playedGames: 2, // Cold start!
          },
          {
            ...samplePlStandings.table[1],
            playedGames: 2, // Cold start!
          },
        ],
      };

      const fixture: Fixture = {
        id: 'fx-cold',
        utcKickoffTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '65', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
      };

      const result = evaluateMatchIntelligence(fixture, { PL: earlySeasonStandings });
      expect(result.isColdStart).toBe(true);
      expect(result.isEligible).toBe(false);
      expect(result.evidenceLevel).toBe('COLD_START');
      expect(result.ineligibilityReason).toMatch(/cold start/i);
    });

    it('visibly flags unranked teams not present in provider league table', () => {
      const fixtureWithUnrankedTeam: Fixture = {
        id: 'fx-unranked',
        utcKickoffTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '9999', name: 'Unknown FC', shortName: 'Unknown', tla: 'UNK' },
      };

      const result = evaluateMatchIntelligence(fixtureWithUnrankedTeam, sampleStandingsMap);
      expect(result.isColdStart).toBe(true);
      expect(result.isEligible).toBe(false);
      expect(result.ineligibilityReason).toMatch(/unranked/i);
    });

    it('honestly handles missing league standings without inventing fallback data', () => {
      const clFixture: Fixture = {
        id: 'cl-1',
        utcKickoffTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '65', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
      };

      // In sampleStandingsMap, CL is null
      const result = evaluateMatchIntelligence(clFixture, sampleStandingsMap);
      expect(result.isEligible).toBe(false);
      expect(result.ineligibilityReason).toMatch(/temporarily unavailable/i);
      expect(result.probabilities).toBeUndefined();
    });
  });

  // 6. Provider failures without fabricated fallback content
  describe('6. Provider failures without fabricated fallback content', () => {
    it('throws honest PROVIDER_NOT_CONFIGURED error on 503 and never returns fake fixtures', async () => {
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

    it('throws RATE_LIMITED on 429 and does not invent mock fixtures', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 429,
        ok: false,
        json: async () => ({
          error: 'Rate limit reached',
        }),
      } as any);

      await expect(FixtureService.getFixtures({})).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    });
  });

  // 7. No duplicate model or shadow-validation records
  describe('7. No duplicate model or shadow-validation records', () => {
    it('verifies that only one canonical Poisson model registry exists', () => {
      const reg1 = PredictionModelRegistry.getInstance();
      const reg2 = PredictionModelRegistry.getInstance();
      expect(reg1).toBe(reg2); // Strict reference equality

      const info = reg1.getModelInfo();
      expect(info.modelId).toBe(MODEL_REGISTRY_ID);
      expect(info.version).toBe(FROZEN_MODEL_VERSION);
      expect(info.version).toBe('POISSON_V1_FROZEN');
    });

    it('contains honest disclaimers rejecting guaranteed winners, sure bets, or value bets without odds', () => {
      const fixture: Fixture = {
        id: 'fx-check-disclaimer',
        utcKickoffTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '61', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
      };

      const result = evaluateMatchIntelligence(fixture, sampleStandingsMap);
      expect(result.disclaimer).toMatch(/not guarantees/i);
      expect(result.disclaimer).toMatch(/sure bets/i);
      expect(result.validationNotice).toMatch(/shadow observation/i);
    });
  });

  // 8. Real-Event Status Mapping & Conservative Stale-Cache Handling
  describe('8. Real-Event Status Mapping & Conservative Stale-Cache Handling', () => {
    it('correctly maps all provider statuses including SUSPENDED without defaulting to scheduled', () => {
      expect(mapFootballDataStatus('SUSPENDED')).toBe('SUSPENDED');
      expect(mapFootballDataStatus('POSTPONED')).toBe('POSTPONED');
      expect(mapFootballDataStatus('CANCELLED')).toBe('CANCELLED');
      expect(mapFootballDataStatus('IN_PLAY')).toBe('IN_PLAY');
      expect(mapFootballDataStatus('PAUSED')).toBe('PAUSED');
      expect(mapFootballDataStatus('FINISHED')).toBe('FINISHED');
      expect(mapFootballDataStatus('AWARDED')).toBe('FINISHED');
      expect(mapFootballDataStatus('TIMED')).toBe('TIMED');
      expect(mapFootballDataStatus('SCHEDULED')).toBe('SCHEDULED');
    });

    it('excludes suspended, postponed, and cancelled fixtures from prediction eligibility', () => {
      const suspendedFixture: Fixture = {
        id: 'fx-suspended',
        utcKickoffTime: '2026-10-15T15:00:00Z',
        status: 'SUSPENDED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '61', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
      };

      const evalSuspended = evaluateMatchIntelligence(suspendedFixture, sampleStandingsMap);
      expect(evalSuspended.isEligible).toBe(false);
      expect(evalSuspended.ineligibilityReason).toMatch(/status is SUSPENDED/i);

      const postponedFixture: Fixture = {
        ...suspendedFixture,
        id: 'fx-postponed',
        status: 'POSTPONED',
      };
      const evalPostponed = evaluateMatchIntelligence(postponedFixture, sampleStandingsMap);
      expect(evalPostponed.isEligible).toBe(false);

      const cancelledFixture: Fixture = {
        ...suspendedFixture,
        id: 'fx-cancelled',
        status: 'CANCELLED',
      };
      const evalCancelled = evaluateMatchIntelligence(cancelledFixture, sampleStandingsMap);
      expect(evalCancelled.isEligible).toBe(false);
    });

    it('conservatively excludes matches whose kickoff has already passed, even if cached status says SCHEDULED', () => {
      // 2 hours in the past
      const pastKickoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const staleScheduledFixture: Fixture = {
        id: 'fx-stale-scheduled',
        utcKickoffTime: pastKickoff,
        status: 'SCHEDULED', // Stale cache
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '61', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
      };

      const result = evaluateMatchIntelligence(staleScheduledFixture, sampleStandingsMap);
      expect(result.isEligible).toBe(false);
      expect(result.ineligibilityReason).toMatch(/kickoff time has passed/i);
    });

    it('ranks only genuinely upcoming fixtures when stale cached fixtures exist in the pool', () => {
      const futureKickoff = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      const genuineUpcomingFixture: Fixture = {
        id: 'fx-genuine-upcoming',
        utcKickoffTime: futureKickoff,
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: '61', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
      };

      const pastKickoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const pastFixtureWithStaleStatus: Fixture = {
        id: 'fx-stale-status',
        utcKickoffTime: pastKickoff,
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
        homeTeam: { id: '64', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
        awayTeam: { id: '65', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
      };

      const evaluations = [
        evaluateMatchIntelligence(genuineUpcomingFixture, sampleStandingsMap),
        evaluateMatchIntelligence(pastFixtureWithStaleStatus, sampleStandingsMap),
      ];

      const ranked = rankEligibleMatches(evaluations);
      expect(ranked.length).toBe(1);
      expect(ranked[0].fixtureId).toBe('fx-genuine-upcoming');
      expect(ranked[0].rank).toBe(1);
    });
  });
});
