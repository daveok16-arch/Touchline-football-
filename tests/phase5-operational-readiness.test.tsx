/**
 * Phase 5 – End-to-end operational readiness regression tests.
 *
 * These cover defects confirmed during the Phase 5 audit:
 *   1. Half-time (PAUSED) fixtures were labelled "In-Play" instead of "Half-Time".
 *   2. The competitions directory offered a "Table" button for every competition,
 *      even the 74 with no working standings implementation.
 *   3. The overview timezone tile appended a hardcoded "(UTC+1)" regardless of the
 *      timezone the user had selected.
 *
 * All fixtures here are TEST DATA. No live provider or odds data is involved.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FixtureCard } from '../src/components/FixtureCard';
import { MatchDetailView } from '../src/views/MatchDetailView';
import { CompetitionsView } from '../src/views/CompetitionsView';
import { HomeView } from '../src/views/HomeView';
import { FixtureService } from '../src/services/fixtureService';
import { Fixture, Competition } from '../src/types/football';
import { buildOddsPayload, ODDS_CAVEATS } from '../src/services/oddsEligibility';
import { validateOddsBatch, SUPPORTED_ODDS_MARKET, OddsObservation } from '../src/services/oddsSchema';
import { OddsFetchResult } from '../src/services/oddsAdapter';

const baseCompetition: Competition = {
  id: 'PL',
  name: 'Premier League',
  code: 'PL',
  type: 'LEAGUE',
  country: 'England',
  season: '2026/27',
  isSupported: true,
};

const pausedFixture: Fixture = {
  id: 'fd-500',
  utcKickoffTime: '2026-10-14T18:00:00Z',
  status: 'PAUSED',
  minute: 45,
  score: { home: 1, away: 0, halftime: { home: 1, away: 0 } },
  competition: baseCompetition,
  homeTeam: { id: 't1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
  awayTeam: { id: 't2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
};

describe('Phase 5 – half-time is distinguished from in-play', () => {
  it('FixtureCard labels a PAUSED fixture as Half-Time, never In-Play', () => {
    render(
      <FixtureCard fixture={pausedFixture} timezoneId="Africa/Lagos" onSelect={() => {}} />
    );

    expect(screen.getByText('Half-Time')).toBeTruthy();
    expect(screen.queryByText('In-Play')).toBeNull();
  });

  it('FixtureCard still labels a genuinely in-play fixture as In-Play', () => {
    render(
      <FixtureCard
        fixture={{ ...pausedFixture, status: 'IN_PLAY', minute: 68 }}
        timezoneId="Africa/Lagos"
        onSelect={() => {}}
      />
    );

    expect(screen.getByText(/In-Play 68'/i)).toBeTruthy();
    expect(screen.queryByText('Half-Time')).toBeNull();
  });
});

describe('Phase 5 – match detail distinguishes half-time', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('MatchDetailView shows Half-Time for a PAUSED fixture and does not claim In-Play', async () => {
    vi.spyOn(FixtureService, 'getFixtureById').mockResolvedValue(pausedFixture);
    vi.spyOn(FixtureService, 'getStandings').mockResolvedValue(null);
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([]);

    render(
      <MatchDetailView matchId="fd-500" timezoneId="Africa/Lagos" onBack={() => {}} />
    );

    await waitFor(() => expect(screen.getByText('Half-Time')).toBeTruthy());
    expect(screen.queryByText('In-Play')).toBeNull();
  });
});

describe('Phase 5 – competitions directory only offers standings where implemented', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a Table button only for competitions with a working standings implementation', async () => {
    const catalogue: Competition[] = [
      { ...baseCompetition }, // PL – standings implemented
      {
        id: 'SP-4',
        name: 'Austrian Bundesliga',
        code: 'SP-4',
        type: 'LEAGUE',
        country: 'Austria',
        season: '2026/27',
        isSupported: true,
      }, // no standings implementation
    ];

    vi.spyOn(FixtureService, 'getCompetitions').mockResolvedValue(catalogue);
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([]);

    render(<CompetitionsView onSelectCompetition={() => {}} onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText('Premier League')).toBeTruthy());
    expect(screen.getByText('Austrian Bundesliga')).toBeTruthy();

    // Exactly one competition (PL) supports standings, so exactly one Table button.
    expect(screen.getAllByText('Table')).toHaveLength(1);
  });
});

describe('Phase 5 – overview timezone tile reflects the selected timezone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not append a hardcoded UTC+1 when the user has selected UTC', async () => {
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([]);
    vi.spyOn(FixtureService, 'getCompetitions').mockResolvedValue([]);
    vi.spyOn(FixtureService, 'getAllSupportedStandings').mockResolvedValue({
      PL: null,
      CL: null,
      PD: null,
      SA: null,
    });

    render(<HomeView timezoneId="UTC" onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText('Timezone')).toBeTruthy());
    expect(screen.queryByText(/\(UTC\+1\)/)).toBeNull();
  });
});

describe('Phase 5 – missing or invalid odds never yield a value estimate', () => {
  const unavailable: OddsFetchResult = {
    status: 'auth_error',
    observations: [],
    provider: '5dollarfootballapi',
    notice: 'Provider rejected the key (HTTP 401 invalid_api_key).',
  };
  const okEmpty: OddsFetchResult = {
    status: 'ok',
    observations: [],
    provider: '5dollarfootballapi',
    notice: 'OK',
  };
  const model = { homeWin: 0.6, draw: 0.25, awayWin: 0.15 };

  const observation = (overrides: Partial<OddsObservation> = {}): OddsObservation => ({
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
  });

  it('produces no analysis when the provider is unavailable', () => {
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: unavailable,
      validated: [],
      modelProbabilities: model,
    });
    expect(p.available).toBe(false);
    expect(p.analysis).toBeUndefined();
    expect(p.eligibility.eligible).toBe(false);
    expect(p.eligibility.reasons).toContain('PROVIDER_UNAVAILABLE');
  });

  it('produces no analysis when odds are absent but the provider is healthy', () => {
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: okEmpty,
      validated: [],
      modelProbabilities: model,
    });
    expect(p.analysis).toBeUndefined();
    expect(p.eligibility.reasons).toContain('NO_ODDS');
  });

  it('produces no analysis when odds are present but invalid', () => {
    const validated = validateOddsBatch([observation({ selection: { home: 0, draw: 3.5, away: 4.0 } })]);
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: { ...okEmpty, observations: [observation()] },
      validated,
      modelProbabilities: model,
    });
    expect(p.analysis).toBeUndefined();
    expect(p.eligibility.eligible).toBe(false);
    expect(p.eligibility.reasons).toContain('INVALID_ODDS');
  });

  it('produces no analysis when the model prediction is unavailable', () => {
    const validated = validateOddsBatch([observation()]);
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: { ...okEmpty, observations: [observation()] },
      validated,
      modelProbabilities: null,
    });
    expect(p.analysis).toBeUndefined();
    expect(p.eligibility.reasons).toContain('MODEL_PREDICTION_UNAVAILABLE');
  });

  it('always carries the honest model-limitation caveats', () => {
    expect(ODDS_CAVEATS.join(' ')).toMatch(/overconfident in the high-probability tail/i);
    expect(ODDS_CAVEATS.join(' ')).toMatch(/Champions League/i);
    const p = buildOddsPayload({
      matchId: 'fd-100',
      fetch: unavailable,
      validated: [],
      modelProbabilities: null,
    });
    expect(p.caveats).toEqual(ODDS_CAVEATS);
  });
});
