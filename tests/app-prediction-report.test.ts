/**
 * Tests for the model prediction count report (read-only analysis).
 * Uses synthetic fixtures/standings — no network, no real provider.
 */

import { describe, it, expect } from 'vitest';
import { Competition, CompetitionStandings, Fixture, MatchIntelligence, StandingEntry } from '../src/types/football';
import {
  buildMatchPredictionReport,
  classifyIntelligenceOutcome,
  collectMatchPredictionReport,
  formatMatchPredictionReport,
} from '../src/analysis/matchPredictionReport';
import { evaluateMatchIntelligence, rankEligibleMatches } from '../src/services/predictionEngine';
import { parseArgs } from '../scripts/model-predictions';

const AS_OF = new Date('2026-10-16T11:00:00Z').getTime();
const FUTURE = '2026-10-16T19:45:00Z';
const PAST = '2026-10-16T08:00:00Z';

function comp(code: string, name = code): Competition {
  return { id: code, name, code, type: 'LEAGUE', country: 'X', season: '2025/26' };
}

function fixture(
  id: string,
  code: string,
  home: [string, string],
  away: [string, string],
  kickoff = FUTURE,
  status: Fixture['status'] = 'SCHEDULED'
): Fixture {
  const team = ([tid, tname]: [string, string]) => ({ id: tid, name: tname, shortName: tname, tla: tid.slice(0, 3) });
  return {
    id,
    utcKickoffTime: kickoff,
    status,
    competition: comp(code),
    homeTeam: team(home),
    awayTeam: team(away),
  };
}

function entry(teamId: string, name: string, played: number, gf = 15, ga = 10, gd = 5): StandingEntry {
  return {
    position: 1,
    team: { id: teamId, name, shortName: name, tla: teamId.slice(0, 3) },
    playedGames: played,
    won: 5,
    draw: 3,
    lost: 2,
    points: 18,
    goalsFor: gf,
    goalsAgainst: ga,
    goalDifference: gd,
  };
}

function standings(code: string, table: StandingEntry[]): CompetitionStandings {
  return { competition: comp(code), season: { startDate: '2025-08-01', endDate: '2026-05-01' }, table };
}

const PL_STANDINGS = standings('PL', [
  entry('h1', 'Home FC', 10, 20, 10, 10),
  entry('a1', 'Away FC', 10, 14, 14, 0),
  entry('h2', 'Cold FC', 2),
  entry('a2', 'Warm FC', 10),
]);

describe('classifyIntelligenceOutcome', () => {
  const cases: Array<[string | undefined, boolean, string]> = [
    [undefined, true, 'Eligible'],
    ['Competition XX is not supported for Daily Intelligence.', false, 'Unsupported competition'],
    ['Match status is FINISHED. Predictions are evaluated only for upcoming scheduled matches.', false, 'Not upcoming (status)'],
    ['Kickoff time has passed (2026-10-16T08:00:00Z). Match is no longer upcoming under conservative freshness rules.', false, 'Kickoff already passed'],
    ['League table for PL is temporarily unavailable from the provider.', false, 'Standings unavailable'],
    ['Unranked in standings: X not found in current league table.', false, 'Team unranked in table'],
    ['Cold start: Insufficient league history (A: 1 matches, B: 2 matches). Minimum 3 matches required.', false, 'Cold start (<3 matches played)'],
    ['Model probability computation failed for this match pairing.', false, 'Probability computation failed'],
    ['something unexpected', false, 'Other (unclassified)'],
  ];

  for (const [reason, eligible, expected] of cases) {
    it(`maps ${String(reason).slice(0, 40)} -> ${expected}`, () => {
      const ev = { isEligible: eligible, ineligibilityReason: reason } as MatchIntelligence;
      expect(classifyIntelligenceOutcome(ev)).toBe(expected);
    });
  }
});

describe('collectMatchPredictionReport (injected loaders, no network)', () => {
  const fixtures: Fixture[] = [
    fixture('pl-valid', 'PL', ['h1', 'Home FC'], ['a1', 'Away FC']),
    fixture('pl-cold', 'PL', ['h2', 'Cold FC'], ['a2', 'Warm FC']),
    fixture('pl-unranked', 'PL', ['zz', 'Ghost FC'], ['a1', 'Away FC']),
    fixture('cup-unsupported', 'SP-106', ['c1', 'Cup A'], ['c2', 'Cup B']),
    fixture('pl-past', 'PL', ['h1', 'Home FC'], ['a1', 'Away FC'], PAST),
  ];

  const run = () =>
    collectMatchPredictionReport({
      dateKey: '2026-10-16',
      timezoneId: 'UTC',
      asOfMs: AS_OF,
      loadFixtures: async () => fixtures,
      loadStandings: async () => ({ PL: PL_STANDINGS, CL: null, PD: null, SA: null }),
      loadUpcoming: async () => fixtures.filter((f) => f.status === 'SCHEDULED'),
    });

  it('counts predicted (eligible) matches for the day', async () => {
    const report = await run();
    expect(report.totalFixtures).toBe(5);
    expect(report.evaluatedCount).toBe(4); // the past fixture is not genuinely upcoming
    expect(report.eligibleCount).toBe(1);
    expect(report.ranked[0].fixtureId).toBe('pl-valid');
    expect(report.ranked[0].homeWinPct + report.ranked[0].drawPct + report.ranked[0].awayWinPct).toBeGreaterThan(95);
  });

  it('explains why the other fixtures were excluded', async () => {
    const report = await run();
    const byOutcome = Object.fromEntries(report.outcomes.map((o) => [o.outcome, o.count]));
    expect(byOutcome['Eligible']).toBe(1);
    expect(byOutcome['Cold start (<3 matches played)']).toBe(1);
    expect(byOutcome['Team unranked in table']).toBe(1);
    expect(byOutcome['Unsupported competition']).toBe(1);
    expect(byOutcome['Kickoff already passed']).toBe(1);
  });

  it('breaks fixtures down per competition', async () => {
    const report = await run();
    const pl = report.perCompetition.find((c) => c.code === 'PL')!;
    expect(pl.totalFixtures).toBe(4);
    expect(pl.evaluated).toBe(3);
    expect(pl.eligible).toBe(1);
    const cup = report.perCompetition.find((c) => c.code === 'SP-106')!;
    expect(cup.totalFixtures).toBe(1);
    expect(cup.eligible).toBe(0);
  });

  it('lists all outcome buckets even when their count is zero', async () => {
    const report = await run();
    // Absent buckets are simply not listed; present ones are ordered by count desc.
    const counts = report.outcomes.map((o) => o.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(report.outcomes.length).toBe(5);
  });
});

describe('buildMatchPredictionReport (pure)', () => {
  it('handles an empty day without throwing', () => {
    const report = buildMatchPredictionReport({
      dateKey: '2026-01-01',
      timezoneId: 'UTC',
      generatedAtUtc: '2026-01-01T00:00:00Z',
      fixtures: [],
      allEvaluations: [],
      evaluated: [],
      ranked: [],
    });
    expect(report.totalFixtures).toBe(0);
    expect(report.eligibleCount).toBe(0);
    expect(report.usedUpcomingFallback).toBe(false);
    expect(report.perCompetition).toEqual([]);
    expect(report.outcomes).toEqual([]);
    const text = formatMatchPredictionReport(report);
    expect(text).toContain('Predicted (eligible): 0');
    expect(text).toContain('(no eligible matches)');
  });

  it('flags when the ranked set fell back to later upcoming fixtures', () => {
    const report = buildMatchPredictionReport({
      dateKey: '2026-01-01',
      timezoneId: 'UTC',
      generatedAtUtc: '2026-01-01T00:00:00Z',
      fixtures: [],
      allEvaluations: [],
      evaluated: [],
      ranked: [],
      usedUpcomingFallback: true,
    });
    expect(report.usedUpcomingFallback).toBe(true);
    expect(formatMatchPredictionReport(report)).toContain('no upcoming fixtures on 2026-01-01');
  });

  it('renders a headline with the predicted count', async () => {
    const fixtures = [fixture('pl-valid', 'PL', ['h1', 'Home FC'], ['a1', 'Away FC'])];
    const standingsMap = { PL: PL_STANDINGS, CL: null, PD: null, SA: null };
    const evaluated = fixtures.map((f) => evaluateMatchIntelligence(f, standingsMap, AS_OF));
    const report = buildMatchPredictionReport({
      dateKey: '2026-10-16',
      timezoneId: 'UTC',
      generatedAtUtc: new Date(AS_OF).toISOString(),
      fixtures,
      allEvaluations: evaluated,
      evaluated,
      ranked: rankEligibleMatches(evaluated),
    });
    const text = formatMatchPredictionReport(report);
    expect(text).toContain('Predicted (eligible): 1');
    expect(text).toMatch(/#1\s+PL\s+Home FC vs Away FC/);
  });
});

describe('CLI arg parsing', () => {
  it('parses flags and defaults', () => {
    expect(parseArgs([])).toEqual({ json: false, help: false });
    expect(parseArgs(['--date', '2026-10-16', '--tz', 'UTC', '--base-url', 'http://x:1', '--json'])).toEqual({
      json: true,
      help: false,
      dateKey: '2026-10-16',
      timezoneId: 'UTC',
      baseUrl: 'http://x:1',
    });
    expect(parseArgs(['--date=2026-10-17'])).toEqual({ json: false, help: false, dateKey: '2026-10-17' });
    expect(parseArgs(['-c', 'PL']).competitionId).toBe('PL');
    expect(parseArgs(['--search', 'Everton']).searchQuery).toBe('Everton');
    expect(parseArgs(['--at', '2026-10-16T09:00:00Z']).asOfMs).toBe(Date.parse('2026-10-16T09:00:00Z'));
  });

  it('sets the help flag without exiting', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs([]).help).toBe(false);
  });

  it('rejects malformed input instead of silently ignoring it', () => {
    expect(() => parseArgs(['--date'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--at', 'not-a-date'])).toThrow(/ISO date/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('collectMatchPredictionReport – search filter threading', () => {
  it('forwards searchQuery to the fixture loader', async () => {
    const seen: Array<string | undefined> = [];
    await collectMatchPredictionReport({
      dateKey: '2026-10-16',
      timezoneId: 'UTC',
      asOfMs: AS_OF,
      searchQuery: 'Everton',
      loadFixtures: async (_d, _tz, _c, q) => {
        seen.push(q);
        return [];
      },
      loadStandings: async () => ({ PL: null, CL: null, PD: null, SA: null }),
      loadUpcoming: async () => [],
    });
    expect(seen).toEqual(['Everton']);
  });

  it('marks an empty day as fallback and reports 0 rather than a later day as "today"', async () => {
    const report = await collectMatchPredictionReport({
      dateKey: '2026-10-16',
      timezoneId: 'UTC',
      asOfMs: AS_OF,
      searchQuery: 'Nobody',
      loadFixtures: async () => [],
      loadStandings: async () => ({ PL: null, CL: null, PD: null, SA: null }),
      loadUpcoming: async () => [],
    });
    expect(report.totalFixtures).toBe(0);
    expect(report.usedUpcomingFallback).toBe(true);
    expect(report.eligibleCount).toBe(0);
  });
});
