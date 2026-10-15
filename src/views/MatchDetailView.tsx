import React, { useState, useEffect } from 'react';
import { Fixture, MatchIntelligence, CompetitionStandings } from '../types/football';
import { FixtureService } from '../services/fixtureService';
import {
  evaluateMatchIntelligence,
  rankEligibleMatches,
  SUPPORTED_INTELLIGENCE_COMPETITIONS,
  isGenuinelyUpcomingFixture,
} from '../services/predictionEngine';
import { formatKickoffFull, formatKickoffTime, getTimezoneAbbr } from '../utils/timezone';
import { isFixtureStale } from '../utils/freshness';
import { EmptyState } from '../components/EmptyState';
import {
  ArrowLeft,
  Calendar,
  MapPin,
  User,
  History,
  Clock,
  Layers,
  Sparkles,
  ShieldAlert,
  BarChart3,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';

interface MatchDetailViewProps {
  matchId: string;
  timezoneId: string;
  onBack: () => void;
}

export const MatchDetailView: React.FC<MatchDetailViewProps> = ({
  matchId,
  timezoneId,
  onBack,
}) => {
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const [intelligence, setIntelligence] = useState<MatchIntelligence | null>(null);
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const [homeCrestError, setHomeCrestError] = useState(false);
  const [awayCrestError, setAwayCrestError] = useState(false);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setFixture(null);
    setIntelligence(null);

    FixtureService.getFixtureById(matchId)
      .then((res) => {
        if (!isMounted) return;
        setFixture(res);
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
  }, [matchId, retryNonce]);

  useEffect(() => {
    if (!fixture) {
      setIntelligence(null);
      return;
    }

    let isMounted = true;
    setIntelligenceLoading(true);
    const compCode = (fixture.competition?.code || '').toUpperCase();

    // If unsupported competition, evaluate directly to get standard honest ineligibility record
    if (!SUPPORTED_INTELLIGENCE_COMPETITIONS.includes(compCode)) {
      const unsupportedEval = evaluateMatchIntelligence(fixture, {});
      if (isMounted) {
        if (
          String(unsupportedEval.fixtureId) === String(fixture.id) &&
          (unsupportedEval.fixture?.competition?.code || '').toUpperCase() === compCode
        ) {
          setIntelligence(unsupportedEval);
        } else {
          setIntelligence(null);
        }
        setIntelligenceLoading(false);
      }
      return;
    }

    // Supported competition: fetch standings and upcoming matches for ranking
    Promise.all([
      FixtureService.getStandings(compCode).catch(() => null),
      FixtureService.getFixtures({
        competitionId: fixture.competition?.id || compCode,
        status: 'SCHEDULED',
        timezoneId,
      }).catch(() => [] as Fixture[]),
    ])
      .then(([standings, scheduledFixtures]) => {
        if (!isMounted) return;

        const standingsMap: Record<string, CompetitionStandings | null> = {
          [compCode]: standings,
        };

        let matchedIntelligence: MatchIntelligence | null = null;

        // If scheduled fixtures are available, evaluate all of them to compute ranking position
        if (scheduledFixtures && scheduledFixtures.length > 0) {
          const upcomingPool = scheduledFixtures.filter((f) => isGenuinelyUpcomingFixture(f));

          const fixturePool = upcomingPool.some((f) => String(f.id) === String(fixture.id))
            ? upcomingPool
            : isGenuinelyUpcomingFixture(fixture)
            ? [...upcomingPool, fixture]
            : upcomingPool;

          const evaluatedList = fixturePool.map((f) => evaluateMatchIntelligence(f, standingsMap));
          const rankedList = rankEligibleMatches(evaluatedList);

          // Strictly verify fixture ID and competition
          const found = rankedList.find(
            (r) =>
              String(r.fixtureId) === String(fixture.id) &&
              (r.fixture?.competition?.code || '').toUpperCase() === compCode
          );

          if (found) {
            matchedIntelligence = found;
          }
        }

        // If not found in rankedList (e.g. cold start, finished match, or standing missing), evaluate directly
        if (!matchedIntelligence) {
          const directEval = evaluateMatchIntelligence(fixture, standingsMap);
          if (
            String(directEval.fixtureId) === String(fixture.id) &&
            (directEval.fixture?.competition?.code || '').toUpperCase() === compCode
          ) {
            matchedIntelligence = directEval;
          }
        }

        setIntelligence(matchedIntelligence);
        setIntelligenceLoading(false);
      })
      .catch(() => {
        if (!isMounted) return;
        const fallbackEval = evaluateMatchIntelligence(fixture, { [compCode]: null });
        if (
          String(fallbackEval.fixtureId) === String(fixture.id) &&
          (fallbackEval.fixture?.competition?.code || '').toUpperCase() === compCode
        ) {
          setIntelligence(fallbackEval);
        } else {
          setIntelligence(null);
        }
        setIntelligenceLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [fixture, timezoneId, retryNonce]);

  const handleRetry = () => {
    setRetryNonce((prev) => prev + 1);
  };

  if (loading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto py-8">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 text-xs text-slate-400 hover:text-white"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to fixtures</span>
        </button>
        <div className="h-64 bg-slate-900 border border-slate-800 rounded-2xl animate-pulse" />
        <div className="h-44 bg-slate-900 border border-slate-800 rounded-2xl animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto py-8">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to fixtures</span>
        </button>
        <EmptyState
          type={errorCode === 'PROVIDER_NOT_CONFIGURED' ? 'not_configured' : 'unavailable'}
          title={
            errorCode === 'PROVIDER_NOT_CONFIGURED'
              ? 'Football data is not connected yet.'
              : 'Football data is temporarily unavailable. Try again.'
          }
          description={
            errorCode === 'PROVIDER_NOT_CONFIGURED'
              ? 'Add FOOTBALL_DATA_API_KEY to your environment variables to load match details.'
              : 'Please try again in a few moments.'
          }
          onRetry={handleRetry}
        />
      </div>
    );
  }

  if (!fixture) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto py-8">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to fixtures</span>
        </button>
        <EmptyState
          type="no_fixtures"
          title="Match not found."
          description="The requested match could not be found in the current schedule."
          onRetry={onBack}
          retryLabel="Return to Fixtures"
        />
      </div>
    );
  }

  const isFinished = fixture.status === 'FINISHED';
  const isLive = fixture.status === 'IN_PLAY' || fixture.status === 'PAUSED';
  const isHalfTime = fixture.status === 'PAUSED';
  const isScheduled = fixture.status === 'SCHEDULED' || fixture.status === 'TIMED';
  const isPostponed = fixture.status === 'POSTPONED';
  const isSuspended = fixture.status === 'SUSPENDED';
  const isCancelled = fixture.status === 'CANCELLED';
  const isStale = isFixtureStale(fixture);

  const kickoffTimeStr = formatKickoffTime(fixture.utcKickoffTime, timezoneId);
  const fullDateTime = formatKickoffFull(fixture.utcKickoffTime, timezoneId);

  const homeName = fixture.homeTeam?.name || 'Home Club';
  const homeTla = fixture.homeTeam?.tla || 'HOM';

  const awayName = fixture.awayTeam?.name || 'Away Club';
  const awayTla = fixture.awayTeam?.tla || 'AWY';

  const compCode = (fixture.competition?.code || '').toUpperCase();
  const isExactFixtureMatch =
    Boolean(intelligence) &&
    String(intelligence?.fixtureId) === String(fixture.id) &&
    (intelligence?.fixture?.competition?.code || '').toUpperCase() === compCode;

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-20">
      {/* Top Back Navigation Bar */}
      <div>
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Fixtures</span>
        </button>
      </div>

      {/* Main Scoreboard Banner */}
      <div className="bg-[#0F172A] border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        {/* Meta Bar */}
        <div className="bg-[#0A101E] px-6 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="font-bold text-white">{fixture.competition?.name || 'Competition'}</span>
            {fixture.matchday && (
              <>
                <span aria-hidden="true" className="text-slate-600">•</span>
                <span>Matchday {fixture.matchday}</span>
              </>
            )}
            {fixture.stage && fixture.stage !== 'REGULAR_SEASON' && (
              <>
                <span aria-hidden="true" className="text-slate-600">•</span>
                <span>{fixture.stage.replace(/_/g, ' ')}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-slate-500" />
            <span className="font-mono text-slate-300">{kickoffTimeStr}</span>
          </div>
        </div>

        {/* Score & Clubs Grid */}
        <div className="p-6 sm:p-10">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 sm:gap-8">
            {/* Home Team */}
            <div className="flex flex-col items-center sm:items-end text-center sm:text-right space-y-2">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-slate-800/80 border border-slate-700/80 flex items-center justify-center p-3 shadow-inner overflow-hidden">
                {fixture.homeTeam?.crest && !homeCrestError ? (
                  <img
                    src={fixture.homeTeam.crest}
                    alt={homeName}
                    className="w-full h-full object-contain"
                    onError={() => setHomeCrestError(true)}
                  />
                ) : (
                  <span className="text-lg font-bold text-slate-300">{homeTla}</span>
                )}
              </div>
              <div>
                <h2 className="text-base sm:text-xl font-bold text-white tracking-tight">
                  {homeName}
                </h2>
              </div>
            </div>

            {/* Center: Score or Kickoff Time */}
            <div className="flex flex-col items-center justify-center px-2 sm:px-6">
              {isFinished || isLive ? (
                fixture.score && fixture.score.home !== null && fixture.score.away !== null ? (
                  <div className="flex flex-col items-center">
                    <div className="flex items-center gap-3 font-mono text-3xl sm:text-5xl font-extrabold text-white tracking-tight tabular-nums">
                      <span>{fixture.score.home}</span>
                      <span className="text-slate-600 font-normal">:</span>
                      <span>{fixture.score.away}</span>
                    </div>
                    <div className="mt-2 text-xs font-mono">
                      {isLive && (
                        <span className="text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded font-semibold">
                          {isHalfTime
                            ? 'Half-Time'
                            : fixture.isDelayed
                            ? 'Delayed – In-Play'
                            : 'In-Play'}
                          {!isHalfTime && fixture.minute ? ` • ${fixture.minute}'` : ''}
                        </span>
                      )}
                      {isFinished && (
                        <span className="text-slate-400 font-semibold uppercase tracking-wider">
                          Full Time
                        </span>
                      )}
                    </div>
                    {isStale && (
                      <span className="mt-1.5 text-[10px] font-mono text-slate-400 border border-slate-700 rounded px-1.5 py-0.5">
                        Score may be stale
                      </span>
                    )}
                    {fixture.score.halftime && fixture.score.halftime.home !== null && fixture.score.halftime.away !== null && (
                      <span className="text-[11px] text-slate-400 font-mono mt-1.5">
                        Halftime: {fixture.score.halftime.home} - {fixture.score.halftime.away}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <span className="font-mono text-2xl text-slate-400">– : –</span>
                    <span className="text-xs text-slate-400 mt-1">
                      {isFinished ? 'Full Time (Score unrecorded)' : 'In-Play'}
                    </span>
                  </div>
                )
              ) : isSuspended ? (
                <div className="flex flex-col items-center space-y-1">
                  <span className="text-sm font-semibold text-amber-400 uppercase tracking-wider">
                    Suspended
                  </span>
                </div>
              ) : isPostponed ? (
                <div className="flex flex-col items-center space-y-1">
                  <span className="text-sm font-semibold text-amber-400 uppercase tracking-wider">
                    Postponed
                  </span>
                </div>
              ) : isCancelled ? (
                <div className="flex flex-col items-center space-y-1">
                  <span className="text-sm font-semibold text-rose-400 uppercase tracking-wider">
                    Cancelled
                  </span>
                </div>
              ) : (
                <div className="flex flex-col items-center space-y-1">
                  <span className="text-xs font-semibold text-slate-500 tracking-widest uppercase">
                    Kickoff
                  </span>
                  <span className="font-mono text-2xl sm:text-3xl font-bold text-emerald-400 tabular-nums">
                    {kickoffTimeStr}
                  </span>
                </div>
              )}
            </div>

            {/* Away Team */}
            <div className="flex flex-col items-center sm:items-start text-center sm:text-left space-y-2">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-slate-800/80 border border-slate-700/80 flex items-center justify-center p-3 shadow-inner overflow-hidden">
                {fixture.awayTeam?.crest && !awayCrestError ? (
                  <img
                    src={fixture.awayTeam.crest}
                    alt={awayName}
                    className="w-full h-full object-contain"
                    onError={() => setAwayCrestError(true)}
                  />
                ) : (
                  <span className="text-lg font-bold text-slate-300">{awayTla}</span>
                )}
              </div>
              <div>
                <h2 className="text-base sm:text-xl font-bold text-white tracking-tight">
                  {awayName}
                </h2>
              </div>
            </div>
          </div>

          {/* Sub-header Kickoff Date */}
          <div className="mt-8 pt-4 border-t border-slate-800 text-center text-xs text-slate-400">
            <span>{fullDateTime}</span>
          </div>
        </div>
      </div>

      {/* Daily Match Intelligence Card */}
      <div className="bg-[#0F172A] border border-slate-800 rounded-2xl p-6 space-y-5 shadow-xl relative overflow-hidden">
        {/* Glow accent */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-emerald-500/5 blur-3xl pointer-events-none rounded-full" />

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                <Sparkles className="w-3 h-3 text-emerald-400" />
                <span>Daily Match Intelligence</span>
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                Model: Poisson V1 (Frozen)
              </span>
            </div>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Match Outcome Projection & Evidence Analysis
            </h3>
          </div>

          {intelligence?.isEligible && intelligence.rank && (
            <div className="flex items-center gap-2 self-start sm:self-center">
              <span className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-mono">
                #{intelligence.rank} Daily Rank
              </span>
            </div>
          )}
        </div>

        {intelligenceLoading ? (
          <div className="py-6 space-y-4 animate-pulse">
            <div className="h-4 w-40 bg-slate-800 rounded" />
            <div className="grid grid-cols-3 gap-3">
              <div className="h-24 bg-slate-900 border border-slate-800 rounded-xl" />
              <div className="h-24 bg-slate-900 border border-slate-800 rounded-xl" />
              <div className="h-24 bg-slate-900 border border-slate-800 rounded-xl" />
            </div>
            <div className="h-16 bg-slate-900 border border-slate-800 rounded-xl" />
          </div>
        ) : !intelligence ? (
          <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl text-xs text-slate-400 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-slate-200">Intelligence Unavailable</p>
              <p className="mt-0.5 leading-relaxed">
                Could not compute statistical match intelligence for this fixture. Standings or fixture details are unavailable.
              </p>
            </div>
          </div>
        ) : !isExactFixtureMatch ? (
          <div className="p-4 bg-rose-950/40 border border-rose-800/60 rounded-xl text-xs text-rose-300 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-rose-200">Fixture Integrity Mismatch</p>
              <p className="mt-0.5 leading-relaxed">
                Prediction record does not match the selected fixture ID ({fixture.id}) and competition ({compCode}). Probabilities withheld under data safety guardrails.
              </p>
            </div>
          </div>
        ) : intelligence.isEligible && intelligence.probabilities ? (
          <div className="space-y-5">
            {/* 3-Way Probabilities Cards */}
            <div className="grid grid-cols-3 gap-3">
              {/* Home Win */}
              <div className="p-3.5 bg-slate-900/90 border border-emerald-900/40 rounded-xl text-center space-y-1">
                <span className="text-[11px] text-slate-400 font-medium block truncate">
                  {homeName} Win
                </span>
                <span className="text-2xl sm:text-3xl font-extrabold text-emerald-400 font-mono block">
                  {Math.round(intelligence.probabilities.homeWin * 100)}%
                </span>
                <span className="text-[10px] text-slate-500 font-mono block">
                  P = {intelligence.probabilities.homeWin.toFixed(3)}
                </span>
              </div>

              {/* Draw */}
              <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl text-center space-y-1">
                <span className="text-[11px] text-slate-400 font-medium block">
                  Draw
                </span>
                <span className="text-2xl sm:text-3xl font-extrabold text-slate-300 font-mono block">
                  {Math.round(intelligence.probabilities.draw * 100)}%
                </span>
                <span className="text-[10px] text-slate-500 font-mono block">
                  P = {intelligence.probabilities.draw.toFixed(3)}
                </span>
              </div>

              {/* Away Win */}
              <div className="p-3.5 bg-slate-900/90 border border-blue-900/40 rounded-xl text-center space-y-1">
                <span className="text-[11px] text-slate-400 font-medium block truncate">
                  {awayName} Win
                </span>
                <span className="text-2xl sm:text-3xl font-extrabold text-blue-400 font-mono block">
                  {Math.round(intelligence.probabilities.awayWin * 100)}%
                </span>
                <span className="text-[10px] text-slate-500 font-mono block">
                  P = {intelligence.probabilities.awayWin.toFixed(3)}
                </span>
              </div>
            </div>

            {/* Visual Probability Distribution Bar */}
            <div className="space-y-1.5">
              <div className="h-3 w-full bg-slate-800 rounded-full overflow-hidden flex">
                <div
                  style={{ width: `${Math.round(intelligence.probabilities.homeWin * 100)}%` }}
                  className="bg-emerald-500 transition-all"
                  title={`Home Win: ${Math.round(intelligence.probabilities.homeWin * 100)}%`}
                />
                <div
                  style={{ width: `${Math.round(intelligence.probabilities.draw * 100)}%` }}
                  className="bg-slate-500 transition-all"
                  title={`Draw: ${Math.round(intelligence.probabilities.draw * 100)}%`}
                />
                <div
                  style={{ width: `${Math.round(intelligence.probabilities.awayWin * 100)}%` }}
                  className="bg-blue-500 transition-all"
                  title={`Away Win: ${Math.round(intelligence.probabilities.awayWin * 100)}%`}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 px-1">
                <span className="text-emerald-400 font-semibold">
                  {homeTla} {Math.round(intelligence.probabilities.homeWin * 100)}%
                </span>
                <span className="text-slate-400">
                  Draw {Math.round(intelligence.probabilities.draw * 100)}%
                </span>
                <span className="text-blue-400 font-semibold">
                  {awayTla} {Math.round(intelligence.probabilities.awayWin * 100)}%
                </span>
              </div>
            </div>

            {/* Metadata Pills: Evidence Level, Cold-Start Status, Ranking Score, Data Freshness */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1 text-xs">
              <div className="p-2.5 bg-slate-900/80 border border-slate-800 rounded-lg">
                <span className="text-[10px] text-slate-400 block">Evidence Quality</span>
                <span
                  className={`font-semibold inline-block mt-0.5 ${
                    intelligence.evidenceLevel === 'HIGH'
                      ? 'text-emerald-400'
                      : intelligence.evidenceLevel === 'MODERATE'
                      ? 'text-blue-400'
                      : 'text-amber-400'
                  }`}
                >
                  {intelligence.evidenceLevel === 'HIGH'
                    ? 'High Evidence'
                    : intelligence.evidenceLevel === 'MODERATE'
                    ? 'Moderate Evidence'
                    : 'Preliminary'}
                </span>
              </div>

              <div className="p-2.5 bg-slate-900/80 border border-slate-800 rounded-lg">
                <span className="text-[10px] text-slate-400 block">Cold-Start Status</span>
                <span className="font-semibold text-emerald-400 inline-block mt-0.5">
                  {intelligence.isColdStart ? 'Cold Start' : 'Threshold Met (≥ 3 Games)'}
                </span>
              </div>

              <div className="p-2.5 bg-slate-900/80 border border-slate-800 rounded-lg">
                <span className="text-[10px] text-slate-400 block">Expected Goals (xG)</span>
                <span className="font-semibold text-white font-mono inline-block mt-0.5">
                  {intelligence.probabilities.expectedGoalsHome.toFixed(2)} - {intelligence.probabilities.expectedGoalsAway.toFixed(2)}
                </span>
              </div>

              <div className="p-2.5 bg-slate-900/80 border border-slate-800 rounded-lg">
                <span className="text-[10px] text-slate-400 block">Data Freshness</span>
                <span className="font-semibold text-slate-200 inline-block mt-0.5 truncate" title={intelligence.dataFreshness}>
                  {intelligence.dataFreshness}
                </span>
              </div>
            </div>

            {/* Factual Grounded Explanation */}
            <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl space-y-1.5 text-xs">
              <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
                <BarChart3 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Data-Driven Match Rationale</span>
              </div>
              <p className="text-slate-300 leading-relaxed">
                {intelligence.conciseExplanation}
              </p>
              {intelligence.evidenceDescription && (
                <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800/80">
                  {intelligence.evidenceDescription}
                </p>
              )}
            </div>

            {/* Statistical Disclaimer & Validation Notice */}
            <div className="p-3 bg-slate-900/40 border border-slate-800/60 rounded-lg text-[11px] text-slate-400 space-y-1">
              <div className="flex items-start gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  {intelligence.disclaimer}
                </p>
              </div>
              <p className="text-[10px] text-slate-500 pl-5">
                {intelligence.validationNotice}
              </p>
            </div>
          </div>
        ) : (
          /* Ineligible / Guardrail State */
          <div className="p-5 bg-slate-900/70 border border-amber-900/30 rounded-xl space-y-3 text-xs">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1 flex-1">
                <span className="font-bold text-amber-300 text-sm block">
                  Match Intelligence Excluded by Model Guardrails
                </span>
                <p className="text-slate-300 leading-relaxed font-medium">
                  {intelligence.ineligibilityReason}
                </p>
                <p className="text-slate-400 leading-relaxed pt-1">
                  {intelligence.conciseExplanation}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-slate-800 text-[11px]">
              <div className="p-2 bg-slate-900/90 rounded border border-slate-800">
                <span className="text-slate-400 block">Cold-Start Status</span>
                <span className={`font-semibold ${intelligence.isColdStart ? 'text-amber-400' : 'text-slate-300'}`}>
                  {intelligence.isColdStart ? 'Active Guardrail' : 'Inactive'}
                </span>
              </div>
              <div className="p-2 bg-slate-900/90 rounded border border-slate-800">
                <span className="text-slate-400 block">Data Status</span>
                <span className="font-semibold text-slate-300 truncate block" title={intelligence.dataFreshness}>
                  {intelligence.dataFreshness}
                </span>
              </div>
              <div className="p-2 bg-slate-900/90 rounded border border-slate-800">
                <span className="text-slate-400 block">Audit Standard</span>
                <span className="font-semibold text-slate-300">
                  Project Touchline Honesty Rules
                </span>
              </div>
            </div>

            <p className="text-[10px] text-slate-400 leading-normal border-t border-slate-800/60 pt-2">
              Predictions are never fabricated or shown without verified provider standings and upcoming scheduled match status.
            </p>
          </div>
        )}
      </div>

      {/* Match Details Card */}
      <div className="bg-[#0F172A] border border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-white tracking-tight flex items-center gap-2 border-b border-slate-800 pb-3">
          <Calendar className="w-4 h-4 text-emerald-400" />
          <span>Match Information</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          {fixture.venue?.name && (
            <div className="flex items-center gap-3 p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
              <div>
                <span className="text-slate-400 block text-[11px]">Venue</span>
                <span className="font-semibold text-white">
                  {fixture.venue.name}{fixture.venue.city ? `, ${fixture.venue.city}` : ''}
                </span>
              </div>
            </div>
          )}

          {fixture.referee?.name && (
            <div className="flex items-center gap-3 p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <User className="w-4 h-4 text-slate-400 shrink-0" />
              <div>
                <span className="text-slate-400 block text-[11px]">Referee</span>
                <span className="font-semibold text-white">
                  {fixture.referee.name}{fixture.referee.nationality ? ` (${fixture.referee.nationality})` : ''}
                </span>
              </div>
            </div>
          )}

          {fixture.competition?.name && (
            <div className="flex items-center gap-3 p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <Layers className="w-4 h-4 text-slate-400 shrink-0" />
              <div>
                <span className="text-slate-400 block text-[11px]">Competition</span>
                <span className="font-semibold text-white">{fixture.competition.name}</span>
              </div>
            </div>
          )}

          {fixture.matchday && (
            <div className="flex items-center gap-3 p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
              <div>
                <span className="text-slate-400 block text-[11px]">Matchday</span>
                <span className="font-semibold text-white font-mono">Matchday {fixture.matchday}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Head to Head Card (Only shown if real provider data is present) */}
      {fixture.h2h && (
        <div className="bg-[#0F172A] border border-slate-800 rounded-2xl p-6 space-y-4">
          <h3 className="text-sm font-bold text-white tracking-tight flex items-center gap-2 border-b border-slate-800 pb-3">
            <History className="w-4 h-4 text-emerald-400" />
            <span>Head-to-Head Record</span>
          </h3>

          <div className="grid grid-cols-4 gap-3 text-center">
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <span className="text-[11px] text-slate-400 block">Matches</span>
              <span className="text-base font-bold text-white font-mono">{fixture.h2h.matchesPlayed}</span>
            </div>
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <span className="text-[11px] text-slate-400 block">{homeTla} Wins</span>
              <span className="text-base font-bold text-emerald-400 font-mono">{fixture.h2h.homeWins}</span>
            </div>
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <span className="text-[11px] text-slate-400 block">Draws</span>
              <span className="text-base font-bold text-slate-300 font-mono">{fixture.h2h.draws}</span>
            </div>
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-lg">
              <span className="text-[11px] text-slate-400 block">{awayTla} Wins</span>
              <span className="text-base font-bold text-emerald-400 font-mono">{fixture.h2h.awayWins}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
