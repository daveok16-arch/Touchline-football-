import React, { useState, useEffect } from 'react';
import { Competition, Fixture } from '../types/football';
import { FixtureService } from '../services/fixtureService';
import { getRegistryEntryById } from '../services/competitionRegistry';
import { EmptyState } from '../components/EmptyState';
import { Trophy, Calendar, ArrowRight } from 'lucide-react';

interface CompetitionsViewProps {
  onSelectCompetition: (compId: string) => void;
  onNavigate: (view: string) => void;
}

export const CompetitionsView: React.FC<CompetitionsViewProps> = ({
  onSelectCompetition,
  onNavigate,
}) => {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    setErrorCode(null);

    Promise.all([
      FixtureService.getCompetitions(),
      FixtureService.getFixtures(),
    ])
      .then(([comps, fixs]) => {
        if (!isMounted) return;
        setCompetitions(comps);
        setFixtures(fixs);
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
  }, [retryNonce]);

  const handleRetry = () => {
    setRetryNonce((prev) => prev + 1);
  };

  // Count matches per competition
  const countsByComp = fixtures.reduce<Record<string, number>>((acc, f) => {
    if (f?.competition?.id) {
      acc[f.competition.id] = (acc[f.competition.id] || 0) + 1;
    }
    return acc;
  }, {});

  return (
    <div className="space-y-6 pb-16 max-w-5xl mx-auto">
      {/* Header */}
      <div className="border-b border-slate-800 pb-5">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Project Touchline</span>
          <span aria-hidden="true">•</span>
          <span className="font-mono text-emerald-400">Directory</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mt-1 flex items-center gap-2.5">
          <Trophy className="w-6 h-6 text-emerald-400" />
          <span>Competitions</span>
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-2xl leading-relaxed">
          Verified supported leagues and continental tournaments.
        </p>
      </div>

      {/* Directory Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-6">
          <div className="h-44 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
          <div className="h-44 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
          <div className="h-44 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
          <div className="h-44 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
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
              ? 'Configure FOOTBALL_DATA_API_KEY in the environment to connect live football leagues.'
              : 'Please try again in a few moments.'
          }
          onRetry={handleRetry}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {competitions.map((comp) => {
            const count = countsByComp[comp.id] || 0;
            return (
              <div
                key={comp.id}
                className="bg-[#0F172A] hover:bg-[#131F38] border border-slate-800/80 hover:border-slate-700 rounded-xl p-5 sm:p-6 transition-all flex flex-col justify-between space-y-4"
              >
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center p-2 shrink-0">
                    {comp.emblem ? (
                      <img
                        src={comp.emblem}
                        alt={comp.name}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <Trophy className="w-6 h-6 text-emerald-400" />
                    )}
                  </div>
                  <div className="space-y-1 min-w-0">
                    <h2 className="text-base sm:text-lg font-bold text-white tracking-tight truncate">
                      {comp.name}
                    </h2>
                    <p className="text-xs text-slate-400">
                      {comp.country} • {comp.season || '2024/25'}
                    </p>
                    {count > 0 && (
                      <span className="inline-block font-mono text-[11px] text-emerald-400/90 font-medium">
                        {count} scheduled matches
                      </span>
                    )}
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                  <button
                    onClick={() => onSelectCompetition(comp.id)}
                    className="inline-flex items-center gap-1.5 font-semibold text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    <Calendar className="w-3.5 h-3.5" />
                    <span>View Fixtures</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                  {getRegistryEntryById(comp.id)?.standings && (
                    <button
                      onClick={() => onNavigate('standings')}
                      className="inline-flex items-center gap-1.5 font-medium text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      <Trophy className="w-3.5 h-3.5 text-amber-400" />
                      <span>Table</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
