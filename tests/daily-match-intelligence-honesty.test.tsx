/**
 * Daily Match Intelligence – honesty regressions.
 *
 * Covers three defects confirmed by inspection:
 *   1. When the selected date had no upcoming match, later dates' predictions were shown with
 *      no indication that they were not for the selected date.
 *   2. Nothing explained why the other matches were skipped.
 *   3. The "Inspect Excluded Fixtures" section was dead code: it filtered `intelligenceList`,
 *      which contains only ranked (eligible) matches, so it never rendered.
 *
 * All fixtures here are TEST DATA. No live provider is involved.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DailyMatchIntelligence } from '../src/components/DailyMatchIntelligence';
import { evaluateMatchIntelligence, rankEligibleMatches } from '../src/services/predictionEngine';
import { CompetitionStandings, Fixture, StandingEntry } from '../src/types/football';

function entry(name: string, played: number, gf: number, ga: number): StandingEntry {
  return {
    position: 1,
    team: { id: name, name, shortName: name, tla: name.slice(0, 3).toUpperCase() },
    playedGames: played,
    won: played,
    draw: 0,
    lost: 0,
    points: played * 3,
    goalsFor: gf,
    goalsAgainst: ga,
    goalDifference: gf - ga,
    form: null,
  };
}

const PL_STANDINGS: CompetitionStandings = {
  competition: { id: 'PL', code: 'PL', name: 'PL', type: 'LEAGUE', country: 'X', season: '2025/26' },
  season: { startDate: '', endDate: '', currentMatchday: 10 },
  table: [
    entry('Home FC', 10, 20, 10),
    entry('Away FC', 10, 14, 14),
    entry('Cold FC', 1, 1, 1),
    entry('Warm FC', 10, 12, 12),
  ],
};

function fixture(id: string, home: string, away: string, kickoffIso: string, status: Fixture['status'] = 'TIMED'): Fixture {
  return {
    id,
    competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2025/26' },
    utcKickoffTime: kickoffIso,
    status,
    homeTeam: { id: home, name: home, shortName: home, tla: home.slice(0, 3).toUpperCase() },
    awayTeam: { id: away, name: away, shortName: away, tla: away.slice(0, 3).toUpperCase() },
  } as Fixture;
}

const standingsMap = { PL: PL_STANDINGS, CL: null, PD: null, SA: null };

// A far-future kickoff keeps these fixtures genuinely upcoming regardless of when tests run.
const FUTURE = '2099-06-01T15:00:00Z';

function build(list: Fixture[], asOf = Date.now()) {
  const evaluated = list.map((f) => evaluateMatchIntelligence(f, standingsMap, asOf));
  return { evaluated, ranked: rankEligibleMatches(evaluated) };
}

const baseProps = {
  loading: false,
  timezoneId: 'UTC',
  selectedDateLabel: 'Today (UTC)',
  onNavigateToMatch: vi.fn(),
};

describe('DailyMatchIntelligence – fallback and skip transparency', () => {
  it('warns that the list is not for the selected date when falling back', () => {
    const { evaluated, ranked } = build([
      fixture('m1', 'Home FC', 'Away FC', FUTURE),
      fixture('m2', 'Cold FC', 'Warm FC', FUTURE),
    ]);
    render(
      <DailyMatchIntelligence
        {...baseProps}
        intelligenceList={ranked}
        evaluatedFixtures={evaluated}
        usingFallback={true}
      />
    );
    expect(screen.getByText(/No upcoming matches left on Today \(UTC\)/)).toBeTruthy();
    expect(screen.getByText(/not\s+for Today \(UTC\)/)).toBeTruthy();
  });

  it('does not warn when the selected date has its own upcoming matches', () => {
    const { evaluated, ranked } = build([fixture('m1', 'Home FC', 'Away FC', FUTURE)]);
    render(
      <DailyMatchIntelligence
        {...baseProps}
        intelligenceList={ranked}
        evaluatedFixtures={evaluated}
        usingFallback={false}
      />
    );
    expect(screen.queryByText(/No upcoming matches left on/)).toBeNull();
  });

  it('summarises why matches were skipped, with counts', () => {
    const { evaluated, ranked } = build([
      fixture('m1', 'Home FC', 'Away FC', FUTURE),
      fixture('m2', 'Cold FC', 'Warm FC', FUTURE),
      fixture('m3', 'Home FC', 'Away FC', FUTURE, 'IN_PLAY'),
    ]);
    render(
      <DailyMatchIntelligence
        {...baseProps}
        intelligenceList={ranked}
        evaluatedFixtures={evaluated}
        usingFallback={false}
      />
    );
    expect(screen.getByText(/Why 2 match\(es\) were skipped/)).toBeTruthy();
    expect(screen.getByText(/Cold start \(<3 matches played\)/)).toBeTruthy();
    expect(screen.getByText(/Not upcoming \(status\)/)).toBeTruthy();
  });

  it('renders the excluded-fixtures toggle that was previously dead code', () => {
    const { evaluated, ranked } = build([
      fixture('m1', 'Home FC', 'Away FC', FUTURE),
      fixture('m2', 'Cold FC', 'Warm FC', FUTURE),
    ]);
    render(
      <DailyMatchIntelligence
        {...baseProps}
        intelligenceList={ranked}
        evaluatedFixtures={evaluated}
        usingFallback={false}
      />
    );
    expect(screen.getByText(/1 match\(es\) excluded by data guardrails/)).toBeTruthy();
    expect(screen.getByText(/Inspect Excluded Fixtures/)).toBeTruthy();
  });

  it('states the measured overconfidence on high-confidence picks', () => {
    const { evaluated, ranked } = build([fixture('m1', 'Home FC', 'Away FC', FUTURE)]);
    render(
      <DailyMatchIntelligence
        {...baseProps}
        intelligenceList={ranked}
        evaluatedFixtures={evaluated}
        usingFallback={false}
      />
    );
    // The model rated >=80% picks at 0.864 while they occurred 0.729 on held-out data.
    expect(screen.getByText(/rated above 80% occurred 73% of the time/)).toBeTruthy();
  });

  it('does not show the overconfidence notice when nothing is eligible', () => {
    const { evaluated, ranked } = build([fixture('m1', 'Cold FC', 'Warm FC', FUTURE)]);
    render(
      <DailyMatchIntelligence
        {...baseProps}
        intelligenceList={ranked}
        evaluatedFixtures={evaluated}
        usingFallback={false}
      />
    );
    expect(screen.queryByText(/occurred 73% of the time/)).toBeNull();
  });
});
