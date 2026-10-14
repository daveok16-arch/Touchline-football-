import React, { useState, useEffect, useMemo } from 'react';
import { Fixture, Competition } from '../types/football';
import { FixtureService } from '../services/fixtureService';
import { FixtureCard } from '../components/FixtureCard';
import { EmptyState } from '../components/EmptyState';
import { getTimezoneAbbr, getDateKeyInTimezone } from '../utils/timezone';
import { groupFixturesByCompetition } from '../utils/competitionGrouping';
import {
  Calendar,
  Filter,
  Search,
  X,
} from 'lucide-react';

interface FixturesViewProps {
  timezoneId: string;
  onSelectFixture: (fixtureId: string) => void;
  initialCompetitionId?: string;
}

export const FixturesView: React.FC<FixturesViewProps> = ({
  timezoneId,
  onSelectFixture,
  initialCompetitionId,
}) => {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Filters
  const [selectedDate, setSelectedDate] = useState<string>('ALL');
  const [selectedCompetition, setSelectedCompetition] = useState<string>(initialCompetitionId || 'ALL');
  const [selectedStatus, setSelectedStatus] = useState<'ALL' | 'LIVE' | 'SCHEDULED' | 'FINISHED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [retryNonce, setRetryNonce] = useState(0);

  // Quick dates
  const quickDates = useMemo(() => {
    const now = new Date();
    const todayKey = getDateKeyInTimezone(now.toISOString(), timezoneId);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayKey = getDateKeyInTimezone(yesterday.toISOString(), timezoneId);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowKey = getDateKeyInTimezone(tomorrow.toISOString(), timezoneId);

    return [
      { label: 'All Dates', dateKey: 'ALL' },
      { label: 'Yesterday', dateKey: yesterdayKey },
      { label: 'Today', dateKey: todayKey },
      { label: 'Tomorrow', dateKey: tomorrowKey },
    ];
  }, [timezoneId]);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    setErrorCode(null);

    Promise.all([
      FixtureService.getFixtures({
        dateKey: selectedDate,
        competitionId: selectedCompetition,
        status: selectedStatus,
        searchQuery,
        timezoneId,
      }),
      FixtureService.getCompetitions(),
    ])
      .then(([fixs, comps]) => {
        if (!isMounted) return;
        setFixtures(fixs);
        setCompetitions(comps);
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
  }, [selectedDate, selectedCompetition, selectedStatus, searchQuery, timezoneId, retryNonce]);

  const handleRetry = () => {
    setRetryNonce((prev) => prev + 1);
  };

  const resetAllFilters = () => {
    setSelectedDate('ALL');
    setSelectedCompetition('ALL');
    setSelectedStatus('ALL');
    setSearchQuery('');
  };

  const hasActiveFilters =
    selectedDate !== 'ALL' ||
    selectedCompetition !== 'ALL' ||
    selectedStatus !== 'ALL' ||
    searchQuery.trim().length > 0;

  // Group all displayed fixtures by canonical competition (exactly one heading per competition)
  const competitionGroups = useMemo(() => {
    return groupFixturesByCompetition(fixtures);
  }, [fixtures]);

  return (
    <div className="space-y-6 pb-16">
      {/* Title & Context Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Project Touchline</span>
            <span aria-hidden="true">•</span>
            <span className="font-mono text-emerald-400">Schedule ({getTimezoneAbbr(timezoneId)})</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mt-1 flex items-center gap-2">
            <Calendar className="w-6 h-6 text-emerald-400" />
            <span>Fixtures</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Schedules and results across supported leagues.
          </p>
        </div>

        {fixtures.length > 0 && !loading && (
          <div className="text-xs text-slate-400 sm:text-right">
            <span>Showing </span>
            <span className="font-bold text-emerald-400 font-mono tabular-nums">{fixtures.length}</span>
            <span> matches</span>
          </div>
        )}
      </div>

      {/* Filter Controls Panel */}
      <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        {/* Top Filter Row: Search & Status */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-center">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by team or venue..."
              className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-8 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Status Segment */}
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 p-1 rounded-lg">
            {(['ALL', 'LIVE', 'SCHEDULED', 'FINISHED'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setSelectedStatus(status)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                  selectedStatus === status
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/80'
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

        {/* Date Filter Quick Bar */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-800/60">
          <span className="text-xs text-slate-400 font-medium mr-1">Date:</span>
          {quickDates.map((d) => (
            <button
              key={d.dateKey}
              onClick={() => setSelectedDate(d.dateKey)}
              className={`px-3 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                selectedDate === d.dateKey
                  ? 'bg-slate-800 text-white font-semibold border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        {/* Competition Filter Quick Bar */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-800/60">
          <span className="text-xs text-slate-400 font-medium mr-1 flex items-center gap-1">
            <Filter className="w-3 h-3" />
            <span>League:</span>
          </span>
          <button
            onClick={() => setSelectedCompetition('ALL')}
            className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap ${
              selectedCompetition === 'ALL'
                ? 'bg-slate-800 text-white font-semibold border border-slate-700'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            All
          </button>
          {competitions.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCompetition(c.id)}
              className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                selectedCompetition === c.id
                  ? 'bg-slate-800 text-white font-semibold border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              {c.name}
            </button>
          ))}
          {hasActiveFilters && (
            <button
              onClick={resetAllFilters}
              className="ml-auto text-xs text-emerald-400 hover:text-emerald-300 underline font-medium"
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* Main Fixtures Listing */}
      {loading ? (
        <div className="space-y-4 py-6">
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
              ? 'Add FOOTBALL_DATA_API_KEY to your environment variables to load live fixtures.'
              : 'Please try again in a few moments.'
          }
          onRetry={handleRetry}
        />
      ) : fixtures.length === 0 ? (
        <EmptyState
          type="no_fixtures"
          title="No fixtures found for this date."
          description="Try selecting a different date or clearing your competition filter."
          onRetry={resetAllFilters}
          retryLabel="Show All Matches"
        />
      ) : (
        <div className="space-y-6">
          {competitionGroups.map((group) => (
            <div key={group.id} className="space-y-3" data-testid={`competition-group-${group.id}`}>
              <div className="flex items-center justify-between text-xs text-slate-400 px-1 border-b border-slate-800/80 pb-2">
                <h2 className="font-bold text-slate-200 text-sm tracking-tight" data-testid="competition-heading">{group.name}</h2>
                <span>{group.fixtures.length} matches</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.fixtures.map((fixture) => (
                  <FixtureCard
                    key={fixture.id}
                    fixture={fixture}
                    timezoneId={timezoneId}
                    onSelect={onSelectFixture}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
