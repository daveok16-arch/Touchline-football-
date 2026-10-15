/**
 * Project Touchline – Shadow validation ledger (RESEARCH ONLY)
 *
 * Schema v2 (Phase S). A shadow, append-only record of PRE-MATCH forecasts for BOTH the
 * frozen model and the calibration candidate, captured from the same fixture snapshot,
 * plus later outcome attachment. Storage-agnostic and pure: every append returns a NEW
 * immutable snapshot. It NEVER feeds user-facing predictions, the API, or betting logic.
 *
 * v2 changes vs v1:
 *  - Stable keys: `kickoffVersion` (fixture@kickoffMs) and `auditKey` (version#generatedAtMs).
 *  - Explicit `mode` ('replay' | 'prospective'); the evaluator refuses mixed-mode data.
 *  - Capture-window eligibility recorded per capture; primary selected deterministically.
 *  - `shadowCalibrationHistory` is PRIMARY-ONLY (at most one observation per fixture/version).
 *  - Future/invalid timestamps are rejected when a reference clock is supplied.
 *  - Snapshot carries `schemaVersion`; older snapshots are rejected (no silent reinterpretation).
 *
 * Flag: `ENABLE_SHADOW_CALIBRATION_RECORDING`, default OFF (exactly "true" to enable).
 */

import { Outcome, ProbabilityTriplet, outcomeFromScore } from './predictionMetrics';
import { CalibrationFallbackReason, CalibrationObservation } from './calibrationCandidate';
import { FROZEN_MODEL_VERSION } from './predictionEngine';
import { CALIBRATION_CANDIDATE_ID } from './calibrationCandidate';
import {
  CaptureSkipReason,
  evaluateCaptureEligibility,
  kickoffVersionKey,
  auditCaptureKey,
  selectPrimaryCaptureKey,
  PrimaryCandidate,
} from './shadowCapturePolicy';

/** Environment variable that gates shadow recording. Off unless exactly "true". */
export const SHADOW_FLAG_ENV = 'ENABLE_SHADOW_CALIBRATION_RECORDING';

/** Ledger schema version. Snapshots without this exact version are rejected. */
export const SHADOW_SCHEMA_VERSION = 2;

export const SHADOW_MODEL_VERSION = FROZEN_MODEL_VERSION;
export const SHADOW_CANDIDATE_VERSION = CALIBRATION_CANDIDATE_ID;

/** Data provenance: historical replay vs. prospective live observation. */
export type CollectionMode = 'replay' | 'prospective';

/** True only when shadow recording is explicitly enabled. */
export function isShadowRecordingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SHADOW_FLAG_ENV] === 'true';
}

export interface ShadowCalibrationInfo {
  /** Applied temperature (1 means fallback / no scaling). */
  temperature: number;
  fallback: boolean;
  fallbackReason?: CalibrationFallbackReason;
  /** Eligible calibration samples used (0 when fallback). */
  sampleCount: number;
  /** Latest outcomeKnownAtMs among calibration samples (null when none). */
  fittedThroughMs: number | null;
  /** Predeclared minimum sample requirement. */
  minSamples: number;
}

export interface ShadowSourceInfo {
  /** Data source for the fixture snapshot, e.g. 'football-data.org'. */
  provider: string;
  /** Provider-supplied ISO timestamp of the fixture's last update (if known). */
  sourceUpdatedAt?: string;
}

export interface ShadowForecast {
  /** Stable per-capture audit key: `${kickoffVersion}#${generatedAtMs}`. */
  auditKey: string;
  /** Stable kickoff-version key: `${fixtureId}@${kickoffMs}`. */
  kickoffVersion: string;
  fixtureId: string;
  competitionCode: string;
  season: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Provider-scheduled kickoff (UTC ISO). */
  kickoffTime: string;
  kickoffVersionMs: number;
  /** Local clock: when the forecast was generated. */
  generatedAt: string;
  generatedAtMs: number;
  /** Local clock: when the record was persisted. */
  recordedAt: string;
  recordedAtMs: number;
  /** replay | prospective. */
  mode: CollectionMode;
  revision: number;
  /** Capture-window eligibility at capture time. */
  eligibility: { eligible: boolean; reason?: CaptureSkipReason };
  /** True only for the deterministically selected primary of the latest kickoff version. */
  isPrimary: boolean;
  frozen: ProbabilityTriplet;
  candidate: ProbabilityTriplet;
  calibration: ShadowCalibrationInfo;
  models: { frozen: string; candidate: string };
  source: ShadowSourceInfo;
}

export interface ShadowResultRevision {
  homeGoals: number;
  awayGoals: number;
  outcome: Outcome;
  resultSource: string;
  /** Local clock: when this revision was retrieved. */
  resultRetrievedAt: string;
  /** Local clock: first trusted observation of the outcome. */
  outcomeKnownAtMs: string;
  /** Local clock: when this revision was recorded. */
  recordedAt: string;
  /** Present on corrections (revision > 0). */
  correctionReason?: string;
}

export interface ShadowResult {
  key: string;
  fixtureId: string;
  mode: CollectionMode;
  /** Chronological revisions; [0] is the first observation, later entries are corrections. */
  revisions: ShadowResultRevision[];
}

export interface ShadowSnapshot {
  schemaVersion: number;
  version: number;
  forecasts: ShadowForecast[];
  results: ShadowResult[];
}

export const EMPTY_SHADOW: ShadowSnapshot = Object.freeze({
  schemaVersion: SHADOW_SCHEMA_VERSION,
  version: 0,
  forecasts: [],
  results: [],
}) as ShadowSnapshot;

export interface ShadowForecastInput {
  fixtureId: string;
  competitionCode: string;
  season: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Scheduled kickoff of the version known at capture time. */
  kickoffTime: string;
  /** Optional: current scheduled kickoff if it differs (reschedule detection). */
  currentKickoffTime?: string;
  generatedAt: string;
  recordedAt: string;
  frozen: ProbabilityTriplet;
  candidate: ProbabilityTriplet;
  calibration: ShadowCalibrationInfo;
  source: ShadowSourceInfo;
  mode: CollectionMode;
  /** Reference clock for future-timestamp rejection; when supplied, no stamp may exceed it. */
  nowMs?: number;
}

export type RecordShadowResult =
  | { ok: true; snapshot: ShadowSnapshot; forecast: ShadowForecast }
  | { ok: false; reason: 'DUPLICATE' | 'POST_KICKOFF' | 'INVALID_PROBABILITIES' | 'INVALID_TIMESTAMP' | 'INVALID_IDENTITY' | 'MISSING_GENERATED_AT' | 'FUTURE_TIMESTAMP' };

export type SettleShadowResult =
  | { ok: true; snapshot: ShadowSnapshot; result: ShadowResult; correction: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'DUPLICATE' | 'MISSING_SCORE' | 'INVALID_TIMESTAMP' | 'MODE_MISMATCH' | 'FUTURE_TIMESTAMP' };

function parseMs(iso: string | undefined | null): number {
  if (typeof iso !== 'string') return NaN;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? NaN : ms;
}

function validTriplet(p: ProbabilityTriplet | null | undefined): p is ProbabilityTriplet {
  if (!p) return false;
  return [p.homeWin, p.draw, p.awayWin].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
}

/**
 * Recomputes `isPrimary` for every forecast of a fixture. The "active version" is the
 * fixture's latest kickoff version; the primary is the deterministically selected eligible
 * capture within it (or none). All other captures are demoted. Deterministic and pure.
 */
function recomputePrimary(forecasts: ShadowForecast[], fixtureId: string): ShadowForecast[] {
  const mine = forecasts.filter((f) => f.fixtureId === fixtureId);
  if (mine.length === 0) return forecasts;

  let activeMs = -Infinity;
  for (const f of mine) activeMs = Math.max(activeMs, f.kickoffVersionMs);
  const activeVersion = kickoffVersionKey(fixtureId, activeMs);

  const eligible: PrimaryCandidate[] = mine
    .filter((f) => f.kickoffVersion === activeVersion && f.eligibility.eligible)
    .map((f) => ({ kickoffVersion: f.kickoffVersion, generatedAtMs: f.generatedAtMs, revision: f.revision, auditKey: f.auditKey }));

  const primaryKey = Number.isFinite(activeMs) ? selectPrimaryCaptureKey(eligible, activeMs) : null;

  return forecasts.map((f) =>
    f.fixtureId === fixtureId ? Object.freeze({ ...f, isPrimary: f.auditKey === primaryKey }) : f
  );
}

/**
 * Records a paired (frozen + candidate) pre-match shadow forecast.
 * - Rejects exact duplicates by audit key (idempotent).
 * - Rejects forecasts recorded at or after their kickoff version's kickoff.
 * - Records capture-window eligibility; primary is recomputed deterministically.
 */
export function recordShadowForecast(snapshot: ShadowSnapshot, input: ShadowForecastInput): RecordShadowResult {
  const kickoffMs = parseMs(input.kickoffTime);
  const currentKickoffMs = input.currentKickoffTime !== undefined ? parseMs(input.currentKickoffTime) : kickoffMs;
  const recordedMs = parseMs(input.recordedAt);
  const generatedMs = parseMs(input.generatedAt);
  if (isNaN(kickoffMs) || isNaN(recordedMs)) return { ok: false, reason: 'INVALID_TIMESTAMP' };
  if (isNaN(generatedMs)) return { ok: false, reason: 'MISSING_GENERATED_AT' };
  if (!Number.isFinite(currentKickoffMs)) return { ok: false, reason: 'INVALID_TIMESTAMP' };

  if (!input.fixtureId || !input.homeTeamId || !input.awayTeamId) return { ok: false, reason: 'INVALID_IDENTITY' };
  if (!validTriplet(input.frozen) || !validTriplet(input.candidate)) return { ok: false, reason: 'INVALID_PROBABILITIES' };

  if (input.nowMs !== undefined) {
    if (generatedMs > input.nowMs || recordedMs > input.nowMs) return { ok: false, reason: 'FUTURE_TIMESTAMP' };
  }

  // Pre-match only, and the record must not predate its own generation.
  if (recordedMs >= kickoffMs) return { ok: false, reason: 'POST_KICKOFF' };
  if (generatedMs > recordedMs) return { ok: false, reason: 'INVALID_TIMESTAMP' };

  const version = kickoffVersionKey(input.fixtureId, kickoffMs);
  const auditKey = auditCaptureKey(input.fixtureId, kickoffMs, generatedMs);

  // Idempotent: an exact re-append of the same capture is a no-op duplicate.
  if (snapshot.forecasts.some((f) => f.auditKey === auditKey)) {
    return { ok: false, reason: 'DUPLICATE' };
  }

  const eligibility = evaluateCaptureEligibility({
    generatedAtMs: generatedMs,
    kickoffMsAtCapture: kickoffMs,
    kickoffMsCurrent: currentKickoffMs,
  });

  const revision = snapshot.forecasts.filter((f) => f.kickoffVersion === version).length + 1;

  const entry: ShadowForecast = Object.freeze({
    auditKey,
    kickoffVersion: version,
    fixtureId: input.fixtureId,
    competitionCode: input.competitionCode,
    season: input.season,
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    kickoffTime: input.kickoffTime,
    kickoffVersionMs: kickoffMs,
    generatedAt: input.generatedAt,
    generatedAtMs: generatedMs,
    recordedAt: input.recordedAt,
    recordedAtMs: recordedMs,
    mode: input.mode,
    revision,
    eligibility: eligibility.eligible ? { eligible: true } : { eligible: false, reason: eligibility.reason },
    isPrimary: false, // set by recomputePrimary below
    frozen: Object.freeze({ ...input.frozen }),
    candidate: Object.freeze({ ...input.candidate }),
    calibration: Object.freeze({ ...input.calibration }),
    models: Object.freeze({ frozen: SHADOW_MODEL_VERSION, candidate: SHADOW_CANDIDATE_VERSION }),
    source: Object.freeze({ ...input.source }),
  });

  const withEntry = recomputePrimary([...snapshot.forecasts, entry], input.fixtureId);
  const finalEntry = withEntry.find((f) => f.auditKey === auditKey)!;

  const next: ShadowSnapshot = Object.freeze({
    schemaVersion: SHADOW_SCHEMA_VERSION,
    version: snapshot.version + 1,
    forecasts: Object.freeze(withEntry) as unknown as ShadowForecast[],
    results: snapshot.results,
  });
  return { ok: true, snapshot: next, forecast: finalEntry };
}

export interface ShadowOutcomeInput {
  fixtureId: string;
  homeGoals: number | null | undefined;
  awayGoals: number | null | undefined;
  resultSource: string;
  resultRetrievedAt: string;
  outcomeKnownAtMs: string;
  recordedAt: string;
  mode: CollectionMode;
  correctionReason?: string;
  /** Reference clock for future-timestamp rejection. */
  nowMs?: number;
}

/**
 * Attaches (or corrects) an outcome. Corrections append and never rewrite history.
 * Duplicate identical attachments are rejected. Missing/invalid scores stay unsettled.
 */
export function settleShadowForecast(snapshot: ShadowSnapshot, input: ShadowOutcomeInput): SettleShadowResult {
  const forecast = snapshot.forecasts.find((f) => f.fixtureId === input.fixtureId);
  if (!forecast) return { ok: false, reason: 'NOT_FOUND' };

  const outcome = outcomeFromScore(input.homeGoals, input.awayGoals);
  if (outcome == null) return { ok: false, reason: 'MISSING_SCORE' };

  const kickoffMs = forecast.kickoffVersionMs;
  const knownMs = parseMs(input.outcomeKnownAtMs);
  const retrievedMs = parseMs(input.resultRetrievedAt);
  const recordedMs = parseMs(input.recordedAt);
  if (isNaN(knownMs) || isNaN(retrievedMs) || isNaN(recordedMs)) return { ok: false, reason: 'INVALID_TIMESTAMP' };
  // A result cannot be known before kickoff.
  if (knownMs < kickoffMs) return { ok: false, reason: 'INVALID_TIMESTAMP' };
  if (input.nowMs !== undefined && (knownMs > input.nowMs || retrievedMs > input.nowMs || recordedMs > input.nowMs)) {
    return { ok: false, reason: 'FUTURE_TIMESTAMP' };
  }

  const existing = snapshot.results.find((r) => r.key === input.fixtureId);
  if (existing && existing.mode !== input.mode) return { ok: false, reason: 'MODE_MISMATCH' };

  const revision: ShadowResultRevision = Object.freeze({
    homeGoals: input.homeGoals as number,
    awayGoals: input.awayGoals as number,
    outcome,
    resultSource: input.resultSource,
    resultRetrievedAt: input.resultRetrievedAt,
    outcomeKnownAtMs: input.outcomeKnownAtMs,
    recordedAt: input.recordedAt,
    correctionReason: input.correctionReason,
  });

  if (!existing) {
    const result: ShadowResult = Object.freeze({
      key: input.fixtureId,
      fixtureId: input.fixtureId,
      mode: input.mode,
      revisions: Object.freeze([revision]) as unknown as ShadowResultRevision[],
    });
    const next: ShadowSnapshot = Object.freeze({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      version: snapshot.version + 1,
      forecasts: snapshot.forecasts,
      results: Object.freeze([...snapshot.results, result]) as unknown as ShadowResult[],
    });
    return { ok: true, snapshot: next, result, correction: false };
  }

  const last = existing.revisions[existing.revisions.length - 1];
  const identical =
    last.homeGoals === revision.homeGoals &&
    last.awayGoals === revision.awayGoals &&
    last.outcomeKnownAtMs === revision.outcomeKnownAtMs;
  if (identical) return { ok: false, reason: 'DUPLICATE' };

  const updated: ShadowResult = Object.freeze({
    key: existing.key,
    fixtureId: existing.fixtureId,
    mode: existing.mode,
    revisions: Object.freeze([...existing.revisions, revision]) as unknown as ShadowResultRevision[],
  });
  const results = snapshot.results.map((r) => (r.key === input.fixtureId ? updated : r));
  const next: ShadowSnapshot = Object.freeze({
    schemaVersion: SHADOW_SCHEMA_VERSION,
    version: snapshot.version + 1,
    forecasts: snapshot.forecasts,
    results: Object.freeze(results) as unknown as ShadowResult[],
  });
  return { ok: true, snapshot: next, result: updated, correction: true };
}

/** Current authoritative outcome for a fixture (latest revision), or undefined. */
export function currentShadowResult(snapshot: ShadowSnapshot, fixtureId: string): ShadowResultRevision | undefined {
  const r = snapshot.results.find((x) => x.key === fixtureId);
  return r ? r.revisions[r.revisions.length - 1] : undefined;
}

/** Primary forecast for a fixture (the deterministically selected eligible capture). */
export function primaryShadowForecast(snapshot: ShadowSnapshot, fixtureId: string): ShadowForecast | undefined {
  const candidates = snapshot.forecasts.filter((f) => f.fixtureId === fixtureId && f.isPrimary);
  if (candidates.length === 0) return undefined;
  // Exactly one should exist; pick the highest revision defensively.
  return candidates.reduce((best, f) => (f.revision > best.revision ? f : best));
}

/**
 * Builds calibration observations from SETTLED PRIMARY forecasts: the FROZEN probabilities
 * paired with the authoritative outcome. At most ONE observation per fixture/kickoff version
 * (the primary). `outcomeKnownAtMs` is the result's known time, so the strictly-prior rule
 * applies to when the result became known, not the kickoff.
 */
export function shadowCalibrationHistory(
  snapshot: ShadowSnapshot,
  opts: { mode?: CollectionMode } = {}
): CalibrationObservation[] {
  const seen = new Set<string>();
  const obs: CalibrationObservation[] = [];
  for (const f of snapshot.forecasts) {
    if (!f.isPrimary) continue;
    if (opts.mode && f.mode !== opts.mode) continue;
    const resultRecord = snapshot.results.find((r) => r.key === f.fixtureId);
    if (!resultRecord) continue;
    if (opts.mode && resultRecord.mode !== opts.mode) continue;
    const result = resultRecord.revisions[resultRecord.revisions.length - 1];
    const knownMs = parseMs(result.outcomeKnownAtMs);
    if (isNaN(knownMs)) continue;
    if (seen.has(f.kickoffVersion)) continue;
    seen.add(f.kickoffVersion);
    obs.push({ probabilities: f.frozen, outcome: result.outcome, outcomeKnownAtMs: knownMs });
  }
  return obs;
}

/** Distinct collection modes present in the snapshot (for mixed-mode rejection). */
export function snapshotModes(snapshot: ShadowSnapshot): CollectionMode[] {
  const modes = new Set<CollectionMode>();
  for (const f of snapshot.forecasts) modes.add(f.mode);
  for (const r of snapshot.results) modes.add(r.mode);
  return [...modes].sort();
}

export interface ShadowVerifyResult {
  ok: boolean;
  problems: string[];
}

/** Verifies structural invariants of the shadow snapshot. */
export function verifyShadowSnapshot(snapshot: ShadowSnapshot): ShadowVerifyResult {
  const problems: string[] = [];
  if (snapshot.schemaVersion !== SHADOW_SCHEMA_VERSION) {
    problems.push(`Unexpected schemaVersion: ${snapshot.schemaVersion}`);
  }
  const auditSeen = new Set<string>();
  const primariesPerFixture = new Map<string, number>();
  for (const f of snapshot.forecasts) {
    if (!f.fixtureId) problems.push(`Missing fixtureId for key ${f.auditKey}`);
    if (auditSeen.has(f.auditKey)) problems.push(`Duplicate auditKey: ${f.auditKey}`);
    auditSeen.add(f.auditKey);
    if (!validTriplet(f.frozen) || !validTriplet(f.candidate)) problems.push(`Invalid probabilities: ${f.auditKey}`);
    const recMs = f.recordedAtMs;
    if (!Number.isFinite(recMs) || !Number.isFinite(f.kickoffVersionMs)) problems.push(`Invalid timestamps: ${f.auditKey}`);
    else if (recMs >= f.kickoffVersionMs) problems.push(`Forecast not pre-kickoff: ${f.auditKey}`);
    if (f.calibration.fittedThroughMs != null && f.calibration.fittedThroughMs >= f.generatedAtMs) {
      problems.push(`Calibration window not strictly prior: ${f.auditKey}`);
    }
    if (f.isPrimary) primariesPerFixture.set(f.fixtureId, (primariesPerFixture.get(f.fixtureId) ?? 0) + 1);
  }
  for (const [fixtureId, n] of primariesPerFixture) {
    if (n > 1) problems.push(`Multiple primaries for fixture ${fixtureId}`);
  }
  for (const r of snapshot.results) {
    if (r.revisions.length === 0) problems.push(`Result with no revisions: ${r.key}`);
    for (const rev of r.revisions) {
      const expected = outcomeFromScore(rev.homeGoals, rev.awayGoals);
      if (expected !== rev.outcome) problems.push(`Result outcome mismatch: ${r.key}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------- storage-agnostic serialization ----------

export function serializeShadowSnapshot(snapshot: ShadowSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Parses a snapshot. Only schema v2 is accepted; older/incompatible snapshots are REJECTED
 * with an explicit error (no silent reinterpretation of replay data as prospective).
 */
export function parseShadowSnapshot(text: string): { snapshot: ShadowSnapshot; error?: string } {
  try {
    const parsed = JSON.parse(text) as Partial<ShadowSnapshot>;
    if (!parsed || !Array.isArray(parsed.forecasts) || !Array.isArray(parsed.results)) {
      return { snapshot: EMPTY_SHADOW, error: 'MALFORMED_SNAPSHOT' };
    }
    if (parsed.schemaVersion !== SHADOW_SCHEMA_VERSION) {
      return { snapshot: EMPTY_SHADOW, error: `INCOMPATIBLE_SCHEMA: expected ${SHADOW_SCHEMA_VERSION}, got ${String(parsed.schemaVersion)}` };
    }
    return {
      snapshot: {
        schemaVersion: SHADOW_SCHEMA_VERSION,
        version: parsed.version ?? 0,
        forecasts: parsed.forecasts,
        results: parsed.results,
      },
    };
  } catch (e) {
    return { snapshot: EMPTY_SHADOW, error: `PARSE_ERROR: ${(e as Error).message}` };
  }
}
