/**
 * Project Touchline – Fixture Provider Health Summary
 *
 * Separates "a provider is unhealthy" from "this competition has no fixtures".
 * When a provider fails or is rate-limited, the fixtures endpoint still returns any
 * data it has, plus a degradation notice — never a misleading empty list or a
 * disruptive banner. Kept pure and separate from Express so it can be tested.
 */

export interface FixtureFetchOutcome {
  footballDataConfigured: boolean;
  sportApiConfigured: boolean;
  footballDataRateLimited: boolean;
  footballDataError: string | null;
  sportApiError: string | null;
}

export interface FixtureFetchSummary {
  /** True when any configured provider failed, was rate-limited, or returned nothing usable. */
  degraded: boolean;
  /** Human-readable, non-alarming explanation of what is degraded (undefined when healthy). */
  notice?: string;
  /**
   * True when the sole configured fixtures provider is rate-limited, so the caller
   * should signal 429 rather than return an empty list.
   */
  soleProviderRateLimited: boolean;
}

export function summarizeFixtureFetch(outcome: FixtureFetchOutcome): FixtureFetchSummary {
  const degradations: string[] = [];

  if (outcome.footballDataRateLimited) {
    degradations.push('football-data.org rate limit reached (10 req/min).');
  }
  if (outcome.footballDataError) {
    degradations.push(outcome.footballDataError);
  }
  if (outcome.sportApiError) {
    degradations.push(outcome.sportApiError);
  }

  const soleProviderRateLimited =
    outcome.footballDataRateLimited && !outcome.sportApiConfigured;

  return {
    degraded: degradations.length > 0,
    notice: degradations.length > 0 ? degradations.join(' ') : undefined,
    soleProviderRateLimited,
  };
}

/** football-data.org rejects any date window longer than 10 days with HTTP 400. */
export const MAX_FD_WINDOW_DAYS = 10;

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateKey;
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

/**
 * Resolves an explicit, valid football-data.org date window.
 *
 * The provider requires both dateFrom and dateTo and caps the span at 10 days; an
 * open-ended request is rejected with HTTP 400. When the caller supplies no window,
 * one covering yesterday through the next 8 days is used so the Yesterday/Today/
 * Tomorrow UI filters all have data without exceeding the limit.
 */
export function resolveFixtureDateWindow(
  dateFrom?: string | null,
  dateTo?: string | null,
  now: Date = new Date()
): { dateFrom: string; dateTo: string } {
  const from = typeof dateFrom === 'string' && dateFrom ? dateFrom : null;
  const to = typeof dateTo === 'string' && dateTo ? dateTo : null;

  if (!from) {
    const today = now.toISOString().split('T')[0];
    return { dateFrom: addDays(today, -1), dateTo: addDays(today, MAX_FD_WINDOW_DAYS - 2) };
  }
  if (!to) {
    return { dateFrom: from, dateTo: addDays(from, MAX_FD_WINDOW_DAYS - 1) };
  }
  return { dateFrom: from, dateTo: to };
}

