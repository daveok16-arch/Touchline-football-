/**
 * Project Touchline – Odds Resolution Service
 *
 * Orchestrates a single odds lookup end-to-end, with the safety rules in one place:
 *   1. The Odds API must be explicitly enabled and have a key, otherwise nothing is sent.
 *   2. The competition must have a *verified* sport-key mapping, otherwise nothing is sent.
 *   3. The local monthly budget and the provider-reported quota are checked *before* any
 *      request; when spent, the request is refused (`budget_exhausted`) and not sent.
 *   4. Events are matched to canonical fixtures by normalised club names and kickoff
 *      tolerance. An ambiguous or time-mismatched event is rejected — odds are never
 *      attached to a fixture we are not certain about.
 *   5. 5DollarFootballAPI is never used as an odds source here (its key is invalid and it
 *      is kept disabled).
 *
 * The service is pure with respect to its dependencies (fetch + fixture loader + clock are
 * injected), so the full decision path is unit-testable without network access.
 */

import {
  fetchTheOddsApiOdds,
  adaptTheOddsApiEvent,
  COMPETITION_TO_ODDS_SPORT_KEY,
  OddsFetchResult,
} from './oddsAdapter';
import { OddsObservation } from './oddsSchema';
import { matchEventToFixture, MatchCandidate, DEFAULT_KICKOFF_TOLERANCE_MS } from './oddsFixtureMatch';
import { QuotaSnapshot, refusalReason, recordRequest } from './oddsQuota';

export interface OddsServiceConfig {
  oddsApiKey: string | null | undefined;
  oddsApiEnabled: boolean;
  /** Bookmaker regions; default `uk`. */
  regions?: string;
  /** Local monthly request cap. */
  monthlyBudget: number;
  /** Kickoff tolerance for event→fixture matching. */
  kickoffToleranceMs?: number;
}

export interface OddsServiceDeps {
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Canonical fixtures for the competition, used for event matching. */
  loadCandidates: (competitionCode: string) => Promise<MatchCandidate[]>;
}

export interface OddsServiceResult {
  result: OddsFetchResult;
  /** Updated quota snapshot to persist. */
  quota: QuotaSnapshot;
}

function emptyResult(
  status: OddsFetchResult['status'],
  notice: string,
  provider: OddsFetchResult['provider']
): OddsFetchResult {
  return { status, observations: [], notice, provider };
}

/**
 * Resolves odds for one canonical fixture. Never throws; always returns a classified
 * result plus the updated quota snapshot.
 */
export async function resolveOddsForFixture(
  matchId: string,
  competitionCode: string,
  config: OddsServiceConfig,
  quota: QuotaSnapshot,
  deps: OddsServiceDeps
): Promise<OddsServiceResult> {
  const now = deps.now ?? new Date();
  const provider = 'the-odds-api' as const;

  // (1) Enabled + keyed?
  if (!config.oddsApiEnabled) {
    return {
      result: emptyResult(
        'not_configured',
        'The Odds API is disabled (ENABLE_ODDS_API is not true). No request was sent.',
        provider
      ),
      quota,
    };
  }
  if (!config.oddsApiKey || config.oddsApiKey.trim().length === 0) {
    return {
      result: emptyResult('not_configured', 'ODDS_API_KEY is not configured. No request was sent.', provider),
      quota,
    };
  }

  // (2) Verified sport-key mapping?
  const sportKey = COMPETITION_TO_ODDS_SPORT_KEY[competitionCode];
  if (!sportKey) {
    return {
      result: emptyResult(
        'market_unavailable',
        `No verified The Odds API sport key for competition ${competitionCode}. No request was sent.`,
        provider
      ),
      quota,
    };
  }

  // (3) Budget / quota check BEFORE sending anything.
  const cost = 1; // 1 market (h2h) x 1 region
  const refusal = refusalReason(quota, now, cost);
  if (refusal === 'provider_quota_exhausted') {
    return {
      result: emptyResult('budget_exhausted', 'The provider reports no remaining credits this month. No request was sent.', provider),
      quota,
    };
  }
  if (refusal === 'local_budget_exhausted') {
    return {
      result: emptyResult(
        'budget_exhausted',
        `Local monthly odds budget reached (${quota.monthlyBudget} requests). No request was sent.`,
        provider
      ),
      quota,
    };
  }

  // (4) Load candidates and fetch.
  const candidates = await deps.loadCandidates(competitionCode);
  const fetchResult = await fetchTheOddsApiOdds(config.oddsApiKey, sportKey, competitionCode, {
    now,
    fetchImpl: deps.fetchImpl,
    regions: config.regions,
    costCredits: cost,
    allowRequest: true,
  });

  // Record the request against the budget using the provider's own quota headers.
  const quotaAfter = recordRequest(quota, now, cost, (fetchResult.quota as any) && {
    get: (h: string) =>
      h === 'x-requests-remaining'
        ? fetchResult.quota?.remaining?.toString() ?? null
        : h === 'x-requests-used'
        ? fetchResult.quota?.used?.toString() ?? null
        : h === 'x-requests-last'
        ? fetchResult.quota?.last?.toString() ?? null
        : null,
  });

  if (fetchResult.status !== 'ok') {
    return { result: { ...fetchResult }, quota: quotaAfter };
  }

  // (5) Match events to the requested canonical fixture. Refuse on anything ambiguous.
  const tolerance = config.kickoffToleranceMs ?? DEFAULT_KICKOFF_TOLERANCE_MS;
  const matchesToRequested: any[] = [];
  let sawAmbiguous = false;
  let sawKickoffMismatch = false;
  for (const event of fetchResult.events) {
    const m = matchEventToFixture(
      { homeName: event.home_team, awayName: event.away_team, commenceIso: event.commence_time },
      candidates,
      tolerance
    );
    if (m.status === 'ambiguous') sawAmbiguous = true;
    if (m.status === 'kickoff_mismatch') sawKickoffMismatch = true;
    if (m.status === 'matched' && m.fixtureId === matchId) matchesToRequested.push(event);
  }

  if (matchesToRequested.length === 0) {
    const notice = sawAmbiguous
      ? 'Multiple odds events matched this fixture ambiguously. Odds were not attached.'
      : sawKickoffMismatch
      ? 'An odds event matched the teams but not the kickoff time within tolerance. Odds were not attached.'
      : 'The Odds API returned no event that maps unambiguously to this fixture. Odds were not attached.';
    return { result: emptyResult('fixture_mismatch', notice, provider), quota: quotaAfter };
  }
  if (matchesToRequested.length > 1) {
    return {
      result: emptyResult('fixture_mismatch', 'Multiple odds events matched this fixture. Odds were not attached.', provider),
      quota: quotaAfter,
    };
  }

  const observations: OddsObservation[] = [];
  observations.push(...adaptTheOddsApiEvent(matchesToRequested[0], matchId, competitionCode));

  if (observations.length === 0) {
    return {
      result: emptyResult(
        'market_unavailable',
        'No bookmaker returned a complete home/draw/away 1X2 line for this fixture.',
        provider
      ),
      quota: quotaAfter,
    };
  }

  return {
    result: { status: 'ok', observations, notice: 'OK', provider, quota: fetchResult.quota, costCredits: cost },
    quota: quotaAfter,
  };
}
