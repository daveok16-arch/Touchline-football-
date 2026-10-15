/**
 * Project Touchline – Phase Q shadow recording coordinator (RESEARCH ONLY)
 *
 * Ties together: flag gating, calibration-candidate fitting, paired forecast capture,
 * and storage-agnostic persistence. It NEVER influences user-facing predictions. All
 * entry points return diagnostics instead of throwing, so a shadow failure can never
 * break a normal prediction request.
 *
 * Flag: `ENABLE_SHADOW_CALIBRATION_RECORDING`, default OFF.
 */

import fs from 'fs';
import path from 'path';
import { ProbabilityTriplet } from './predictionMetrics';
import {
  CalibrationObservation,
  CandidateCalibration,
  CalibrationFallbackReason,
  buildCandidateCalibration,
  calibrateTriplet,
  MIN_CALIBRATION_SAMPLES,
  CALIBRATION_CANDIDATE_ID,
} from './calibrationCandidate';
import {
  ShadowSnapshot,
  ShadowForecast,
  ShadowCalibrationInfo,
  ShadowSourceInfo,
  CollectionMode,
  EMPTY_SHADOW,
  RecordShadowResult,
  recordShadowForecast,
  serializeShadowSnapshot,
  parseShadowSnapshot,
  isShadowRecordingEnabled,
} from './shadowLedger';
import { FROZEN_MODEL_VERSION } from './predictionEngine';

/** Default research-only storage location (gitignored). */
export const SHADOW_DEFAULT_PATH = path.resolve(process.cwd(), '.phaseQ-shadow', 'shadow-snapshot.json');

export interface CaptureShadowInput {
  fixtureId: string;
  competitionCode: string;
  season: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Scheduled kickoff of the version known at capture time. */
  kickoffTime: string;
  /** Optional current scheduled kickoff (reschedule detection). */
  currentKickoffTime?: string;
  generatedAt: string;
  frozen: ProbabilityTriplet;
  history: CalibrationObservation[];
  source: ShadowSourceInfo;
  /** Provenance of the capture: 'replay' (offline) or 'prospective' (live). */
  mode: CollectionMode;
  /** Recording instant; defaults to `generatedAt`. */
  recordedAt?: string;
  /** Reference clock for future-timestamp rejection. */
  nowMs?: number;
  /** Minimum calibration samples; defaults to the candidate's 500. */
  minSamples?: number;
  /**
   * Optional precomputed calibrator (or null for fallback). When provided, the fit is
   * skipped and this value is used. Lets callers refit on a cadence (e.g. daily) instead
   * of on every forecast.
   */
  calibration?: { calibration: CandidateCalibration | null; fallbackReason?: CalibrationFallbackReason };
}

export type CaptureShadowResult =
  | { ok: true; snapshot: ShadowSnapshot; forecast: ShadowForecast }
  | { ok: false; reason: string };

/**
 * Builds a paired shadow forecast (frozen + candidate) from one fixture snapshot and
 * appends it. Gated by the shadow flag; returns a diagnostic when disabled or when the
 * append is rejected. Never throws.
 */
export function captureShadowForecast(
  snapshot: ShadowSnapshot,
  input: CaptureShadowInput,
  env: Record<string, string | undefined> = process.env
): CaptureShadowResult {
  try {
    if (!isShadowRecordingEnabled(env)) return { ok: false, reason: 'SHADOW_DISABLED' };

    const minSamples = input.minSamples ?? MIN_CALIBRATION_SAMPLES;
    const built = input.calibration ?? buildCandidateCalibration(input.history, new Date(input.generatedAt).getTime(), { minSamples });

    const candidate = built.calibration
      ? calibrateTriplet(input.frozen, built.calibration)
      : input.frozen;

    const calibration: ShadowCalibrationInfo = built.calibration
      ? {
          temperature: built.calibration.temperature,
          fallback: false,
          sampleCount: built.calibration.sampleCount,
          fittedThroughMs: Number.isFinite(built.calibration.fittedThroughMs) ? built.calibration.fittedThroughMs : null,
          minSamples,
        }
      : {
          temperature: 1,
          fallback: true,
          fallbackReason: built.fallbackReason,
          sampleCount: 0,
          fittedThroughMs: null,
          minSamples,
        };

    const recorded: RecordShadowResult = recordShadowForecast(snapshot, {
      fixtureId: input.fixtureId,
      competitionCode: input.competitionCode,
      season: input.season,
      homeTeamId: input.homeTeamId,
      awayTeamId: input.awayTeamId,
      kickoffTime: input.kickoffTime,
      currentKickoffTime: input.currentKickoffTime,
      generatedAt: input.generatedAt,
      recordedAt: input.recordedAt ?? input.generatedAt,
      frozen: input.frozen,
      candidate,
      calibration,
      source: input.source,
      mode: input.mode,
      nowMs: input.nowMs,
    });
    if (!recorded.ok) return { ok: false, reason: recorded.reason };
    return { ok: true, snapshot: recorded.snapshot, forecast: recorded.forecast };
  } catch (e) {
    // A shadow failure must never propagate to callers.
    return { ok: false, reason: `SHADOW_ERROR: ${(e as Error).message}` };
  }
}

// ---------- persistence (best-effort, never throws) ----------

export interface ShadowPersistenceDiagnostic {
  ok: boolean;
  path: string;
  error?: string;
}

/** Loads a shadow snapshot from disk; returns an empty snapshot with a diagnostic on failure. */
export function loadShadowSnapshot(filePath: string = SHADOW_DEFAULT_PATH): {
  snapshot: ShadowSnapshot;
  diagnostic: ShadowPersistenceDiagnostic;
} {
  try {
    if (!fs.existsSync(filePath)) {
      return { snapshot: EMPTY_SHADOW, diagnostic: { ok: true, path: filePath } };
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = parseShadowSnapshot(text);
    if (parsed.error) return { snapshot: EMPTY_SHADOW, diagnostic: { ok: false, path: filePath, error: parsed.error } };
    return { snapshot: parsed.snapshot, diagnostic: { ok: true, path: filePath } };
  } catch (e) {
    return { snapshot: EMPTY_SHADOW, diagnostic: { ok: false, path: filePath, error: (e as Error).message } };
  }
}

/**
 * Persists a shadow snapshot. Writes to a temp file then renames, so a crash cannot leave a
 * truncated ledger. Returns a diagnostic; never throws.
 */
export function saveShadowSnapshot(
  snapshot: ShadowSnapshot,
  filePath: string = SHADOW_DEFAULT_PATH
): ShadowPersistenceDiagnostic {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, serializeShadowSnapshot(snapshot), 'utf8');
    fs.renameSync(tmp, filePath);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, path: filePath, error: (e as Error).message };
  }
}

/** Convenience for tests/diagnostics: version identifiers used in shadow records. */
export const SHADOW_VERSIONS = Object.freeze({
  frozen: FROZEN_MODEL_VERSION,
  candidate: CALIBRATION_CANDIDATE_ID,
});
