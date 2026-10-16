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

/** Serializable daily-budget state, persisted alongside the collector state. */
export interface BudgetPersisted {
  /** UTC day key (YYYY-MM-DD) the counter belongs to. */
  dayKey: string;
  /** Requests charged on that day. */
  dayCount: number;
  /**
   * Recent per-minute request timestamps (epoch ms), used to rebuild the sliding window after
   * a restart. Optional for backward compatibility (a counter without it restores as empty).
   */
  minuteStamps?: number[];
}

/**
 * Durable sink for the request budget, written after EVERY charged request (write-ahead), so a
 * crash between request accounting and the end-of-tick bundle commit cannot lose usage and let a
 * restart re-burn the ceiling. `load` is consulted at tick start and merged monotonically with
 * the bundle's counter. A separate small atomic file is used because the budget is an
 * independent monotonic counter, not part of the state/snapshot consistency invariant.
 */
export interface BudgetSink {
  /** Durably records the budget. Must return true only when the record is durable. */
  save(budget: BudgetPersisted): boolean;
  load(): BudgetPersisted | null;
}

/**
 * Durably records the collector state + snapshot together. Returns true only when the record is
 * durable; a false return or a thrown error means the commit did not happen.
 */
export interface BundleSink {
  save(state: CollectorState, snapshot: ShadowSnapshot): boolean;
}

/**
 * Sliding-window per-minute limiter plus a hard per-day ceiling. Every request attempt,
 * including retries and error responses, must be charged via `tryConsume`.
 *
 * Both counters are durable: `toPersisted`/`restorePersisted`/`adoptPersisted` round-trip the
 * day counter AND the recent minute window through the collector state, so a process restart
 * cannot reset either limit and immediately re-burn quota.
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

  /**
   * Prunes stamps outside the 60s window, deduplicates, sorts, and caps the retained list to the
   * per-minute limit. Stamps are unique by construction (see `tryConsume`), so dedup only removes
   * genuine cross-source duplicates (bundle vs sink) and never collapses distinct charges.
   */
  private pruneMinuteStamps(nowMs: number): void {
    const inWindow = this.minuteStamps.filter((t) => Number.isFinite(t) && nowMs - t < 60_000);
    let unique = [...new Set(inWindow)].sort((a, b) => a - b);
    if (unique.length > this.config.perMinute) {
      unique = unique.slice(unique.length - this.config.perMinute);
    }
    this.minuteStamps = unique;
  }

  /** Snapshots the durable daily counter and the recent minute window for persistence. */
  toPersisted(nowMs: number): BudgetPersisted {
    const today = this.day(nowMs);
    this.pruneMinuteStamps(nowMs);
    return {
      dayKey: today,
      dayCount: today === this.dayKey ? this.dayCount : 0,
      minuteStamps: [...this.minuteStamps],
    };
  }

  /**
   * Restores a persisted budget. Only a counter from the CURRENT UTC day is adopted; a counter
   * from a previous day (or a missing/corrupt one) starts fresh at zero. The day count is clamped
   * to the configured ceiling and minute stamps are pruned, so a corrupt bundle can never widen
   * the budget.
   */
  restorePersisted(persisted: BudgetPersisted | null | undefined, nowMs: number): void {
    const today = this.day(nowMs);
    this.dayKey = today;
    if (persisted && persisted.dayKey === today && Number.isFinite(persisted.dayCount)) {
      this.dayCount = Math.max(0, Math.min(Math.floor(persisted.dayCount), this.config.perDay));
    } else {
      this.dayCount = 0;
    }
    this.minuteStamps = [];
    if (persisted && Array.isArray(persisted.minuteStamps)) {
      this.minuteStamps = persisted.minuteStamps.filter((t) => Number.isFinite(t));
    }
    this.pruneMinuteStamps(nowMs);
  }

  /**
   * Monotonic adoption of a persisted budget within the same UTC day: the day count is raised to
   * the persisted value when higher (never lowered), and the persisted minute stamps are merged
   * into the in-memory window. This lets a fresh process adopt a restored ceiling/window without
   * clobbering charges already made in-process (e.g. by a shared standings source). Called at the
   * start of each tick so a restart cannot silently forget usage.
   */
  adoptPersisted(persisted: BudgetPersisted | null | undefined, nowMs: number): void {
    const today = this.day(nowMs);
    if (this.dayKey !== today) {
      this.dayKey = today;
      this.dayCount = 0;
    }
    if (persisted && persisted.dayKey === today && Number.isFinite(persisted.dayCount)) {
      const p = Math.max(0, Math.min(Math.floor(persisted.dayCount), this.config.perDay));
      if (p > this.dayCount) this.dayCount = p;
    }
    if (persisted && Array.isArray(persisted.minuteStamps)) {
      this.minuteStamps = [...this.minuteStamps, ...persisted.minuteStamps.filter((t) => Number.isFinite(t))];
    }
    this.pruneMinuteStamps(nowMs);
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
    // Unique by construction so the bundle/sink merge cannot double-count the same charge.
    let stamp = nowMs;
    while (this.minuteStamps.includes(stamp)) stamp += 1;
    this.minuteStamps.push(stamp);
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
  /**
   * Fixture ids permanently quarantined for conflicting provider identity. Once quarantined, an
   * id is never recorded again through any discovery path, so a bad record cannot re-enter
   * capture or settlement. Persisted with the state so the quarantine survives restarts.
   */
  quarantined?: string[];
  /**
   * Fail-closed latch. Set when budget accounting could not be durably recorded (both the
   * write-ahead sink and the atomic bundle failed). While set, the collector issues NO further
   * provider requests and refuses to advance research state until it is explicitly cleared. It is
   * persisted so the halt survives a restart (which would otherwise re-burn the ceiling).
   */
  persistenceFailed?: boolean;
  /**
   * Durable daily request-budget counter. Persisted in the same atomic commit as the rest of
   * the state so a restart cannot reset the per-day ceiling and re-burn provider quota.
   * Optional for backward compatibility (a state without it restores as zero).
   */
  budget?: BudgetPersisted;
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
  /**
   * A pre-built shared budget instance. When supplied, the collector uses THIS counter instead of
   * creating its own, so every request the collector makes is accounted in the same per-minute/
   * per-day window as other consumers (e.g. a standings source). This is what makes the ceiling
   * genuinely shared rather than per-component. The instance is persisted through the sinks.
   */
  budgetInstance?: RequestBudget;
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
  /**
   * Forward-clock tolerance. A forward gap larger than this is treated as a clock anomaly and the
   * tick performs no work (so it cannot roll the budget, skip capture windows, finalize
   * corrections, or settle off a wrong clock). Default 48h, well above the normal tick cadence.
   */
  maxForwardJumpMs?: number;
  /** Max provider requests issued per tick (bounds a burst; default 10). */
  maxRequestsPerTick?: number;
  /** How long after first settlement to keep verifying for provider corrections. */
  correctionVerificationWindowMs?: number;
  /** Min interval between correction-verification polls for a settled fixture. */
  correctionPollIntervalMs?: number;
  /**
   * Durable budget sink written after every charged request (write-ahead). When provided, the
   * collector loads it at tick start and merges it monotonically, so a crash between request
   * accounting and the bundle commit cannot let a restart re-burn the ceiling.
   */
  budgetSink?: BudgetSink;
  /**
   * Durably records the collector state + snapshot. Called at the end of a tick that made a
   * request, so the daily counter and research state are committed together. Returns false (or
   * throws) when the write is not durable. When both this and `budgetSink` fail, the collector
   * latches fail-closed and issues no further requests.
   */
  bundleSink?: BundleSink;
  /**
   * When set, the collector treats the bundle as non-durable from this tick (simulating a bundle
   * write failure without needing a throwing sink). Useful for tests and for callers that detect
   * their own persistence failure.
   */
  bundleWriteFailed?: boolean;
  /**
   * Operator override to clear a persisted `persistenceFailed` latch and resume collection after
   * persistence has been restored. Defaults to false: the latch stays set across restarts.
   */
  resetPersistenceFailure?: boolean;
}

export interface CollectorTickDiagnostic {
  ranAt: number;
  enabled: boolean;
  skipped?: 'DISABLED' | 'CLOCK_JUMP' | 'CLOCK_FORWARD_JUMP' | 'PERSISTENCE_FAILED';
  requestsAttempted: number;
  requestsDenied: number;
  requestsCapped: number;
  /** Requests accounted for but NOT durably recorded (sink and bundle both unavailable). */
  requestsUnpersisted?: number;
  /** True when the tick latched: budget accounting could not be durably recorded. */
  persistenceFailed?: boolean;
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
  private readonly maxForwardJumpMs: number;
  private readonly maxRequestsPerTick: number;
  private readonly correctionVerificationWindowMs: number;
  private readonly correctionPollIntervalMs: number;
  private readonly budgetSink: BudgetSink | undefined;
  private readonly bundleSink: BundleSink | undefined;
  private readonly bundleWriteFailed: boolean;
  private readonly resetPersistenceFailure: boolean;

  constructor(options: CollectorOptions) {
    this.transport = options.transport;
    this.forecasts = options.forecasts;
    this.budget = options.budgetInstance ?? new RequestBudget(options.budget ?? DEFAULT_BUDGET);
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 6 * HOUR;
    this.resultPollIntervalMs = options.resultPollIntervalMs ?? 20 * 60 * 1000;
    this.discoveryHorizonMs = options.discoveryHorizonMs ?? 7 * 24 * HOUR;
    this.backoffSeed = options.backoffSeed ?? 1;
    this.clockJumpToleranceMs = options.clockJumpToleranceMs ?? 5 * 60 * 1000;
    this.maxForwardJumpMs = options.maxForwardJumpMs ?? 48 * HOUR;
    this.maxRequestsPerTick = options.maxRequestsPerTick ?? 10;
    this.correctionVerificationWindowMs = options.correctionVerificationWindowMs ?? 24 * HOUR;
    this.correctionPollIntervalMs = options.correctionPollIntervalMs ?? 3 * HOUR;
    this.budgetSink = options.budgetSink;
    this.bundleSink = options.bundleSink;
    this.bundleWriteFailed = options.bundleWriteFailed ?? false;
    this.resetPersistenceFailure = options.resetPersistenceFailure ?? false;
  }

  /**
   * Charges one request; returns false (with a note) when the budget or tick cap denies it.
   *
   * Fail-closed durability: a request is only authorized when its charge can be recorded durably.
   * The charge is written to the write-ahead sink first; if that write fails the request is
   * refused and the tick latches `persistenceFailed`. When there is no sink, durability defers to
   * the end-of-tick bundle commit, which (if it also cannot be durably recorded) latches the same
   * halt. The latch is persisted so a restart cannot re-burn the ceiling.
   */
  private charge(nowMs: number, diag: CollectorTickDiagnostic): boolean {
    if (this.budgetSink) {
      if (diag.requestsAttempted >= this.maxRequestsPerTick) {
        diag.requestsCapped += 1;
        diag.notes.push('TICK_CAP_REACHED');
        return false;
      }
      // Consume, then write-ahead the counter INCLUDING this charge, before the request.
      const r = this.budget.tryConsume(nowMs);
      if (!r.allowed) {
        diag.requestsDenied += 1;
        diag.notes.push(`BUDGET_DENIED:${r.reason}`);
        return false;
      }
      if (this.sinkSaveOk(this.budget.toPersisted(nowMs))) {
        diag.requestsAttempted += 1;
        return true;
      }
      // The write-ahead failed, so the charge cannot be guaranteed durable before the request.
      // Refuse the request and latch fail-closed (the bundle commit is not write-ahead).
      this.latchPersistenceFailure(diag, 'BUDGET_SINK_WRITE_FAILED');
      return false;
    }
    // No sink: durability defers to the end-of-tick bundle commit.
    if (this.bundleWriteFailed || this.bundleSink) {
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
    // No durable path at all: use the in-memory limiters and proceed (legacy behaviour).
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

  /** Best-effort write-ahead of the durable budget snapshot; returns true only when durable. */
  private sinkSaveOk(budget: BudgetPersisted): boolean {
    if (!this.budgetSink) return false;
    try {
      return this.budgetSink.save(budget) === true;
    } catch {
      return false;
    }
  }

  /** Durably commits state + snapshot when a bundle sink is configured; returns durability. */
  private bundleSaveOk(state: CollectorState, snapshot: ShadowSnapshot): boolean {
    if (this.bundleWriteFailed) return false;
    if (!this.bundleSink) return false;
    try {
      return this.bundleSink.save(state, snapshot) === true;
    } catch {
      return false;
    }
  }

  /** Latches the fail-closed halt and records why. */
  private latchPersistenceFailure(diag: CollectorTickDiagnostic, reason: string): void {
    diag.persistenceFailed = true;
    diag.notes.push(`PERSISTENCE_FAILED:${reason}`);
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

    // Adopt the durable counter before any request. Merge both the bundle's counter and the
    // write-ahead sink (if present) monotonically so a restart cannot forget usage.
    this.budget.adoptPersisted(state.budget, nowMs);
    if (this.budgetSink) {
      try {
        this.budget.adoptPersisted(this.budgetSink.load(), nowMs);
      } catch {
        /* a corrupt sink must not block the tick; the bundle counter still applies */
      }
    }

    // Fail-closed latch: when a previous tick could not durably record budget accounting, issue no
    // requests and do not advance research state. The operator clears it via resetPersistenceFailure
    // once persistence is restored.
    if (state.persistenceFailed && !this.resetPersistenceFailure) {
      diag.skipped = 'PERSISTENCE_FAILED';
      diag.notes.push('PERSISTENCE_FAILED_LATCHED');
      return { state, snapshot, diagnostic: diag };
    }

    // Clock-integrity guard: a significant backward jump stops recording entirely.
    if (state.lastTickMs > 0 && nowMs < state.lastTickMs - this.clockJumpToleranceMs) {
      diag.skipped = 'CLOCK_JUMP';
      diag.notes.push(`CLOCK_JUMP_DETECTED: now=${nowMs} last=${state.lastTickMs}`);
      return { state, snapshot, diagnostic: diag };
    }
    // A large forward jump halts the tick entirely. It could otherwise silently advance the UTC
    // day (resetting the daily budget), skip capture windows, finalize corrections, or fire
    // settlements off wrong timestamps. Halting makes the anomaly a no-op and the explicit
    // skipped reason makes it visible, so the anomaly cannot silently advance research state.
    if (state.lastTickMs > 0 && nowMs > state.lastTickMs + this.maxForwardJumpMs) {
      diag.skipped = 'CLOCK_FORWARD_JUMP';
      diag.notes.push(`CLOCK_FORWARD_JUMP: now=${nowMs} last=${state.lastTickMs} delta=${nowMs - state.lastTickMs}`);
      return { state, snapshot, diagnostic: diag };
    }

    // Copy the pending/observed elements too: the loop below mutates entries in place (captured,
    // lastPolledMs, attempts, settled...), so a shallow array copy would leak those mutations back
    // into the caller's `state`. `runOnce` must not mutate its inputs.
    let nextState: CollectorState = {
      ...state,
      pending: state.pending.map((p) => ({ ...p })),
      observed: state.observed.map((o) => ({ ...o })),
    };
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
    // Persist the durable daily counter so a restart cannot reset the per-day ceiling.
    nextState.budget = this.budget.toPersisted(nowMs);
    diag.budget = this.budget.snapshot(nowMs);

    // Fail-closed durability. Resolve the latch, then commit so the latch is itself persisted.
    //  - `charge()` already set diag.persistenceFailed when the write-ahead sink failed.
    //  - Otherwise durability defers to the end-of-tick bundle commit; if neither the sink nor the
    //    bundle recorded the charge, latch the halt.
    let latch = diag.persistenceFailed === true;
    const durableConfigured = !!this.budgetSink || !!this.bundleSink || this.bundleWriteFailed;
    const sinkRecorded = this.budgetSink && diag.requestsAttempted > 0 ? this.sinkSaveOk(nextState.budget) : false;
    nextState.persistenceFailed = latch ? true : this.resetPersistenceFailure ? false : state.persistenceFailed ?? false;

    let bundleRecorded = false;
    if (durableConfigured && (diag.requestsAttempted > 0 || nextState.persistenceFailed)) {
      bundleRecorded = this.bundleSaveOk(nextState, nextSnapshot);
    }
    if (diag.requestsAttempted > 0 && !nextState.persistenceFailed && durableConfigured && !sinkRecorded && !bundleRecorded) {
      diag.requestsUnpersisted = diag.requestsAttempted;
      this.latchPersistenceFailure(diag, 'NO_DURABLE_STORE');
      nextState.persistenceFailed = true;
      this.bundleSaveOk(nextState, nextSnapshot); // best-effort persistence of the latch
    }
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
    // Record the discovery batch's conflicting ids, then record only clean fixtures.
    const firstById = new Map<string, TransportFixture>();
    const conflicted = new Set<string>();
    for (const f of fixtures) {
      const prev = firstById.get(f.fixtureId);
      if (!prev) {
        firstById.set(f.fixtureId, f);
        continue;
      }
      const teamsDiffer = prev.homeTeamId !== f.homeTeamId || prev.awayTeamId !== f.awayTeamId;
      if (teamsDiffer) {
        conflicted.add(f.fixtureId);
        diag.notes.push(`PROVIDER_CONFLICT:${f.fixtureId}`);
      }
    }
    for (const f of fixtures) {
      const permanently = state.quarantined?.includes(f.fixtureId) ?? false;
      if (conflicted.has(f.fixtureId)) {
        // First conflict: quarantine the id persistently (idempotent across ticks).
        if (!permanently) {
          state.quarantined = [...(state.quarantined ?? []), f.fixtureId];
          diag.notes.push(`QUARANTINED:${f.fixtureId}`);
        }
        continue;
      }
      if (permanently) {
        // Already quarantined: never re-record through any discovery path.
        diag.notes.push(`QUARANTINE_SKIP:${f.fixtureId}`);
        continue;
      }
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
