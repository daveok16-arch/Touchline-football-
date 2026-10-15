/**
 * Project Touchline – Phase S prospective shadow collector (RESEARCH ONLY)
 *
 * Orchestrates prospective shadow capture: fixture discovery, capture-window checks,
 * pending-result polling, correction detection, backoff, request budgeting, and durable
 * state. It NEVER influences user-facing predictions, the API, or betting logic, and it is
 * NOT wired into application startup.
 *
 * SAFETY BOUNDARY
 *  - Enablement is a SEPARATE flag, `ENABLE_SHADOW_COLLECTOR`, default OFF. The collector
 *    does nothing unless explicitly enabled.
 *  - This module performs NO network I/O itself: it calls an injected `CollectorTransport`.
 *    A real HTTP transport (calling the app's own /api endpoints) is a LATER, separately
 *    approved step. Tests and the dry run use offline transports only.
 *  - The collector is not imported by server.ts or any view; nothing starts on app boot.
 */

import fs from 'fs';
import path from 'path';
import { ProbabilityTriplet } from './predictionMetrics';
import { CalibrationObservation } from './calibrationCandidate';
import { applyTemperature } from './research/calibration';
import {
  ShadowSnapshot,
  CollectionMode,
  recordShadowForecast,
  settleShadowForecast,
  currentShadowResult,
  primaryShadowForecast,
  ShadowCalibrationInfo,
} from './shadowLedger';
import { isWithinCaptureWindow, captureWindow } from './shadowCapturePolicy';

/** Separate enablement flag for the collector. Default OFF. */
export const SHADOW_COLLECTOR_FLAG_ENV = 'ENABLE_SHADOW_COLLECTOR';

/** True only when the collector flag is exactly "true". */
export function isShadowCollectorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SHADOW_COLLECTOR_FLAG_ENV] === 'true';
}

/** A fixture snapshot as returned by a transport (provider-adapted, minimal fields). */
export interface TransportFixture {
  fixtureId: string;
  competitionCode: string;
  season: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Provider-scheduled kickoff (ISO). */
  kickoffTime: string;
  /** Provider status: only 'FINISHED' is treated as a trustworthy final result. */
  status: string;
  /** Provider lastUpdated (ISO), when available. */
  providerLastUpdated?: string;
  homeGoals?: number | null;
  awayGoals?: number | null;
}

export type TransportError = 'RATE_LIMITED' | 'SERVER_ERROR' | 'NETWORK' | 'NOT_FOUND';
export type TransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TransportError; retryAfterMs?: number };

export interface CollectorTransport {
  /** Upcoming fixtures within the discovery horizon. */
  listFixtures(nowMs: number): Promise<TransportResult<TransportFixture[]>>;
  /** A single fixture by id. */
  getMatch(fixtureId: string, nowMs: number): Promise<TransportResult<TransportFixture>>;
}

/** Provides the frozen probabilities and calibration history for a fixture. */
export interface ForecastProvider {
  /** Frozen (uncalibrated) probabilities for the fixture, or null if not computable. */
  frozenProbabilities(fixture: TransportFixture): ProbabilityTriplet | null;
  /** Calibration observations strictly prior to `asOfMs` (already leakage-filtered). */
  calibrationHistory(asOfMs: number): CalibrationObservation[];
  /** Precomputed calibrator for `asOfMs`, or null for fallback. */
  calibrationFor(asOfMs: number): { temperature: number; sampleCount: number; fittedThroughMs: number | null; fallback: boolean; fallbackReason?: string; minSamples?: number } | null;
  /** Source metadata for provenance. */
  sourceInfo(fixture: TransportFixture): { provider: string; sourceUpdatedAt?: string };
}

// ---------- request budget ----------

export interface BudgetConfig {
  /** Hard per-minute ceiling (provider limit). */
  perMinute: number;
  /** Hard per-day ceiling (collector-imposed). */
  perDay: number;
}

export const DEFAULT_BUDGET: BudgetConfig = Object.freeze({ perMinute: 10, perDay: 500 });

export type BudgetDenial = 'PER_MINUTE' | 'PER_DAY';

/**
 * Sliding-window per-minute limiter plus a hard per-day ceiling. Every request attempt,
 * including retries and error responses, must be charged via `tryConsume`.
 */
export class RequestBudget {
  private readonly config: BudgetConfig;
  private minuteStamps: number[] = [];
  private dayKey = '';
  private dayCount = 0;

  constructor(config: BudgetConfig = DEFAULT_BUDGET) {
    this.config = config;
  }

  private day(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  /** True when a request may be made now; does not consume. */
  canConsume(nowMs: number): { allowed: boolean; reason?: BudgetDenial; retryAfterMs?: number } {
    if (this.day(nowMs) !== this.dayKey) {
      this.dayKey = this.day(nowMs);
      this.dayCount = 0;
    }
    this.minuteStamps = this.minuteStamps.filter((t) => nowMs - t < 60_000);
    if (this.dayCount >= this.config.perDay) return { allowed: false, reason: 'PER_DAY' };
    if (this.minuteStamps.length >= this.config.perMinute) {
      const oldest = this.minuteStamps[0];
      return { allowed: false, reason: 'PER_MINUTE', retryAfterMs: Math.max(1, oldest + 60_000 - nowMs) };
    }
    return { allowed: true };
  }

  /** Attempts to consume one request slot. */
  tryConsume(nowMs: number): { allowed: boolean; reason?: BudgetDenial; retryAfterMs?: number } {
    const check = this.canConsume(nowMs);
    if (!check.allowed) return check;
    this.minuteStamps.push(nowMs);
    this.dayCount += 1;
    return { allowed: true };
  }

  snapshot(nowMs: number): { usedToday: number; perDay: number; usedThisMinute: number; perMinute: number } {
    const inMinute = this.minuteStamps.filter((t) => nowMs - t < 60_000).length;
    return {
      usedToday: this.day(nowMs) === this.dayKey ? this.dayCount : 0,
      perDay: this.config.perDay,
      usedThisMinute: inMinute,
      perMinute: this.config.perMinute,
    };
  }
}

/** Exponential backoff with deterministic jitter, honouring a server Retry-After. */
export function nextBackoffMs(attempt: number, retryAfterMs: number | undefined, seed: number): number {
  const base = Math.min(2 ** Math.max(0, attempt) * 1000, 60_000);
  if (retryAfterMs && retryAfterMs > 0) return Math.max(retryAfterMs, base);
  // Deterministic jitter in [0, base/4) from a simple hash of (seed, attempt).
  let h = (seed ^ (attempt * 2654435761)) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
  const jitter = (h % Math.max(1, Math.floor(base / 4)));
  return base + jitter;
}

// ---------- durable state ----------

export const COLLECTOR_STATE_SCHEMA_VERSION = 1;

/** Default research-only collector state location (gitignored). */
export const SHADOW_COLLECTOR_DEFAULT_PATH = path.resolve(process.cwd(), '.phaseS-collector', 'collector-state.json');

export interface PendingFixture {
  fixtureId: string;
  competitionCode: string;
  season: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffTime: string;
  kickoffVersionMs: number;
  firstSeenMs: number;
  lastPolledMs: number;
  attempts: number;
  captured: boolean;
  settled: boolean;
  /** Set when the fixture was rescheduled to a new kickoff version. */
  superseded?: boolean;
  /** Local clock: when this fixture was first settled (start of correction verification). */
  settledAtMs?: number;
  /** Local clock: when this settled fixture was last re-verified for a correction. */
  lastVerifiedMs?: number;
  /** True once the correction-verification window has elapsed (outcome treated as final). */
  final?: boolean;
}

export interface ObservedResult {
  fixtureId: string;
  homeGoals: number;
  awayGoals: number;
  providerLastUpdated?: string;
  observedAtMs: number;
}

export interface CollectorState {
  schemaVersion: number;
  lastDiscoveryMs: number;
  lastTickMs: number;
  pending: PendingFixture[];
  observed: ObservedResult[];
}

export function emptyCollectorState(): CollectorState {
  return { schemaVersion: COLLECTOR_STATE_SCHEMA_VERSION, lastDiscoveryMs: 0, lastTickMs: 0, pending: [], observed: [] };
}

/**
 * Atomic, recoverable state store: writes main via temp+rename, keeps a `.bak` of the
 * previous good file, and appends a one-line forensic journal entry per commit. On load it
 * prefers the main file and falls back to `.bak` if main is missing or corrupt.
 */
export class CollectorStateStore {
  constructor(private readonly filePath: string) {}

  /** Absolute path of the main state file. */
  get mainPath(): string {
    return this.filePath;
  }

  private get bakPath(): string {
    return `${this.filePath}.bak`;
  }
  private get journalPath(): string {
    return `${this.filePath}.journal`;
  }

  load(): { state: CollectorState; diagnostic: { ok: boolean; source: 'main' | 'bak' | 'empty'; error?: string } } {
    for (const [source, p] of [['main', this.filePath], ['bak', this.bakPath]] as const) {
      if (!fs.existsSync(p)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as CollectorState;
        if (parsed && parsed.schemaVersion === COLLECTOR_STATE_SCHEMA_VERSION && Array.isArray(parsed.pending)) {
          return { state: parsed, diagnostic: { ok: true, source } };
        }
      } catch {
        /* try next source */
      }
    }
    return { state: emptyCollectorState(), diagnostic: { ok: true, source: 'empty' } };
  }

  save(state: CollectorState, journalLine?: string): { ok: boolean; error?: string } {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, this.bakPath);
        } catch {
          /* best effort */
        }
      }
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, this.filePath);
      if (journalLine) {
        fs.appendFileSync(this.journalPath, journalLine + '\n', 'utf8');
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

// ---------- collector ----------

export interface CollectorOptions {
  transport: CollectorTransport;
  forecasts: ForecastProvider;
  budget?: BudgetConfig;
  /** Max gap between discovery polls. */
  discoveryIntervalMs?: number;
  /** Result polling interval per pending fixture. */
  resultPollIntervalMs?: number;
  /** Discovery horizon ahead of now. */
  discoveryHorizonMs?: number;
  /** Deterministic jitter seed for backoff. */
  backoffSeed?: number;
  /** Clock-jump tolerance: a backward jump larger than this stops recording. */
  clockJumpToleranceMs?: number;
  /** Max provider requests issued per tick (bounds a burst; default 10). */
  maxRequestsPerTick?: number;
  /** How long after first settlement to keep verifying for provider corrections. */
  correctionVerificationWindowMs?: number;
  /** Min interval between correction-verification polls for a settled fixture. */
  correctionPollIntervalMs?: number;
}

export interface CollectorTickDiagnostic {
  ranAt: number;
  enabled: boolean;
  skipped?: 'DISABLED' | 'CLOCK_JUMP';
  requestsAttempted: number;
  requestsDenied: number;
  requestsCapped: number;
  captures: number;
  settlements: number;
  corrections: number;
  verifications: number;
  budget: ReturnType<RequestBudget['snapshot']>;
  notes: string[];
}

const HOUR = 60 * 60 * 1000;

/**
 * The collector. Construct explicitly with dependencies; it never self-starts. `runOnce`
 * performs one tick at `nowMs` and returns diagnostics. All provider access goes through
 * the injected transport and is budget-charged.
 */
export class ShadowCollector {
  private readonly transport: CollectorTransport;
  private readonly forecasts: ForecastProvider;
  private readonly budget: RequestBudget;
  private readonly discoveryIntervalMs: number;
  private readonly resultPollIntervalMs: number;
  private readonly discoveryHorizonMs: number;
  private readonly backoffSeed: number;
  private readonly clockJumpToleranceMs: number;
  private readonly maxRequestsPerTick: number;
  private readonly correctionVerificationWindowMs: number;
  private readonly correctionPollIntervalMs: number;

  constructor(options: CollectorOptions) {
    this.transport = options.transport;
    this.forecasts = options.forecasts;
    this.budget = new RequestBudget(options.budget ?? DEFAULT_BUDGET);
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 6 * HOUR;
    this.resultPollIntervalMs = options.resultPollIntervalMs ?? 20 * 60 * 1000;
    this.discoveryHorizonMs = options.discoveryHorizonMs ?? 7 * 24 * HOUR;
    this.backoffSeed = options.backoffSeed ?? 1;
    this.clockJumpToleranceMs = options.clockJumpToleranceMs ?? 5 * 60 * 1000;
    this.maxRequestsPerTick = options.maxRequestsPerTick ?? 10;
    this.correctionVerificationWindowMs = options.correctionVerificationWindowMs ?? 24 * HOUR;
    this.correctionPollIntervalMs = options.correctionPollIntervalMs ?? 3 * HOUR;
  }

  /** Charges one request; returns false (with a note) when the budget or tick cap denies it. */
  private charge(nowMs: number, diag: CollectorTickDiagnostic): boolean {
    if (diag.requestsAttempted >= this.maxRequestsPerTick) {
      diag.requestsCapped += 1;
      diag.notes.push('TICK_CAP_REACHED');
      return false;
    }
    const r = this.budget.tryConsume(nowMs);
    if (!r.allowed) {
      diag.requestsDenied += 1;
      diag.notes.push(`BUDGET_DENIED:${r.reason}`);
      return false;
    }
    diag.requestsAttempted += 1;
    return true;
  }

  /**
   * Performs one collector tick. Does not throw. Requires `enabled` to be true.
   * `snapshot` is the current shadow ledger; a new snapshot is returned when mutated.
   */
  async runOnce(
    nowMs: number,
    state: CollectorState,
    snapshot: ShadowSnapshot,
    enabled: boolean = isShadowCollectorEnabled()
  ): Promise<{ state: CollectorState; snapshot: ShadowSnapshot; diagnostic: CollectorTickDiagnostic }> {
    const diag: CollectorTickDiagnostic = {
      ranAt: nowMs,
      enabled,
      requestsAttempted: 0,
      requestsDenied: 0,
      requestsCapped: 0,
      captures: 0,
      settlements: 0,
      corrections: 0,
      verifications: 0,
      budget: this.budget.snapshot(nowMs),
      notes: [],
    };
    if (!enabled) {
      diag.skipped = 'DISABLED';
      return { state, snapshot, diagnostic: diag };
    }

    // Clock-integrity guard: a significant backward jump stops recording entirely.
    if (state.lastTickMs > 0 && nowMs < state.lastTickMs - this.clockJumpToleranceMs) {
      diag.skipped = 'CLOCK_JUMP';
      diag.notes.push(`CLOCK_JUMP_DETECTED: now=${nowMs} last=${state.lastTickMs}`);
      return { state, snapshot, diagnostic: diag };
    }

    let nextState: CollectorState = { ...state, pending: [...state.pending], observed: [...state.observed] };
    let nextSnapshot = snapshot;

    // 1) Discovery.
    if (nowMs - state.lastDiscoveryMs >= this.discoveryIntervalMs) {
      if (this.charge(nowMs, diag)) {
        const res = await this.transport.listFixtures(nowMs);
        if (res.ok) {
          nextState = this.mergeDiscovered(nextState, res.data, nowMs, diag);
          nextState.lastDiscoveryMs = nowMs;
        } else {
          diag.notes.push(`DISCOVERY_ERROR:${res.error}`);
        }
      }
    }

    // 2) Capture for fixtures inside their window; 3) result polling for past-kickoff fixtures.
    for (const p of nextState.pending) {
      if (p.superseded) continue;
      const kickoffMs = p.kickoffVersionMs;

      if (nowMs < kickoffMs) {
        // Attempt capture once the window has opened (so late discovery is recorded as an
        // audit-only, ineligible capture). Before the window opens, wait.
        const win = captureWindow(kickoffMs);
        if (!p.captured && nowMs >= win.openMs) {
          const fixture: TransportFixture = {
            fixtureId: p.fixtureId, competitionCode: p.competitionCode, season: p.season,
            homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, kickoffTime: p.kickoffTime, status: 'SCHEDULED',
          };
          const frozen = this.forecasts.frozenProbabilities(fixture);
          if (frozen) {
            const cal = this.forecasts.calibrationFor(nowMs);
            const minSamples = cal?.minSamples ?? 0;
            const info: ShadowCalibrationInfo = cal
              ? { temperature: cal.temperature, fallback: cal.fallback, fallbackReason: cal.fallbackReason as never, sampleCount: cal.sampleCount, fittedThroughMs: cal.fittedThroughMs, minSamples }
              : { temperature: 1, fallback: true, sampleCount: 0, fittedThroughMs: null, minSamples };
            const candidate = cal && !cal.fallback
              ? applyTemp(frozen, cal.temperature)
              : frozen;
            const rec = recordShadowForecast(nextSnapshot, {
              fixtureId: p.fixtureId, competitionCode: p.competitionCode, season: p.season,
              homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId,
              kickoffTime: p.kickoffTime, currentKickoffTime: p.kickoffTime,
              generatedAt: new Date(nowMs).toISOString(), recordedAt: new Date(nowMs).toISOString(),
              frozen, candidate, calibration: info,
              source: this.forecasts.sourceInfo(fixture), mode: 'prospective', nowMs,
            });
            if (rec.ok) {
              nextSnapshot = rec.snapshot;
              p.captured = true;
              diag.captures += 1;
            } else {
              diag.notes.push(`CAPTURE_REJECTED:${p.fixtureId}:${rec.reason}`);
            }
          } else {
            diag.notes.push(`NO_FROZEN_PROBABILITIES:${p.fixtureId}`);
          }
        }
        continue;
      }

      // Past kickoff: poll for a final result.
      const prior = nextState.observed.find((o) => o.fixtureId === p.fixtureId);

      // Correction verification: a settled fixture is re-polled (bounded, throttled) to catch
      // provider score corrections. The outcome is treated as final only after the window
      // elapses; later corrections are still appended, but the study treats the first
      // trusted revision as the recorded outcome.
      if (p.settled) {
        if (p.final) continue;
        const settledAt = p.settledAtMs ?? nowMs;
        const elapsed = nowMs - settledAt;
        if (elapsed >= this.correctionVerificationWindowMs) {
          p.final = true;
          diag.notes.push(`FINALIZED:${p.fixtureId}`);
          continue;
        }
        if (nowMs - (p.lastVerifiedMs ?? 0) < this.correctionPollIntervalMs) continue;
        if (!this.charge(nowMs, diag)) continue;
        p.lastVerifiedMs = nowMs;
        const vres = await this.transport.getMatch(p.fixtureId, nowMs);
        diag.verifications += 1;
        if (!vres.ok) {
          diag.notes.push(`VERIFY_ERROR:${p.fixtureId}:${vres.error}`);
          continue;
        }
        const vf = vres.data;
        if (vf.status !== 'FINISHED' || vf.homeGoals == null || vf.awayGoals == null) continue;
        if (prior && prior.homeGoals === vf.homeGoals && prior.awayGoals === vf.awayGoals) {
          // Optionally re-stamp providerLastUpdated without a score change.
          if (vf.providerLastUpdated && vf.providerLastUpdated !== prior.providerLastUpdated) {
            prior.providerLastUpdated = vf.providerLastUpdated;
            diag.notes.push(`LASTUPDATED_ADVANCED:${p.fixtureId}`);
          }
          continue;
        }
        // Score changed: append a correction revision.
        const s = settleShadowForecast(nextSnapshot, {
          fixtureId: p.fixtureId, homeGoals: vf.homeGoals, awayGoals: vf.awayGoals,
          resultSource: this.forecasts.sourceInfo(vf).provider,
          resultRetrievedAt: new Date(nowMs).toISOString(),
          outcomeKnownAtMs: new Date(nowMs).toISOString(),
          recordedAt: new Date(nowMs).toISOString(),
          mode: 'prospective',
          correctionReason: `provider correction (lastUpdated=${vf.providerLastUpdated ?? 'unknown'})`,
          nowMs,
        });
        if (s.ok && s.correction) {
          nextSnapshot = s.snapshot;
          diag.corrections += 1;
          const idx = nextState.observed.findIndex((o) => o.fixtureId === p.fixtureId);
          const obs: ObservedResult = { fixtureId: p.fixtureId, homeGoals: vf.homeGoals, awayGoals: vf.awayGoals, providerLastUpdated: vf.providerLastUpdated, observedAtMs: nowMs };
          if (idx >= 0) nextState.observed[idx] = obs; else nextState.observed.push(obs);
        }
        continue;
      }

      if (nowMs - p.lastPolledMs < this.resultPollIntervalMs) continue;
      if (!this.charge(nowMs, diag)) continue;

      const res = await this.transport.getMatch(p.fixtureId, nowMs);
      p.lastPolledMs = nowMs;
      p.attempts += 1;
      if (!res.ok) {
        diag.notes.push(`RESULT_ERROR:${p.fixtureId}:${res.error}:backoff=${nextBackoffMs(p.attempts, res.retryAfterMs, this.backoffSeed)}`);
        continue;
      }
      const f = res.data;
      if (f.status !== 'FINISHED' || f.homeGoals == null || f.awayGoals == null) {
        diag.notes.push(`NOT_FINISHED:${p.fixtureId}:${f.status}`);
        continue;
      }

      const s = settleShadowForecast(nextSnapshot, {
        fixtureId: p.fixtureId, homeGoals: f.homeGoals, awayGoals: f.awayGoals,
        resultSource: this.forecasts.sourceInfo(f).provider,
        resultRetrievedAt: new Date(nowMs).toISOString(),
        outcomeKnownAtMs: new Date(nowMs).toISOString(),
        recordedAt: new Date(nowMs).toISOString(),
        mode: 'prospective',
        nowMs,
      });
      if (s.ok) {
        nextSnapshot = s.snapshot;
        p.settled = true;
        p.settledAtMs = nowMs;
        p.lastVerifiedMs = nowMs;
        if (s.correction) diag.corrections += 1; else diag.settlements += 1;
        const idx = nextState.observed.findIndex((o) => o.fixtureId === p.fixtureId);
        const obs: ObservedResult = { fixtureId: p.fixtureId, homeGoals: f.homeGoals, awayGoals: f.awayGoals, providerLastUpdated: f.providerLastUpdated, observedAtMs: nowMs };
        if (idx >= 0) nextState.observed[idx] = obs; else nextState.observed.push(obs);
      } else if (s.reason !== 'DUPLICATE') {
        diag.notes.push(`SETTLE_REJECTED:${p.fixtureId}:${s.reason}`);
      }
    }

    nextState.lastTickMs = nowMs;
    diag.budget = this.budget.snapshot(nowMs);
    return { state: nextState, snapshot: nextSnapshot, diagnostic: diag };
  }

  /** Merges discovered fixtures into pending state; reschedules create new versions. */
  private mergeDiscovered(
    state: CollectorState,
    fixtures: TransportFixture[],
    nowMs: number,
    diag: CollectorTickDiagnostic
  ): CollectorState {
    const horizonEnd = nowMs + this.discoveryHorizonMs;
    // Detect conflicting provider records for the same id within this discovery batch.
    const byId = new Map<string, TransportFixture>();
    for (const f of fixtures) {
      const prev = byId.get(f.fixtureId);
      if (!prev) {
        byId.set(f.fixtureId, f);
        continue;
      }
      const kickoffDiffers = new Date(prev.kickoffTime).getTime() !== new Date(f.kickoffTime).getTime();
      const teamsDiffer = prev.homeTeamId !== f.homeTeamId || prev.awayTeamId !== f.awayTeamId;
      if (kickoffDiffers || teamsDiffer) {
        diag.notes.push(`PROVIDER_CONFLICT:${f.fixtureId}`);
      }
    }
    for (const f of fixtures) {
      const kickoffMs = new Date(f.kickoffTime).getTime();
      if (!Number.isFinite(kickoffMs) || kickoffMs < nowMs || kickoffMs > horizonEnd) continue;
      const existing = state.pending.find((p) => p.fixtureId === f.fixtureId && !p.superseded);
      if (!existing) {
        state.pending.push({
          fixtureId: f.fixtureId, competitionCode: f.competitionCode, season: f.season,
          homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId, kickoffTime: f.kickoffTime,
          kickoffVersionMs: kickoffMs, firstSeenMs: nowMs, lastPolledMs: 0, attempts: 0,
          captured: false, settled: false,
        });
      } else if (existing.kickoffVersionMs !== kickoffMs) {
        // Reschedule: supersede the old version; a fresh pending row tracks the new one.
        existing.superseded = true;
        state.pending.push({
          fixtureId: f.fixtureId, competitionCode: f.competitionCode, season: f.season,
          homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId, kickoffTime: f.kickoffTime,
          kickoffVersionMs: kickoffMs, firstSeenMs: nowMs, lastPolledMs: 0, attempts: 0,
          captured: false, settled: false,
        });
        diag.notes.push(`RESCHEDULED:${f.fixtureId}`);
      }
    }
    return state;
  }
}

/** Local temperature application (shared with calibrationCandidate via research/calibration). */
function applyTemp(p: ProbabilityTriplet, t: number): ProbabilityTriplet {
  return applyTemperature(p, t);
}

export const COLLECTOR_DEFAULTS = Object.freeze({
  discoveryIntervalMs: 6 * HOUR,
  resultPollIntervalMs: 20 * 60 * 1000,
  discoveryHorizonMs: 7 * 24 * HOUR,
  budget: DEFAULT_BUDGET,
  maxRequestsPerTick: 10,
  correctionVerificationWindowMs: 24 * HOUR,
  correctionPollIntervalMs: 3 * HOUR,
});

export { captureWindow, isWithinCaptureWindow, currentShadowResult, primaryShadowForecast };
