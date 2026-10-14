import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FixturesView } from '../src/views/FixturesView';
import { HomeView } from '../src/views/HomeView';
import { groupFixturesByCompetition, getCanonicalCompetitionMeta } from '../src/utils/competitionGrouping';
import { Fixture } from '../src/types/football';
import { FixtureService } from '../src/services/fixtureService';

describe('Competition Headings & Grouping Integrity', () => {
  const mockInterleavedFixtures: Fixture[] = [
    {
      id: 'iw-1',
      utcKickoffTime: '2026-10-13T16:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'SP-93', code: 'SP-93', name: 'Internationals Women', type: 'LEAGUE', country: 'World', season: '2026/27' },
      homeTeam: { id: 'th1', name: 'USA Women', shortName: 'USA', tla: 'USA' },
      awayTeam: { id: 'ta1', name: 'Spain Women', shortName: 'Spain', tla: 'ESP' },
    },
    {
      id: 'cl-1',
      utcKickoffTime: '2026-10-13T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: 'th2', name: 'Arsenal', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: 'ta2', name: 'Lille', shortName: 'Lille', tla: 'LIL' },
    },
    {
      id: 'iw-2',
      utcKickoffTime: '2026-10-13T14:00:00Z', // earlier kickoff
      status: 'FINISHED',
      score: { home: 2, away: 1 },
      competition: { id: 'SP-93', code: 'SP-93', name: 'Internationals Women', type: 'LEAGUE', country: 'World', season: '2026/27' },
      homeTeam: { id: 'th3', name: 'Brazil Women', shortName: 'Brazil', tla: 'BRA' },
      awayTeam: { id: 'ta3', name: 'Argentina Women', shortName: 'Argentina', tla: 'ARG' },
    },
    {
      id: 'wewcq-1',
      utcKickoffTime: '2026-10-13T17:30:00Z',
      status: 'SCHEDULED',
      competition: { id: 'SP-125', code: 'SP-125', name: "Women's European World Cup Qualifiers", type: 'LEAGUE', country: 'Europe', season: '2026/27' },
      homeTeam: { id: 'th4', name: 'Germany Women', shortName: 'Germany', tla: 'GER' },
      awayTeam: { id: 'ta4', name: 'France Women', shortName: 'France', tla: 'FRA' },
    },
    {
      id: 'iw-3',
      utcKickoffTime: '2026-10-13T21:00:00Z', // variant naming e.g. with whitespace or trailing
      status: 'SCHEDULED',
      competition: { id: '93', code: 'SP-93', name: 'Internationals Women ', type: 'LEAGUE', country: 'World', season: '2026/27' },
      homeTeam: { id: 'th5', name: 'England Women', shortName: 'England', tla: 'ENG' },
      awayTeam: { id: 'ta5', name: 'Netherlands Women', shortName: 'Netherlands', tla: 'NED' },
    },
    {
      id: 'cl-2',
      utcKickoffTime: '2026-10-13T20:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: 'th6', name: 'Inter Milan', shortName: 'Inter', tla: 'INT' },
      awayTeam: { id: 'ta6', name: 'Slavia Prague', shortName: 'Slavia', tla: 'SLA' },
    },
  ];

  it('groups all displayed fixtures by canonical competition into exactly one heading per competition', () => {
    const groups = groupFixturesByCompetition(mockInterleavedFixtures);

    // There should be exactly 3 groups: Internationals Women, Champions League, Women's European World Cup Qualifiers
    expect(groups).toHaveLength(3);

    const groupNames = groups.map((g) => g.name);
    expect(groupNames).toContain('Internationals Women');
    expect(groupNames).toContain('UEFA Champions League');
    expect(groupNames).toContain("Women's European World Cup Qualifiers");

    // "Internationals Women" must appear exactly once in the list of groups
    const iwGroups = groups.filter((g) => g.name === 'Internationals Women');
    expect(iwGroups).toHaveLength(1);

    // All 3 Internationals Women matches must belong to this single group
    const iwGroup = iwGroups[0];
    expect(iwGroup.fixtures).toHaveLength(3);
    const iwMatchIds = iwGroup.fixtures.map((f) => f.id);
    expect(iwMatchIds).toEqual(['iw-2', 'iw-1', 'iw-3']); // strictly chronological: 14:00, 16:00, 21:00
  });

  it('maintains strict chronological kickoff order within each competition group', () => {
    const groups = groupFixturesByCompetition(mockInterleavedFixtures);

    for (const group of groups) {
      for (let i = 0; i < group.fixtures.length - 1; i++) {
        const timeCurrent = new Date(group.fixtures[i].utcKickoffTime).getTime();
        const timeNext = new Date(group.fixtures[i + 1].utcKickoffTime).getTime();
        expect(timeCurrent).toBeLessThanOrEqual(timeNext);
      }
    }
  });

  it('harmonizes variant tournament names (e.g. whitespace, Champions League vs UEFA Champions League) without duplicating headings', () => {
    const variants: Fixture[] = [
      {
        id: 'var-1',
        utcKickoffTime: '2026-10-13T18:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026' },
        homeTeam: { id: 't1', name: 'Team A', shortName: 'A', tla: 'A' },
        awayTeam: { id: 't2', name: 'Team B', shortName: 'B', tla: 'B' },
      },
      {
        id: 'var-2',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'Champions League', type: 'CUP', country: 'Europe', season: '2026' },
        homeTeam: { id: 't3', name: 'Team C', shortName: 'C', tla: 'C' },
        awayTeam: { id: 't4', name: 'Team D', shortName: 'D', tla: 'D' },
      },
      {
        id: 'var-3',
        utcKickoffTime: '2026-10-13T20:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League ', type: 'CUP', country: 'Europe', season: '2026' },
        homeTeam: { id: 't5', name: 'Team E', shortName: 'E', tla: 'E' },
        awayTeam: { id: 't6', name: 'Team F', shortName: 'F', tla: 'F' },
      },
    ];

    const groups = groupFixturesByCompetition(variants);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('UEFA Champions League');
    expect(groups[0].fixtures).toHaveLength(3);
  });

  it('renders exactly one heading for each competition in FixturesView UI when fixtures are interleaved', async () => {
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue(mockInterleavedFixtures);
    vi.spyOn(FixtureService, 'getCompetitions').mockResolvedValue([
      { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2024/25' },
      { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2024/25' },
    ]);

    render(
      <FixturesView
        timezoneId="Africa/Lagos"
        onSelectFixture={() => {}}
      />
    );

    // Wait for fixtures to render
    await waitFor(() => {
      expect(screen.getByText('Showing')).toBeTruthy();
    });

    // Check competition headings
    const competitionHeadings = screen.getAllByTestId('competition-heading');
    expect(competitionHeadings).toHaveLength(3);

    // Each competition heading must appear exactly once in the heading list
    const headingNames = competitionHeadings.map((h) => h.textContent);
    expect(headingNames).toEqual([
      'Internationals Women',
      "Women's European World Cup Qualifiers",
      'UEFA Champions League',
    ]);

    expect(screen.getAllByRole('heading', { name: 'Internationals Women' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'UEFA Champions League' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: "Women's European World Cup Qualifiers" })).toHaveLength(1);

    // Match counts displayed next to headings
    expect(screen.getByText('3 matches')).toBeTruthy(); // Internationals Women has 3
    expect(screen.getByText('2 matches')).toBeTruthy(); // Champions League has 2
    expect(screen.getByText('1 matches')).toBeTruthy(); // Women's European World Cup Qualifiers has 1

    // All match cards remain present and rendered
    expect(screen.getAllByText('USA').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Arsenal').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Brazil').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Germany').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('England').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Inter').length).toBeGreaterThanOrEqual(1);
  });

  it('triggers onSelectFixture when a fixture card is clicked under its competition heading', async () => {
    const onSelect = vi.fn();
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue(mockInterleavedFixtures);
    vi.spyOn(FixtureService, 'getCompetitions').mockResolvedValue([]);

    render(
      <FixturesView
        timezoneId="Africa/Lagos"
        onSelectFixture={onSelect}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Showing')).toBeTruthy();
    });

    // Find the Arsenal match card and click it
    const arsenalCard = screen.getByText('Arsenal').closest('[role="button"]') as HTMLElement;
    expect(arsenalCard).toBeTruthy();
    arsenalCard.click();

    expect(onSelect).toHaveBeenCalledWith('cl-1');
  });

  it('ensures filtering by search or status preserves single heading without creating ghost duplicates', async () => {
    // Return only matches for Arsenal
    const filteredMatches = mockInterleavedFixtures.filter((f) => f.id === 'cl-1');
    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue(filteredMatches);
    vi.spyOn(FixtureService, 'getCompetitions').mockResolvedValue([]);

    render(
      <FixturesView
        timezoneId="Africa/Lagos"
        onSelectFixture={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Showing')).toBeTruthy();
    });

    const headings = screen.getAllByTestId('competition-heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('UEFA Champions League');
    expect(screen.getByText('1 matches')).toBeTruthy();
    expect(screen.queryByText('Internationals Women')).toBeNull();
  });

  it('renders exactly one card for LASK–Liverpool and one card for Feyenoord–Como in FixturesView with live scores retained', async () => {
    const liveDuplicatesFeed: Fixture[] = [
      {
        id: 'fd-575351',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '675', name: 'Feyenoord Rotterdam', shortName: 'Feyenoord', tla: 'FEY' },
        awayTeam: { id: '7397', name: 'Como 1907', shortName: 'Como 1907', tla: 'COM' },
        score: { home: 2, away: 1, halftime: { home: 1, away: 1 } },
        isDelayed: true,
      },
      {
        id: 'fd-575350',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '2016', name: 'LASK Linz', shortName: 'LASK', tla: 'LIN' },
        awayTeam: { id: '64', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
        score: { home: 1, away: 5, halftime: { home: 0, away: 3 } },
        isDelayed: true,
      },
      {
        id: 'sp-13596816',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        minute: 69,
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '180', name: 'Feyenoord', shortName: 'Feyenoord', tla: 'FEY' },
        awayTeam: { id: '19', name: 'Como', shortName: 'Como', tla: 'COM' },
        score: { home: 2, away: 1 },
        isDelayed: false,
      },
      {
        id: 'sp-13596817',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        minute: 74,
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '137', name: 'LASK', shortName: 'LASK', tla: 'LAS' },
        awayTeam: { id: '312', name: 'Liverpool', shortName: 'Liverpool', tla: 'LIV' },
        score: { home: 1, away: 6 },
        isDelayed: false,
      },
    ];

    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue(
      // Simulate calling through FixtureService (which applies deduplication)
      groupFixturesByCompetition(liveDuplicatesFeed).flatMap((g) => g.fixtures)
    );
    vi.spyOn(FixtureService, 'getCompetitions').mockResolvedValue([
      { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
    ]);

    render(
      <FixturesView
        timezoneId="Africa/Lagos"
        onSelectFixture={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Showing')).toBeTruthy();
    });

    // Exactly 2 total match cards in the UI (not 4)
    expect(screen.getByText('2 matches')).toBeTruthy();

    // Liverpool card appears exactly once
    const liverpoolElements = screen.getAllByText('Liverpool');
    expect(liverpoolElements).toHaveLength(1);

    // Feyenoord card appears exactly once
    const feyenoordElements = screen.getAllByText('Feyenoord');
    expect(feyenoordElements).toHaveLength(1);

    // Live updated score for LASK vs Liverpool (1–6) must be visible
    expect(screen.getByText('6')).toBeTruthy();
  });

  it('renders exactly one card for LASK–Liverpool and one card for Feyenoord–Como in HomeView Overview', async () => {
    const liveDuplicatesFeed: Fixture[] = [
      {
        id: 'fd-575351',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '675', name: 'Feyenoord Rotterdam', shortName: 'Feyenoord', tla: 'FEY' },
        awayTeam: { id: '7397', name: 'Como 1907', shortName: 'Como 1907', tla: 'COM' },
        score: { home: 2, away: 1, halftime: { home: 1, away: 1 } },
        isDelayed: true,
      },
      {
        id: 'fd-575350',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '2016', name: 'LASK Linz', shortName: 'LASK', tla: 'LIN' },
        awayTeam: { id: '64', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
        score: { home: 1, away: 5, halftime: { home: 0, away: 3 } },
        isDelayed: true,
      },
      {
        id: 'sp-13596816',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        minute: 69,
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '180', name: 'Feyenoord', shortName: 'Feyenoord', tla: 'FEY' },
        awayTeam: { id: '19', name: 'Como', shortName: 'Como', tla: 'COM' },
        score: { home: 2, away: 1 },
        isDelayed: false,
      },
      {
        id: 'sp-13596817',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        minute: 74,
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '137', name: 'LASK', shortName: 'LASK', tla: 'LAS' },
        awayTeam: { id: '312', name: 'Liverpool', shortName: 'Liverpool', tla: 'LIV' },
        score: { home: 1, away: 6 },
        isDelayed: false,
      },
    ];

    vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue(
      groupFixturesByCompetition(liveDuplicatesFeed).flatMap((g) => g.fixtures)
    );
    vi.spyOn(FixtureService, 'getCompetitions').mockResolvedValue([]);
    vi.spyOn(FixtureService, 'getAllSupportedStandings').mockResolvedValue({
      PL: null,
      CL: null,
      PD: null,
      SA: null,
    });

    render(
      <HomeView
        timezoneId="Africa/Lagos"
        onNavigate={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'UEFA Champions League' })).toBeTruthy();
    });

    // UEFA Champions League group indicates 2 matches (not 4)
    expect(screen.getAllByText('2 matches').length).toBeGreaterThanOrEqual(1);

    // Liverpool card appears once in HomeView
    const liverpoolCards = screen.getAllByText('Liverpool');
    expect(liverpoolCards).toHaveLength(1);

    // Feyenoord card appears once in HomeView
    const feyenoordCards = screen.getAllByText('Feyenoord');
    expect(feyenoordCards).toHaveLength(1);
  });
});

