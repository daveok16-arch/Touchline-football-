import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FixtureCard } from '../src/components/FixtureCard';
import { EmptyState } from '../src/components/EmptyState';
import { Fixture } from '../src/types/football';

describe('Match Status, Scores & Error Display Integrity', () => {
  const baseFixture: Fixture = {
    id: 'test-fx-1',
    utcKickoffTime: '2026-10-11T16:00:00Z',
    status: 'SCHEDULED',
    competition: {
      id: 'PL',
      name: 'Premier League',
      code: 'PL',
      type: 'LEAGUE',
      country: 'England',
      season: '2024/25',
      isSupported: true,
    },
    homeTeam: { id: 't1', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
    awayTeam: { id: 't2', name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
  };

  it('A score alone NEVER determines match status: scheduled fixture with accidental score stays SCHEDULED', () => {
    const scheduledWithAccidentalScore: Fixture = {
      ...baseFixture,
      status: 'SCHEDULED',
      score: { home: 3, away: 0 },
    };

    render(
      <FixtureCard
        fixture={scheduledWithAccidentalScore}
        timezoneId="Africa/Lagos"
        onSelect={() => {}}
      />
    );

    // Must show VS, not 3:0
    expect(screen.getByText('VS')).toBeTruthy();
    expect(screen.queryByText('3')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();

    // Must show kickoff time
    expect(screen.getAllByText('17:00 WAT').length).toBeGreaterThanOrEqual(1);
  });

  it('A finished match with missing score displays "Score unrecorded" and does not invent zeros', () => {
    const finishedWithMissingScore: Fixture = {
      ...baseFixture,
      status: 'FINISHED',
      score: undefined,
    };

    render(
      <FixtureCard
        fixture={finishedWithMissingScore}
        timezoneId="Africa/Lagos"
        onSelect={() => {}}
      />
    );

    expect(screen.getByText('Score unrecorded')).toBeTruthy();
    expect(screen.getByText('– : –')).toBeTruthy();
    expect(screen.getByText('FT')).toBeTruthy();
  });

  it('A finished match with real score displays the actual scores accurately', () => {
    const finishedWithScore: Fixture = {
      ...baseFixture,
      status: 'FINISHED',
      score: { home: 2, away: 1 },
    };

    render(
      <FixtureCard
        fixture={finishedWithScore}
        timezoneId="Africa/Lagos"
        onSelect={() => {}}
      />
    );

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('FT')).toBeTruthy();
  });

  it('Delayed in-play match displays delayed status and does not label as live', () => {
    const delayedFixture: Fixture = {
      ...baseFixture,
      status: 'IN_PLAY',
      minute: 68,
      isDelayed: true,
      score: { home: 1, away: 1 },
    };

    render(
      <FixtureCard
        fixture={delayedFixture}
        timezoneId="Africa/Lagos"
        onSelect={() => {}}
      />
    );

    expect(screen.getByText(/Delayed – In-Play 68'/i)).toBeTruthy();
  });

  it('EmptyState for unconfigured provider displays concise honest message', () => {
    render(
      <EmptyState
        type="not_configured"
        onRetry={() => {}}
      />
    );
    expect(screen.getByText('Football data is not connected yet.')).toBeTruthy();
    expect(screen.getByText(/key has not been configured/i)).toBeTruthy();
  });

  it('EmptyState for temporarily unavailable provider displays clear message with retry', () => {
    render(
      <EmptyState
        type="unavailable"
        onRetry={() => {}}
      />
    );
    expect(screen.getByText('Football data is temporarily unavailable. Try again.')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('EmptyState for no fixtures found displays honest notice', () => {
    render(
      <EmptyState
        type="no_fixtures"
      />
    );
    expect(screen.getByText('No fixtures found for this date.')).toBeTruthy();
  });

  it('Suspended match displays Suspended status and does not label as scheduled or in-play', () => {
    const suspendedFixture: Fixture = {
      ...baseFixture,
      status: 'SUSPENDED',
    };

    render(
      <FixtureCard
        fixture={suspendedFixture}
        timezoneId="Africa/Lagos"
        onSelect={() => {}}
      />
    );

    expect(screen.getByText('Suspended')).toBeTruthy();
    expect(screen.queryByText(/WAT/)).toBeNull();
  });
});
