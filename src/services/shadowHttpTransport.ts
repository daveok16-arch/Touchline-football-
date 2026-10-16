/**
 * Project Touchline – Phase T3 minimal HTTP collector transport (RESEARCH ONLY)
 *
 * A `CollectorTransport` and `StandingsSource` that read the app's OWN same-origin endpoints
 * (`/api/fixtures`, `/api/matches/:id`, `/api/standings`). It performs no provider calls of its
 * own and carries no credentials: the server holds the API keys and these adapters only speak
 * to the local Touchline API.
 *
 * It is NOT wired into application startup, no scheduler drives it, and it is constructed only
 * by an explicit caller. Nothing here runs unless something constructs and drives it.
 *
 * Safety properties:
 *  - Fail-closed: construction throws unless a fixture provider credential is configured.
 *  - Timeouts via AbortController; bounded retries only on NETWORK/SERVER_ERROR.
 *  - 429 is mapped to RATE_LIMITED with a parsed `Retry-After` (never retried here).
 *  - Strict response validation: a malformed payload is a SERVER_ERROR, never a fabricated row.
 *  - Identity integrity: a fixture without a usable id/teams/kickoff is skipped, not invented.
 */

import {
  CollectorTransport,
  TransportError,
  TransportFixture,
  TransportResult,
  nextBackoffMs,
} from './shadowCollector';
import { StandingsSource } from './shadowForecastProvider';
import { CompetitionStandings } from '../types/football';

export interface HttpTransportOptions {
  /** Same-origin base URL, e.g. `http://127.0.0.1:3000`. */
  baseUrl: string;
  /** Injectable fetch (tests supply a mock); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests supply a no-op); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Bounded retries for NETWORK/SERVER_ERROR (does not apply to 429/404/other 4xx). */
  maxRetries?: number;
  /** Deterministic backoff seed. */
  backoffSeed?: number;
}

export const HTTP_TRANSPORT_DEFAULTS = Object.freeze({
  timeoutMs: 8_000,
  /**
   * In-transport retries are OFF by default. A retry is another HTTP request to the same-origin
   * API (which may itself hit the provider), but the collector charges only ONE budget unit per
   * transport call. Retrying here would therefore spend more provider requests than the budget
   * accounts for. The budget-safe retry mechanism is the collector's next-tick poll (each of
   * which is charged). Opt in only when the caller also accounts for the extra requests.
   */
  maxRetries: 0,
  backoffSeed: 7,
});

/** Env vars that, if any is set, mean a fixtures provider is configured server-side. */
const FIXTURE_PROVIDER_ENV_KEYS = [
  'FOOTBALL_DATA_API_KEY',
  'FOOTBALL_DATA_TOKEN',
  'FOOTBALL_DATA_ORG_TOKEN',
  'SPORTAPI_KEY',
];

/**
 * Startup configuration check. Returns `{ ok: false }` when no fixtures provider credential is
 * present, so a caller can refuse to build the transport rather than run it credential-less.
 */
export function checkTransportConfig(
  env: Record<string, string | undefined> = process.env
): { ok: true } | { ok: false; error: string } {
  const configured = FIXTURE_PROVIDER_ENV_KEYS.some((k) => Boolean(env[k]));
  return configured ? { ok: true } : { ok: false, error: 'NO_FIXTURE_PROVIDER_CONFIGURED' };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
}

/**
 * Maps one adapted `Fixture` JSON object to a `TransportFixture`. Returns null when the record
 * lacks a usable identity (id, both team ids, kickoff) so a bad row is skipped, not fabricated.
 */
export function toTransportFixture(raw: unknown): TransportFixture | null {
  if (!isRecord(raw)) return null;
  const fixtureId = asString(raw.id);
  const kickoffTime = asString(raw.utcKickoffTime);
  const homeTeam = isRecord(raw.homeTeam) ? asString(raw.homeTeam.id) : null;
  const awayTeam = isRecord(raw.awayTeam) ? asString(raw.awayTeam.id) : null;
  if (!fixtureId || !kickoffTime || !homeTeam || !awayTeam) return null;
  if (!Number.isFinite(Date.parse(kickoffTime))) return null;

  const competition = isRecord(raw.competition) ? raw.competition : {};
  const score = isRecord(raw.score) ? raw.score : undefined;

  return {
    fixtureId,
    competitionCode: (asString(competition.code) ?? 'UNKNOWN').toUpperCase(),
    season: asString(competition.season) ?? '',
    homeTeamId: homeTeam,
    awayTeamId: awayTeam,
    kickoffTime,
    status: asString(raw.status) ?? 'SCHEDULED',
    providerLastUpdated: asString(raw.lastUpdated) ?? undefined,
    homeGoals: score ? asNumberOrNull(score.home) : null,
    awayGoals: score ? asNumberOrNull(score.away) : null,
  };
}

interface RawResponse {
  status: number;
  retryAfterMs?: number;
  json: unknown;
}

interface HttpCore {
  baseUrl: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  maxRetries: number;
  backoffSeed: number;
}

/**
 * Timeout-bounded GET with bounded retries. NETWORK and SERVER_ERROR are retried up to
 * `maxRetries` with the collector's deterministic backoff; 429 (with parsed `Retry-After`),
 * 404 and other 4xx are returned immediately and never retried here.
 */
async function fetchWithRetry(core: HttpCore, path: string, nowMs: number): Promise<TransportResult<RawResponse>> {
  let attempt = 0;
  for (;;) {
    let result: TransportResult<RawResponse>;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), core.timeoutMs);
      let res: Response;
      try {
        res = await core.fetchImpl(`${core.baseUrl}${path}`, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), nowMs);
      if (res.status === 404) {
        result = { ok: false, error: 'NOT_FOUND' };
      } else if (res.status === 429) {
        result = { ok: false, error: 'RATE_LIMITED', retryAfterMs };
      } else if (res.status >= 400) {
        result = { ok: false, error: 'SERVER_ERROR' };
      } else {
        try {
          result = { ok: true, data: { status: res.status, retryAfterMs, json: await res.json() } };
        } catch {
          result = { ok: false, error: 'SERVER_ERROR' }; // malformed body
        }
      }
    } catch {
      result = { ok: false, error: 'NETWORK' };
    }

    if (result.ok) return result;
    const retryable = result.error === 'NETWORK' || result.error === 'SERVER_ERROR';
    if (!retryable || attempt >= core.maxRetries) return result;
    await core.sleep(nextBackoffMs(attempt, undefined, core.backoffSeed));
    attempt += 1;
  }
}

function coreFrom(options: HttpTransportOptions): HttpCore {
  return {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    sleep: options.sleep ?? defaultSleep,
    timeoutMs: options.timeoutMs ?? HTTP_TRANSPORT_DEFAULTS.timeoutMs,
    maxRetries: options.maxRetries ?? HTTP_TRANSPORT_DEFAULTS.maxRetries,
    backoffSeed: options.backoffSeed ?? HTTP_TRANSPORT_DEFAULTS.backoffSeed,
  };
}

/**
 * Same-origin HTTP transport. Every call is timeout-bounded; NETWORK/SERVER_ERROR are retried
 * up to `maxRetries` with the collector's deterministic backoff; 429/404/other 4xx are not.
 */
export class HttpShadowTransport implements CollectorTransport {
  private readonly core: HttpCore;

  constructor(options: HttpTransportOptions) {
    this.core = coreFrom(options);
  }

  /** `GET /api/fixtures?competition=ALL` – upcoming fixtures within the discovery horizon. */
  async listFixtures(nowMs: number): Promise<TransportResult<TransportFixture[]>> {
    const res = await fetchWithRetry(this.core, '/api/fixtures?competition=ALL', nowMs);
    if (!res.ok) return res;
    const body = res.data.json;
    if (!isRecord(body) || !Array.isArray(body.matches)) {
      return { ok: false, error: 'SERVER_ERROR' }; // malformed payload
    }
    const fixtures: TransportFixture[] = [];
    for (const row of body.matches) {
      const tf = toTransportFixture(row);
      if (tf) fixtures.push(tf);
    }
    return { ok: true, data: fixtures };
  }

  /** `GET /api/matches/:id` – a single fixture by id. */
  async getMatch(fixtureId: string, nowMs: number): Promise<TransportResult<TransportFixture>> {
    const res = await fetchWithRetry(this.core, `/api/matches/${encodeURIComponent(fixtureId)}`, nowMs);
    if (!res.ok) return res;
    const body = res.data.json;
    if (!isRecord(body) || !isRecord(body.match)) {
      return { ok: false, error: 'SERVER_ERROR' }; // malformed payload
    }
    const tf = toTransportFixture(body.match);
    if (!tf) return { ok: false, error: 'SERVER_ERROR' };
    return { ok: true, data: tf };
  }
}

/** Same-origin standings source for the standings-aware `ForecastProvider`. */
export class HttpStandingsSource implements StandingsSource {
  private readonly core: HttpCore;

  constructor(options: HttpTransportOptions) {
    this.core = coreFrom(options);
  }

  /** `GET /api/standings?competition=<code>` – a league table, or null when unavailable. */
  async getStandings(
    competitionCode: string,
    nowMs: number
  ): Promise<TransportResult<CompetitionStandings | null>> {
    const code = competitionCode.toUpperCase();
    const res = await fetchWithRetry(this.core, `/api/standings?competition=${encodeURIComponent(code)}`, nowMs);
    if (!res.ok) return res;
    const body = res.data.json;
    if (!isRecord(body)) return { ok: false, error: 'SERVER_ERROR' };
    // A null standings object means the provider returned nothing usable – not an error.
    if (body.standings === null || body.standings === undefined) return { ok: true, data: null };
    if (!isRecord(body.standings) || !Array.isArray((body.standings as Record<string, unknown>).table)) {
      return { ok: false, error: 'SERVER_ERROR' }; // malformed payload
    }
    return { ok: true, data: body.standings as unknown as CompetitionStandings };
  }
}

export interface ShadowHttpAdapters {
  transport: CollectorTransport;
  standings: StandingsSource;
}

/**
 * Builds the transport and standings adapters, failing closed when no fixtures provider
 * credential is configured. Constructed explicitly by a caller; never on app boot.
 */
export function createShadowHttpAdapters(
  options: HttpTransportOptions,
  env: Record<string, string | undefined> = process.env
): ShadowHttpAdapters {
  const check = checkTransportConfig(env);
  if (!check.ok) {
    throw new Error(
      `Shadow transport refused to start: no fixtures provider credential configured (${check.error}). ` +
        'Set FOOTBALL_DATA_API_KEY or SPORTAPI_KEY.'
    );
  }
  return {
    transport: new HttpShadowTransport(options),
    standings: new HttpStandingsSource(options),
  };
}
