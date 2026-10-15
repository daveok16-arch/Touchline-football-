/**
 * Project Touchline – Canonical Odds Contract and Validation
 *
 * A provider-agnostic representation of a bookmaker's 1X2 (home/draw/away) decimal
 * prices for a single fixture, plus strict validation. Kept entirely separate from the
 * frozen model's probabilities and from live fixture/standings data.
 *
 * Honesty rules enforced here:
 * - Odds are accepted only when they are finite, positive decimals (> 1.0).
 * - An observation must carry a timestamp and must not be older than the freshness limit.
 * - A fixture must be identified so prices can be matched to a known fixture.
 * - Duplicate observations for the same (fixture, bookmaker, market) are rejected.
 * - Missing selections make the observation ineligible; no price is ever invented.
 */

export type OddsProviderId = '5dollarfootballapi' | 'the-odds-api' | 'none';

/** Which point in time a price belongs to. */
export type OddsPhase = 'opening' | 'closing' | 'inplay';

/** The only market this layer scores: full-time 1X2. */
export const SUPPORTED_ODDS_MARKET = '1X2_FULL_TIME';

export interface OddsSelection {
  /** Decimal odds. Must be finite and > 1.0. */
  home: number;
  draw: number;
  away: number;
}

export interface OddsObservation {
  /** Fixture this price belongs to (canonical id, e.g. `fd-12345`). */
  fixtureId: string;
  competitionCode: string;
  provider: OddsProviderId;
  bookmaker: string;
  market: typeof SUPPORTED_ODDS_MARKET;
  phase: OddsPhase;
  /** ISO timestamp when the price was observed/recorded. */
  observedAt: string;
  /** ISO timestamp of the opening price, only when the provider genuinely supplies it. */
  openingAt?: string;
  /** Market settlement period. 1X2 full-time settles on 90 minutes + stoppage. */
  period: 'FULL_TIME';
  /** Decimal prices for each selection. */
  selection: OddsSelection;
}

export type OddsRejectionReason =
  | 'MISSING_FIXTURE_ID'
  | 'UNKNOWN_PROVIDER'
  | 'MISSING_BOOKMAKER'
  | 'INVALID_MARKET'
  | 'INVALID_PERIOD'
  | 'MISSING_SELECTION'
  | 'INVALID_ODDS'
  | 'MISSING_TIMESTAMP'
  | 'EXPIRED_OBSERVATION'
  | 'DUPLICATE_OBSERVATION';

export interface OddsValidationIssue {
  reason: OddsRejectionReason;
  detail: string;
}

export interface OddsValidationOptions {
  /** Maximum age of an observation in milliseconds. Default 24h. */
  maxAgeMs?: number;
  /** "Now" for freshness checks; injectable for deterministic tests. */
  now?: Date;
  /** Existing observations to check duplicates against. */
  existing?: OddsObservation[];
}

export const DEFAULT_MAX_ODDS_AGE_MS = 24 * 60 * 60 * 1000;

function isPositiveDecimal(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 1.0;
}

function parseMs(iso: string | undefined): number {
  if (!iso) return NaN;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? NaN : ms;
}

/** Stable identity for duplicate detection: fixture + bookmaker + market + phase. */
export function oddsObservationKey(o: OddsObservation): string {
  return [o.fixtureId, o.bookmaker.toLowerCase(), o.market, o.phase].join('|');
}

/**
 * Validates a single odds observation. Returns an empty array when the observation is
 * usable, otherwise one issue per failed rule.
 */
export function validateOddsObservation(
  observation: Partial<OddsObservation>,
  options: OddsValidationOptions = {}
): OddsValidationIssue[] {
  const issues: OddsValidationIssue[] = [];
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_ODDS_AGE_MS;
  const now = options.now ?? new Date();

  if (!observation.fixtureId || typeof observation.fixtureId !== 'string') {
    issues.push({ reason: 'MISSING_FIXTURE_ID', detail: 'Odds observation has no fixture id.' });
  }
  if (
    observation.provider !== '5dollarfootballapi' &&
    observation.provider !== 'the-odds-api' &&
    observation.provider !== 'none'
  ) {
    issues.push({ reason: 'UNKNOWN_PROVIDER', detail: `Unknown provider: ${String(observation.provider)}` });
  }
  if (!observation.bookmaker || typeof observation.bookmaker !== 'string') {
    issues.push({ reason: 'MISSING_BOOKMAKER', detail: 'Odds observation has no bookmaker identity.' });
  }
  if (observation.market !== SUPPORTED_ODDS_MARKET) {
    issues.push({
      reason: 'INVALID_MARKET',
      detail: `Unsupported market: ${String(observation.market)} (only ${SUPPORTED_ODDS_MARKET} is scored).`,
    });
  }
  if (observation.period !== 'FULL_TIME') {
    issues.push({ reason: 'INVALID_PERIOD', detail: `Unsupported period: ${String(observation.period)}.` });
  }

  const sel = observation.selection;
  if (!sel || typeof sel.home !== 'number' || typeof sel.draw !== 'number' || typeof sel.away !== 'number') {
    issues.push({ reason: 'MISSING_SELECTION', detail: '1X2 requires home, draw and away prices.' });
  } else if (!isPositiveDecimal(sel.home) || !isPositiveDecimal(sel.draw) || !isPositiveDecimal(sel.away)) {
    issues.push({
      reason: 'INVALID_ODDS',
      detail: `Decimal odds must be finite and > 1.0 (got ${sel.home}/${sel.draw}/${sel.away}).`,
    });
  }

  const observedMs = parseMs(observation.observedAt);
  if (isNaN(observedMs)) {
    issues.push({ reason: 'MISSING_TIMESTAMP', detail: 'Odds observation has no valid observedAt timestamp.' });
  } else if (observedMs > now.getTime() + 60_000) {
    issues.push({ reason: 'MISSING_TIMESTAMP', detail: 'Observation timestamp is in the future.' });
  } else if (now.getTime() - observedMs > maxAgeMs) {
    const ageH = ((now.getTime() - observedMs) / 3_600_000).toFixed(1);
    issues.push({ reason: 'EXPIRED_OBSERVATION', detail: `Observation is ${ageH}h old (max ${(maxAgeMs / 3_600_000).toFixed(0)}h).` });
  }

  if (options.existing && options.existing.length > 0) {
    const key = oddsObservationKey(observation as OddsObservation);
    if (options.existing.some((e) => oddsObservationKey(e) === key)) {
      issues.push({ reason: 'DUPLICATE_OBSERVATION', detail: `Duplicate observation for ${key}.` });
    }
  }

  return issues;
}

export interface ValidatedOdds {
  observation: OddsObservation;
  valid: boolean;
  issues: OddsValidationIssue[];
}

/** Validates a batch and returns each observation with its issues (no observation is dropped). */
export function validateOddsBatch(
  observations: Partial<OddsObservation>[],
  options: OddsValidationOptions = {}
): ValidatedOdds[] {
  const accepted: OddsObservation[] = [];
  return observations.map((o) => {
    const issues = validateOddsObservation(o, { ...options, existing: [...(options.existing ?? []), ...accepted] });
    if (issues.length === 0) accepted.push(o as OddsObservation);
    return { observation: o as OddsObservation, valid: issues.length === 0, issues };
  });
}

/** True when the fixture id on the odds matches the fixture the caller asked about. */
export function matchesFixture(observation: OddsObservation, fixtureId: string): boolean {
  return observation.fixtureId === fixtureId;
}
