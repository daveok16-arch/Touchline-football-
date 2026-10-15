/**
 * Project Touchline – Phase S capture policy (RESEARCH ONLY)
 *
 * Preregistered capture window and primary-forecast selection. Pure functions, no I/O.
 *
 * Window: target = kickoff − 24h; tolerance ±2h  =>  [kickoff − 26h, kickoff − 22h].
 * The ±2h tolerance is a PREREGISTERED DESIGN CHOICE, not an empirically optimal value.
 *
 * A forecast's eligibility is judged against the kickoff version known AT CAPTURE TIME.
 * A reschedule creates a new kickoff version; an old capture is never relabelled as
 * eligible for the new version.
 */

/** Target lead time before kickoff (24 hours). */
export const CAPTURE_TARGET_LEAD_MS = 24 * 60 * 60 * 1000;
/** Symmetric tolerance around the target (2 hours). */
export const CAPTURE_TOLERANCE_MS = 2 * 60 * 60 * 1000;

export const CAPTURE_WINDOW_OPEN_LEAD_MS = CAPTURE_TARGET_LEAD_MS + CAPTURE_TOLERANCE_MS; // 26h before kickoff
export const CAPTURE_WINDOW_CLOSE_LEAD_MS = CAPTURE_TARGET_LEAD_MS - CAPTURE_TOLERANCE_MS; // 22h before kickoff

/** Reason codes for captures that are not primary-eligible. */
export type CaptureSkipReason =
  | 'LATE_DISCOVERY'      // first seen after the window closed (kickoff − 22h)
  | 'TOO_EARLY'           // generated before the window opened (kickoff − 26h)
  | 'MISSING_KICKOFF'
  | 'POST_KICKOFF'
  | 'INVALID_TIMESTAMP'
  | 'RESCHEDULED_VERSION' // capture belongs to a superseded kickoff version
  | 'PROVIDER_CONFLICT'   // conflicting provider records for the same id
  | 'NOT_PRIMARY';        // eligible but another in-window capture was selected

export interface CaptureWindow {
  /** Window opens at kickoff − 26h (inclusive). */
  openMs: number;
  /** Target instant, kickoff − 24h. */
  targetMs: number;
  /** Window closes at kickoff − 22h (inclusive). */
  closeMs: number;
}

/** Computes the capture window for a given scheduled kickoff. */
export function captureWindow(kickoffMs: number): CaptureWindow {
  return {
    openMs: kickoffMs - CAPTURE_WINDOW_OPEN_LEAD_MS,
    targetMs: kickoffMs - CAPTURE_TARGET_LEAD_MS,
    closeMs: kickoffMs - CAPTURE_WINDOW_CLOSE_LEAD_MS,
  };
}

/** True when `generatedAtMs` falls within the inclusive capture window for `kickoffMs`. */
export function isWithinCaptureWindow(generatedAtMs: number, kickoffMs: number): boolean {
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(kickoffMs)) return false;
  const w = captureWindow(kickoffMs);
  return generatedAtMs >= w.openMs && generatedAtMs <= w.closeMs;
}

/**
 * Stable kickoff-version key. A reschedule (different scheduled kickoff) yields a new key,
 * so forecasts from the old version can never be attributed to the new one.
 */
export function kickoffVersionKey(fixtureId: string, kickoffMs: number): string {
  return `${fixtureId}@${kickoffMs}`;
}

/** Stable per-capture audit key: fixture + kickoff version + generation instant. */
export function auditCaptureKey(fixtureId: string, kickoffMs: number, generatedAtMs: number): string {
  return `${kickoffVersionKey(fixtureId, kickoffMs)}#${generatedAtMs}`;
}

export interface EligibilityInput {
  generatedAtMs: number;
  /** Scheduled kickoff of the version known at capture time. */
  kickoffMsAtCapture: number;
  /** Scheduled kickoff of the CURRENT (possibly rescheduled) version. */
  kickoffMsCurrent: number;
}

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: CaptureSkipReason };

/**
 * Decides whether a capture is primary-eligible.
 * - A capture made for a superseded kickoff version is audit-only (RESCHEDULED_VERSION).
 * - Otherwise the capture is judged strictly within the window for its own kickoff version.
 */
export function evaluateCaptureEligibility(input: EligibilityInput): Eligibility {
  const { generatedAtMs, kickoffMsAtCapture, kickoffMsCurrent } = input;
  if (!Number.isFinite(kickoffMsAtCapture) || !Number.isFinite(kickoffMsCurrent)) {
    return { eligible: false, reason: 'MISSING_KICKOFF' };
  }
  if (!Number.isFinite(generatedAtMs)) return { eligible: false, reason: 'INVALID_TIMESTAMP' };
  if (kickoffMsAtCapture !== kickoffMsCurrent) return { eligible: false, reason: 'RESCHEDULED_VERSION' };
  if (generatedAtMs >= kickoffMsAtCapture) return { eligible: false, reason: 'POST_KICKOFF' };
  const w = captureWindow(kickoffMsAtCapture);
  if (generatedAtMs < w.openMs) return { eligible: false, reason: 'TOO_EARLY' };
  if (generatedAtMs > w.closeMs) return { eligible: false, reason: 'LATE_DISCOVERY' };
  return { eligible: true };
}

/** Minimal shape needed to select a primary capture (avoids a circular import on the ledger). */
export interface PrimaryCandidate {
  kickoffVersion: string;
  generatedAtMs: number;
  revision: number;
  auditKey: string;
}

/**
 * Deterministic primary selection among a fixture/version's eligible captures:
 *   1. closest to the target instant (|generatedAt − target|),
 *   2. then earliest generation time,
 *   3. then lowest revision,
 *   4. then lexicographically smallest audit key.
 * Returns the selected auditKey, or null when the list is empty.
 */
export function selectPrimaryCaptureKey(
  candidates: PrimaryCandidate[],
  kickoffMs: number
): string | null {
  if (candidates.length === 0) return null;
  const target = captureWindow(kickoffMs).targetMs;
  const sorted = [...candidates].sort((a, b) => {
    const da = Math.abs(a.generatedAtMs - target);
    const db = Math.abs(b.generatedAtMs - target);
    if (da !== db) return da - db;
    if (a.generatedAtMs !== b.generatedAtMs) return a.generatedAtMs - b.generatedAtMs;
    if (a.revision !== b.revision) return a.revision - b.revision;
    return a.auditKey.localeCompare(b.auditKey);
  });
  return sorted[0].auditKey;
}
