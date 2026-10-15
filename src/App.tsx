/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { HomeView } from './views/HomeView';
import { FixturesView } from './views/FixturesView';
import { MatchDetailView } from './views/MatchDetailView';
import { CompetitionsView } from './views/CompetitionsView';
import { StandingsView } from './views/StandingsView';
import { DEFAULT_TIMEZONE, getResolvedTimezone, getTimezoneAbbr } from './utils/timezone';
import {
  LayoutDashboard,
  Calendar,
  Trophy,
  BarChart2,
} from 'lucide-react';

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
    <div className="min-h-screen bg-[#090D16] text-slate-100 flex flex-col font-sans selection:bg-emerald-500/20 selection:text-emerald-300">
      {/* Top Application Header */}
      <Header
        currentView={currentView}
        onNavigate={navigateTo}
        timezoneId={timezoneId}
        onTimezoneChange={setTimezoneId}
      />

      {/* Main View Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-20">
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

        {currentView === 'standings' && (
          <StandingsView />
        )}
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0D1526]/95 backdrop-blur-md border-t border-slate-800 py-1.5 px-4">
        <div className="grid grid-cols-4 gap-1 text-center">
          <button
            onClick={() => navigateTo('home')}
            className={`flex flex-col items-center py-1 rounded transition-colors ${
              currentView === 'home' ? 'text-emerald-400 font-semibold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutDashboard className="w-4 h-4 mb-0.5" />
            <span className="text-[10px]">Overview</span>
          </button>
          <button
            onClick={() => navigateTo('fixtures')}
            className={`flex flex-col items-center py-1 rounded transition-colors ${
              currentView === 'fixtures' || currentView === 'match'
                ? 'text-emerald-400 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Calendar className="w-4 h-4 mb-0.5" />
            <span className="text-[10px]">Fixtures</span>
          </button>
          <button
            onClick={() => navigateTo('competitions')}
            className={`flex flex-col items-center py-1 rounded transition-colors ${
              currentView === 'competitions' ? 'text-emerald-400 font-semibold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Trophy className="w-4 h-4 mb-0.5" />
            <span className="text-[10px]">Leagues</span>
          </button>
          <button
            onClick={() => navigateTo('standings')}
            className={`flex flex-col items-center py-1 rounded transition-colors ${
              currentView === 'standings' ? 'text-emerald-400 font-semibold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <BarChart2 className="w-4 h-4 mb-0.5" />
            <span className="text-[10px]">Standings</span>
          </button>
        </div>
      </div>

      {/* Desktop Footer */}
      <footer className="border-t border-slate-800/80 bg-[#070B13] py-8 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-300">Project Touchline</span>
              <span aria-hidden="true" className="text-slate-700">•</span>
              <span className="text-slate-400">Football Intelligence</span>
            </div>
            <div className="flex items-center gap-4 text-slate-400">
              <button
                onClick={() => navigateTo('home')}
                className="hover:text-slate-200 transition-colors"
              >
                Overview
              </button>
              <button
                onClick={() => navigateTo('fixtures')}
                className="hover:text-slate-200 transition-colors"
              >
                Fixtures
              </button>
              <button
                onClick={() => navigateTo('competitions')}
                className="hover:text-slate-200 transition-colors"
              >
                Competitions
              </button>
              <button
                onClick={() => navigateTo('standings')}
                className="hover:text-slate-200 transition-colors"
              >
                Standings
              </button>
            </div>
          </div>
          <div className="pt-3 border-t border-slate-800/50 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-slate-500">
            <p>
              Data provided via Football-Data.org Free Tier proxy.
            </p>
            <p className="font-mono text-slate-400">
              Timezone: {getResolvedTimezone(timezoneId)} ({getTimezoneAbbr(timezoneId)})
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
