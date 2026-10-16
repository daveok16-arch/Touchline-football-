import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  adaptFootballDataMatch,
  adaptFootballDataMatchesResponse,
  adaptFootballDataStandingsResponse,
  SUPPORTED_COMPETITION_CODES,
} from './src/services/footballDataAdapter';
import {
  FootballDataMatch,
  FootballDataMatchesResponse,
  FootballDataStandingsResponse,
} from './src/types/footballData';
import { deduplicateFixtures } from './src/utils/matchIdentity';
import { Fixture, CompetitionStandings } from './src/types/football';
import {
  adaptSportApiFixture,
  adaptSportApiFixturesResponse,
  adaptSportApiStandings,
  CODE_TO_SPORTAPI_ID,
} from './src/services/sportApiAdapter';
import { buildCompetitionCatalogue } from './src/services/competitionCatalogue';
import { buildProviderStatus } from './src/services/providerStatus';
import { summarizeFixtureFetch, resolveFixtureDateWindow } from './src/services/fixtureAvailability';
import { STANDINGS_SUPPORTED_IDS } from './src/services/competitionRegistry';
import {
  evaluateMatchIntelligence,
  SUPPORTED_INTELLIGENCE_COMPETITIONS,
} from './src/services/predictionEngine';
import { ProbabilityTriplet } from './src/services/predictionMetrics';
import { validateOddsBatch } from './src/services/oddsSchema';
import { buildOddsPayload } from './src/services/oddsEligibility';
import { resolveOddsForFixture } from './src/services/oddsService';
import { createQuotaSnapshot, QuotaSnapshot } from './src/services/oddsQuota';
import { MatchCandidate } from './src/services/oddsFixtureMatch';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// In-memory cache structure
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry<any>>();

// Sliding window rate limiter for external requests
const requestTimestamps: number[] = [];
const RATE_LIMIT_PER_MINUTE = 10;

function cleanOldTimestamps() {
  const oneMinuteAgo = Date.now() - 60_000;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
    requestTimestamps.shift();
  }
}

function checkRateLimit(): { allowed: boolean; retryAfter: number } {
  cleanOldTimestamps();
  if (requestTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
    const oldest = requestTimestamps[0];
    const retryAfterSeconds = Math.ceil((oldest + 60_000 - Date.now()) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfterSeconds) };
  }
  return { allowed: true, retryAfter: 0 };
}

function recordOutboundRequest() {
  requestTimestamps.push(Date.now());
}

/**
 * Local monthly odds request budget. Configurable via ODDS_MONTHLY_REQUEST_BUDGET
 * (default 300, below The Odds API free tier's 500/month, to leave headroom). The
 * provider-reported quota is tracked alongside it; whichever is lower governs.
 */
const ODDS_MONTHLY_REQUEST_BUDGET = (() => {
  const raw = Number(process.env.ODDS_MONTHLY_REQUEST_BUDGET);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 300;
})();
let oddsQuota: QuotaSnapshot = createQuotaSnapshot(ODDS_MONTHLY_REQUEST_BUDGET, new Date());

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > entry.ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache<T>(key: string, data: T, ttlMs: number) {
  cache.set(key, { data, timestamp: Date.now(), ttlMs });
}

function getApiToken(): string | null {
  return (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_TOKEN ||
    process.env.FOOTBALL_DATA_ORG_TOKEN ||
    null
  );
}

function getSportApiToken(): string | null {
  return process.env.SPORTAPI_KEY || null;
}

function getFiveDollarToken(): string | null {
  return process.env.FIVE_DOLLAR_KEY || null;
}

function getOddsApiToken(): string | null {
  return process.env.ODDS_API_KEY || null;
}

function isOddsApiEnabled(): boolean {
  return process.env.ENABLE_ODDS_API === 'true';
}

// 1. Provider Status Endpoint
app.get('/api/status', (_req: Request, res: Response) => {
  const token = getApiToken();
  const sportApiToken = getSportApiToken();
  const fiveDollarToken = getFiveDollarToken();
  const oddsApiToken = getOddsApiToken();
  const oddsEnabled = isOddsApiEnabled();
  cleanOldTimestamps();

  res.json(
    buildProviderStatus({
      footballDataConfigured: Boolean(token && token.trim().length > 0),
      sportApiConfigured: Boolean(sportApiToken && sportApiToken.trim().length > 0),
      fiveDollarConfigured: Boolean(fiveDollarToken && fiveDollarToken.trim().length > 0),
      oddsApiTokenConfigured: Boolean(oddsApiToken && oddsApiToken.trim().length > 0),
      oddsApiEnabled: oddsEnabled,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
      requestsUsedInLastMinute: requestTimestamps.length,
    })
  );
});

// 2. Competitions Directory Endpoint
app.get('/api/competitions', (_req: Request, res: Response) => {
  const token = getApiToken();
  if (!token) {
    return res.status(503).json({
      configured: false,
      status: 'not_configured',
      message:
        'Football-Data.org API token is not configured. Add FOOTBALL_DATA_API_KEY to your environment variables to enable live data.',
      competitions: buildCompetitionCatalogue([]),
    });
  }
  return res.json({
    configured: true,
    competitions: buildCompetitionCatalogue([]),
  });
});

// 3. Fixtures Endpoint
app.get('/api/fixtures', async (req: Request, res: Response) => {
  const token = getApiToken();
  const { dateFrom, dateTo, competition } = req.query;

  // Explicit check: CAF Champions League is not supported on the free tier
  if (competition === 'CAF') {
    return res.json({
      configured: Boolean(token),
      competition: 'CAF',
      isSupported: false,
      notice: 'CAF Champions League is not covered by the football-data.org free tier API.',
      matches: [],
    });
  }

  // football-data.org only accepts an explicit date window of at most 10 days.
  // An open-ended query is rejected with HTTP 400, so an explicit range is always sent.
  const { dateFrom: fdDateFrom, dateTo: fdDateTo } = resolveFixtureDateWindow(
    typeof dateFrom === 'string' ? dateFrom : null,
    typeof dateTo === 'string' ? dateTo : null
  );

  const sportApiToken = getSportApiToken();

  if (!token && !sportApiToken) {
    return res.status(503).json({
      configured: false,
      status: 'not_configured',
      message:
        'No fixture data provider is configured. Add FOOTBALL_DATA_API_KEY or SPORTAPI_KEY to your environment variables.',
      matches: [],
    });
  }

  const cacheKey = `fixtures:${dateFrom || 'all'}:${dateTo || 'all'}:${competition || 'all'}`;
  const cached = getCached<any>(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    let fdFixtures: any[] = [];
    let fdRateLimited = false;
    let fdError: string | null = null;

    // Only call football-data.org when the request could match one of its
    // competitions. Requesting a SportAPI-only competition must not burn the
    // free-tier quota with a full unfiltered fetch.
    const fdRequested =
      !competition || competition === 'ALL' || SUPPORTED_COMPETITION_CODES.includes(competition as any);

    if (token && fdRequested) {
      // Rate limit validation for football-data.org (10 req/min)
      const rl = checkRateLimit();
      if (rl.allowed) {
        let url = 'https://api.football-data.org/v4/matches';
        const params = new URLSearchParams();

        if (competition && typeof competition === 'string' && competition !== 'ALL') {
          if (SUPPORTED_COMPETITION_CODES.includes(competition as any)) {
            params.append('competitions', competition);
          }
        } else {
          params.append('competitions', SUPPORTED_COMPETITION_CODES.join(','));
        }

        if (fdDateFrom) params.append('dateFrom', fdDateFrom);
        if (fdDateTo) params.append('dateTo', fdDateTo);

        url += `?${params.toString()}`;

        try {
          recordOutboundRequest();
          const upstreamRes = await fetch(url, {
            headers: {
              'X-Auth-Token': token,
            },
          });

          if (upstreamRes.ok) {
            const rawData = (await upstreamRes.json()) as FootballDataMatchesResponse;
            fdFixtures = adaptFootballDataMatchesResponse(rawData);
          } else {
            // Authentication failures, upstream errors and rate limits are surfaced
            // as degradation, never silently swallowed as "no fixtures".
            fdError = `football-data.org responded HTTP ${upstreamRes.status}`;
          }
        } catch (e: any) {
          fdError = `football-data.org unreachable: ${e?.message || 'network error'}`;
        }
      } else {
        fdRateLimited = true;
      }
    }

    // Secondary provider: SportAPI.ai (incrementally enabled with 2,000 req/day quota)
    let spFixtures: any[] = [];
    let spError: string | null = null;
    if (sportApiToken) {
      const spDate =
        dateFrom && typeof dateFrom === 'string'
          ? dateFrom
          : new Date().toISOString().split('T')[0];

      try {
        const spRes = await fetch(`https://sportapi.ai/api/fixtures/date/${spDate}`, {
          headers: { 'X-Api-Key': sportApiToken },
        });
        if (spRes.ok) {
          const spData = await spRes.json();
          if (spData.success && Array.isArray(spData.data)) {
            let matches = adaptSportApiFixturesResponse(spData.data);
            if (competition && competition !== 'ALL') {
              matches = matches.filter(
                (m) => m.competition.code === competition || m.competition.id === competition
              );
            }
            spFixtures = matches;
          } else {
            spError = 'sportapi.ai returned an unexpected payload';
          }
        } else {
          spError = `sportapi.ai responded HTTP ${spRes.status}`;
        }
      } catch (e: any) {
        // SportAPI fetch failure is gracefully handled, preserving Football-Data
        spError = `sportapi.ai unreachable: ${e?.message || 'network error'}`;
      }
    }

    // If the only configured fixtures provider is rate-limited, signal it honestly
    // (429) instead of returning an empty list that looks like "no matches today".
    const fetchSummary = summarizeFixtureFetch({
      footballDataConfigured: Boolean(token),
      sportApiConfigured: Boolean(sportApiToken),
      footballDataRateLimited: fdRateLimited,
      footballDataError: fdError,
      sportApiError: spError,
    });

    if (fetchSummary.soleProviderRateLimited) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({
        error: 'Free tier rate limit reached (10 requests/minute). Please retry shortly.',
        retryAfter: 30,
        matches: [],
      });
    }

    const deduplicated = deduplicateFixtures([...fdFixtures, ...spFixtures]);

    const payload = {
      configured: true,
      count: deduplicated.length,
      degraded: fetchSummary.degraded,
      notice: fetchSummary.notice,
      matches: deduplicated,
    };

    // Cache fixtures for 90 seconds to stay safely within 10 req/min
    setCache(cacheKey, payload, 90_000);

    return res.json(payload);
  } catch (err: any) {
    return res.status(502).json({
      error: 'Failed to communicate with football data API.',
      message: err?.message,
    });
  }
});

// 4. Single Match Endpoint
app.get('/api/matches/:id', async (req: Request, res: Response) => {
  const token = getApiToken();
  const sportApiToken = getSportApiToken();
  const rawId = req.params.id;

  // Route SportAPI matches (sp- prefix)
  if (rawId.startsWith('sp-')) {
    if (!sportApiToken) {
      return res.status(503).json({
        configured: false,
        status: 'not_configured',
        message: 'SportAPI.ai is not configured.',
        match: null,
      });
    }
    const cleanSpId = rawId.replace(/^sp-/, '').trim();
    const cacheKey = `match:sp:${cleanSpId}`;
    const cached = getCached<any>(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    try {
      const spRes = await fetch(`https://sportapi.ai/api/fixtures/${cleanSpId}`, {
        headers: { 'X-Api-Key': sportApiToken },
      });
      if (spRes.status === 404) {
        return res.status(404).json({ error: 'Match not found in SportAPI database.' });
      }
      if (!spRes.ok) {
        return res.status(spRes.status).json({ error: 'SportAPI upstream error' });
      }
      const data = await spRes.json();
      if (!data.success || !data.fixture) {
        return res.status(404).json({ error: 'Match not found in SportAPI database.' });
      }
      const adapted = adaptSportApiFixture(data.fixture);
      const payload = { configured: true, match: adapted };
      setCache(cacheKey, payload, 120_000);
      return res.json(payload);
    } catch (err: any) {
      return res.status(502).json({ error: 'Failed to communicate with SportAPI.ai.', message: err?.message });
    }
  }

  // Route Football-Data.org matches (default and fd- prefix)
  const cleanId = rawId.replace(/^fd-/, '').trim();

  if (!token) {
    return res.status(503).json({
      configured: false,
      status: 'not_configured',
      message:
        'Football-Data.org API token is not configured. Add FOOTBALL_DATA_API_KEY to your environment variables.',
      match: null,
    });
  }

  const cacheKey = `match:${cleanId}`;
  const cached = getCached<any>(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  const rl = checkRateLimit();
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({
      error: 'Free tier rate limit reached (10 requests/minute). Please retry shortly.',
      retryAfter: rl.retryAfter,
    });
  }

  try {
    recordOutboundRequest();
    const url = `https://api.football-data.org/v4/matches/${cleanId}`;
    const upstreamRes = await fetch(url, {
      headers: {
        'X-Auth-Token': token,
      },
    });

    if (upstreamRes.status === 404) {
      return res.status(404).json({ error: 'Match not found in football-data.org database.' });
    }

    if (upstreamRes.status === 429) {
      return res.status(429).json({
        error: 'Upstream football-data.org rate limit (10 req/min) exceeded.',
        retryAfter: 30,
      });
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return res.status(upstreamRes.status).json({
        error: `Football-Data API error: ${upstreamRes.statusText}`,
        details: errText,
      });
    }

    const rawMatch = (await upstreamRes.json()) as FootballDataMatch;
    const adaptedFixture = adaptFootballDataMatch(rawMatch);

    const payload = {
      configured: true,
      match: adaptedFixture,
    };

    // Cache match detail for 120 seconds
    setCache(cacheKey, payload, 120_000);

    return res.json(payload);
  } catch (err: any) {
    return res.status(502).json({
      error: 'Failed to communicate with football-data.org API.',
      message: err?.message,
    });
  }
});

// 5. Standings Endpoint
app.get('/api/standings', async (req: Request, res: Response) => {
  const token = getApiToken();
  const rawComp = (req.query.competition as string) || 'PL';
  const compCode = rawComp.toUpperCase();

  // Only competitions with a working standings implementation are accepted, and
  // that set is derived from the registry — never advertised as broader than it is.
  const standingsAllowed = new Set<string>(STANDINGS_SUPPORTED_IDS);
  if (!standingsAllowed.has(compCode)) {
    return res.status(400).json({
      error: `Standings are only available for competitions with a working implementation (${STANDINGS_SUPPORTED_IDS.join(', ')}).`,
    });
  }

  const sportApiToken = getSportApiToken();
  const sportLeagueId = CODE_TO_SPORTAPI_ID[compCode];

  if (!token && (!sportApiToken || !sportLeagueId)) {
    return res.status(503).json({
      configured: false,
      status: 'not_configured',
      message:
        'Football-Data.org API token is not configured. Add FOOTBALL_DATA_API_KEY to your environment variables.',
      standings: null,
    });
  }

  const cacheKey = `standings:${compCode}`;
  const cached = getCached<any>(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  // 1. Try Primary: Football-Data.org
  if (token) {
    const rl = checkRateLimit();
    if (rl.allowed) {
      try {
        recordOutboundRequest();
        const url = `https://api.football-data.org/v4/competitions/${compCode}/standings`;
        const upstreamRes = await fetch(url, {
          headers: {
            'X-Auth-Token': token,
          },
        });

        if (upstreamRes.ok) {
          const rawData = (await upstreamRes.json()) as FootballDataStandingsResponse;
          const adaptedStandings = adaptFootballDataStandingsResponse(rawData);

          const payload = {
            configured: true,
            standings: adaptedStandings,
          };

          // Cache standings for 300 seconds (5 minutes)
          setCache(cacheKey, payload, 300_000);
          return res.json(payload);
        }
      } catch {
        // Fall through to SportAPI fallback
      }
    }
  }

  // 2. Try Secondary / Fallback: SportAPI.ai
  if (sportApiToken && sportLeagueId) {
    try {
      const spRes = await fetch(`https://sportapi.ai/api/standings/${sportLeagueId}`, {
        headers: { 'X-Api-Key': sportApiToken },
      });
      if (spRes.ok) {
        const spData = await spRes.json();
        if (spData.success && Array.isArray(spData.data)) {
          const adapted = adaptSportApiStandings(sportLeagueId, spData.data);
          if (adapted) {
            const payload = {
              configured: true,
              standings: adapted,
            };
            setCache(cacheKey, payload, 300_000);
            return res.json(payload);
          }
        }
      }
    } catch {
      // SportAPI error
    }
  }

  return res.status(502).json({
    error: 'Failed to communicate with standings providers.',
  });
});

// 6. Odds Endpoint (Strictly separate from fixtures, results, and standings)
//
// Odds are used only to compare against the FROZEN model's 1X2 probabilities. They never
// feed the model, never modify fixtures/results/standings, and never produce a wager
// recommendation. When no valid odds or no model prediction exists, the response is an
// honest, ineligible payload rather than fabricated numbers.
async function computeFrozenModelProbabilities(
  matchId: string,
  competitionCode: string
): Promise<ProbabilityTriplet | null> {
  const code = competitionCode.toUpperCase();
  if (!SUPPORTED_INTELLIGENCE_COMPETITIONS.includes(code)) return null;

  const fixture = await fetchFixtureForModel(matchId);
  if (!fixture) return null;

  const standings = await fetchStandingsForModel(code);
  const intelligence = evaluateMatchIntelligence(fixture, { [code]: standings });
  if (!intelligence.isEligible || !intelligence.probabilities) return null;

  const p = intelligence.probabilities;
  return { homeWin: p.homeWin, draw: p.draw, awayWin: p.awayWin };
}

/** Resolves a single fixture from whichever provider owns the id prefix. */
async function fetchFixtureForModel(matchId: string): Promise<Fixture | null> {
  const fdToken = getApiToken();
  const spToken = getSportApiToken();

  try {
    if (matchId.startsWith('sp-')) {
      if (!spToken) return null;
      const cleanId = matchId.replace(/^sp-/, '').trim();
      const r = await fetch(`https://sportapi.ai/api/fixtures/${cleanId}`, {
        headers: { 'X-Api-Key': spToken },
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data?.fixture ? adaptSportApiFixture(data.fixture) : null;
    }
    if (!fdToken) return null;
    const cleanId = matchId.replace(/^fd-/, '').trim();
    const r = await fetch(`https://api.football-data.org/v4/matches/${cleanId}`, {
      headers: { 'X-Auth-Token': fdToken },
    });
    if (!r.ok) return null;
    const raw = (await r.json()) as FootballDataMatch;
    return adaptFootballDataMatch(raw);
  } catch {
    return null;
  }
}

/** Resolves standings from the same providers used by the standings endpoint. */
async function fetchStandingsForModel(code: string): Promise<CompetitionStandings | null> {
  const fdToken = getApiToken();
  const spToken = getSportApiToken();

  if (fdToken) {
    try {
      const r = await fetch(`https://api.football-data.org/v4/competitions/${code}/standings`, {
        headers: { 'X-Auth-Token': fdToken },
      });
      if (r.ok) {
        const raw = (await r.json()) as FootballDataStandingsResponse;
        const adapted = adaptFootballDataStandingsResponse(raw);
        if (adapted) return adapted;
      }
    } catch {
      // fall through to SportAPI
    }
  }

  const spLeagueId = CODE_TO_SPORTAPI_ID[code];
  if (spToken && spLeagueId) {
    try {
      const r = await fetch(`https://sportapi.ai/api/standings/${spLeagueId}`, {
        headers: { 'X-Api-Key': spToken },
      });
      if (r.ok) {
        const data = await r.json();
        if (data?.success && Array.isArray(data.data)) {
          return adaptSportApiStandings(spLeagueId, data.data);
        }
      }
    } catch {
      // no standings available
    }
  }
  return null;
}

/**
 * Loads canonical fixture candidates for a competition, for odds event matching.
 * Uses the same provider chain as the fixtures endpoint so odds can only attach to a
 * fixture the app itself can see. Returns [] when the provider has nothing (never invents).
 */
async function loadOddsCandidates(competitionCode: string): Promise<MatchCandidate[]> {
  try {
    const fixtures = await loadFixturesForCompetition(competitionCode);
    return fixtures
      .filter((f) => (f.status === 'SCHEDULED' || f.status === 'TIMED') && f.utcKickoffTime)
      .map((f) => ({
        fixtureId: f.id,
        homeName: f.homeTeam?.name || '',
        awayName: f.awayTeam?.name || '',
        kickoffIso: f.utcKickoffTime,
      }));
  } catch {
    return [];
  }
}

/** Resolves the fixtures for one competition from the configured providers. */
async function loadFixturesForCompetition(competitionCode: string): Promise<Fixture[]> {
  const fdToken = getApiToken();
  const spToken = getSportApiToken();
  const out: Fixture[] = [];

  if (fdToken) {
    try {
      const { dateFrom, dateTo } = resolveFixtureDateWindow(null, null);
      const url = `https://api.football-data.org/v4/competitions/${competitionCode}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
      const r = await fetch(url, { headers: { 'X-Auth-Token': fdToken } });
      if (r.ok) {
        const raw = await r.json();
        const matches: FootballDataMatch[] = raw?.matches ?? [];
        out.push(...matches.map(adaptFootballDataMatch));
      }
    } catch {
      // fall through to SportAPI
    }
  }

  const spLeagueId = CODE_TO_SPORTAPI_ID[competitionCode];
  if (out.length === 0 && spToken && spLeagueId) {
    try {
      const r = await fetch(`https://sportapi.ai/api/fixtures?league=${spLeagueId}`, {
        headers: { 'X-Api-Key': spToken },
      });
      if (r.ok) {
        const data = await r.json();
        if (data?.success && Array.isArray(data.data)) {
          out.push(...data.data.map(adaptSportApiFixture));
        }
      }
    } catch {
      // no fixtures available
    }
  }

  return deduplicateFixtures(out);
}

app.get('/api/odds/:id', async (req: Request, res: Response) => {
  const matchId = req.params.id;
  const competitionCode = String(req.query.competition || '').toUpperCase();
  const oddsApiToken = getOddsApiToken();
  const oddsEnabled = isOddsApiEnabled();

  // 5DollarFootballAPI is kept disabled as an odds source: its key is invalid/revoked and
  // it must not be retried. It is intentionally not called here.

  const { result: fetchResult, quota } = await resolveOddsForFixture(
    matchId,
    competitionCode,
    {
      oddsApiKey: oddsApiToken,
      oddsApiEnabled: oddsEnabled,
      monthlyBudget: ODDS_MONTHLY_REQUEST_BUDGET,
    },
    oddsQuota,
    { loadCandidates: loadOddsCandidates }
  );
  oddsQuota = quota;

  const validated = validateOddsBatch(fetchResult.observations);

  // Compute the frozen model's 1X2 probabilities for this fixture, if we can do so
  // honestly. No fixture/standings data means no model probabilities and no analysis.
  let modelProbabilities: ProbabilityTriplet | null = null;
  if (fetchResult.status === 'ok' && competitionCode) {
    modelProbabilities = await computeFrozenModelProbabilities(matchId, competitionCode);
  }

  return res.json(
    buildOddsPayload({ matchId, fetch: fetchResult, validated, modelProbabilities })
  );
});

// Vite Middleware for Development / Static serving for Production
async function setupFrontend() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  } else {
    process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Project Touchline] Server running at http://0.0.0.0:${PORT}`);
  });
}

setupFrontend().catch((err) => {
  console.error('[Project Touchline] Server failed to start:', err);
  process.exit(1);
});
