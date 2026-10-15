/**
 * Project Touchline – 5DollarFootballAPI Odds Adapter
 *
 * Maps the real 5DollarFootballAPI odds contract
 * (`GET https://api.5dollarfootballapi.com/v1/fixtures/{id}/odds`) into the canonical
 * odds schema, and classifies failures honestly. It never substitutes or invents odds.
 *
 * Verified contract (OpenAPI 3.2, v1):
 *   auth: `Authorization: Bearer <key>` or `X-API-Key: <key>`
 *   success: { success: 1, data: { fixture_id, bookmakers: [ { id, name, slug, odds } ] } }
 *   1X2: odds["1x2"] = { opening: {home,draw,away}, closing: {...}, inplay: {...}|null }
 *   error:   { success: 0, error: { type, code, message, request_id } }
 */

import { OddsObservation, OddsProviderId, SUPPORTED_ODDS_MARKET, OddsPhase } from './oddsSchema';
import { ParsedQuotaHeaders, parseQuotaHeaders, HeaderReader } from './oddsQuota';

export const FIVE_DOLLAR_BASE_URL = 'https://api.5dollarfootballapi.com/v1';
export const THE_ODDS_API_BASE_URL = 'https://api.the-odds-api.com/v4';

/**
 * Canonical competition id → The Odds API sport key. Only mappings that were verified
 * against the live `/v4/sports` list are present; anything absent has no odds mapping
 * and must not be guessed.
 */
export const COMPETITION_TO_ODDS_SPORT_KEY: Record<string, string> = {
  PL: 'soccer_epl',
  CL: 'soccer_uefa_champs_league',
  PD: 'soccer_spain_la_liga',
  SA: 'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
  'SP-9': 'soccer_france_ligue_one',
  'SP-8': 'soccer_netherlands_eredivisie',
  'SP-13': 'soccer_portugal_primeira_liga',
  'SP-16': 'soccer_turkey_super_league',
  'SP-11': 'soccer_norway_eliteserien',
  'SP-12': 'soccer_poland_ekstraklasa',
  'SP-19': 'soccer_denmark_superliga',
  'SP-15': 'soccer_switzerland_superleague',
  'SP-10': 'soccer_greece_super_league',
  'SP-20': 'soccer_usa_mls',
};

export type OddsFetchStatus =
  | 'ok'
  | 'auth_error'
  | 'plan_restricted'
  | 'fixture_not_found'
  | 'rate_limited'
  | 'market_unavailable'
  | 'network_error'
  | 'invalid_response'
  | 'budget_exhausted'
  | 'fixture_mismatch'
  | 'not_configured';

export interface OddsFetchResult {
  status: OddsFetchStatus;
  observations: OddsObservation[];
  /** Honest, human-readable notice. Never contains secrets. */
  notice: string;
  /** Retry hint for rate limits. */
  retryAfterSeconds?: number;
  provider: OddsProviderId;
  /** Provider-reported quota headers, when the provider supplied them. */
  quota?: ParsedQuotaHeaders;
  /** Credit cost of the request, when it was actually dispatched. */
  costCredits?: number;
}

/** Classifies an HTTP status + parsed error body into a fetch status. */
export function classifyOddsError(httpStatus: number, body: any): OddsFetchStatus {
  const code: string = body?.error?.code || '';
  if (httpStatus === 401) return 'auth_error';
  if (httpStatus === 403) return 'plan_restricted';
  if (httpStatus === 404) return 'fixture_not_found';
  if (httpStatus === 429) return 'rate_limited';
  if (code === 'missing_api_key' || code === 'invalid_api_key' || code === 'revoked_api_key') return 'auth_error';
  if (code === 'plan_required' || code === 'upgrade_required') return 'plan_restricted';
  if (httpStatus >= 500) return 'network_error';
  return 'invalid_response';
}

export function noticeForStatus(status: OddsFetchStatus): string {
  switch (status) {
    case 'auth_error':
      return '5DollarFootballAPI rejected the key (HTTP 401 invalid_api_key). No odds are available until valid credentials are supplied.';
    case 'plan_restricted':
      return 'The requested market or bookmaker is outside the current 5DollarFootballAPI plan (HTTP 403).';
    case 'fixture_not_found':
      return 'No odds exist for this fixture in the 5DollarFootballAPI database (HTTP 404).';
    case 'rate_limited':
      return '5DollarFootballAPI rate limit reached (HTTP 429). Retry later.';
    case 'market_unavailable':
      return 'The fixture exists but carries no 1X2 full-time market in the provider response.';
    case 'network_error':
      return 'Could not reach 5DollarFootballAPI (network or upstream error).';
    case 'invalid_response':
      return '5DollarFootballAPI returned an unrecognised response shape.';
    case 'not_configured':
      return 'FIVE_DOLLAR_KEY is not configured. No odds are requested.';
    case 'budget_exhausted':
      return 'The local monthly odds budget is exhausted. No request was sent.';
    case 'fixture_mismatch':
      return 'No canonical fixture could be matched unambiguously. Odds were not attached.';
    case 'ok':
      return 'OK';
  }
}

export function noticeForOddsApiStatus(status: OddsFetchStatus): string {
  switch (status) {
    case 'auth_error':
      return 'The Odds API rejected the key (HTTP 401). No odds are available until valid credentials are supplied.';
    case 'plan_restricted':
      return 'The requested sport, market or region is outside the current The Odds API plan (HTTP 403).';
    case 'fixture_not_found':
      return 'The Odds API does not list this event.';
    case 'rate_limited':
      return 'The Odds API rate limit reached (HTTP 429). Retry later.';
    case 'market_unavailable':
      return 'No 1X2 (h2h) market with home/draw/away prices was returned for this competition.';
    case 'network_error':
      return 'Could not reach The Odds API (network or upstream error).';
    case 'invalid_response':
      return 'The Odds API returned an unrecognised response shape.';
    case 'budget_exhausted':
      return 'The local monthly odds request budget or the provider quota is exhausted. No request was sent.';
    case 'fixture_mismatch':
      return 'No single canonical fixture could be matched unambiguously to an odds event. Odds were not attached.';
    case 'not_configured':
      return 'ODDS_API_KEY is not configured or The Odds API is disabled. No odds are requested.';
    case 'ok':
      return 'OK';
  }
}

function toOddsPhase(phase: string): OddsPhase {
  return phase === 'opening' || phase === 'inplay' ? phase : 'closing';
}

function validPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 1.0;
}

/**
 * Maps a 5Dollar odds payload into canonical observations.
 * Returns an empty array (never fabricated data) when the 1X2 market is absent.
 */
export function adaptFiveDollarOdds(
  payload: any,
  fixtureId: string,
  competitionCode: string,
  observedAt: string
): OddsObservation[] {
  const bookmakers = payload?.data?.bookmakers;
  if (!Array.isArray(bookmakers)) return [];

  const observations: OddsObservation[] = [];
  for (const book of bookmakers) {
    const market = book?.odds?.['1x2'];
    if (!market) continue;
    const slug = book?.slug || book?.name || 'unknown-bookmaker';

    for (const phase of ['opening', 'closing', 'inplay'] as const) {
      const line = market[phase];
      if (!line) continue;
      if (!validPrice(line.home) || !validPrice(line.draw) || !validPrice(line.away)) continue;
      observations.push({
        fixtureId,
        competitionCode,
        provider: '5dollarfootballapi',
        bookmaker: slug,
        market: SUPPORTED_ODDS_MARKET,
        phase: toOddsPhase(phase),
        observedAt,
        // The provider does not supply an explicit opening timestamp, only an opening
        // price line, so openingAt is deliberately left undefined rather than invented.
        openingAt: undefined,
        period: 'FULL_TIME',
        selection: { home: line.home, draw: line.draw, away: line.away },
      });
    }
  }
  return observations;
}

/**
 * Fetches and adapts odds for one fixture. Never throws; always returns a classified
 * result. `apiKey` must be non-empty for a request to be attempted.
 */
export async function fetchFiveDollarOdds(
  apiKey: string | null | undefined,
  fixtureId: string,
  competitionCode: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {}
): Promise<OddsFetchResult> {
  const provider: OddsProviderId = '5dollarfootballapi';
  if (!apiKey || apiKey.trim().length === 0) {
    return { status: 'not_configured', observations: [], notice: noticeForStatus('not_configured'), provider };
  }

  const cleanId = fixtureId.replace(/^fd-/, '').trim();
  const url = `${FIVE_DOLLAR_BASE_URL}/fixtures/${encodeURIComponent(cleanId)}/odds?market=1x2`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const observedAt = (options.now ?? new Date()).toISOString();

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch {
    return { status: 'network_error', observations: [], notice: noticeForStatus('network_error'), provider };
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const status = classifyOddsError(res.status, body);
    const retryAfter = Number(res.headers?.get?.('Retry-After'));
    return {
      status,
      observations: [],
      notice: noticeForStatus(status),
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      provider,
    };
  }

  if (body?.success !== 1) {
    const status = classifyOddsError(res.status, body);
    return { status, observations: [], notice: noticeForStatus(status), provider };
  }

  const observations = adaptFiveDollarOdds(body, fixtureId, competitionCode, observedAt);
  if (observations.length === 0) {
    return { status: 'market_unavailable', observations: [], notice: noticeForStatus('market_unavailable'), provider };
  }
  return { status: 'ok', observations, notice: noticeForStatus('ok'), provider };
}

/* ------------------------------------------------------------------------------------------
 * The Odds API (the-odds-api.com)
 *
 * Verified contract (v4):
 *   GET /v4/sports/{sport}/odds?apiKey=…&regions=…&markets=h2h&oddsFormat=decimal&dateFormat=iso
 *   success: [ { id, sport_key, commence_time, home_team, away_team,
 *                bookmakers: [ { key, title, last_update, markets: [ { key: "h2h",
 *                outcomes: [ { name, price } ] } ] } ] } ]
 *   The draw is the outcome whose name is "Draw"; home/away are matched by team name.
 *   Quota headers: x-requests-remaining / x-requests-used / x-requests-last.
 * ---------------------------------------------------------------------------------------- */

function toOddsApiProvider(): OddsProviderId {
  return 'the-odds-api';
}

/**
 * Maps a The Odds API event into canonical observations for one specific canonical fixture.
 * Returns an empty array (never fabricated data) when no bookmaker supplies a complete
 * home/draw/away 1X2 line. `last_update` is the genuine provider timestamp; the draw is
 * located by name, and home/away by the event's own team names.
 */
export function adaptTheOddsApiEvent(
  event: any,
  canonicalFixtureId: string,
  competitionCode: string
): OddsObservation[] {
  const homeName: string = event?.home_team;
  const awayName: string = event?.away_team;
  const bookmakers = event?.bookmakers;
  if (!homeName || !awayName || !Array.isArray(bookmakers)) return [];

  const observations: OddsObservation[] = [];
  for (const book of bookmakers) {
    const markets = Array.isArray(book?.markets) ? book.markets : [];
    const h2h = markets.find((m: any) => m?.key === 'h2h');
    if (!h2h || !Array.isArray(h2h.outcomes)) continue;

    const findPrice = (name: string): number | undefined => {
      const o = h2h.outcomes.find((x: any) => x?.name === name);
      return typeof o?.price === 'number' ? o.price : undefined;
    };
    const home = findPrice(homeName);
    const away = findPrice(awayName);
    const draw = findPrice('Draw');
    if (!validPrice(home) || !validPrice(draw) || !validPrice(away)) continue;

    const bookmaker = book?.key || book?.title;
    if (!bookmaker) continue;

    observations.push({
      fixtureId: canonicalFixtureId,
      competitionCode,
      provider: toOddsApiProvider(),
      bookmaker,
      market: SUPPORTED_ODDS_MARKET,
      // The Odds API returns a current line with a genuine update timestamp; the phase is
      // "closing" (the live/current price), not an invented opening line.
      phase: 'closing',
      observedAt: book?.last_update || new Date().toISOString(),
      openingAt: undefined,
      period: 'FULL_TIME',
      selection: { home, draw, away },
    });
  }
  return observations;
}

export interface FetchOddsApiOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Bookmaker regions; default `uk`. Cost = markets x regions. */
  regions?: string;
  /** Expected credit cost used for budget accounting; default 1. */
  costCredits?: number;
  /** When false, no request is sent and `budget_exhausted` is returned. */
  allowRequest?: boolean;
}

/** The Odds API result: like `OddsFetchResult`, plus the raw events for the caller to match. */
export interface OddsApiFetchResult extends OddsFetchResult {
  /** Raw provider events (unmatched). Empty unless status is `ok`. */
  events: any[];
}

/**
 * Fetches one competition's h2h odds from The Odds API. Never throws; always returns a
 * classified result. `apiKey` must be non-empty and `sportKey` must be a verified mapping
 * for a request to be attempted. This function does NOT attach odds to a fixture — the
 * caller matches events to canonical fixtures via `matchEventToFixture`.
 */
export async function fetchTheOddsApiOdds(
  apiKey: string | null | undefined,
  sportKey: string | null | undefined,
  competitionCode: string,
  options: FetchOddsApiOptions = {}
): Promise<OddsApiFetchResult> {
  const provider = toOddsApiProvider();
  if (!apiKey || apiKey.trim().length === 0) {
    return { status: 'not_configured', observations: [], events: [], notice: noticeForOddsApiStatus('not_configured'), provider };
  }
  if (!sportKey) {
    return {
      status: 'market_unavailable',
      observations: [],
      events: [],
      notice: `No verified The Odds API sport key for competition ${competitionCode}. No request sent.`,
      provider,
    };
  }
  if (options.allowRequest === false) {
    return { status: 'budget_exhausted', observations: [], events: [], notice: noticeForOddsApiStatus('budget_exhausted'), provider };
  }

  const regions = options.regions ?? 'uk';
  const costCredits = options.costCredits ?? 1;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url =
    `${THE_ODDS_API_BASE_URL}/sports/${encodeURIComponent(sportKey)}/odds` +
    `?apiKey=${encodeURIComponent(apiKey)}&regions=${encodeURIComponent(regions)}` +
    `&markets=h2h&oddsFormat=decimal&dateFormat=iso`;

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    return { status: 'network_error', observations: [], events: [], notice: noticeForOddsApiStatus('network_error'), provider };
  }

  const quota = parseQuotaHeaders(res.headers as unknown as HeaderReader);

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const status = classifyOddsError(res.status, body);
    const retryAfter = Number(res.headers?.get?.('Retry-After'));
    return {
      status,
      observations: [],
      events: [],
      notice: noticeForOddsApiStatus(status),
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      provider,
      quota,
      costCredits,
    };
  }

  if (!Array.isArray(body)) {
    return { status: 'invalid_response', observations: [], events: [], notice: noticeForOddsApiStatus('invalid_response'), provider, quota, costCredits };
  }

  // Return the raw events; the caller matches them to canonical fixtures. We surface them
  // as observations only after matching, so an unmatchable event never becomes odds.
  return { status: 'ok', observations: [], events: body, notice: noticeForOddsApiStatus('ok'), provider, quota, costCredits };
}
