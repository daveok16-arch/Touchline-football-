import React, { useMemo, useState } from 'react';
import { MatchIntelligence } from '../types/football';
import { formatKickoffTime } from '../utils/timezone';
import { classifyIntelligenceOutcome } from '../analysis/matchPredictionReport';
import {
  Sparkles,
  ArrowRight,
  BarChart3,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  CalendarClock,
} from 'lucide-react';

interface DailyMatchIntelligenceProps {
  intelligenceList: MatchIntelligence[];
  /** Every fixture that was evaluated for this view (eligible and excluded), for the skip summary. */
  evaluatedFixtures: MatchIntelligence[];
  /** True when the selected date had no upcoming match and later fixtures were ranked instead. */
  usingFallback: boolean;
  /** Human-readable label for the currently selected date, used in the fallback notice. */
  selectedDateLabel: string;
  loading: boolean;
  timezoneId: string;
  onNavigateToMatch: (matchId: string) => void;
}

export const DailyMatchIntelligence: React.FC<DailyMatchIntelligenceProps> = ({
  intelligenceList,
  evaluatedFixtures,
  usingFallback,
  selectedDateLabel,
  loading,
  timezoneId,
  onNavigateToMatch,
}) => {
  const [showIneligible, setShowIneligible] = useState(false);

  const eligibleMatches = intelligenceList.filter((m) => m.isEligible && m.probabilities);
  // Excluded fixtures come from the full evaluated set: `intelligenceList` holds only ranked
  // (eligible) matches, so filtering it for ineligible ones always produced an empty list.
  const ineligibleMatches = evaluatedFixtures.filter((m) => !m.isEligible);

  // Count why each evaluated fixture was skipped, ordered by frequency (descending).
  const skipSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of evaluatedFixtures) {
      if (ev.isEligible) continue;
      const outcome = classifyIntelligenceOutcome(ev);
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count);
  }, [evaluatedFixtures]);

  return (
    <section className="bg-gradient-to-b from-[#0F172A] to-[#0B1120] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl relative overflow-hidden">
      {/* Subtle glow highlight */}
      <div className="absolute top-0 right-0 w-80 h-80 bg-emerald-500/5 blur-3xl pointer-events-none rounded-full" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <Sparkles className="w-3 h-3 text-emerald-400" />
              <span>Daily Match Intelligence</span>
            </span>
          </div>
          <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
            Upcoming Match Probability Rankings
          </h2>
        </div>
        <p className="text-xs text-slate-400 font-medium self-start sm:self-center">
          Probabilities are estimates, not guarantees.
        </p>
      </div>

      {/* Measured overconfidence notice: the frozen model overstates high-confidence picks.
          On held-out 2024/2025 it rated fixtures >=80% at 0.864 while they occurred 0.729. */}
      {!loading && eligibleMatches.length > 0 && (
        <p className="mt-3 text-[11px] text-slate-400 leading-relaxed">
          High-confidence picks are the model's weakest area: on 2024/25 data, matches it rated
          above 80% occurred 73% of the time. Treat the top probabilities as upper estimates.
        </p>
      )}

      {/* Fallback notice: the ranked list is not for the selected date */}
      {!loading && usingFallback && eligibleMatches.length > 0 && (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-3">
          <CalendarClock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed">
            <p className="font-semibold text-amber-200">
              No upcoming matches left on {selectedDateLabel}
            </p>
            <p className="text-amber-200/80 mt-0.5">
              The predictions below are the next upcoming fixtures from later dates — they are not
              for {selectedDateLabel}.
            </p>
          </div>
        </div>
      )}

      {/* Why matches were skipped (shown whenever anything was excluded) */}
      {!loading && skipSummary.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 px-3.5 py-3">
          <p className="text-[11px] font-semibold text-slate-300 mb-1.5">
            Why {skipSummary.reduce((n, s) => n + s.count, 0)} match(es) were skipped
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {skipSummary.map((s) => (
              <li key={s.outcome} className="text-[11px] text-slate-400">
                <span className="font-mono font-semibold text-slate-200 tabular-nums">
                  {s.count}
                </span>{' '}
                {s.outcome}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Main Content Area */}
      {loading ? (
        <div className="py-6 space-y-4">
          <div className="h-5 w-40 bg-slate-800 rounded animate-pulse" />
          <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="h-52 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
            <div className="h-52 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
            <div className="h-52 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
          </div>
        </div>
      ) : eligibleMatches.length === 0 ? (
        <div className="py-8 px-4 text-center space-y-2.5">
          <div className="w-10 h-10 rounded-full bg-slate-800/80 border border-slate-700/60 mx-auto flex items-center justify-center text-slate-400">
            <BarChart3 className="w-5 h-5 text-slate-400" />
          </div>
          <h3 className="text-sm font-bold text-white">
            No Eligible Upcoming Fixtures to Rank for this Date
          </h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
            Evaluates scheduled upcoming matches across Premier League, UEFA Champions League, La
            Liga, and Serie A. A match is ranked only when both teams have played at least 3 league
            matches, so early-season and early Champions League matchdays produce no predictions.
          </p>
          {ineligibleMatches.length > 0 && (
            <p className="text-xs text-amber-400/90 pt-1">
              {ineligibleMatches.length} match(es) observed but excluded due to cold-start thresholds, live/finished status, or tournament table format.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400 px-0.5">
            <span className="font-semibold text-slate-300">
              Ranked Eligible Matches ({eligibleMatches.length})
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              Sorted by Decisiveness Spread
            </span>
          </div>

          <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
            {eligibleMatches.map((item) => {
              const {
                fixture,
                probabilities,
                rank,
                evidenceLevel,
                evidenceDescription,
                conciseExplanation,
                rankingScore,
              } = item;

              if (!probabilities) return null;

              const homeWinPct = Math.round(probabilities.homeWin * 100);
              const drawPct = Math.round(probabilities.draw * 100);
              const awayWinPct = Math.round(probabilities.awayWin * 100);
              const kickoffFormatted = formatKickoffTime(fixture.utcKickoffTime, timezoneId);

              return (
                <div
                  key={fixture.id}
                  className="bg-[#0C1322] border border-slate-800 hover:border-slate-700/90 rounded-xl p-3.5 sm:p-4 flex flex-col justify-between transition-all group shadow-sm"
                >
                  <div className="space-y-3">
                    {/* Card Header: Rank, League, Kickoff */}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-mono">
                          #{rank}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-300 px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60">
                          {fixture.competition?.code || 'LEAGUE'}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-400 font-medium">
                        {kickoffFormatted}
                      </span>
                    </div>

                    {/* Teams & Win Probabilities Display */}
                    <div className="space-y-1.5 py-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {fixture.homeTeam?.crest ? (
                            <img
                              src={fixture.homeTeam.crest}
                              alt=""
                              className="w-5 h-5 object-contain shrink-0"
                              onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
                            />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] text-slate-400 font-bold shrink-0">
                              {fixture.homeTeam?.tla || 'H'}
                            </div>
                          )}
                          <span className="text-sm font-semibold text-white truncate group-hover:text-emerald-300 transition-colors">
                            {fixture.homeTeam?.name}
                          </span>
                        </div>
                        <span className="text-xs font-bold text-emerald-400 font-mono shrink-0">
                          {homeWinPct}%
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {fixture.awayTeam?.crest ? (
                            <img
                              src={fixture.awayTeam.crest}
                              alt=""
                              className="w-5 h-5 object-contain shrink-0"
                              onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
                            />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] text-slate-400 font-bold shrink-0">
                              {fixture.awayTeam?.tla || 'A'}
                            </div>
                          )}
                          <span className="text-sm font-semibold text-white truncate group-hover:text-emerald-300 transition-colors">
                            {fixture.awayTeam?.name}
                          </span>
                        </div>
                        <span className="text-xs font-bold text-blue-400 font-mono shrink-0">
                          {awayWinPct}%
                        </span>
                      </div>
                    </div>

                    {/* Probability Distribution Bar */}
                    <div className="space-y-1 pt-0.5">
                      <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden flex">
                        <div
                          style={{ width: `${homeWinPct}%` }}
                          className="bg-emerald-500 transition-all"
                          title={`Home Win: ${homeWinPct}%`}
                        />
                        <div
                          style={{ width: `${drawPct}%` }}
                          className="bg-slate-500 transition-all"
                          title={`Draw: ${drawPct}%`}
                        />
                        <div
                          style={{ width: `${awayWinPct}%` }}
                          className="bg-blue-500 transition-all"
                          title={`Away Win: ${awayWinPct}%`}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 px-0.5">
                        <span className="text-emerald-400 font-semibold">H {homeWinPct}%</span>
                        <span className="text-slate-400">D {drawPct}%</span>
                        <span className="text-blue-400 font-semibold">A {awayWinPct}%</span>
                      </div>
                    </div>

                    {/* Evidence & Decisiveness Metric */}
                    <div className="flex items-center justify-between gap-2 text-[10px] pt-0.5">
                      <span
                        className={`px-1.5 py-0.5 rounded font-medium border ${
                          evidenceLevel === 'HIGH'
                            ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60'
                            : evidenceLevel === 'MODERATE'
                            ? 'bg-blue-950/60 text-blue-300 border-blue-800/60'
                            : 'bg-amber-950/60 text-amber-300 border-amber-800/60'
                        }`}
                        title={evidenceDescription}
                      >
                        {evidenceLevel === 'HIGH'
                          ? 'High Evidence'
                          : evidenceLevel === 'MODERATE'
                          ? 'Moderate Evidence'
                          : 'Preliminary'}
                      </span>
                      <span className="text-slate-400 font-mono">
                        Spread: +{Math.round((rankingScore ?? 0) * 100)}%
                      </span>
                    </div>

                    {/* Concise Grounded Explanation */}
                    <p className="text-[11px] text-slate-300 line-clamp-2 leading-relaxed border-t border-slate-800/60 pt-2">
                      {conciseExplanation}
                    </p>
                  </div>

                  {/* Card Footer: Match Link & Expected Goals */}
                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between">
                    <span className="text-[10px] text-slate-400 font-mono">
                      xG: {probabilities.expectedGoalsHome.toFixed(2)} - {probabilities.expectedGoalsAway.toFixed(2)}
                    </span>
                    <button
                      onClick={() => onNavigateToMatch(fixture.id)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition-colors group-hover:translate-x-0.5"
                    >
                      <span>Match Details</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Ineligible Matches Section Toggle */}
      {ineligibleMatches.length > 0 && (
        <div className="mt-5 pt-3.5 border-t border-slate-800/80">
          <button
            onClick={() => setShowIneligible(!showIneligible)}
            className="flex items-center justify-between w-full text-xs text-slate-400 hover:text-slate-300 py-1 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
              <span>
                {ineligibleMatches.length} match(es) excluded by data guardrails
              </span>
            </span>
            <span className="text-[11px] font-medium text-slate-400 flex items-center gap-1">
              {showIneligible ? 'Hide Excluded' : 'Inspect Excluded Fixtures'}
              {showIneligible ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </span>
          </button>

          {showIneligible && (
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2 text-xs">
              {ineligibleMatches.map((m) => (
                <div
                  key={m.fixtureId}
                  className="p-2.5 bg-slate-900/60 border border-slate-800/70 rounded-lg space-y-1"
                >
                  <div className="flex items-center justify-between text-slate-300 font-semibold">
                    <span>
                      {m.fixture?.homeTeam?.name} vs {m.fixture?.awayTeam?.name}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {m.fixture?.competition?.code || 'LEAGUE'}
                    </span>
                  </div>
                  <p className="text-[11px] text-amber-400/90 leading-tight">
                    {m.ineligibilityReason}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
