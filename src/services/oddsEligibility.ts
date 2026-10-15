/**
 * Project Touchline – Odds Eligibility and Safeguards
 *
 * Decides whether a value analysis may be shown at all, and produces an honest payload.
 * Default posture is conservative: anything unavailable, stale, incomplete, mismatched,
 * or missing a model probability is ineligible and no analysis is produced.
 *
 * This module never converts model overconfidence into a betting signal and never uses a
 * fixed probability threshold to dress up poorly calibrated probabilities as a pick.
 */

import { OddsObservation, OddsValidationIssue, SUPPORTED_ODDS_MARKET, matchesFixture } from './oddsSchema';
import { analyzeValue, ValueAnalysis, VALUE_DISCLAIMER } from './oddsValue';
import { OddsFetchResult } from './oddsAdapter';
import { ProbabilityTriplet } from './predictionMetrics';

export type IneligibilityReason =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'NO_ODDS'
  | 'INVALID_ODDS'
  | 'STALE_ODDS'
  | 'FIXTURE_MISMATCH'
  | 'MISSING_SELECTION'
  | 'MODEL_PREDICTION_UNAVAILABLE';

export interface OddsEligibility {
  eligible: boolean;
  reasons: IneligibilityReason[];
  detail: string[];
}

export interface OddsAnalysisPayload {
  matchId: string;
  provider: string;
  available: boolean;
  notice: string;
  eligibility: OddsEligibility;
  /** Present only when eligible. */
  analysis?: ValueAnalysis;
  /** Always present: honest framing and known model limitations. */
  caveats: string[];
}

export const ODDS_CAVEATS = [
  'Odds are third-party bookmaker prices; the frozen Poisson model is an independent statistical estimate.',
  'Market probability, model probability, their difference (percentage points) and expected return are separate fields and are never combined into a single "value" claim.',
  'Expected return is an expectation under the model, not a guaranteed or proven profit.',
  'Known limitation: the frozen model is overconfident in the high-probability tail (teams priced near 0.93 win ~0.71 historically).',
  'Known limitation: the model is weakest on cup competitions such as the Champions League, where single-league rating tables are structurally inadequate.',
  'No wager is placed, recommended, or executed by this application.',
];

function validationReasons(issues: OddsValidationIssue[]): IneligibilityReason[] {
  const out = new Set<IneligibilityReason>();
  for (const i of issues) {
    switch (i.reason) {
      case 'INVALID_ODDS':
        out.add('INVALID_ODDS');
        break;
      case 'EXPIRED_OBSERVATION':
        out.add('STALE_ODDS');
        break;
      case 'MISSING_SELECTION':
        out.add('MISSING_SELECTION');
        break;
      case 'MISSING_FIXTURE_ID':
        out.add('FIXTURE_MISMATCH');
        break;
      default:
        out.add('INVALID_ODDS');
    }
  }
  return [...out];
}

export interface BuildOddsPayloadInput {
  matchId: string;
  fetch: OddsFetchResult;
  /** Validated observations (valid flag + issues) for this fixture. */
  validated: Array<{ observation: OddsObservation; valid: boolean; issues: OddsValidationIssue[] }>;
  /** Frozen-model probabilities for this fixture, or null when no prediction exists. */
  modelProbabilities: ProbabilityTriplet | null;
}

/**
 * Builds the honest odds payload. Analysis is produced only when the provider returned
 * usable odds AND the observation passed validation AND a model prediction exists.
 */
export function buildOddsPayload(input: BuildOddsPayloadInput): OddsAnalysisPayload {
  const { matchId, fetch, validated, modelProbabilities } = input;
  const reasons: IneligibilityReason[] = [];
  const detail: string[] = [];

  if (fetch.status === 'not_configured') {
    reasons.push('PROVIDER_NOT_CONFIGURED');
    detail.push(fetch.notice);
  } else if (fetch.status !== 'ok') {
    reasons.push('PROVIDER_UNAVAILABLE');
    detail.push(fetch.notice);
  }

  const usable = validated.filter((v) => v.valid && matchesFixture(v.observation, matchId));
  if (validated.length === 0 && fetch.status === 'ok') {
    reasons.push('NO_ODDS');
    detail.push('Provider returned no odds observations for this fixture.');
  }
  for (const v of validated) {
    if (!matchesFixture(v.observation, matchId)) {
      if (!reasons.includes('FIXTURE_MISMATCH')) reasons.push('FIXTURE_MISMATCH');
      detail.push(`Odds for ${v.observation.fixtureId} do not match requested fixture ${matchId}.`);
    }
  }
  if (validated.length > 0 && usable.length === 0) {
    for (const v of validated) reasons.push(...validationReasons(v.issues));
    for (const v of validated) for (const i of v.issues) detail.push(i.detail);
  }

  if (!modelProbabilities) {
    reasons.push('MODEL_PREDICTION_UNAVAILABLE');
    detail.push('No frozen-model 1X2 probabilities exist for this fixture, so no comparison is possible.');
  }

  const uniqueReasons = [...new Set(reasons)];
  const eligible = uniqueReasons.length === 0 && usable.length > 0 && modelProbabilities !== null;

  // Choose the freshest usable observation deterministically (latest observedAt, then bookmaker).
  let chosen: OddsObservation | undefined;
  if (eligible) {
    chosen = [...usable].sort((a, b) => {
      const ta = new Date(b.observation.observedAt).getTime();
      const tb = new Date(a.observation.observedAt).getTime();
      if (ta !== tb) return ta - tb;
      return a.observation.bookmaker.localeCompare(b.observation.bookmaker);
    })[0].observation;
  }

  const available = fetch.status === 'ok' && usable.length > 0;
  const notice = eligible
    ? `Bookmaker ${chosen!.bookmaker} ${SUPPORTED_ODDS_MARKET} prices observed at ${chosen!.observedAt}. Analysis is a model comparison, not a recommendation.`
    : uniqueReasons.length > 0
    ? fetch.notice !== 'OK'
      ? fetch.notice
      : detail[0] || 'Odds are not eligible for analysis.'
    : 'No eligible odds for analysis.';

  return {
    matchId,
    provider: fetch.provider,
    available,
    notice,
    eligibility: { eligible, reasons: uniqueReasons, detail },
    analysis: eligible && chosen ? analyzeValue(chosen, modelProbabilities) : undefined,
    caveats: ODDS_CAVEATS,
  };
}

export { VALUE_DISCLAIMER };
