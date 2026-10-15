/**
 * Project Touchline – Provider Status Builder
 *
 * Builds the `/api/status` payload from *verified* capability facts rather than a
 * provider's advertised coverage. Kept separate from the Express handler so the
 * truthfulness of the report can be unit-tested directly.
 *
 * It distinguishes, per provider:
 *   - availability (configured / active / error / disabled)
 *   - competition catalogue coverage (verified ids only)
 *   - fixture availability
 *   - standings support (only where a working implementation exists)
 *   - live-score support
 */

import { COMPETITION_REGISTRY } from './competitionRegistry';
import { buildCompetitionCatalogue } from './competitionCatalogue';

export interface ProviderCapabilities {
  availability: 'active' | 'unconfigured' | 'disabled' | 'error';
  competitionCatalogueCoverage: number;
  competitionCatalogueIds: string[];
  fixtureAvailability: 'verified' | 'unavailable' | 'none';
  standingsSupport: boolean;
  liveScoreSupport: 'live' | 'delayed' | 'none';
}

export interface ProviderStatusEntry {
  id: string;
  name: string;
  role: 'primary_fixtures' | 'secondary_fixtures' | 'odds' | 'auxiliary_odds';
  configured: boolean;
  status: 'active' | 'unconfigured' | 'disabled' | 'rate_limited' | 'error';
  tier: 'free' | 'paid';
  rateLimit: string;
  latencyNotice: string;
  missingConfig?: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderStatusInput {
  footballDataConfigured: boolean;
  sportApiConfigured: boolean;
  fiveDollarConfigured: boolean;
  oddsApiTokenConfigured: boolean;
  oddsApiEnabled: boolean;
  rateLimitPerMinute: number;
  requestsUsedInLastMinute: number;
}

export interface ProviderStatusPayload {
  configured: boolean;
  provider: string;
  tier: string;
  rateLimitPerMinute: number;
  requestsUsedInLastMinute: number;
  latencyNotice: string;
  competitionCatalogue: {
    uniqueCompetitions: number;
    standingsSupported: number;
    coreCompetitions: string[];
  };
  supportedCompetitions: Array<{ code: string; id: number; name: string; country: string }>;
  unsupportedCompetitions: Array<{ code: string; name: string; reason: string }>;
  providers: ProviderStatusEntry[];
}

export function buildProviderStatus(input: ProviderStatusInput): ProviderStatusPayload {
  const catalogue = buildCompetitionCatalogue([]);
  const fdIds = COMPETITION_REGISTRY.filter((c) => c.fdCode).map((c) => c.id);
  const sportApiIds = COMPETITION_REGISTRY.filter((c) => c.sportApiId !== undefined).map((c) => c.id);
  const standingsIds = COMPETITION_REGISTRY.filter((c) => c.standings).map((c) => c.id);

  const oddsApiConfigured = input.oddsApiTokenConfigured && input.oddsApiEnabled;

  return {
    configured: input.footballDataConfigured,
    provider: 'football-data.org',
    tier: 'free',
    rateLimitPerMinute: input.rateLimitPerMinute,
    requestsUsedInLastMinute: input.requestsUsedInLastMinute,
    latencyNotice: 'Delayed scores (free tier latency: up to 15 minutes). Not real-time live data.',
    competitionCatalogue: {
      uniqueCompetitions: catalogue.length,
      standingsSupported: standingsIds.length,
      coreCompetitions: ['PL', 'CL', 'PD', 'SA'],
    },
    supportedCompetitions: [
      { code: 'PL', id: 2021, name: 'Premier League', country: 'England' },
      { code: 'CL', id: 2001, name: 'UEFA Champions League', country: 'Europe' },
      { code: 'PD', id: 2014, name: 'La Liga (Primera División)', country: 'Spain' },
      { code: 'SA', id: 2019, name: 'Serie A', country: 'Italy' },
    ],
    unsupportedCompetitions: [
      {
        code: 'CAF',
        name: 'CAF Champions League',
        reason: 'Not covered by football-data.org free tier API.',
      },
    ],
    providers: [
      {
        id: 'football-data.org',
        name: 'Football-Data.org',
        role: 'primary_fixtures',
        configured: input.footballDataConfigured,
        status: input.footballDataConfigured ? 'active' : 'unconfigured',
        tier: 'free',
        rateLimit: '10 requests/minute',
        latencyNotice: 'Delayed scores (free tier latency: up to 15 min).',
        missingConfig: input.footballDataConfigured ? undefined : 'FOOTBALL_DATA_API_KEY is not configured',
        capabilities: {
          availability: input.footballDataConfigured ? 'active' : 'unconfigured',
          competitionCatalogueCoverage: input.footballDataConfigured ? fdIds.length : 0,
          competitionCatalogueIds: fdIds,
          fixtureAvailability: input.footballDataConfigured ? 'verified' : 'unavailable',
          standingsSupport: input.footballDataConfigured,
          liveScoreSupport: 'delayed',
        },
      },
      {
        id: 'sportapi.ai',
        name: 'SportAPI.ai',
        role: 'secondary_fixtures',
        configured: input.sportApiConfigured,
        status: input.sportApiConfigured ? 'active' : 'unconfigured',
        tier: 'free',
        rateLimit: '2,000 requests/day',
        latencyNotice: '1-minute polling interval, 30-60s goal pushes.',
        missingConfig: input.sportApiConfigured ? undefined : 'SPORTAPI_KEY is not configured',
        capabilities: {
          availability: input.sportApiConfigured ? 'active' : 'unconfigured',
          competitionCatalogueCoverage: input.sportApiConfigured ? sportApiIds.length : 0,
          competitionCatalogueIds: sportApiIds,
          fixtureAvailability: input.sportApiConfigured ? 'verified' : 'unavailable',
          // No verified standings implementation is wired for these competitions.
          standingsSupport: false,
          liveScoreSupport: 'live',
        },
      },
      {
        id: '5dollarfootballapi',
        name: '5DollarFootballAPI',
        role: 'odds',
        configured: input.fiveDollarConfigured,
        status: input.fiveDollarConfigured ? 'error' : 'unconfigured',
        tier: 'free',
        rateLimit: '60 requests/hour (max 20 req/min)',
        latencyNotice: 'Real-time Bet365 odds markets.',
        missingConfig: input.fiveDollarConfigured
          ? 'FIVE_DOLLAR_KEY failed upstream authentication (HTTP 401 invalid_api_key). Provider stopped until resolved.'
          : 'FIVE_DOLLAR_KEY is not configured',
        capabilities: {
          availability: input.fiveDollarConfigured ? 'error' : 'unconfigured',
          competitionCatalogueCoverage: 0,
          competitionCatalogueIds: [],
          fixtureAvailability: 'none',
          standingsSupport: false,
          liveScoreSupport: 'none',
        },
      },
      {
        id: 'the-odds-api',
        name: 'The Odds API',
        role: 'auxiliary_odds',
        configured: oddsApiConfigured,
        status: !input.oddsApiEnabled ? 'disabled' : input.oddsApiTokenConfigured ? 'active' : 'unconfigured',
        tier: 'free',
        rateLimit: '500 credits/month (rapid credit depletion: markets * regions per call)',
        latencyNotice: 'Aggregated bookmaker lines.',
        missingConfig: !input.oddsApiEnabled
          ? 'The Odds API is kept disabled by policy (ENABLE_ODDS_API is not set to true to prevent quota burn).'
          : input.oddsApiTokenConfigured
          ? undefined
          : 'ODDS_API_KEY is not configured',
        capabilities: {
          availability: !input.oddsApiEnabled ? 'disabled' : input.oddsApiTokenConfigured ? 'active' : 'unconfigured',
          competitionCatalogueCoverage: 0,
          competitionCatalogueIds: [],
          fixtureAvailability: 'none',
          standingsSupport: false,
          liveScoreSupport: 'none',
        },
      },
    ],
  };
}
