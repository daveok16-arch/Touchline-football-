/**
 * Project Touchline – Shadow collector OPERATOR DRIVER (RESEARCH ONLY)
 *
 * The fail-closed wrapper an operator uses to run a bounded shadow tick. It refuses to run
 * BEFORE issuing any provider request unless BOTH durable stores — the write-ahead `BudgetSink`
 * and the `CollectorBundleStore` — are present, initialized, and durably writable. There is no
 * silent fallback to non-durable mode in this driver.
 *
 * It also pins an explicit per-tick request cap for the first observation (<= 3 charged
 * requests). The cap is layered ON TOP of the collector's shared per-minute/per-day budget:
 * every request still passes `RequestBudget.tryConsume`, so the tick cap can never widen the
 * daily or per-minute ceiling.
 *
 * Pure orchestration: no timers, no startup wiring, no flag mutation. Constructed explicitly by
 * an operator script.
 */

import {
  BudgetConfig,
  BudgetPersisted,
  BudgetSink,
  CollectorState,
  CollectorTickDiagnostic,
  CollectorTransport,
  ForecastProvider,
  RequestBudget,
  ShadowCollector,
  isShadowCollectorEnabled,
} from './shadowCollector';
import { CollectorBundle } from './shadowCollectorPersistence';
import { ShadowSnapshot } from './shadowLedger';

/** Hard cap on charged requests per operator tick for the first observation. */
export const OPERATOR_MAX_REQUESTS_PER_TICK = 3;

/**
 * Structural view of the atomic bundle store. `CollectorBundleStore` satisfies it; tests may
 * supply a fake to exercise the guard without touching disk.
 */
export interface BundleStoreLike {
  load(): { bundle: CollectorBundle; diagnostic: { ok: boolean; source: string; error?: string } };
  save(
    state: CollectorState,
    snapshot: ShadowSnapshot,
    journalLine?: string
  ): { ok: boolean; error?: string; commit?: number };
}

export interface DurableStoreCheck {
  ok: boolean;
  reasons: string[];
}

/** Thrown (before any request) when durable storage cannot be verified. */
export class DurableStoreUnavailableError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(
      `Shadow operator driver refused to start: durable storage not verified (${reasons.join('; ')}). ` +
        'No provider request was issued.'
    );
    this.name = 'DurableStoreUnavailableError';
    this.reasons = reasons;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DurableStoreHandles {
  bundleStore?: BundleStoreLike | null;
  budgetSink?: BudgetSink | null;
  /** Budget value to probe the sink with; falls back to the bundle's counter, then today's zero. */
  budget?: BudgetPersisted;
}

/**
 * Verifies both durable stores are present, initialized, and durably writable. The write probes
 * are VALUE-PRESERVING (they rewrite the currently-loaded value), so verification itself cannot
 * lose budget usage or corrupt the bundle. Never throws; returns the reasons on failure.
 */
export function verifyDurableStores(handles: DurableStoreHandles): DurableStoreCheck {
  const reasons: string[] = [];
  const { bundleStore, budgetSink } = handles;

  if (!bundleStore || typeof bundleStore.load !== 'function' || typeof bundleStore.save !== 'function') {
    reasons.push('bundle store missing or malformed');
  }
  if (!budgetSink || typeof budgetSink.save !== 'function') {
    reasons.push('budget sink missing or malformed');
  }
  if (reasons.length > 0) return { ok: false, reasons };

  let state: CollectorState | undefined;
  let snapshot: ShadowSnapshot | undefined;
  try {
    const loaded = bundleStore!.load();
    if (!loaded || !loaded.bundle || loaded.diagnostic?.ok !== true) {
      reasons.push('bundle store load did not return a valid bundle');
    } else {
      state = loaded.bundle.state;
      snapshot = loaded.bundle.snapshot;
    }
  } catch (e) {
    reasons.push(`bundle store load threw: ${msg(e)}`);
  }

  if (state && snapshot) {
    try {
      const r = bundleStore!.save(state, snapshot, 'operator startup durable-store probe');
      if (!r || r.ok !== true) reasons.push(`bundle store write probe failed: ${r?.error ?? 'not durable'}`);
    } catch (e) {
      reasons.push(`bundle store write probe threw: ${msg(e)}`);
    }
  }

  const budgetNow: BudgetPersisted =
    handles.budget ??
    state?.budget ?? { dayKey: new Date().toISOString().slice(0, 10), dayCount: 0, minuteStamps: [] };
  try {
    if (budgetSink!.save(budgetNow) !== true) reasons.push('budget sink write probe returned non-durable');
  } catch (e) {
    reasons.push(`budget sink write probe threw: ${msg(e)}`);
  }

  return { ok: reasons.length === 0, reasons };
}

export interface OperatorObservationDriverOptions {
  transport: CollectorTransport;
  forecasts: ForecastProvider;
  bundleStore?: BundleStoreLike | null;
  budgetSink?: BudgetSink | null;
  budget?: BudgetConfig;
  /**
   * A pre-built budget instance shared with the forecast provider's standings source. When
   * supplied, the provider and the collector charge the SAME counter, so the ceiling is shared.
   */
  budgetInstance?: RequestBudget;
  /** Requested per-tick cap; clamped to [1, OPERATOR_MAX_REQUESTS_PER_TICK]. */
  maxRequestsPerTick?: number;
  now?: () => number;
  clockJumpToleranceMs?: number;
  maxForwardJumpMs?: number;
}

export interface OperatorTickResult {
  state: CollectorState;
  snapshot: ShadowSnapshot;
  diagnostic: CollectorTickDiagnostic;
  check: DurableStoreCheck;
  maxRequestsPerTick: number;
}

export interface OperatorObservationDriver {
  readonly maxRequestsPerTick: number;
  /** The verified durable-store check; throws before any request if either store is unverifiable. */
  requireVerified(): DurableStoreCheck;
  /** A read-only view of the persisted bundle; makes no request. */
  peek(): { state: CollectorState; snapshot: ShadowSnapshot; commit: number } | null;
  /** Verify, then run exactly one bounded tick. Throws (no request) when storage is unverified. */
  runOnce(enabled?: boolean): Promise<OperatorTickResult>;
}

/**
 * Builds the fail-closed operator driver. The per-tick cap is clamped to
 * `[1, OPERATOR_MAX_REQUESTS_PER_TICK]` so the first observation cannot issue a burst; the
 * collector still consults the shared `RequestBudget` before every request, so the cap never
 * bypasses the daily/per-minute ceiling.
 */
export function createOperatorDriver(options: OperatorObservationDriverOptions): OperatorObservationDriver {
  const requested = options.maxRequestsPerTick ?? OPERATOR_MAX_REQUESTS_PER_TICK;
  const maxRequestsPerTick = Math.max(1, Math.min(Math.floor(requested), OPERATOR_MAX_REQUESTS_PER_TICK));
  const now = options.now ?? (() => Date.now());

  const requireVerified = (): DurableStoreCheck => {
    const check = verifyDurableStores({ bundleStore: options.bundleStore, budgetSink: options.budgetSink });
    if (!check.ok) throw new DurableStoreUnavailableError(check.reasons);
    return check;
  };

  const peek = () => {
    if (!options.bundleStore) return null;
    try {
      const loaded = options.bundleStore.load();
      return { state: loaded.bundle.state, snapshot: loaded.bundle.snapshot, commit: loaded.bundle.commit };
    } catch {
      return null;
    }
  };

  return {
    maxRequestsPerTick,
    requireVerified,
    peek,
    async runOnce(enabled: boolean = isShadowCollectorEnabled()): Promise<OperatorTickResult> {
      // Refuse BEFORE any provider request when storage is not verified.
      const check = requireVerified();

      const before = peek()?.commit ?? -1;
      const loaded = options.bundleStore!.load();
      // One shared budget instance governs every request in this tick (the collector's own
      // requests AND any request made by the injected forecast provider's standings source), so
      // the per-minute/per-day ceiling is genuinely shared rather than per-component.
      const sharedBudget = options.budgetInstance ?? new RequestBudget(options.budget);
      const collector = new ShadowCollector({
        transport: options.transport,
        forecasts: options.forecasts,
        budgetInstance: sharedBudget,
        budgetSink: options.budgetSink ?? undefined,
        bundleSink: { save: (s, snap) => options.bundleStore!.save(s, snap, 'operator tick commit').ok },
        maxRequestsPerTick,
        clockJumpToleranceMs: options.clockJumpToleranceMs,
        maxForwardJumpMs: options.maxForwardJumpMs,
      });
      const out = await collector.runOnce(now(), loaded.bundle.state, loaded.bundle.snapshot, enabled);

      // The collector commits only when a request was charged (or it latched). A capture built
      // from already-primed standings charges no request, so complete the durable commit here
      // rather than silently dropping the new forecast. Value-preserving and exactly once.
      const after = peek()?.commit ?? -1;
      if (enabled && after === before) {
        const r = options.bundleStore!.save(out.state, out.snapshot, 'operator tick commit (no request charged)');
        if (!r || r.ok !== true) {
          throw new DurableStoreUnavailableError([`post-tick durable commit failed: ${r?.error ?? 'not durable'}`]);
        }
      }

      return { ...out, check, maxRequestsPerTick };
    },
  };
}
