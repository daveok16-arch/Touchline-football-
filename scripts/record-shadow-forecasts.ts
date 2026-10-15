/**
 * Project Touchline – Phase Q offline shadow replay harness (RESEARCH ONLY)
 *
 * Exercises the full shadow pipeline (paired capture via the calibration candidate +
 * persistence + settlement) against a fixtures file WITHOUT any network calls. It reuses
 * the untouched `runBacktest` to obtain frozen probabilities, then records a paired shadow
 * forecast per eligible fixture and settles it from the known result.
 *
 * IMPORTANT: a replay over already-examined seasons is an INFRASTRUCTURE SMOKE TEST, not
 * prospective evidence. Do not treat its output as a prospective confirmation. The only
 * legitimate prospective source is fixtures observed after the flags are enabled locally.
 *
 * Gated by `ENABLE_SHADOW_CALIBRATION_RECORDING`; refuses to run when it is not "true".
 *
 * Usage:
 *   ENABLE_SHADOW_CALIBRATION_RECORDING=true npx tsx scripts/record-shadow-forecasts.ts [fixturesDir] [outFile]
 */

import fs from 'fs';
import path from 'path';
import { adaptFootballDataMatchesResponse } from '../src/services/footballDataAdapter';
import { Fixture } from '../src/types/football';
import { runBacktest } from '../src/services/predictionBacktest';
import {
  EMPTY_SHADOW,
  ShadowSnapshot,
  settleShadowForecast,
  shadowCalibrationHistory,
  verifyShadowSnapshot,
  isShadowRecordingEnabled,
} from '../src/services/shadowLedger';
import {
  captureShadowForecast,
  saveShadowSnapshot,
  SHADOW_DEFAULT_PATH,
} from '../src/services/shadowRecording';
import { buildCandidateCalibration, CandidateCalibration, CalibrationFallbackReason } from '../src/services/calibrationCandidate';
import { CAPTURE_TARGET_LEAD_MS } from '../src/services/shadowCapturePolicy';

const CACHE_DIR = process.cwd() + '/.phase3-cache';
const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;
const FORECAST_LEAD_MS = CAPTURE_TARGET_LEAD_MS; // replay captures at the 24h target (primary-eligible)
const SETTLEMENT_DELAY_MS = 24 * 60 * 60 * 1000; // outcome known 24h after kickoff (replay assumption only)

function loadAll(dir: string): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const comp of COMPETITIONS) {
    for (const season of SEASONS) {
      const f = path.join(dir, `${comp}-${season}.json`);
      if (!fs.existsSync(f)) continue;
      fixtures.push(...adaptFootballDataMatchesResponse(JSON.parse(fs.readFileSync(f, 'utf8'))));
    }
  }
  return fixtures;
}

function main(): void {
  if (!isShadowRecordingEnabled()) {
    console.error('Refusing to run: set ENABLE_SHADOW_CALIBRATION_RECORDING=true to enable shadow recording.');
    process.exitCode = 2;
    return;
  }
  const dir = process.argv[2] || CACHE_DIR;
  const outFile = process.argv[3] || SHADOW_DEFAULT_PATH;

  const fixtures = loadAll(dir);
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  console.log(`Loaded ${fixtures.length} fixtures from ${dir}`);
  const { records } = runBacktest(fixtures, { minHistory: 3 });
  const eligible = records
    .filter((r) => r.eligible && r.outcome != null && r.model && Number.isFinite(r.kickoffMs))
    .sort((a, b) => a.kickoffMs - b.kickoffMs || a.fixtureId.localeCompare(b.fixtureId));
  console.log(`Eligible fixtures to replay: ${eligible.length}`);

  let snapshot: ShadowSnapshot = EMPTY_SHADOW;
  let recorded = 0;
  let settled = 0;
  let fallbacks = 0;
  let active = 0;

  // Refit the calibrator once per calendar month from strictly-prior settled outcomes.
  const monthKey = (ms: number) => {
    const d = new Date(ms);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  const monthStart = (mk: number) => Date.UTC(Math.floor(mk / 12), mk % 12, 1);
  let cachedMonth = -1;
  let cachedCal: { calibration: CandidateCalibration | null; fallbackReason?: CalibrationFallbackReason } = {
    calibration: null,
    fallbackReason: 'INSUFFICIENT_SAMPLES',
  };

  for (const r of eligible) {
    const fx = byId.get(r.fixtureId);
    const generatedMs = r.kickoffMs - FORECAST_LEAD_MS;
    const generatedAt = new Date(generatedMs).toISOString();

    // Refit the calibrator once per calendar month of the FORECAST time (generatedAt), so the
    // fitted window never postdates a forecast's own generation instant.
    const mk = monthKey(generatedMs);
    if (mk !== cachedMonth) {
      cachedMonth = mk;
      const history = shadowCalibrationHistory(snapshot);
      cachedCal = buildCandidateCalibration(history, monthStart(mk));
    }

    const captured = captureShadowForecast(snapshot, {
      fixtureId: r.fixtureId,
      competitionCode: r.competitionCode,
      season: r.season,
      homeTeamId: String(fx?.homeTeam?.id ?? ''),
      awayTeamId: String(fx?.awayTeam?.id ?? ''),
      kickoffTime: new Date(r.kickoffMs).toISOString(),
      currentKickoffTime: new Date(r.kickoffMs).toISOString(),
      generatedAt,
      recordedAt: new Date(r.kickoffMs - FORECAST_LEAD_MS + 1000).toISOString(),
      frozen: r.model!,
      history: [],
      calibration: cachedCal,
      source: { provider: 'phase3-cache' },
      mode: 'replay',
    });
    if (!captured.ok) continue;
    snapshot = captured.snapshot;
    recorded++;
    if (captured.forecast.calibration.fallback) fallbacks++;
    else active++;

    const knownMs = r.kickoffMs + SETTLEMENT_DELAY_MS;
    const s = settleShadowForecast(snapshot, {
      fixtureId: r.fixtureId,
      homeGoals: r.outcome === 0 ? 2 : r.outcome === 1 ? 1 : 0,
      awayGoals: r.outcome === 0 ? 0 : r.outcome === 1 ? 1 : 2,
      resultSource: 'phase3-cache',
      resultRetrievedAt: new Date(knownMs + 60000).toISOString(),
      outcomeKnownAtMs: new Date(knownMs).toISOString(),
      recordedAt: new Date(knownMs + 61000).toISOString(),
      mode: 'replay',
    });
    if (s.ok) {
      snapshot = s.snapshot;
      settled++;
    }
  }

  const v = verifyShadowSnapshot(snapshot);
  console.log(`Replayed: recorded=${recorded} settled=${settled} activeCalibration=${active} fallbacks=${fallbacks}`);
  console.log(`Invariants: ${v.ok ? 'OK' : 'PROBLEMS: ' + v.problems.slice(0, 5).join('; ')}`);
  const save = saveShadowSnapshot(snapshot, outFile);
  console.log(`Persisted to ${save.path}: ${save.ok ? 'ok' : 'FAILED ' + save.error}`);
  console.log('NOTE: this is an infrastructure replay, NOT prospective evidence.');
}

main();
