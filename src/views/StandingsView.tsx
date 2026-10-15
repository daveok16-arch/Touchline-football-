import React, { useState, useEffect, useMemo } from 'react';
import { CompetitionStandings, Competition } from '../types/football';
import { FixtureService } from '../services/fixtureService';
import { EmptyState } from '../components/EmptyState';
import { Trophy, RefreshCw } from 'lucide-react';

export const StandingsView: React.FC = () => {
  const standingsCompetitions = useMemo<Competition[]>(
    () => FixtureService.getStandingsSupportedCompetitions(),
    []
  );
  const [selectedCompCode, setSelectedCompCode] = useState<string>(standingsCompetitions[0]?.code || 'PL');
  const [standings, setStandings] = useState<CompetitionStandings | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState<number>(0);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    setErrorCode(null);

    FixtureService.getStandings(selectedCompCode)
      .then((data) => {
        if (!isMounted) return;
        setStandings(data);
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
  }, [selectedCompCode, retryNonce]);

  const handleRetry = () => {
    setRetryNonce((prev) => prev + 1);
  };

  const activeComp =
    standingsCompetitions.find((c) => c.code === selectedCompCode) ||
    standingsCompetitions[0];

  return (
    <div className="space-y-6 pb-16 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Project Touchline</span>
            <span aria-hidden="true">•</span>
            <span className="font-mono text-emerald-400">League Tables</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mt-1 flex items-center gap-2.5">
            <Trophy className="w-6 h-6 text-emerald-400" />
            <span>Standings</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Real standings table directly from the connected football provider.
          </p>
        </div>

        {/* Competition Selector Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-900 border border-slate-800 rounded-lg self-start sm:self-auto">
          {standingsCompetitions.map((c) => (
            <button
              key={c.code}
              onClick={() => setSelectedCompCode(c.code)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                selectedCompCode === c.code
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="h-6 w-48 bg-slate-800 rounded animate-pulse" />
          <div className="space-y-2">
            {[...Array(10)].map((_, i) => (
              <div key={i} className="h-10 bg-slate-900 rounded animate-pulse" />
            ))}
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
              ? 'Add FOOTBALL_DATA_API_KEY to your environment variables to load league standings.'
              : 'Unable to reach the provider right now.'
          }
          onRetry={handleRetry}
        />
      ) : !standings || standings.table.length === 0 ? (
        <EmptyState
          type="no_fixtures"
          title="No standings available for this competition."
          description="Standings data has not been published yet for the current season."
          onRetry={handleRetry}
        />
      ) : (
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          <div className="px-5 py-3.5 bg-[#0B1120] border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center gap-2">
              {standings.competition.emblem && (
                <img
                  src={standings.competition.emblem}
                  alt={standings.competition.name}
                  className="w-5 h-5 object-contain"
                />
              )}
              <span className="font-bold text-white text-sm">{standings.competition.name}</span>
              {standings.season.currentMatchday && (
                <>
                  <span aria-hidden="true" className="text-slate-600">•</span>
                  <span>Matchday {standings.season.currentMatchday}</span>
                </>
              )}
            </div>
            <span className="text-[11px] font-mono text-slate-500">
              Season {standings.competition.season || '2024/25'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#0D1526] text-slate-400 font-semibold border-b border-slate-800">
                <tr>
                  <th className="py-3 px-3 text-center w-12">#</th>
                  <th className="py-3 px-4">Club</th>
                  <th className="py-3 px-3 text-center">P</th>
                  <th className="py-3 px-3 text-center">W</th>
                  <th className="py-3 px-3 text-center">D</th>
                  <th className="py-3 px-3 text-center">L</th>
                  <th className="py-3 px-3 text-center font-mono">GD</th>
                  <th className="py-3 px-4 text-center font-bold text-white">PTS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-medium">
                {standings.table.map((entry) => (
                  <tr
                    key={entry.team.id}
                    className="hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 px-3 text-center font-mono text-slate-400">
                      {entry.position}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded bg-slate-800 flex items-center justify-center overflow-hidden shrink-0">
                          {entry.team.crest ? (
                            <img
                              src={entry.team.crest}
                              alt={entry.team.name}
                              className="w-5 h-5 object-contain"
                            />
                          ) : (
                            <span className="text-[10px] font-bold text-slate-300">
                              {entry.team.tla}
                            </span>
                          )}
                        </div>
                        <span className="font-semibold text-white truncate max-w-[200px] sm:max-w-none">
                          {entry.team.name}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-slate-300">
                      {entry.playedGames}
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-slate-400">
                      {entry.won}
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-slate-400">
                      {entry.draw}
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-slate-400">
                      {entry.lost}
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-slate-300">
                      {entry.goalDifference > 0 ? `+${entry.goalDifference}` : entry.goalDifference}
                    </td>
                    <td className="py-3 px-4 text-center font-mono font-bold text-emerald-400 text-sm">
                      {entry.points}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
