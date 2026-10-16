/**
 * Project Touchline – Model prediction count report (READ-ONLY).
 *
 * Answers "how many matches did the model predict for a given day, and why only those?"
 * It reuses the exact pipeline the HomeView overview runs (FixtureService + frozen Poisson
 * engine) so the numbers match the live UI, then summarizes them for an operator or a script.
 *
 * Nothing here writes state, enables a flag, or contacts a provider directly: it only reads the
 * app's own data API through FixtureService.
 */

import { CompetitionStandings, Fixture, MatchIntelligence } from '../types/football';
import { FixtureService } from '../services/fixtureService';
import {
  evaluateMatchIntelligence,
  isGenuinelyUpcomingFixture,
  rankEligibleMatches,
} from '../services/predictionEngine';
import { DEFAULT_TIMEZONE, formatKickoffTime, getDateKeyInTimezone } from '../utils/timezone';

export type FetchLike = (input: any, init?: any) => Promise<any>;

/**
 * Stable buckets for an evaluation outcome. The first is the success case; the rest mirror the
 * engine's documented rejection reasons (see predictionEngine.evaluateMatchIntelligence).
 */
export const INTELLIGENCE_OUTCOMES = [
  'Eligible',
  'Unsupported competition',
  'Not upcoming (status)',
  'Kickoff already passed',
  'Standings unavailable',
  'Team unranked in table',
  'Cold start (<3 matches played)',
  'Probability computation failed',
  'Other (unclassified)',
] as const;

export type IntelligenceOutcome = (typeof INTELLIGENCE_OUTCOMES)[number];

/** Map an engine evaluation to its stable outcome bucket. */
export function classifyIntelligenceOutcome(ev: MatchIntelligence): IntelligenceOutcome {
  if (ev.isEligible) return 'Eligible';
  const reason = ev.ineligibilityReason ?? '';
  if (reason.startsWith('Competition ')) return 'Unsupported competition';
  if (reason.startsWith('Match status is')) return 'Not upcoming (status)';
  if (reason.startsWith('Kickoff time has passed')) return 'Kickoff already passed';
  if (reason.startsWith('League table for')) return 'Standings unavailable';
  if (reason.startsWith('Unranked in standings')) return 'Team unranked in table';
  if (reason.startsWith('Cold start')) return 'Cold start (<3 matches played)';
  if (reason.startsWith('Model probability computation failed')) return 'Probability computation failed';
  return 'Other (unclassified)';
}

export interface CompetitionTally {
  code: string;
  name: string;
  totalFixtures: number;
  evaluated: number;
  eligible: number;
}

export interface OutcomeTally {
  outcome: IntelligenceOutcome;
  count: number;
}

export interface RankedPrediction {
  rank: number;
  fixtureId: string;
  competitionCode: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  kickoffLocal: string;
  homeWinPct: number;
  drawPct: number;
  awayWinPct: number;
  evidenceLevel: string;
  rankingScore: number;
}

export interface MatchPredictionReport {
  generatedAtUtc: string;
  timezoneId: string;
  dateKey: string;
  totalFixtures: number;
  evaluatedCount: number;
  eligibleCount: number;
  /**
   * True when the target day had no genuinely-upcoming fixtures, so the ranked set is the next
   * upcoming scheduled fixtures (filtered the same way) rather than the target day itself.
   */
  usedUpcomingFallback: boolean;
  perCompetition: CompetitionTally[];
  outcomes: OutcomeTally[];
  ranked: RankedPrediction[];
}

export interface MatchPredictionReportInputs {
  dateKey: string;
  timezoneId: string;
  generatedAtUtc: string;
  /** Every fixture on the target day. */
  fixtures: Fixture[];
  /** Engine evaluation for every fixture on the target day (drives the outcome histogram). */
  allEvaluations: MatchIntelligence[];
  /** Engine evaluations for the subset the overview actually ranks. */
  evaluated: MatchIntelligence[];
  /** Ranked, eligible predictions. */
  ranked: MatchIntelligence[];
  /** Set when the day had no upcoming fixtures and the ranked set came from later fixtures. */
  usedUpcomingFallback?: boolean;
}

/** Assemble the report from already-computed evaluations. Pure, no I/O. */
export function buildMatchPredictionReport(inputs: MatchPredictionReportInputs): MatchPredictionReport {
  const { dateKey, timezoneId, generatedAtUtc, fixtures, allEvaluations, evaluated, ranked } = inputs;
  const usedUpcomingFallback = inputs.usedUpcomingFallback ?? false;

  const perComp = new Map<string, CompetitionTally>();
  for (const f of fixtures) {
    const code = f.competition?.code || 'UNKNOWN';
    const row = perComp.get(code) ?? { code, name: f.competition?.name || code, totalFixtures: 0, evaluated: 0, eligible: 0 };
    row.totalFixtures += 1;
    perComp.set(code, row);
  }
  for (const ev of evaluated) {
    const code = ev.fixture?.competition?.code || 'UNKNOWN';
    const row = perComp.get(code) ?? { code, name: ev.fixture?.competition?.name || code, totalFixtures: 0, evaluated: 0, eligible: 0 };
    row.evaluated += 1;
    perComp.set(code, row);
  }
  for (const ev of evaluated) {
    if (!ev.isEligible) continue;
    const code = ev.fixture?.competition?.code || 'UNKNOWN';
    const row = perComp.get(code);
    if (row) row.eligible += 1;
  }

  const outcomeCounts = new Map<IntelligenceOutcome, number>();
  for (const ev of allEvaluations) {
    const key = classifyIntelligenceOutcome(ev);
    outcomeCounts.set(key, (outcomeCounts.get(key) ?? 0) + 1);
  }

  const orderIndex = (o: IntelligenceOutcome) => INTELLIGENCE_OUTCOMES.indexOf(o);
  const outcomes: OutcomeTally[] = [...outcomeCounts.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count || orderIndex(a.outcome) - orderIndex(b.outcome));

  const rankedPredictions: RankedPrediction[] = ranked.map((ev, i) => {
    const p = ev.probabilities!;
    return {
      rank: ev.rank ?? i + 1,
      fixtureId: ev.fixtureId,
      competitionCode: ev.fixture.competition?.code || 'UNKNOWN',
      homeTeam: ev.fixture.homeTeam?.name || 'Home',
      awayTeam: ev.fixture.awayTeam?.name || 'Away',
      kickoffUtc: ev.fixture.utcKickoffTime,
      kickoffLocal: formatKickoffTime(ev.fixture.utcKickoffTime, timezoneId),
      homeWinPct: Math.round(p.homeWin * 100),
      drawPct: Math.round(p.draw * 100),
      awayWinPct: Math.round(p.awayWin * 100),
      evidenceLevel: ev.evidenceLevel,
      rankingScore: ev.rankingScore ?? 0,
    };
  });

  return {
    generatedAtUtc,
    timezoneId,
    dateKey,
    totalFixtures: fixtures.length,
    evaluatedCount: evaluated.length,
    eligibleCount: rankedPredictions.length,
    usedUpcomingFallback,
    perCompetition: [...perComp.values()].sort(
      (a, b) => b.totalFixtures - a.totalFixtures || a.code.localeCompare(b.code)
    ),
    outcomes,
    ranked: rankedPredictions,
  };
}

export interface MatchPredictionReportOptions {
  /** Day to report on (YYYY-MM-DD). Defaults to "today" in `timezoneId`. */
  dateKey?: string;
  timezoneId?: string;
  /** Evaluation instant. Defaults to now. Pinning it makes the result reproducible. */
  asOfMs?: number;
  competitionId?: string;
  /** Free-text team/competition filter, forwarded to the app's fixture search. */
  searchQuery?: string;
  /** Base URL of the running app's data API, e.g. http://127.0.0.1:3000. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Injectable data sources (used by tests); when omitted, the real FixtureService is used. */
  loadFixtures?: (
    dateKey: string,
    timezoneId: string,
    competitionId: string,
    searchQuery?: string
  ) => Promise<Fixture[]>;
  loadStandings?: () => Promise<Record<string, CompetitionStandings | null>>;
  loadUpcoming?: (timezoneId: string) => Promise<Fixture[]>;
}

/**
 * FixtureService issues origin-relative URLs (it is written for the browser), so a Node caller
 * must resolve them against the local server for the duration of the call only.
 */
async function runWithFetch<T>(fetchImpl: FetchLike, fn: () => Promise<T>): Promise<T> {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    (globalThis as any).fetch = original;
  }
}

/** Fetch the day's fixtures, evaluate them with the frozen engine, and build the report. */
export async function collectMatchPredictionReport(
  options: MatchPredictionReportOptions = {}
): Promise<MatchPredictionReport> {
  const timezoneId = options.timezoneId ?? DEFAULT_TIMEZONE;
  const asOfMs = options.asOfMs ?? Date.now();
  const dateKey = options.dateKey ?? getDateKeyInTimezone(new Date(asOfMs).toISOString(), timezoneId);
  const competitionId = options.competitionId ?? 'ALL';
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  // Capture the real fetch ONCE, before we temporarily replace globalThis.fetch. Reading it lazily
  // inside the wrapper would recurse into the wrapper itself.
  const rawFetch: FetchLike = options.fetchImpl ?? ((globalThis as any).fetch.bind(globalThis) as FetchLike);
  const scopedFetch: FetchLike = base
    ? (input, init) => {
        const url = typeof input === 'string' ? input : String(input?.url ?? input);
        return rawFetch(url.startsWith('/') ? base + url : url, init);
      }
    : rawFetch;

  const loadFixtures =
    options.loadFixtures ??
    ((d: string, tz: string, comp: string, q?: string) =>
      FixtureService.getFixtures({
        dateKey: d,
        competitionId: comp,
        status: 'ALL',
        timezoneId: tz,
        searchQuery: q,
      }));
  const loadStandings = options.loadStandings ?? (() => FixtureService.getAllSupportedStandings());
  const loadUpcoming =
    options.loadUpcoming ??
    ((tz: string) =>
      FixtureService.getFixtures({
        status: 'SCHEDULED',
        competitionId,
        timezoneId: tz,
        searchQuery: options.searchQuery,
      }));

  const { fixtures, standingsMap, upcoming } = await runWithFetch(scopedFetch, async () => {
    const [fx, sm, up] = await Promise.all([
      loadFixtures(dateKey, timezoneId, competitionId, options.searchQuery),
      loadStandings(),
      loadUpcoming(timezoneId),
    ]);
    return { fixtures: fx, standingsMap: sm, upcoming: up };
  });

  // Mirror HomeView: prefer the day's genuinely-upcoming fixtures. Only when the day has none
  // does the ranked set fall back to the next upcoming scheduled fixtures (same filters applied),
  // which we flag so the caller does not read a later day's predictions as "today's".
  const currentUpcoming = fixtures.filter((f) => isGenuinelyUpcomingFixture(f, asOfMs));
  const usedUpcomingFallback = currentUpcoming.length === 0;
  const targetFixtures = usedUpcomingFallback
    ? upcoming.filter((f) => isGenuinelyUpcomingFixture(f, asOfMs))
    : currentUpcoming;

  const allEvaluations = fixtures.map((f) => evaluateMatchIntelligence(f, standingsMap, asOfMs));
  const evaluated = targetFixtures.map((f) => evaluateMatchIntelligence(f, standingsMap, asOfMs));
  const ranked = rankEligibleMatches(evaluated);

  return buildMatchPredictionReport({
    dateKey,
    timezoneId,
    generatedAtUtc: new Date(asOfMs).toISOString(),
    fixtures,
    allEvaluations,
    evaluated,
    ranked,
    usedUpcomingFallback,
  });
}

/** Human-readable rendering of a report. */
export function formatMatchPredictionReport(report: MatchPredictionReport): string {
  const lines: string[] = [];
  lines.push('Project Touchline — Model Predictions');
  lines.push(`Date: ${report.dateKey} (${report.timezoneId})   Generated: ${report.generatedAtUtc}`);
  lines.push(
    `Fixtures: ${report.totalFixtures}   Evaluated: ${report.evaluatedCount}   Predicted (eligible): ${report.eligibleCount}`
  );
  if (report.usedUpcomingFallback) {
    lines.push(
      `Note: no upcoming fixtures on ${report.dateKey}; ranked predictions come from later upcoming fixtures.`
    );
  }

  lines.push('');
  lines.push('Per competition:');
  if (report.perCompetition.length === 0) {
    lines.push('  (none)');
  } else {
    const width = Math.max(4, ...report.perCompetition.map((c) => c.code.length));
    for (const c of report.perCompetition) {
      lines.push(
        `  ${c.code.padEnd(width)}  ${c.name.slice(0, 28).padEnd(28)}  fixtures ${String(c.totalFixtures).padStart(3)}   evaluated ${String(c.evaluated).padStart(3)}   predicted ${String(c.eligible).padStart(3)}`
      );
    }
  }

  lines.push('');
  lines.push("Why (all of the day's fixtures):");
  if (report.outcomes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const o of report.outcomes) {
      lines.push(`  ${String(o.count).padStart(4)}  ${o.outcome}`);
    }
  }

  lines.push('');
  lines.push('Ranked predictions:');
  if (report.ranked.length === 0) {
    lines.push('  (no eligible matches)');
  } else {
    for (const p of report.ranked) {
      lines.push(
        `  #${p.rank}  ${p.competitionCode}  ${p.homeTeam} vs ${p.awayTeam}   ${p.kickoffLocal}   ` +
          `H ${p.homeWinPct}% / D ${p.drawPct}% / A ${p.awayWinPct}%   [${p.evidenceLevel}]`
      );
    }
  }

  return lines.join('\n');
}
