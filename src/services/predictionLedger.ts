/**
 * Project Touchline – Prospective Prediction Ledger
 *
 * An append-only record of pre-match forecasts. Guarantees:
 * - A prediction is written with timestamp, fixture identity, model version, kickoff
 *   time and probabilities BEFORE the result is known.
 * - A settlement is attached later WITHOUT mutating the original prediction.
 * - Predictions recorded at or after kickoff are rejected (they are not pre-match forecasts).
 * - Duplicate predictions for the same (fixture, modelVersion) are rejected.
 * - Missing history is never invented: settlement requires an explicit final score.
 *
 * The ledger is intentionally storage-agnostic: it operates on an in-memory snapshot and
 * returns a new immutable snapshot on every append. Persisting the snapshot (file, KV
 * store, database) is the caller's responsibility, and the same pure operations apply.
 */

import { ProbabilityTriplet, Outcome, outcomeFromScore } from './predictionMetrics';

export interface PredictionLedgerEntry {
  /** Stable id: `${modelVersion}:${fixtureId}`. */
  id: string;
  fixtureId: string;
  competitionCode: string;
  season: string;
  modelVersion: string;
  /** ISO timestamp of when the prediction was recorded (before kickoff). */
  recordedAt: string;
  /** ISO kickoff time the prediction was made for. */
  kickoffTime: string;
  probabilities: ProbabilityTriplet;
  /** Settlement is attached later and never overwrites the fields above. */
  settlement?: PredictionSettlement;
}

export interface PredictionSettlement {
  settledAt: string;
  homeGoals: number;
  awayGoals: number;
  outcome: Outcome;
  /** Log loss and Brier for the frozen probabilities against this outcome. */
  logLoss: number;
  brier: number;
}

export interface LedgerSnapshot {
  version: number;
  entries: PredictionLedgerEntry[];
}

export interface RecordPredictionInput {
  fixtureId: string;
  competitionCode: string;
  season: string;
  modelVersion: string;
  recordedAt: string;
  kickoffTime: string;
  probabilities: ProbabilityTriplet;
}

export type RecordPredictionResult =
  | { ok: true; snapshot: LedgerSnapshot; entry: PredictionLedgerEntry }
  | { ok: false; reason: 'DUPLICATE' | 'POST_KICKOFF' | 'INVALID_PROBABILITIES' | 'INVALID_TIMESTAMP' };

export const EMPTY_LEDGER: LedgerSnapshot = Object.freeze({ version: 0, entries: [] }) as LedgerSnapshot;

function makeId(modelVersion: string, fixtureId: string): string {
  return `${modelVersion}:${fixtureId}`;
}

function validTriplet(p: ProbabilityTriplet): boolean {
  if (!p) return false;
  return [p.homeWin, p.draw, p.awayWin].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
}

function parseMs(iso: string): number {
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? NaN : ms;
}

/**
 * Appends a pre-match prediction. Rejects duplicates and any prediction recorded at or
 * after kickoff. Returns a NEW frozen snapshot; the input snapshot is never mutated.
 */
export function recordPrediction(
  snapshot: LedgerSnapshot,
  input: RecordPredictionInput
): RecordPredictionResult {
  const recordedMs = parseMs(input.recordedAt);
  const kickoffMs = parseMs(input.kickoffTime);
  if (isNaN(recordedMs) || isNaN(kickoffMs)) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }
  if (!validTriplet(input.probabilities)) {
    return { ok: false, reason: 'INVALID_PROBABILITIES' };
  }

  const id = makeId(input.modelVersion, input.fixtureId);
  if (snapshot.entries.some((e) => e.id === id)) {
    return { ok: false, reason: 'DUPLICATE' };
  }

  // A prediction must be made strictly before kickoff to be a pre-match forecast.
  if (recordedMs >= kickoffMs) {
    return { ok: false, reason: 'POST_KICKOFF' };
  }

  const entry: PredictionLedgerEntry = {
    id,
    fixtureId: input.fixtureId,
    competitionCode: input.competitionCode,
    season: input.season,
    modelVersion: input.modelVersion,
    recordedAt: input.recordedAt,
    kickoffTime: input.kickoffTime,
    probabilities: { ...input.probabilities },
  };

  const next: LedgerSnapshot = Object.freeze({
    version: snapshot.version + 1,
    entries: Object.freeze([...snapshot.entries, Object.freeze(entry)]) as unknown as PredictionLedgerEntry[],
  });
  return { ok: true, snapshot: next, entry };
}

export type SettleResult =
  | { ok: true; snapshot: LedgerSnapshot; entry: PredictionLedgerEntry }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_SETTLED' | 'MISSING_SCORE' | 'INVALID_TIMESTAMP' };

/**
 * Attaches a settlement to an existing prediction. The original prediction fields
 * (recordedAt, kickoffTime, probabilities, modelVersion) are preserved byte-for-byte.
 * The settlement is only accepted once, and only when an explicit final score exists.
 */
export function settlePrediction(
  snapshot: LedgerSnapshot,
  fixtureId: string,
  modelVersion: string,
  homeGoals: number | null | undefined,
  awayGoals: number | null | undefined,
  settledAt: string
): SettleResult {
  const settledMs = parseMs(settledAt);
  if (isNaN(settledMs)) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }

  const id = makeId(modelVersion, fixtureId);
  const index = snapshot.entries.findIndex((e) => e.id === id);
  if (index === -1) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const existing = snapshot.entries[index];
  if (existing.settlement) {
    return { ok: false, reason: 'ALREADY_SETTLED' };
  }

  const outcome = outcomeFromScore(homeGoals, awayGoals);
  if (outcome == null) {
    return { ok: false, reason: 'MISSING_SCORE' };
  }

  // A settlement cannot predate the prediction or kickoff.
  if (settledMs < parseMs(existing.kickoffTime)) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }

  const probs = existing.probabilities;
  const pArr = [probs.homeWin, probs.draw, probs.awayWin];
  const logLoss = -Math.log(Math.max(pArr[outcome], 1e-15));
  let brier = 0;
  for (let k = 0; k < 3; k++) brier += (pArr[k] - (k === outcome ? 1 : 0)) ** 2;

  const settledEntry: PredictionLedgerEntry = Object.freeze({
    ...existing,
    settlement: Object.freeze({
      settledAt,
      homeGoals: homeGoals as number,
      awayGoals: awayGoals as number,
      outcome,
      logLoss,
      brier,
    }),
  });

  const entries = snapshot.entries.slice();
  entries[index] = settledEntry;

  const next: LedgerSnapshot = Object.freeze({
    version: snapshot.version + 1,
    entries: Object.freeze(entries) as unknown as PredictionLedgerEntry[],
  });
  return { ok: true, snapshot: next, entry: settledEntry };
}

/** Reads an entry without exposing mutable internals. */
export function getEntry(
  snapshot: LedgerSnapshot,
  fixtureId: string,
  modelVersion: string
): PredictionLedgerEntry | undefined {
  const id = makeId(modelVersion, fixtureId);
  return snapshot.entries.find((e) => e.id === id);
}

/**
 * Verifies the ledger's core invariants: unique ids, every entry recorded strictly before
 * kickoff, valid probabilities, and settlement only after kickoff with consistent outcome.
 */
export function verifyLedger(snapshot: LedgerSnapshot): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const e of snapshot.entries) {
    if (seen.has(e.id)) problems.push(`Duplicate id: ${e.id}`);
    seen.add(e.id);

    if (!validTriplet(e.probabilities)) problems.push(`Invalid probabilities: ${e.id}`);
    const recMs = parseMs(e.recordedAt);
    const kickMs = parseMs(e.kickoffTime);
    if (isNaN(recMs) || isNaN(kickMs)) problems.push(`Invalid timestamps: ${e.id}`);
    else if (recMs >= kickMs) problems.push(`Prediction not made before kickoff: ${e.id}`);

    if (e.settlement) {
      const sMs = parseMs(e.settlement.settledAt);
      if (!isNaN(sMs) && !isNaN(kickMs) && sMs < kickMs) {
        problems.push(`Settlement predates kickoff: ${e.id}`);
      }
      const expected = outcomeFromScore(e.settlement.homeGoals, e.settlement.awayGoals);
      if (expected !== e.settlement.outcome) {
        problems.push(`Settlement outcome mismatch: ${e.id}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
