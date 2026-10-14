import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MatchDetailView } from '../src/views/MatchDetailView';
import { FixtureService } from '../src/services/fixtureService';
import { CompetitionStandings, Fixture } from '../src/types/football';

describe('MatchDetailView – Daily Match Intelligence Integration', () => {
  const mockStandingsPL: CompetitionStandings = {
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
      currentMatchday: 12,
    },
    table: [
      {
        position: 1,
        team: { id: 't1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        playedGames: 12,
        form: 'W,W,D,W,W',
        won: 9,
        draw: 2,
        lost: 1,
        points: 29,
        goalsFor: 26,
        goalsAgainst: 8,
        goalDifference: 18,
      },
      {
        position: 2,
        team: { id: 't2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
        playedGames: 12,
        form: 'W,D,L,W,D',
        won: 6,
        draw: 3,
        lost: 3,
        points: 21,
        goalsFor: 18,
        goalsAgainst: 14,
        goalDifference: 4,
      },
      {
        position: 3,
        team: { id: 't3', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
        playedGames: 2, // Cold start (< 3 matches)
        form: 'W,D',
        won: 1,
        draw: 1,
        lost: 0,
        points: 4,
        goalsFor: 3,
        goalsAgainst: 1,
        goalDifference: 2,
      },
    ],
  };

  const eligibleScheduledFixture: Fixture = {
    id: 'match-pl-101',
    utcKickoffTime: '2026-10-14T19:00:00Z',
    status: 'SCHEDULED',
    matchday: 13,
    competition: {
      id: 'PL',
      name: 'Premier League',
      code: 'PL',
      type: 'LEAGUE',
      country: 'England',
      season: '2024/25',
      isSupported: true,
    },
    homeTeam: { id: 't1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
    awayTeam: { id: 't2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
    venue: { name: 'Emirates Stadium', city: 'London' },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Requirement 2 & 5: Renders Daily Match Intelligence for eligible fixture with probabilities, ranking, evidence, and Lagos kickoff', async () => {
    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(eligibleScheduledFixture);
    vi.spyOn(FixtureService, 'getStandings').mockResolvedValue(mockStandingsPL);
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([eligibleScheduledFixture]);

    const onBackMock = vi.fn();
    render(
      <MatchDetailView
        matchId="match-pl-101"
        timezoneId="Africa/Lagos"
        onBack={onBackMock}
      />
    );

    // Header and kickoff time in Africa/Lagos (20:00 WAT for 19:00 UTC)
    await waitFor(() => {
      expect(screen.getByText('Arsenal FC')).toBeTruthy();
      expect(screen.getByText('Chelsea FC')).toBeTruthy();
    });
    expect(screen.getAllByText(/20:00 WAT/).length).toBeGreaterThanOrEqual(1);

    // Daily Match Intelligence section
    await screen.findByText('Daily Match Intelligence');
    expect(screen.getByText('Model: Poisson V1 (Frozen)')).toBeTruthy();

    // Probabilities display
    await screen.findByText(/Arsenal FC Win/i);
    expect(screen.getByText(/Chelsea FC Win/i)).toBeTruthy();
    expect(screen.getAllByText(/Draw/i).length).toBeGreaterThanOrEqual(1);

    // Evidence level and cold start indicators
    expect(screen.getByText('High Evidence')).toBeTruthy();
    expect(screen.getByText(/Threshold Met/i)).toBeTruthy();

    // Data freshness and factual explanation
    expect(screen.getByText(/Standings: Matchday 12/i)).toBeTruthy();
    expect(screen.getByText(/Poisson expectation/i)).toBeTruthy();
    expect(screen.getByText(/xG:/i)).toBeTruthy();

    // Honest disclaimer
    expect(screen.getByText(/Probabilities are mathematical Poisson distribution estimates/i)).toBeTruthy();

    // Back to fixtures navigation button
    const backBtn = screen.getByText('Back to Fixtures');
    expect(backBtn).toBeTruthy();
    fireEvent.click(backBtn);
    expect(onBackMock).toHaveBeenCalledTimes(1);
  });

  it('Requirement 3: Guarantees analysis matches exact fixture ID and competition', async () => {
    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(eligibleScheduledFixture);
    vi.spyOn(FixtureService, 'getStandings').mockResolvedValue(mockStandingsPL);
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([eligibleScheduledFixture]);

    render(
      <MatchDetailView
        matchId="match-pl-101"
        timezoneId="Africa/Lagos"
        onBack={() => {}}
      />
    );

    await screen.findByText('Daily Match Intelligence');

    // Ensure the fixture being analyzed is Arsenal FC vs Chelsea FC for PL
    await screen.findByText(/Arsenal FC Win/i);
    expect(screen.getByText(/Chelsea FC Win/i)).toBeTruthy();

    // Does NOT display another team
    expect(screen.queryByText('Real Madrid Win')).toBeNull();
  });

  it('Requirement 4: Ineligible match (Finished status) displays clear honest guardrail reason', async () => {
    const finishedFixture: Fixture = {
      ...eligibleScheduledFixture,
      id: 'match-pl-finished',
      status: 'FINISHED',
      score: { home: 2, away: 0 },
    };

    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(finishedFixture);
    vi.spyOn(FixtureService, 'getStandings').mockResolvedValue(mockStandingsPL);

    render(
      <MatchDetailView
        matchId="match-pl-finished"
        timezoneId="Africa/Lagos"
        onBack={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Match Intelligence Excluded by Model Guardrails')).toBeTruthy();
    });

    // Explains that match status is FINISHED and predictions only apply to scheduled fixtures
    expect(screen.getByText(/Predictions are evaluated only for upcoming scheduled matches/i)).toBeTruthy();
    expect(screen.getByText(/Full Time/i)).toBeTruthy();
  });

  it('Requirement 4: Ineligible match (Unsupported competition) displays clear honest explanation', async () => {
    const unsupportedFixture: Fixture = {
      ...eligibleScheduledFixture,
      id: 'match-fac-1',
      competition: {
        id: 'FAC',
        name: 'FA Cup',
        code: 'FAC',
        type: 'CUP',
        country: 'England',
        season: '2024/25',
        isSupported: false,
      },
    };

    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(unsupportedFixture);

    render(
      <MatchDetailView
        matchId="match-fac-1"
        timezoneId="Africa/Lagos"
        onBack={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Match Intelligence Excluded by Model Guardrails')).toBeTruthy();
    });

    expect(screen.getByText(/Competition FAC is not supported for Daily Intelligence/i)).toBeTruthy();
  });

  it('Requirement 4: Ineligible match (Cold-start team < 3 matches) displays cold-start guardrail', async () => {
    const coldStartFixture: Fixture = {
      ...eligibleScheduledFixture,
      id: 'match-cold-1',
      awayTeam: { id: 't3', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
    };

    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(coldStartFixture);
    vi.spyOn(FixtureService, 'getStandings').mockResolvedValue(mockStandingsPL);

    render(
      <MatchDetailView
        matchId="match-cold-1"
        timezoneId="Africa/Lagos"
        onBack={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Match Intelligence Excluded by Model Guardrails')).toBeTruthy();
    });

    expect(screen.getByText(/Cold start: Insufficient league history/i)).toBeTruthy();
    expect(screen.getAllByText(/Active Guardrail/i).length).toBeGreaterThanOrEqual(1);
  });

  it('Requirement 4 & 6: Missing provider data displays clear explanation without fabricating data', async () => {
    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(eligibleScheduledFixture);
    // Standings returns null (e.g. 503 or 429)
    vi.spyOn(FixtureService, 'getStandings').mockResolvedValue(null);
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([]);

    render(
      <MatchDetailView
        matchId="match-pl-101"
        timezoneId="Africa/Lagos"
        onBack={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Match Intelligence Excluded by Model Guardrails')).toBeTruthy();
    });

    expect(screen.getByText(/League table for PL is temporarily unavailable from the provider/i)).toBeTruthy();
    // Does not invent or fabricate odds or probability percentages
    expect(screen.queryByText(/Arsenal FC Win/i)).toBeNull();
  });

  it('Requirement 3: Never displays another match\'s probabilities if fixture ID or competition mismatch occurs', async () => {
    // Return fixture A
    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(eligibleScheduledFixture);
    vi.spyOn(FixtureService, 'getStandings').mockResolvedValue(mockStandingsPL);

    // Fixtures returned by provider only has fixture B with a different ID
    const differentFixture: Fixture = {
      ...eligibleScheduledFixture,
      id: 'completely-different-fixture-id-999',
      homeTeam: { id: 'other-1', name: 'Other Club A', shortName: 'Club A', tla: 'OCA' },
      awayTeam: { id: 'other-2', name: 'Other Club B', shortName: 'Club B', tla: 'OCB' },
    };
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([differentFixture]);

    render(
      <MatchDetailView
        matchId="match-pl-101"
        timezoneId="Africa/Lagos"
        onBack={() => {}}
      />
    );

    // Should evaluate match-pl-101 directly and NOT show differentFixture's probabilities
    await screen.findByText(/Arsenal FC Win/i);
    expect(screen.queryByText(/Other Club A Win/i)).toBeNull();
    expect(screen.queryByText(/Other Club B Win/i)).toBeNull();
  });
});
