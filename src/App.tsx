/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AppLayout } from './layout';
import { HomeView } from './views/HomeView';
import { FixturesView } from './views/FixturesView';
import { MatchDetailView } from './views/MatchDetailView';
import { CompetitionsView } from './views/CompetitionsView';
import { StandingsView } from './views/StandingsView';
import { DEFAULT_TIMEZONE } from './utils/timezone';

export default function App() {
  const [currentView, setCurrentView] = useState<'home' | 'fixtures' | 'match' | 'competitions' | 'standings'>('home');
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [timezoneId, setTimezoneId] = useState<string>(DEFAULT_TIMEZONE);
  const [filterCompetitionId, setFilterCompetitionId] = useState<string | undefined>(undefined);

  // Sync hash routing with view state
  const handleHashChange = useCallback(() => {
    const rawHash = window.location.hash.replace('#', '') || 'home';
    const [pathPart, queryPart] = rawHash.split('?');
    const queryParams = new URLSearchParams(queryPart || '');

    if (pathPart.startsWith('match/')) {
      const matchId = pathPart.replace('match/', '').trim();
      setSelectedMatchId(matchId || null);
      setCurrentView('match');
    } else if (pathPart === 'fixtures') {
      const comp = queryParams.get('comp') || undefined;
      setFilterCompetitionId(comp);
      setCurrentView('fixtures');
    } else if (pathPart === 'competitions') {
      setCurrentView('competitions');
    } else if (pathPart === 'standings') {
      setCurrentView('standings');
    } else {
      setCurrentView('home');
    }
  }, []);

  useEffect(() => {
    window.addEventListener('hashchange', handleHashChange);
    if (window.location.hash) {
      handleHashChange();
    }
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [handleHashChange]);

  const navigateTo = (view: string, matchId?: string) => {
    if (view === 'match' && matchId) {
      setSelectedMatchId(matchId);
      setCurrentView('match');
      window.location.hash = `match/${matchId}`;
    } else if (view === 'fixtures') {
      setCurrentView('fixtures');
      window.location.hash = filterCompetitionId ? `fixtures?comp=${filterCompetitionId}` : 'fixtures';
    } else {
      setCurrentView(view as any);
      window.location.hash = view;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSelectCompetition = (compId: string) => {
    setFilterCompetitionId(compId);
    setCurrentView('fixtures');
    window.location.hash = `fixtures?comp=${compId}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <AppLayout
      currentView={currentView}
      onNavigate={navigateTo}
      timezoneId={timezoneId}
      onTimezoneChange={setTimezoneId}
    >
      {currentView === 'home' && (
        <HomeView
          timezoneId={timezoneId}
          onNavigate={navigateTo}
          onSelectCompetition={handleSelectCompetition}
        />
      )}

      {currentView === 'fixtures' && (
        <FixturesView
          timezoneId={timezoneId}
          onSelectFixture={(id) => navigateTo('match', id)}
          initialCompetitionId={filterCompetitionId}
        />
      )}

      {currentView === 'match' && selectedMatchId && (
        <MatchDetailView
          matchId={selectedMatchId}
          timezoneId={timezoneId}
          onBack={() => navigateTo('fixtures')}
        />
      )}

      {currentView === 'competitions' && (
        <CompetitionsView
          onSelectCompetition={handleSelectCompetition}
          onNavigate={navigateTo}
        />
      )}

      {currentView === 'standings' && <StandingsView />}
    </AppLayout>
  );
}
