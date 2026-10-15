/**
 * Project Touchline – shadow ledger v2 tests (Phase S)
 *
 * Covers ledger semantics under schema v2: stable keys, dedup/idempotency, capture-window
 * eligibility, primary selection, provenance/mode separation, corrections, missing scores,
 * future-timestamp rejection, one-observation-per-fixture calibration history, schema
 * rejection, and persistence round-trips.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProbabilityTriplet, Outcome } from '../src/services/predictionMetrics';
import {
  SHADOW_FLAG_ENV,
  SHADOW_SCHEMA_VERSION,
  EMPTY_SHADOW,
  ShadowSnapshot,
  isShadowRecordingEnabled,
  recordShadowForecast,
  settleShadowForecast,
  currentShadowResult,
  primaryShadowForecast,
  shadowCalibrationHistory,
  snapshotModes,
  verifyShadowSnapshot,
  serializeShadowSnapshot,
  parseShadowSnapshot,
} from '../src/services/shadowLedger';
import {
  captureShadowForecast,
  loadShadowSnapshot,
  saveShadowSnapshot,
  SHADOW_VERSIONS,
} from '../src/services/shadowRecording';
import { CalibrationObservation } from '../src/services/calibrationCandidate';
import { CAPTURE_TARGET_LEAD_MS } from '../src/services/shadowCapturePolicy';
import { FROZEN_MODEL_VERSION } from '../src/services/predictionEngine';

const OFF: Record<string, string | undefined> = {};
const ON: Record<string, string | undefined> = { [SHADOW_FLAG_ENV]: 'true' };

const FROZEN: ProbabilityTriplet = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };
const KICKOFF = '2025-09-01T15:00:00Z';
const KICKOFF_MS = Date.parse(KICKOFF);
const TARGET_ISO = new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS).toISOString();

function input(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: 'fx-1',
    competitionCode: 'PL',
    season: '2025/26',
    homeTeamId: 'H',
    awayTeamId: 'A',
    kickoffTime: KICKOFF,
    generatedAt: TARGET_ISO,
    recordedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 1000).toISOString(),
    frozen: FROZEN,
    candidate: { homeWin: 0.47, draw: 0.31, awayWin: 0.22 },
    calibration: { temperature: 1.4, fallback: false, sampleCount: 900, fittedThroughMs: KICKOFF_MS - 5 * 86400000, minSamples: 500 },
    source: { provider: 'football-data.org' },
    mode: 'prospective' as const,
    ...overrides,
  };
}

function history(n: number): CalibrationObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    probabilities: { homeWin: 0.85, draw: 0.1, awayWin: 0.05 },
    outcome: (i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : 2) as Outcome,
    outcomeKnownAtMs: 1000 + i,
  }));
}

describe('shadow ledger v2 – flags and schema', () => {
  it('recording is OFF unless exactly "true"', () => {
    expect(isShadowRecordingEnabled({})).toBe(false);
    expect(isShadowRecordingEnabled({ [SHADOW_FLAG_ENV]: 'TRUE' })).toBe(false);
    expect(isShadowRecordingEnabled({ [SHADOW_FLAG_ENV]: 'true' })).toBe(true);
  });

  it('EMPTY_SHADOW carries schema v2', () => {
    expect(EMPTY_SHADOW.schemaVersion).toBe(SHADOW_SCHEMA_VERSION);
  });

  it('exposes version identifiers', () => {
    expect(SHADOW_VERSIONS.frozen).toBe(FROZEN_MODEL_VERSION);
    expect(SHADOW_VERSIONS.candidate).toBe('TEMP_SCALE_CANDIDATE_V1');
  });
});

describe('shadow ledger v2 – stable keys and dedup', () => {
  it('assigns kickoffVersion and auditKey and never mutates the input', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input());
    expect(r.ok).toBe(true);
    expect(EMPTY_SHADOW.forecasts.length).toBe(0);
    if (!r.ok) return;
    expect(r.forecast.kickoffVersion).toBe(`fx-1@${KICKOFF_MS}`);
    expect(r.forecast.auditKey).toBe(`fx-1@${KICKOFF_MS}#${Date.parse(TARGET_ISO)}`);
  });

  it('is idempotent: an exact re-append is a DUPLICATE', () => {
    const r1 = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r1.ok) throw new Error('setup');
    const r2 = recordShadowForecast(r1.snapshot, input());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('DUPLICATE');
  });

  it('distinct captures at the same instant are NOT collapsed (different kickoff versions)', () => {
    const r1 = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r1.ok) throw new Error('setup');
    const r2 = recordShadowForecast(r1.snapshot, input({ kickoffTime: '2025-09-02T15:00:00Z', generatedAt: TARGET_ISO, recordedAt: new Date(Date.parse('2025-09-02T15:00:00Z') - CAPTURE_TARGET_LEAD_MS + 1000).toISOString() }));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.snapshot.forecasts.length).toBe(2);
  });
});

describe('shadow ledger v2 – capture-window eligibility and primary selection', () => {
  it('marks an in-window capture eligible and primary', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r.ok) throw new Error('setup');
    expect(r.forecast.eligibility.eligible).toBe(true);
    expect(r.forecast.isPrimary).toBe(true);
  });

  it('marks a too-early capture ineligible (TOO_EARLY) and not primary', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input({ generatedAt: '2025-08-30T00:00:00Z', recordedAt: '2025-08-30T00:00:01Z' }));
    if (!r.ok) throw new Error('setup');
    expect(r.forecast.eligibility).toEqual({ eligible: false, reason: 'TOO_EARLY' });
    expect(r.forecast.isPrimary).toBe(false);
  });

  it('marks a late capture ineligible (LATE_DISCOVERY) and not primary', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input({ generatedAt: '2025-09-01T10:00:00Z', recordedAt: '2025-09-01T10:00:01Z' }));
    if (!r.ok) throw new Error('setup');
    expect(r.forecast.eligibility).toEqual({ eligible: false, reason: 'LATE_DISCOVERY' });
    expect(r.forecast.isPrimary).toBe(false);
  });

  it('selects the eligible capture closest to the target; later captures are audit-only', () => {
    // Capture A: exactly at target (primary). Capture B: 1h later, still in window (audit).
    const a = recordShadowForecast(EMPTY_SHADOW, input());
    if (!a.ok) throw new Error('setup');
    const b = recordShadowForecast(a.snapshot, input({ generatedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 3600000).toISOString(), recordedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 3600001).toISOString() }));
    if (!b.ok) throw new Error('setup');
    expect(b.snapshot.forecasts.length).toBe(2);
    const primaries = b.snapshot.forecasts.filter((f) => f.isPrimary);
    expect(primaries.length).toBe(1);
    expect(primaries[0].auditKey).toBe(a.forecast.auditKey);
    expect(primaryShadowForecast(b.snapshot, 'fx-1')!.auditKey).toBe(a.forecast.auditKey);
  });

  it('a reschedule creates a new version and never relabels the old capture as eligible', () => {
    const newKickoff = '2025-09-08T15:00:00Z';
    const newKickoffMs = Date.parse(newKickoff);
    const oldMs = KICKOFF_MS;
    const r1 = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r1.ok) throw new Error('setup');
    // A second capture for the OLD version, but the current schedule is already the new one.
    const r2 = recordShadowForecast(r1.snapshot, input({
      generatedAt: new Date(oldMs - CAPTURE_TARGET_LEAD_MS + 3600000).toISOString(),
      recordedAt: new Date(oldMs - CAPTURE_TARGET_LEAD_MS + 3600001).toISOString(),
      currentKickoffTime: newKickoff,
    }));
    if (!r2.ok) throw new Error('setup');
    expect(r2.forecast.eligibility).toEqual({ eligible: false, reason: 'RESCHEDULED_VERSION' });
    // The new-version capture becomes primary.
    const r3 = recordShadowForecast(r2.snapshot, input({
      kickoffTime: newKickoff,
      currentKickoffTime: newKickoff,
      generatedAt: new Date(newKickoffMs - CAPTURE_TARGET_LEAD_MS).toISOString(),
      recordedAt: new Date(newKickoffMs - CAPTURE_TARGET_LEAD_MS + 1000).toISOString(),
    }));
    if (!r3.ok) throw new Error('setup');
    const prim = primaryShadowForecast(r3.snapshot, 'fx-1')!;
    expect(prim.kickoffVersionMs).toBe(newKickoffMs);
    expect(prim.eligibility.eligible).toBe(true);
    // No old-version capture is primary.
    const oldOnes = r3.snapshot.forecasts.filter((f) => f.kickoffVersionMs === oldMs);
    expect(oldOnes.length).toBe(2);
    expect(oldOnes.every((f) => !f.isPrimary)).toBe(true);
  });
});

describe('shadow ledger v2 – timestamps and provenance', () => {
  it('rejects a future-dated forecast when a reference clock is supplied', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input({ nowMs: KICKOFF_MS - CAPTURE_TARGET_LEAD_MS - 1000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FUTURE_TIMESTAMP');
  });

  it('records the collection mode on forecasts and results', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input({ mode: 'replay' }));
    if (!r.ok) throw new Error('setup');
    expect(r.forecast.mode).toBe('replay');
    expect(snapshotModes(r.snapshot)).toEqual(['replay']);
  });

  it('rejects invalid identity, probabilities, and generated-after-recorded', () => {
    expect(recordShadowForecast(EMPTY_SHADOW, input({ homeTeamId: '' })).ok).toBe(false);
    expect(recordShadowForecast(EMPTY_SHADOW, input({ frozen: { homeWin: 1.5, draw: 0, awayWin: -0.5 } })).ok).toBe(false);
    expect(recordShadowForecast(EMPTY_SHADOW, input({ generatedAt: '2025-09-01T12:00:00Z', recordedAt: '2025-09-01T11:00:00Z' })).ok).toBe(false);
  });

  it('rejects forecasts recorded at or after kickoff', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input({ recordedAt: KICKOFF }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('POST_KICKOFF');
  });
});

describe('shadow ledger v2 – outcomes, corrections, and mode integrity', () => {
  function settled() {
    const r = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r.ok) throw new Error('setup');
    const s = settleShadowForecast(r.snapshot, { fixtureId: 'fx-1', homeGoals: 2, awayGoals: 1, resultSource: 'fd', resultRetrievedAt: '2025-09-01T17:10:00Z', outcomeKnownAtMs: '2025-09-01T17:00:00Z', recordedAt: '2025-09-01T17:10:01Z', mode: 'prospective' });
    if (!s.ok) throw new Error('setup settle');
    return s;
  }

  it('attaches a verified result', () => {
    const s = settled();
    expect(s.correction).toBe(false);
    expect(currentShadowResult(s.snapshot, 'fx-1')!.outcome).toBe(0);
  });

  it('preserves audit history on correction', () => {
    const s1 = settled();
    const s2 = settleShadowForecast(s1.snapshot, { fixtureId: 'fx-1', homeGoals: 0, awayGoals: 0, resultSource: 'fd', resultRetrievedAt: '2025-09-02T09:00:00Z', outcomeKnownAtMs: '2025-09-02T08:00:00Z', recordedAt: '2025-09-02T09:00:01Z', mode: 'prospective', correctionReason: 'provider corrected score' });
    if (!s2.ok) throw new Error('setup');
    expect(s2.correction).toBe(true);
    expect(s2.result.revisions.length).toBe(2);
    expect(s2.result.revisions[0].outcome).toBe(0);
    expect(s2.result.revisions[1].outcome).toBe(1);
  });

  it('rejects a duplicate attachment and a result known before kickoff', () => {
    const s1 = settled();
    const dup = settleShadowForecast(s1.snapshot, { fixtureId: 'fx-1', homeGoals: 2, awayGoals: 1, resultSource: 'fd', resultRetrievedAt: '2025-09-01T18:00:00Z', outcomeKnownAtMs: '2025-09-01T17:00:00Z', recordedAt: '2025-09-01T18:00:01Z', mode: 'prospective' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe('DUPLICATE');
    const early = settleShadowForecast(s1.snapshot, { fixtureId: 'fx-1', homeGoals: 1, awayGoals: 0, resultSource: 'fd', resultRetrievedAt: '2025-09-01T10:00:00Z', outcomeKnownAtMs: '2025-09-01T10:00:00Z', recordedAt: '2025-09-01T10:00:01Z', mode: 'prospective' });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('INVALID_TIMESTAMP');
  });

  it('rejects a mode mismatch when settling', () => {
    const s1 = settled();
    const mm = settleShadowForecast(s1.snapshot, { fixtureId: 'fx-1', homeGoals: 3, awayGoals: 0, resultSource: 'fd', resultRetrievedAt: '2025-09-02T09:00:00Z', outcomeKnownAtMs: '2025-09-02T08:00:00Z', recordedAt: '2025-09-02T09:00:01Z', mode: 'replay' });
    expect(mm.ok).toBe(false);
    if (!mm.ok) expect(mm.reason).toBe('MODE_MISMATCH');
  });

  it('treats postponed/cancelled fixtures as missing score (no settlement)', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r.ok) throw new Error('setup');
    const s = settleShadowForecast(r.snapshot, { fixtureId: 'fx-1', homeGoals: null, awayGoals: null, resultSource: 'fd', resultRetrievedAt: '2025-09-02T10:00:00Z', outcomeKnownAtMs: '2025-09-02T10:00:00Z', recordedAt: '2025-09-02T10:00:01Z', mode: 'prospective' });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toBe('MISSING_SCORE');
    expect(currentShadowResult(r.snapshot, 'fx-1')).toBeUndefined();
  });
});

describe('shadow ledger v2 – calibration history (primary-only)', () => {
  it('contributes at most one observation per fixture/version', () => {
    const a = recordShadowForecast(EMPTY_SHADOW, input());
    if (!a.ok) throw new Error('setup');
    const b = recordShadowForecast(a.snapshot, input({ generatedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 3600000).toISOString(), recordedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 3600001).toISOString() }));
    if (!b.ok) throw new Error('setup');
    const s = settleShadowForecast(b.snapshot, { fixtureId: 'fx-1', homeGoals: 2, awayGoals: 1, resultSource: 'fd', resultRetrievedAt: '2025-09-01T17:10:00Z', outcomeKnownAtMs: '2025-09-01T17:00:00Z', recordedAt: '2025-09-01T17:10:01Z', mode: 'prospective' });
    if (!s.ok) throw new Error('setup');
    const hist = shadowCalibrationHistory(s.snapshot);
    expect(hist.length).toBe(1);
    expect(hist[0].outcomeKnownAtMs).toBe(Date.parse('2025-09-01T17:00:00Z'));
  });

  it('uses the result-known time and excludes equal timestamps (strictly prior)', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r.ok) throw new Error('setup');
    const s = settleShadowForecast(r.snapshot, { fixtureId: 'fx-1', homeGoals: 2, awayGoals: 1, resultSource: 'fd', resultRetrievedAt: '2025-09-01T17:10:00Z', outcomeKnownAtMs: '2025-09-01T17:00:00Z', recordedAt: '2025-09-01T17:10:01Z', mode: 'prospective' });
    if (!s.ok) throw new Error('setup');
    const hist = shadowCalibrationHistory(s.snapshot);
    // A forecast generated exactly at the result-known time must NOT use it.
    const sameTime = captureShadowForecast(s.snapshot, {
      fixtureId: 'fx-2', competitionCode: 'PL', season: '2025/26', homeTeamId: 'H', awayTeamId: 'A',
      kickoffTime: '2025-09-03T15:00:00Z', generatedAt: '2025-09-01T17:00:00Z', frozen: FROZEN, history: hist,
      source: { provider: 'fd' }, mode: 'prospective', minSamples: 1,
    }, ON);
    expect(sameTime.ok).toBe(true);
    if (sameTime.ok) expect(sameTime.forecast.calibration.fallback).toBe(true);
  });
});

describe('shadow ledger v2 – verification and persistence', () => {
  it('verify flags multiple primaries', () => {
    const a = recordShadowForecast(EMPTY_SHADOW, input());
    if (!a.ok) throw new Error('setup');
    const b = recordShadowForecast(a.snapshot, input({ generatedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 3600000).toISOString(), recordedAt: new Date(KICKOFF_MS - CAPTURE_TARGET_LEAD_MS + 3600001).toISOString() }));
    if (!b.ok) throw new Error('setup');
    const broken: ShadowSnapshot = {
      ...b.snapshot,
      forecasts: b.snapshot.forecasts.map((f) => ({ ...f, isPrimary: true })),
    };
    const v = verifyShadowSnapshot(broken);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes('Multiple primaries'))).toBe(true);
  });

  it('parse rejects a non-v2 schema', () => {
    const v1 = JSON.stringify({ version: 1, forecasts: [], results: [] });
    const parsed = parseShadowSnapshot(v1);
    expect(parsed.error).toContain('INCOMPATIBLE_SCHEMA');
  });

  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowS-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a v2 snapshot through disk', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r.ok) throw new Error('setup');
    const file = path.join(dir, 'shadow.json');
    expect(saveShadowSnapshot(r.snapshot, file).ok).toBe(true);
    const loaded = loadShadowSnapshot(file);
    expect(loaded.diagnostic.ok).toBe(true);
    expect(loaded.snapshot.schemaVersion).toBe(SHADOW_SCHEMA_VERSION);
    expect(loaded.snapshot.forecasts.length).toBe(1);
  });

  it('missing file yields an empty snapshot with ok diagnostic', () => {
    const loaded = loadShadowSnapshot(path.join(dir, 'absent.json'));
    expect(loaded.diagnostic.ok).toBe(true);
    expect(loaded.snapshot.forecasts.length).toBe(0);
  });

  it('malformed file yields empty snapshot with error diagnostic (no throw)', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ not json');
    const loaded = loadShadowSnapshot(file);
    expect(loaded.diagnostic.ok).toBe(false);
    expect(loaded.snapshot.forecasts.length).toBe(0);
  });

  it('serialization is stable', () => {
    const r = recordShadowForecast(EMPTY_SHADOW, input());
    if (!r.ok) throw new Error('setup');
    expect(serializeShadowSnapshot(r.snapshot)).toBe(serializeShadowSnapshot(r.snapshot));
  });
});
