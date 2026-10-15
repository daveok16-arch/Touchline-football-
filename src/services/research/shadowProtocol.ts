/**
 * Project Touchline – Phase S preregistered evaluation protocol (RESEARCH ONLY)
 *
 * A canonical, deterministic representation of the prospective evaluation protocol plus a
 * reproducible SHA-256 over its canonical JSON. The hash input contains NO mutable
 * timestamps, random values, or machine-specific paths, so the same protocol always hashes
 * to the same value. Any substantive change yields a different hash and therefore requires
 * a new preregistered collection period.
 *
 * Design choices (window tolerance, sample minimums, thresholds) are DESIGN CHOICES, not
 * statistically validated facts.
 */

import { createHash } from 'crypto';
import {
  CAPTURE_TARGET_LEAD_MS,
  CAPTURE_TOLERANCE_MS,
} from '../shadowCapturePolicy';
import { FROZEN_MODEL_VERSION } from '../predictionEngine';
import { CALIBRATION_CANDIDATE_ID, MIN_CALIBRATION_SAMPLES } from '../calibrationCandidate';
import { SHADOW_SCHEMA_VERSION } from '../shadowLedger';

export const PROTOCOL_ID = 'TOUCHLINE_SHADOW_PROTOCOL_V1';

export interface ShadowProtocol {
  protocolId: string;
  schemaVersion: number;
  /** Capture window, expressed as lead-time offsets (not absolute instants). */
  capture: {
    targetLeadMs: number;
    toleranceMs: number;
    /** Selection rule identifier (deterministic). */
    selection: 'closest_to_target_then_earliest_then_revision_then_auditKey';
    /** A fixture/kickoff version contributes at most one primary forecast. */
    onePrimaryPerVersion: boolean;
  };
  models: {
    frozen: string;
    candidate: string;
    candidateColdStartSamples: number;
    candidateRefitCadence: 'monthly';
    candidateRidge: number;
    candidateGridMin: number;
    candidateGridMax: number;
    candidateGridSteps: number;
  };
  metrics: {
    primary: 'rps';
    secondary: string[];
  };
  bootstrap: {
    seed: number;
    resamples: number;
    blockSize: number;
    sensitivityBlockSizes: number[];
  };
  requirements: {
    minSettledSamples: number;
    preferredSettledSamples: number;
    minElapsedWeeks: number;
    perCompetitionReportThreshold: number;
  };
  stopping: {
    singleAnalysisAtTarget: boolean;
    interimSignificanceChecksAllowed: false;
    correctionsHandledByRescoring: boolean;
  };
  corrections: {
    appendOnly: boolean;
    retuneOnCorrection: false;
  };
  modes: {
    accepted: ['prospective'];
    replayIsEvidence: false;
    mixedModeRejected: boolean;
  };
}

/** The frozen protocol. Changing any value changes the hash. */
export const SHADOW_PROTOCOL: ShadowProtocol = Object.freeze({
  protocolId: PROTOCOL_ID,
  schemaVersion: SHADOW_SCHEMA_VERSION,
  capture: {
    targetLeadMs: CAPTURE_TARGET_LEAD_MS,
    toleranceMs: CAPTURE_TOLERANCE_MS,
    selection: 'closest_to_target_then_earliest_then_revision_then_auditKey',
    onePrimaryPerVersion: true,
  },
  models: {
    frozen: FROZEN_MODEL_VERSION,
    candidate: CALIBRATION_CANDIDATE_ID,
    candidateColdStartSamples: MIN_CALIBRATION_SAMPLES,
    candidateRefitCadence: 'monthly',
    candidateRidge: 5e-4,
    candidateGridMin: 0.5,
    candidateGridMax: 3.0,
    candidateGridSteps: 500,
  },
  metrics: {
    primary: 'rps',
    secondary: ['logLoss', 'brier', 'calibration_ece', 'per_class_calibration'],
  },
  bootstrap: {
    seed: 20261015,
    resamples: 2000,
    blockSize: 20,
    sensitivityBlockSizes: [1, 5, 10, 20, 40, 80],
  },
  requirements: {
    minSettledSamples: 500,
    preferredSettledSamples: 1000,
    minElapsedWeeks: 8,
    perCompetitionReportThreshold: 100,
  },
  stopping: {
    singleAnalysisAtTarget: true,
    interimSignificanceChecksAllowed: false,
    correctionsHandledByRescoring: true,
  },
  corrections: {
    appendOnly: true,
    retuneOnCorrection: false,
  },
  modes: {
    accepted: ['prospective'],
    replayIsEvidence: false,
    mixedModeRejected: true,
  },
}) as ShadowProtocol;

/** Deterministic JSON with object keys sorted recursively (stable across engines). */
export function canonicalize(value: unknown): string {
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) throw new Error('canonicalize: circular reference');
    seen.add(v);
    if (Array.isArray(v)) {
      const arr = v.map(walk);
      seen.delete(v);
      return arr;
    }
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = walk(obj[key]);
    seen.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Reproducible SHA-256 of the canonical protocol JSON. */
export function computeProtocolHash(protocol: ShadowProtocol = SHADOW_PROTOCOL): string {
  return createHash('sha256').update(canonicalize(protocol), 'utf8').digest('hex');
}
