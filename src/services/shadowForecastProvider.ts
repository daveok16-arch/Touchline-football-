/**
 * Project Touchline – Phase T2 standings-aware shadow ForecastProvider (RESEARCH ONLY)
 *
 * Supplies the frozen prediction engine's inputs to the shadow collector WITHOUT touching
 * the engine or its production behavior. It:
 *  - Prefetches league standings through an injected `StandingsSource` (budget-charged).
 *  - Builds a minimal `Fixture` from a `TransportFixture` and calls the UNCHANGED
 *    `evaluateMatchIntelligence` to obtain frozen probabilities for eligible fixtures.
 *  - Derives the calibration candidate from strictly-prior settled primary observations.
 *
 * The `ForecastProvider` contract stays synchronous for `frozenProbabilities`: the driver
 * must call `primeStandings(codes, nowMs)` at the start of a tick (network + budget), after
 * which `frozenProbabilities` reads the cache. A cache miss returns null (no forecast).
 *
 * No network I/O lives here; it calls the injected `StandingsSource`.
 */

import { ProbabilityTriplet } from './predictionMetrics';
import { CalibrationObservation, CandidateCalibration, CalibrationFallbackReason, buildCandidateCalibration, MIN_CALIBRATION_SAMPLES } from './calibrationCandidate';
import { CompetitionStandings, Fixture } from '../types/football';
import { evaluateMatchIntelligence } from './predictionEngine';
import { shadowCalibrationHistory, ShadowSnapshot, EMPTY_SHADOW } from './shadowLedger';
import { ForecastProvider, RequestBudget, TransportFixture, TransportResult, DEFAULT_BUDGET } from './shadowCollector';

/** Source of league standings for a competition code. Implementations may hit the app API. */
export interface StandingsSource {
  getStandings(competitionCode: string, nowMs: number): Promise<TransportResult<CompetitionStandings | null>>;
}

export interface StandingsProviderOptions {
  standings: StandingsSource;
  /** Shared request budget; standings fetches are charged here. */
  budget?: RequestBudget;
  /** Snapshot provider for calibration history (prospective mode). */
  snapshot?: () => ShadowSnapshot;
  /** Minimum calibration samples. */
  minSamples?: number;
  /** Standings cache TTL. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  standings: CompetitionStandings | null;
  fetchedAtMs: number;
}

/**
 * A `ForecastProvider` backed by the frozen engine. `primeStandings` must run before
 * `frozenProbabilities` for the relevant competition codes.
 */
export class StandingsForecastProvider implements ForecastProvider {
  private readonly source: StandingsSource;
  private readonly budget: RequestBudget;
  private readonly snapshotFn: () => ShadowSnapshot;
  private readonly minSamples: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private lastAsOfMs = 0;

  constructor(options: StandingsProviderOptions) {
    this.source = options.standings;
    this.budget = options.budget ?? new RequestBudget(DEFAULT_BUDGET);
    this.snapshotFn = options.snapshot ?? (() => EMPTY_SHADOW);
    this.minSamples = options.minSamples ?? MIN_CALIBRATION_SAMPLES;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  }

  /**
   * Fetches and caches standings for each code. Budget-charged; a denial is reported and the
   * code is left uncached (a later tick may retry). Fresh cache entries are reused.
   */
  async primeStandings(
    competitionCodes: string[],
    nowMs: number
  ): Promise<{ fetched: string[]; denied: string[]; errors: string[] }> {
    this.lastAsOfMs = nowMs;
    const fetched: string[] = [];
    const denied: string[] = [];
    const errors: string[] = [];
    const unique = [...new Set(competitionCodes.map((c) => c.toUpperCase()))];
    for (const code of unique) {
      const hit = this.cache.get(code);
      if (hit && nowMs - hit.fetchedAtMs < this.cacheTtlMs) continue;
      if (!this.budget.tryConsume(nowMs).allowed) {
        denied.push(code);
        continue;
      }
      const res = await this.source.getStandings(code, nowMs);
      if (res.ok) {
        this.cache.set(code, { standings: res.data, fetchedAtMs: nowMs });
        fetched.push(code);
      } else {
        errors.push(`${code}:${res.error}`);
      }
    }
    return { fetched, denied, errors };
  }

  /** Cached standings for a code, or undefined when not primed/expired. */
  cachedStandings(competitionCode: string): CompetitionStandings | null | undefined {
    return this.cache.get(competitionCode.toUpperCase())?.standings;
  }

  /**
   * Frozen probabilities via the UNCHANGED engine. Returns null when standings are not
   * cached, the fixture is ineligible (cold start, unsupported competition, unranked team,
   * or elapsed kickoff), or the model cannot compute probabilities.
   */
  frozenProbabilities(fixture: TransportFixture): ProbabilityTriplet | null {
    const code = fixture.competitionCode.toUpperCase();
    const entry = this.cache.get(code);
    if (!entry || !entry.standings) return null;

    const engineFixture = buildEngineFixture(fixture);
    const result = evaluateMatchIntelligence(engineFixture, { [code]: entry.standings }, this.lastAsOfMs);
    if (!result.isEligible || !result.probabilities) return null;
    const p = result.probabilities;
    return { homeWin: p.homeWin, draw: p.draw, awayWin: p.awayWin };
  }

  /** Strictly-prior prospective observations (primary-only). */
  calibrationHistory(asOfMs: number): CalibrationObservation[] {
    return shadowCalibrationHistory(this.snapshotFn(), { mode: 'prospective' }).filter((o) => o.outcomeKnownAtMs < asOfMs);
  }

  /** Precomputed prospective calibrator for `asOfMs`, or null for fallback. */
  calibrationFor(asOfMs: number): {
    temperature: number;
    sampleCount: number;
    fittedThroughMs: number | null;
    fallback: boolean;
    fallbackReason?: CalibrationFallbackReason;
    minSamples: number;
  } | null {
    const history = this.calibrationHistory(asOfMs);
    const built = buildCandidateCalibration(history, asOfMs, { minSamples: this.minSamples });
    if (!built.calibration) return null;
    const c: CandidateCalibration = built.calibration;
    return {
      temperature: c.temperature,
      sampleCount: c.sampleCount,
      fittedThroughMs: Number.isFinite(c.fittedThroughMs) ? c.fittedThroughMs : null,
      fallback: false,
      minSamples: this.minSamples,
    };
  }

  /** Provenance for the fixture snapshot. */
  sourceInfo(fixture: TransportFixture): { provider: string; sourceUpdatedAt?: string } {
    return { provider: 'football-data.org', sourceUpdatedAt: fixture.providerLastUpdated };
  }
}

/** Builds the minimal engine `Fixture` from a transport fixture (identity + kickoff + status). */
export function buildEngineFixture(tf: TransportFixture): Fixture {
  const kickoff = new Date(tf.kickoffTime).toISOString();
  return {
    id: tf.fixtureId,
    utcKickoffTime: kickoff,
    status: 'SCHEDULED',
    competition: {
      id: tf.competitionCode,
      name: tf.competitionCode,
      code: tf.competitionCode.toUpperCase(),
      type: 'LEAGUE',
      country: '',
      season: tf.season,
    },
    homeTeam: { id: tf.homeTeamId, name: tf.homeTeamId, shortName: tf.homeTeamId, tla: '' },
    awayTeam: { id: tf.awayTeamId, name: tf.awayTeamId, shortName: tf.awayTeamId, tla: '' },
  };
}
