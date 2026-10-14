import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  adaptFootballDataMatch,
  adaptFootballDataMatchesResponse,
  adaptFootballDataStandingsResponse,
  FREE_PROVIDER_COMPETITIONS,
  VERIFIED_SUPPORTED_COMPETITIONS,
  SUPPORTED_COMPETITION_CODES,
} from './src/services/footballDataAdapter';
import {
  FootballDataMatch,
  FootballDataMatchesResponse,
  FootballDataStandingsResponse,
} from './src/types/footballData';
import { deduplicateFixtures } from './src/utils/matchIdentity';
import { MatchOdds } from './src/types/football';
import {
  adaptSportApiFixture,
  adaptSportApiFixturesResponse,
  adaptSportApiStandings,
  CODE_TO_SPORTAPI_ID,
} from './src/services/sportApiAdapter';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

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

  res.json({
    configured: Boolean(token && token.trim().length > 0),
    provider: 'football-data.org',
    tier: 'free',
    rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
    requestsUsedInLastMinute: requestTimestamps.length,
    latencyNotice: 'Delayed scores (free tier latency: up to 15 minutes). Not real-time live data.',
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
        configured: Boolean(token && token.trim().length > 0),
        status: token ? 'active' : 'unconfigured',
        tier: 'free',
        rateLimit: '10 requests/minute',
        supportedCompetitions: ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1', 'ELC', 'DED', 'PPL', 'BSA', 'CLI'],
        latencyNotice: 'Delayed scores (free tier latency: up to 15 min).',
        missingConfig: token ? undefined : 'FOOTBALL_DATA_API_KEY is not configured',
      },
      {
        id: 'sportapi.ai',
        name: 'SportAPI.ai',
        role: 'secondary_fixtures',
        configured: Boolean(sportApiToken && sportApiToken.trim().length > 0),
        status: sportApiToken ? 'active' : 'unconfigured',
        tier: 'free',
        rateLimit: '2,000 requests/day',
        supportedCompetitions: ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1', 'Domestic Cups', 'EL', 'ECL', 'MLS', 'Saudi Pro League', 'J1'],
        latencyNotice: '1-minute polling interval, 30-60s goal pushes.',
        missingConfig: sportApiToken ? undefined : 'SPORTAPI_KEY is not configured',
      },
      {
        id: '5dollarfootballapi',
        name: '5DollarFootballAPI',
        role: 'odds',
        configured: Boolean(fiveDollarToken && fiveDollarToken.trim().length > 0),
        status: fiveDollarToken ? 'error' : 'unconfigured',
        tier: 'free',
        rateLimit: '60 requests/hour (max 20 req/min)',
        supportedCompetitions: ['PL', 'PD', 'SA', 'BL1', 'FL1'],
        latencyNotice: 'Real-time Bet365 odds markets.',
        missingConfig: fiveDollarToken
          ? 'FIVE_DOLLAR_KEY failed upstream authentication (HTTP 401 invalid_api_key). Provider stopped until resolved.'
          : 'FIVE_DOLLAR_KEY is not configured',
      },
      {
        id: 'the-odds-api',
        name: 'The Odds API',
        role: 'auxiliary_odds',
        configured: Boolean(oddsApiToken && oddsApiToken.trim().length > 0 && oddsEnabled),
        status: !oddsEnabled ? 'disabled' : oddsApiToken ? 'active' : 'unconfigured',
        tier: 'free',
        rateLimit: '500 credits/month (rapid credit depletion: markets * regions per call)',
        supportedCompetitions: ['soccer_epl', 'soccer_uefa_champs_league'],
        latencyNotice: 'Aggregated bookmaker lines.',
        missingConfig: !oddsEnabled
          ? 'The Odds API is kept disabled by policy (ENABLE_ODDS_API is not set to true to prevent quota burn).'
          : oddsApiToken
          ? undefined
          : 'ODDS_API_KEY is not configured',
      },
    ],
  });
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
      competitions: VERIFIED_SUPPORTED_COMPETITIONS,
    });
  }
  return res.json({
    configured: true,
    competitions: VERIFIED_SUPPORTED_COMPETITIONS,
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
    if (token) {
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

        if (dateFrom && typeof dateFrom === 'string') {
          params.append('dateFrom', dateFrom);
        }
        if (dateTo && typeof dateTo === 'string') {
          params.append('dateTo', dateTo);
        }

        url += `?${params.toString()}`;

        recordOutboundRequest();
        const upstreamRes = await fetch(url, {
          headers: {
            'X-Auth-Token': token,
          },
        });

        if (upstreamRes.ok) {
          const rawData = (await upstreamRes.json()) as FootballDataMatchesResponse;
          fdFixtures = adaptFootballDataMatchesResponse(rawData);
        }
      }
    }

    // Secondary provider: SportAPI.ai (incrementally enabled with 2,000 req/day quota)
    let spFixtures: any[] = [];
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
          }
        }
      } catch {
        // SportAPI fetch failure is gracefully handled, preserving Football-Data
      }
    }

    const deduplicated = deduplicateFixtures([...fdFixtures, ...spFixtures]);

    const payload = {
      configured: true,
      count: deduplicated.length,
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

  if (!SUPPORTED_COMPETITION_CODES.includes(compCode as any)) {
    return res.status(400).json({
      error: `Competition ${compCode} is not in the verified supported free tier competitions (PL, CL, PD, SA).`,
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
app.get('/api/odds/:id', async (req: Request, res: Response) => {
  const matchId = req.params.id;
  const fiveDollarToken = getFiveDollarToken();
  const oddsApiToken = getOddsApiToken();
  const oddsEnabled = isOddsApiEnabled();

  // If no odds provider key is configured or odds are disabled, return an honest unavailable status
  if (!fiveDollarToken && (!oddsApiToken || !oddsEnabled)) {
    const oddsPayload: MatchOdds = {
      matchId,
      provider: 'none',
      available: false,
      notice: !oddsEnabled
        ? 'Odds are disabled by configuration (ENABLE_ODDS_API=false).'
        : 'Odds providers not configured. Missing FIVE_DOLLAR_KEY or ODDS_API_KEY in environment.',
    };
    return res.json(oddsPayload);
  }

  // If fiveDollarToken is configured, report honest authentication error from upstream
  if (fiveDollarToken) {
    return res.json({
      matchId,
      provider: '5dollarfootballapi',
      available: false,
      notice: 'Odds feed unavailable: FIVE_DOLLAR_KEY failed upstream authentication (HTTP 401 invalid_api_key). Provider stopped until credentials are renewed.',
    });
  }

  // Handle configured odds providers safely (timeout, rate limit, no mock substitution)
  return res.json({
    matchId,
    provider: 'none',
    available: false,
    notice: 'No odds feed available for this match under the active provider contract.',
  });
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
