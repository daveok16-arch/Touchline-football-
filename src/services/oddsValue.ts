/**
 * Project Touchline – Odds Value Analysis
 *
 * Pure, deterministic maths comparing the FROZEN model's 1X2 probabilities with a
 * bookmaker's decimal prices. Market probability, model probability, their difference
 * and expected return are kept as strictly separate fields. Nothing here places a bet,
 * recommends a wager, or claims profit: expected return is a mathematical expectation
 * under the model's own (imperfect) probabilities, not a realised or guaranteed return.
 *
 * De-vig method: proportional (multiplicative) normalisation — the documented method
 * used here. Each raw implied probability is divided by the booksum (1 + overround) so
 * the three de-vigged probabilities sum to 1. This is simple and auditable; it does not
 * remove the favourite–longshot bias the way a power/Shin method would, which is noted
 * as a limitation.
 */

import { ProbabilityTriplet } from './predictionMetrics';
import { OddsObservation } from './oddsSchema';

export const DEVIG_METHOD = 'proportional';

export interface ImpliedProbabilities {
  home: number;
  draw: number;
  away: number;
}

export interface Overround {
  /** Sum of the three raw implied probabilities (1/odds). */
  booksum: number;
  /** booksum - 1; the bookmaker margin. Zero or negative would be anomalous. */
  overround: number;
}

/** Raw implied probability for a single decimal price: 1/odds. */
export function impliedProbability(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 0) return NaN;
  return 1 / decimalOdds;
}

export function impliedProbabilities(odds: { home: number; draw: number; away: number }): ImpliedProbabilities {
  return {
    home: impliedProbability(odds.home),
    draw: impliedProbability(odds.draw),
    away: impliedProbability(odds.away),
  };
}

export function overround(odds: { home: number; draw: number; away: number }): Overround {
  const imp = impliedProbabilities(odds);
  const booksum = imp.home + imp.draw + imp.away;
  return { booksum, overround: booksum - 1 };
}

/**
 * De-vigged market estimate via proportional normalisation. Returns null when the
 * booksum is not a usable positive number.
 */
export function devigProportional(odds: { home: number; draw: number; away: number }): ProbabilityTriplet | null {
  const imp = impliedProbabilities(odds);
  const booksum = imp.home + imp.draw + imp.away;
  if (!Number.isFinite(booksum) || booksum <= 0) return null;
  return {
    homeWin: imp.home / booksum,
    draw: imp.draw / booksum,
    awayWin: imp.away / booksum,
  };
}

/** Probability difference in percentage points: (model - market) * 100. */
export function probabilityDifferencePp(model: number, market: number): number {
  return (model - market) * 100;
}

/**
 * Expected return per unit staked at the offered decimal odds, under the model's
 * probability: modelProbability * decimalOdds - 1. A positive value means the model
 * believes the price is generous; it is NOT proof of profit and may simply reflect
 * model miscalibration (see the upper-tail calibration weakness).
 */
export function expectedReturn(modelProbability: number, decimalOdds: number): number {
  return modelProbability * decimalOdds - 1;
}

export interface SelectionValue {
  selection: 'HOME' | 'DRAW' | 'AWAY';
  /** Bookmaker decimal odds as offered. */
  decimalOdds: number;
  /** Raw implied probability (1/odds), including the margin. */
  rawImpliedProbability: number;
  /** De-vigged market probability (proportional method). */
  marketProbability: number;
  /** Frozen-model probability for the same selection. */
  modelProbability: number;
  /** modelProbability - marketProbability, in percentage points. */
  probabilityDifferencePp: number;
  /** modelProbability * decimalOdds - 1. */
  expectedReturn: number;
}

export interface ValueAnalysis {
  fixtureId: string;
  competitionCode: string;
  provider: string;
  bookmaker: string;
  market: string;
  period: 'FULL_TIME';
  observedAt: string;
  openingAt?: string;
  phase: string;
  overround: Overround;
  devigMethod: typeof DEVIG_METHOD;
  selections: SelectionValue[];
  /** Honest framing text; never asserts profit. */
  disclaimer: string;
}

export const VALUE_DISCLAIMER =
  'Expected return is a mathematical expectation under the frozen model\'s own probabilities, not a guaranteed or proven profit. ' +
  'Market probabilities are de-vigged proportionally and may retain a favourite–longshot bias. ' +
  'The model is known to be overconfident in the high-probability tail and weaker on cup competitions such as the Champions League.';

/**
 * Builds a value analysis for one odds observation against the frozen model's 1X2
 * probabilities. The model probabilities are supplied by the caller so this module never
 * reaches into the engine and never changes it.
 */
export function analyzeValue(
  observation: OddsObservation,
  modelProbabilities: ProbabilityTriplet
): ValueAnalysis {
  const odds = observation.selection;
  const devig = devigProportional(odds);
  const over = overround(odds);

  const mk = (
    selection: 'HOME' | 'DRAW' | 'AWAY',
    decimalOdds: number,
    marketProbability: number,
    modelProbability: number
  ): SelectionValue => ({
    selection,
    decimalOdds,
    rawImpliedProbability: impliedProbability(decimalOdds),
    marketProbability,
    modelProbability,
    probabilityDifferencePp: probabilityDifferencePp(modelProbability, marketProbability),
    expectedReturn: expectedReturn(modelProbability, decimalOdds),
  });

  return {
    fixtureId: observation.fixtureId,
    competitionCode: observation.competitionCode,
    provider: observation.provider,
    bookmaker: observation.bookmaker,
    market: observation.market,
    period: observation.period,
    observedAt: observation.observedAt,
    openingAt: observation.openingAt,
    phase: observation.phase,
    overround: over,
    devigMethod: DEVIG_METHOD,
    selections: [
      mk('HOME', odds.home, devig?.homeWin ?? NaN, modelProbabilities.homeWin),
      mk('DRAW', odds.draw, devig?.draw ?? NaN, modelProbabilities.draw),
      mk('AWAY', odds.away, devig?.awayWin ?? NaN, modelProbabilities.awayWin),
    ],
    disclaimer: VALUE_DISCLAIMER,
  };
}
