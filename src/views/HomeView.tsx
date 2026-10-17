import React, { useState, useEffect, useMemo } from 'react';
import { Fixture, Competition, CompetitionStandings, MatchIntelligence } from '../types/football';
import { FixtureService } from '../services/fixtureService';
import { FixtureCard } from '../components/FixtureCard';
import { EmptyState } from '../components/EmptyState';
import { DailyMatchIntelligence } from '../components/DailyMatchIntelligence';
import { evaluateMatchIntelligence, rankEligibleMatches, isGenuinelyUpcomingFixture } from '../services/predictionEngine';
import { getTimezoneAbbr, getDateKeyInTimezone, formatMatchDate } from '../utils/timezone';
import { groupFixturesByCompetition } from '../utils/competitionGrouping';
import {
  Calendar,
  Filter,
  ArrowRight,
  Trophy,
  Layers,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from 'lucide-react';

interface HomeViewProps {
  timezoneId: string;
  onNavigate: (view: string, matchId?: string) => void;
  onSelectCompetition?: (compId: string) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  timezoneId,
  onNavigate,
}) => {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [allUpcomingFixtures, setAllUpcomingFixtures] = useState<Fixture[]>([]);
  const [standingsMap, setStandingsMap] = useState<Record<string, CompetitionStandings | null>>({
    PL: null,
    CL: null,
    PD: null,
    SA: null,
  });
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Compute standard date keys in Africa/Lagos (WAT)
  const todayKey = useMemo(() => getDateKeyInTimezone(new Date().toISOString(), timezoneId), [timezoneId]);
  const yesterdayKey = useMemo(
    () => getDateKeyInTimezone(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), timezoneId),
    [timezoneId]
  );
  const tomorrowKey = useMemo(
    () => getDateKeyInTimezone(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), timezoneId),
    [timezoneId]
  );

  // Default to today's fixtures on first open
  const [selectedDate, setSelectedDate] = useState<string>(() =>
    getDateKeyInTimezone(new Date().toISOString(), timezoneId)
  );
  const [selectedCompId, setSelectedCompId] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<'ALL' | 'LIVE' | 'SCHEDULED' | 'FINISHED'>('ALL');
  const [retryNonce, setRetryNonce] = useState(0);

  // Keep selectedDate updated when timezone changes if user had Today selected
  useEffect(() => {
    if (selectedDate === yesterdayKey || selectedDate === todayKey || selectedDate === tomorrowKey) {
      setSelectedDate(todayKey);
    }
  }, [timezoneId]);

  // Derive dynamic quick date buttons
  const quickDates = useMemo(() => {
    return [
      { label: 'Today', dateKey: todayKey },
      { label: 'Tomorrow', dateKey: tomorrowKey },
      { label: 'Yesterday', dateKey: yesterdayKey },
      { label: 'All Scheduled', dateKey: 'ALL' },
    ];
  }, [todayKey, tomorrowKey, yesterdayKey]);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    setErrorCode(null);

    Promise.all([
      FixtureService.getFixtures({
        dateKey: selectedDate,
        competitionId: selectedCompId,
        status: selectedStatus,
        timezoneId,
      }),
      FixtureService.getCompetitions(),
      FixtureService.getAllSupportedStandings(),
      FixtureService.getFixtures({
        status: 'SCHEDULED',
        timezoneId,
      }),
    ])
      .then(([fixs, comps, standings, upcoming]) => {
        if (!isMounted) return;
        setFixtures(fixs);
        setCompetitions(comps);
        setStandingsMap(standings);
        setAllUpcomingFixtures(upcoming);
        setLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(err.message || 'Football data is temporarily unavailable. Try again.');
        setErrorCode(err.code || 'PROVIDER_ERROR');
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedDate, selectedCompId, selectedStatus, timezoneId, retryNonce]);

  const handleRetry = () => {
    setRetryNonce((prev) => prev + 1);
  };

  // Date step helper
  const handleStepDay = (step: number) => {
    const currentMs = selectedDate === 'ALL' ? Date.now() : new Date(selectedDate).getTime();
    const target = new Date(currentMs + step * 24 * 60 * 60 * 1000);
    const newKey = getDateKeyInTimezone(target.toISOString(), timezoneId);
    if (newKey) {
      setSelectedDate(newKey);
    }
  };

  // Evaluate Daily Match Intelligence
  const { intelligenceList, evaluatedFixtures, usingFallback } = useMemo(() => {
    // 1. Check if fixtures for the current view contain genuinely upcoming matches
    const currentUpcoming = fixtures.filter((f) => isGenuinelyUpcomingFixture(f));

    // When the selected date has no genuinely upcoming match, rank the next upcoming fixtures
    // instead. `usingFallback` is surfaced to the user so a later date's predictions are never
    // mistaken for the selected day's own predictions.
    const usingFallback = currentUpcoming.length === 0;
    const targetFixtures = usingFallback
      ? allUpcomingFixtures.filter((f) => isGenuinelyUpcomingFixture(f))
      : currentUpcoming;

    const evaluated = targetFixtures.map((f) => evaluateMatchIntelligence(f, standingsMap));
    return {
      intelligenceList: rankEligibleMatches(evaluated),
      evaluatedFixtures: evaluated,
      usingFallback,
    };
  }, [fixtures, allUpcomingFixtures, standingsMap]);

  // Group fixtures by canonical competition (single heading per competition)
  const competitionGroups = useMemo(() => {
    return groupFixturesByCompetition(fixtures);
  }, [fixtures]);

  const getActiveDateLabel = () => {
    if (selectedDate === 'ALL') return 'All Scheduled Dates';
    if (selectedDate === todayKey) return `Today (${getTimezoneAbbr(timezoneId)})`;
    if (selectedDate === tomorrowKey) return `Tomorrow (${getTimezoneAbbr(timezoneId)})`;
    if (selectedDate === yesterdayKey) return `Yesterday (${getTimezoneAbbr(timezoneId)})`;
    return `${selectedDate} (${getTimezoneAbbr(timezoneId)})`;
  };

  return (
    <div className="space-y-8 pb-16">
      {/* Overview Hero Section */}
      <section className="bg-gradient-to-b from-[#0D1629] to-[#0A101E] border border-slate-800/80 rounded-2xl p-6 sm:p-8">
        <div className="max-w-4xl space-y-3">
          <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
            <span>Project Touchline</span>
            <span aria-hidden="true">•</span>
            <span>Football Intelligence</span>
            <span aria-hidden="true">•</span>
            <span className="text-emerald-400 font-mono">Timezone: {getTimezoneAbbr(timezoneId)}</span>
          </div>
          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
            Football Match Center
          </h1>
          <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-2xl">
            Live fixtures, daily match intelligence, and standings across the top European leagues and tournaments.
          </p>
        </div>

        {/* Clean Overview KPI Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-6 border-t border-slate-800/80">
          <div className="bg-[#090D16]/60 border border-slate-800 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">Active Date</span>
            <span className="text-sm font-semibold text-white font-mono mt-0.5 block truncate">
              {getActiveDateLabel()}
            </span>
          </div>
          <div className="bg-[#090D16]/60 border border-slate-800 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">Matches</span>
            <span className="text-sm font-semibold text-emerald-400 font-mono mt-0.5 block tabular-nums">
              {loading ? '...' : fixtures.length} matches
            </span>
          </div>
          <div className="bg-[#090D16]/60 border border-slate-800 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">Ranked Predictions</span>
            <span className="text-sm font-semibold text-white font-mono mt-0.5 block tabular-nums">
              {loading ? '...' : intelligenceList.filter((m) => m.isEligible).length} evaluated
            </span>
          </div>
          <div className="bg-[#090D16]/60 border border-slate-800 rounded-lg p-3">
            <span className="text-xs text-slate-400 block">Timezone</span>
            <span className="text-sm font-semibold text-slate-300 font-mono mt-0.5 block truncate">
              {getTimezoneAbbr(timezoneId)}
            </span>
          </div>
        </div>
      </section>

      {/* Daily Match Intelligence Section */}
      <DailyMatchIntelligence
        intelligenceList={intelligenceList}
        evaluatedFixtures={evaluatedFixtures}
        usingFallback={usingFallback}
        selectedDateLabel={getActiveDateLabel()}
        loading={loading}
        timezoneId={timezoneId}
        onNavigateToMatch={(id) => onNavigate('match', id)}
      />

      {/* Main Fixtures Section */}
      <section className="space-y-5">
        {/* Section Header & Filter Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <Calendar className="w-5 h-5 text-emerald-400" />
              <span>Fixtures & Results</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Kickoff times shown in {getTimezoneAbbr(timezoneId)} • Showing {getActiveDateLabel()}
            </p>
          </div>

          {/* Date Navigation & Quick Switcher */}
          <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
            {/* Prev / Next Steppers */}
            <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
              <button
                onClick={() => handleStepDay(-1)}
                title="Previous Day"
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded transition-colors"
                aria-label="Previous day"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleStepDay(1)}
                title="Next Day"
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded transition-colors"
                aria-label="Next day"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Date Segmented Control */}
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
              {quickDates.map((item) => {
                const active = selectedDate === item.dateKey;
                return (
                  <button
                    key={item.dateKey}
                    onClick={() => setSelectedDate(item.dateKey)}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Secondary Filter Row: Competition & Status */}
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Competition Segment */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-slate-400 font-medium mr-1 flex items-center gap-1">
              <Filter className="w-3.5 h-3.5" />
              <span>League:</span>
            </span>
            <button
              onClick={() => setSelectedCompId('ALL')}
              className={`px-2.5 py-1 rounded text-xs transition-colors whitespace-nowrap ${
                selectedCompId === 'ALL'
                  ? 'bg-slate-800 text-white font-semibold border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All
            </button>
            {competitions.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCompId(c.id)}
                className={`px-2.5 py-1 rounded text-xs transition-colors whitespace-nowrap ${
                  selectedCompId === c.id
                    ? 'bg-slate-800 text-white font-semibold border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>

          {/* Status Segment */}
          <div className="flex items-center gap-1 bg-slate-900/80 border border-slate-800/80 p-0.5 rounded">
            {(['ALL', 'LIVE', 'SCHEDULED', 'FINISHED'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setSelectedStatus(status)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                  selectedStatus === status
                    ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-800/60'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {status === 'ALL'
                  ? 'All'
                  : status === 'LIVE'
                  ? 'In Play'
                  : status === 'SCHEDULED'
                  ? 'Scheduled'
                  : 'Full Time'}
              </button>
            ))}
          </div>
        </div>

        {/* Fixtures Area: Loading, Error, Empty, or Populated */}
        {loading ? (
          <div className="space-y-3 py-6">
            <div className="h-5 w-40 bg-slate-800 rounded animate-pulse" />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="h-28 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
              <div className="h-28 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
              <div className="h-28 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
              <div className="h-28 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
            </div>
          </div>
        ) : error ? (
          <EmptyState
            type={errorCode === 'PROVIDER_NOT_CONFIGURED' ? 'not_configured' : 'unavailable'}
            title={
              errorCode === 'PROVIDER_NOT_CONFIGURED'
                ? 'Football data is not connected yet.'
                : 'Football data is temporarily unavailable. Try again.'
            }
            description={
              errorCode === 'PROVIDER_NOT_CONFIGURED'
                ? 'Configure FOOTBALL_DATA_API_KEY in the environment to stream real match data.'
                : 'Please try again in a few moments.'
            }
            onRetry={handleRetry}
          />
        ) : fixtures.length === 0 ? (
          <EmptyState
            type="no_fixtures"
            title={
              selectedDate === todayKey
                ? 'No fixtures scheduled for today in WAT.'
                : selectedDate === tomorrowKey
                ? 'No fixtures scheduled for tomorrow in WAT.'
                : 'No fixtures found for this date.'
            }
            description={
              selectedDate === todayKey
                ? 'There are no matches scheduled today in the supported European leagues. Check tomorrow or explore all scheduled dates.'
                : 'There are no scheduled matches matching your active filters.'
            }
            onRetry={() => {
              if (selectedDate === todayKey) {
                setSelectedDate(tomorrowKey);
              } else {
                setSelectedDate('ALL');
              }
              setSelectedCompId('ALL');
              setSelectedStatus('ALL');
            }}
            retryLabel={selectedDate === todayKey ? "View Tomorrow's Fixtures" : 'View All Scheduled Fixtures'}
          />
        ) : (
          <div className="space-y-6">
            {competitionGroups.map((group) => (
              <div key={group.id} className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                  <div className="flex items-center gap-2">
                    <h2 className="font-bold text-slate-200 text-sm tracking-tight">{group.name}</h2>
                    <span aria-hidden="true" className="text-slate-600">•</span>
                    <span>{group.fixtures.length} matches</span>
                  </div>
                  <button
                    onClick={() => onNavigate('fixtures')}
                    className="text-emerald-400 hover:text-emerald-300 font-medium hover:underline flex items-center gap-1"
                  >
                    <span>View in schedule</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {group.fixtures.map((fixture) => (
                    <FixtureCard
                      key={fixture.id}
                      fixture={fixture}
                      timezoneId={timezoneId}
                      onSelect={(id) => onNavigate('match', id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Navigation Modules */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
        <div
          onClick={() => onNavigate('fixtures')}
          className="group bg-[#0D1526] hover:bg-[#111C33] border border-slate-800 rounded-xl p-5 transition-colors cursor-pointer flex flex-col justify-between"
        >
          <div>
            <div className="w-9 h-9 rounded bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-3">
              <Calendar className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold text-white group-hover:text-emerald-300 transition-colors">
              Fixtures Browser
            </h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Explore full calendars, filter by league, and search fixtures by team name.
            </p>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs font-semibold text-emerald-400">
            <span>Browse Fixtures</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>

        <div
          onClick={() => onNavigate('competitions')}
          className="group bg-[#0D1526] hover:bg-[#111C33] border border-slate-800 rounded-xl p-5 transition-colors cursor-pointer flex flex-col justify-between"
        >
          <div>
            <div className="w-9 h-9 rounded bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 mb-3">
              <Layers className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold text-white group-hover:text-blue-300 transition-colors">
              Competitions
            </h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Premier League, Champions League, La Liga, and Serie A coverage.
            </p>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs font-semibold text-blue-400">
            <span>View Competitions</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>

        <div
          onClick={() => onNavigate('standings')}
          className="group bg-[#0D1526] hover:bg-[#111C33] border border-slate-800 rounded-xl p-5 transition-colors cursor-pointer flex flex-col justify-between"
        >
          <div>
            <div className="w-9 h-9 rounded bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3">
              <Trophy className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold text-white group-hover:text-amber-300 transition-colors">
              League Standings
            </h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Live league table rankings, points, goal difference, and games played.
            </p>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs font-semibold text-amber-400">
            <span>View Standings</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>
      </section>
    </div>
  );
};
