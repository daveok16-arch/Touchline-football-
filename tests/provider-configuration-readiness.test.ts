import { describe, it, expect } from 'vitest';
import { evaluateMatchIntelligence, rankEligibleMatches } from '../src/services/predictionEngine';
import { CompetitionStandings, Fixture } from '../src/types/football';

describe('Provider Configuration Readiness & Champions League Ineligibility Audit', () => {
  // Champions League Standings Table where all 36 clubs in the league phase have played only 1 match
  const mockClLeaguePhaseStandings: CompetitionStandings = {
    competition: {
      id: 'CL',
      name: 'UEFA Champions League',
      code: 'CL',
      type: 'CUP',
      country: 'Europe',
      season: '2026/27',
      isSupported: true,
    },
    season: {
      startDate: '2026-09-15',
      endDate: '2027-05-29',
      currentMatchday: 2,
    },
    table: [
      {
        position: 1,
        team: { id: '524', name: 'Paris Saint-Germain FC', shortName: 'PSG', tla: 'PSG' },
        playedGames: 1,
        won: 1,
        draw: 0,
        lost: 0,
        points: 3,
        goalsFor: 6,
        goalsAgainst: 1,
        goalDifference: 5,
      },
      {
        position: 2,
        team: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        playedGames: 1,
        won: 1,
        draw: 0,
        lost: 0,
        points: 3,
        goalsFor: 4,
        goalsAgainst: 0,
        goalDifference: 4,
      },
      {
        position: 3,
        team: { id: '521', name: 'Lille OSC', shortName: 'Lille', tla: 'LIL' },
        playedGames: 1,
        won: 1,
        draw: 0,
        lost: 0,
        points: 3,
        goalsFor: 2,
        goalsAgainst: 1,
        goalDifference: 1,
      },
      {
        position: 4,
        team: { id: '108', name: 'FC Internazionale Milano', shortName: 'Inter', tla: 'INT' },
        playedGames: 1,
        won: 1,
        draw: 0,
        lost: 0,
        points: 3,
        goalsFor: 2,
        goalsAgainst: 0,
        goalDifference: 2,
      },
      {
        position: 5,
        team: { id: '851', name: 'Club Brugge KV', shortName: 'Club Brugge', tla: 'BRU' },
        playedGames: 1,
        won: 0,
        draw: 0,
        lost: 1,
        points: 0,
        goalsFor: 0,
        goalsAgainst: 2,
        goalDifference: -2,
      },
    ],
  };

  const nineChampionsLeagueFixtures: Fixture[] = [
    {
      id: 'fd-575341',
      utcKickoffTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '116', name: 'Racing Club de Lens', shortName: 'Lens', tla: 'RCL' },
      awayTeam: { id: '498', name: 'Sporting Clube de Portugal', shortName: 'Sporting CP', tla: 'SPO' },
    },
    {
      id: 'fd-575342',
      utcKickoffTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '8001', name: 'Sabah FK', shortName: 'Sabah', tla: 'SAB' },
      awayTeam: { id: '8002', name: 'SK Slavia Praha', shortName: 'Slavia Praha', tla: 'SLA' },
    },
    {
      id: 'fd-575343',
      utcKickoffTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '108', name: 'FC Internazionale Milano', shortName: 'Inter', tla: 'INT' },
      awayTeam: { id: '851', name: 'Club Brugge KV', shortName: 'Club Brugge', tla: 'BRU' },
    },
    {
      id: 'fd-575344',
      utcKickoffTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '610', name: 'Galatasaray SK', shortName: 'Galatasaray', tla: 'GAL' },
      awayTeam: { id: '81', name: 'FC Barcelona', shortName: 'Barcelona', tla: 'BAR' },
    },
    {
      id: 'fd-575345',
      utcKickoffTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '78', name: 'Club Atlético de Madrid', shortName: 'Atlético', tla: 'ATM' },
      awayTeam: { id: '66', name: 'Manchester United FC', shortName: 'Man United', tla: 'MUN' },
    },
    {
      id: 'fd-575346',
      utcKickoffTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: '521', name: 'Lille OSC', shortName: 'Lille', tla: 'LIL' },
    },
    {
      id: 'fd-575347',
      utcKickoffTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '7001', name: 'Viking FK', shortName: 'Viking', tla: 'VIK' },
      awayTeam: { id: '5', name: 'FC Bayern München', shortName: 'Bayern', tla: 'BAY' },
    },
    {
      id: 'fd-575348',
      utcKickoffTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '721', name: 'RB Leipzig', shortName: 'RB Leipzig', tla: 'RBL' },
      awayTeam: { id: '674', name: 'PSV', shortName: 'PSV', tla: 'PSV' },
    },
    {
      id: 'fd-575349',
      utcKickoffTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '94', name: 'Villarreal CF', shortName: 'Villarreal', tla: 'VIL' },
      awayTeam: { id: '113', name: 'SSC Napoli', shortName: 'Napoli', tla: 'NAP' },
    },
  ];

  it('investigates and confirms that all 9 Champions League matches produce 0 eligible predictions due to cold-start rules', () => {
    // Evaluate all 9 matches with the CL standings table
    const evaluations = nineChampionsLeagueFixtures.map((fixture) =>
      evaluateMatchIntelligence(fixture, { CL: mockClLeaguePhaseStandings })
    );

    // None should be eligible because teams have only played 1 match in the competition phase (< 3 required)
    evaluations.forEach((evalResult) => {
      expect(evalResult.isEligible).toBe(false);
      expect(evalResult.probabilities).toBeUndefined();
      // Ineligibility reason clearly states either cold start or team unranked in early table
      expect(evalResult.ineligibilityReason).toMatch(/cold start|unranked/i);
    });

    // Ranking them yields an empty list of eligible matches (0 eligible predictions)
    const ranked = rankEligibleMatches(evaluations);
    expect(ranked).toHaveLength(0);

    // Verify all 9 fixtures remain intact and preserved
    expect(nineChampionsLeagueFixtures).toHaveLength(9);
  });
});
