/**
 * Project Touchline – Odds Provider Quota & Budget Guard
 *
 * Tracks the request quota reported by an odds provider's response headers and
 * enforces a configurable monthly request budget so a free-tier plan is never
 * exhausted silently. Pure and dependency-free so the rules are unit-testable.
 *
 * Rules:
 * - The budget is a *local* cap on how many metered requests this app may make in a
 *   calendar month, independent of (and never larger than) what the provider reports.
 * - A request is refused before it is sent when the budget is already spent. We never
 *   send a request we cannot account for.
 * - Provider-reported remaining credits are recorded verbatim; when the provider says
 *   zero remain, the guard refuses further requests even if the local counter disagrees.
 * - The local counter resets when the calendar month (UTC) changes.
 */

export interface QuotaSnapshot {
  /** Calendar month the counters belong to, `YYYY-MM` (UTC). */
  monthKey: string;
  /** Local metered requests made this month. */
  requestsUsed: number;
  /** Configured local cap for the month. */
  monthlyBudget: number;
  /** Provider-reported remaining credits, when the provider returned the header. */
  providerRemaining: number | null;
  /** Provider-reported credits used this month, when returned. */
  providerUsed: number | null;
  /** Cost of the most recent request, when the provider returned the header. */
  lastCost: number | null;
  /** ISO timestamp of the last recorded request. */
  lastRequestAt: string | null;
}

export interface ParsedQuotaHeaders {
  remaining: number | null;
  used: number | null;
  last: number | null;
}

/** Minimal shape of the response headers we read. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** `YYYY-MM` for a date in UTC. */
export function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function toIntOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Reads The Odds API quota headers (`x-requests-remaining|used|last`). */
export function parseQuotaHeaders(headers: HeaderReader | undefined | null): ParsedQuotaHeaders {
  if (!headers || typeof headers.get !== 'function') {
    return { remaining: null, used: null, last: null };
  }
  return {
    remaining: toIntOrNull(headers.get('x-requests-remaining')),
    used: toIntOrNull(headers.get('x-requests-used')),
    last: toIntOrNull(headers.get('x-requests-last')),
  };
}

/** Creates a fresh snapshot for the given month and budget. */
export function createQuotaSnapshot(monthlyBudget: number, now: Date): QuotaSnapshot {
  return {
    monthKey: monthKeyOf(now),
    requestsUsed: 0,
    monthlyBudget: Math.max(0, Math.floor(monthlyBudget)),
    providerRemaining: null,
    providerUsed: null,
    lastCost: null,
    lastRequestAt: null,
  };
}

/** Rolls the snapshot into a new month when `now` has crossed a UTC month boundary. */
export function rollMonthIfNeeded(snapshot: QuotaSnapshot, now: Date): QuotaSnapshot {
  const key = monthKeyOf(now);
  if (key === snapshot.monthKey) return snapshot;
  return { ...createQuotaSnapshot(snapshot.monthlyBudget, now), monthKey: key };
}

/**
 * True when a metered request of `cost` credits may be sent.
 * `cost` is the expected credit cost (markets x regions); default 1.
 */
export function canSpend(snapshot: QuotaSnapshot, now: Date, cost = 1): boolean {
  const rolled = rollMonthIfNeeded(snapshot, now);
  if (rolled.providerRemaining !== null && rolled.providerRemaining < cost) return false;
  return rolled.requestsUsed + cost <= rolled.monthlyBudget;
}

/** Reason a request was refused, for honest reporting. */
export type BudgetRefusal = 'local_budget_exhausted' | 'provider_quota_exhausted' | null;

export function refusalReason(snapshot: QuotaSnapshot, now: Date, cost = 1): BudgetRefusal {
  const rolled = rollMonthIfNeeded(snapshot, now);
  if (rolled.providerRemaining !== null && rolled.providerRemaining < cost) return 'provider_quota_exhausted';
  if (rolled.requestsUsed + cost > rolled.monthlyBudget) return 'local_budget_exhausted';
  return null;
}

/**
 * Records a sent request against the budget and merges provider-reported quota headers.
 * Call this only after a request was actually dispatched.
 */
export function recordRequest(
  snapshot: QuotaSnapshot,
  now: Date,
  cost: number,
  headers?: HeaderReader | null
): QuotaSnapshot {
  const rolled = rollMonthIfNeeded(snapshot, now);
  const parsed = parseQuotaHeaders(headers);
  return {
    ...rolled,
    requestsUsed: rolled.requestsUsed + Math.max(0, cost),
    providerRemaining: parsed.remaining ?? rolled.providerRemaining,
    providerUsed: parsed.used ?? rolled.providerUsed,
    lastCost: parsed.last ?? cost,
    lastRequestAt: now.toISOString(),
  };
}

/** True when no further metered requests may be made this month. */
export function isExhausted(snapshot: QuotaSnapshot, now: Date): boolean {
  return !canSpend(snapshot, now, 1);
}
