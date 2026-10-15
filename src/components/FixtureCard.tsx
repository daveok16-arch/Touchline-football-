import React, { useState } from 'react';
import { Fixture } from '../types/football';
import { formatKickoffTime } from '../utils/timezone';
import { isFixtureStale } from '../utils/freshness';
import { ChevronRight } from 'lucide-react';

interface FixtureCardProps {
  fixture: Fixture;
  timezoneId: string;
  onSelect: (fixtureId: string) => void;
}

export const FixtureCard: React.FC<FixtureCardProps> = ({
  fixture,
  timezoneId,
  onSelect,
}) => {
  const [homeCrestError, setHomeCrestError] = useState(false);
  const [awayCrestError, setAwayCrestError] = useState(false);

  const kickoffStr = formatKickoffTime(fixture.utcKickoffTime, timezoneId);
  const isFinished = fixture.status === 'FINISHED';
  const isLive = fixture.status === 'IN_PLAY' || fixture.status === 'PAUSED';
  const isHalfTime = fixture.status === 'PAUSED';
  const isScheduled = fixture.status === 'SCHEDULED' || fixture.status === 'TIMED';
  const isPostponed = fixture.status === 'POSTPONED';
  const isSuspended = fixture.status === 'SUSPENDED';
  const isCancelled = fixture.status === 'CANCELLED';
  const isStale = isFixtureStale(fixture);

  const homeName = fixture.homeTeam?.name || 'Home Club';
  const homeShort = fixture.homeTeam?.shortName || homeName;
  const homeTla = fixture.homeTeam?.tla || 'HOM';

  const awayName = fixture.awayTeam?.name || 'Away Club';
  const awayShort = fixture.awayTeam?.shortName || awayName;
  const awayTla = fixture.awayTeam?.tla || 'AWY';

  const compName = fixture.competition?.name || 'Tournament';

  return (
    <div
      onClick={() => onSelect(fixture.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(fixture.id);
        }
      }}
      className="group bg-[#0F172A] hover:bg-[#131F38] border border-slate-800/80 hover:border-slate-700 rounded-xl p-4 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
    >
      {/* Top Meta Row */}
      <div className="flex items-center justify-between text-xs text-slate-400 mb-3">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="font-semibold text-slate-300 truncate">{compName}</span>
          {fixture.matchday && (
            <>
              <span aria-hidden="true" className="text-slate-600">•</span>
              <span className="text-slate-400">Matchday {fixture.matchday}</span>
            </>
          )}
          {fixture.venue?.name && (
            <>
              <span aria-hidden="true" className="text-slate-600 hidden sm:inline">•</span>
              <span className="text-slate-500 truncate hidden sm:inline">{fixture.venue.city || fixture.venue.name}</span>
            </>
          )}
        </div>

        {/* Status or Kickoff */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isStale && (
            <span
              className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded px-1 py-0.5"
              title="This live score has not updated recently and may be behind the live state."
            >
              Stale
            </span>
          )}
          {isLive && (
            <span className="font-mono text-xs font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
              <span className="text-amber-300">
                {isHalfTime
                  ? 'Half-Time'
                  : fixture.isDelayed
                  ? 'Delayed – In-Play'
                  : 'In-Play'}
                {!isHalfTime && fixture.minute ? ` ${fixture.minute}'` : ''}
              </span>
            </span>
          )}
          {isFinished && (
            <span className="text-slate-400 font-mono text-xs font-semibold">
              FT
            </span>
          )}
          {isScheduled && (
            <span className="font-mono text-emerald-400 font-medium text-xs">
              {kickoffStr}
            </span>
          )}
          {isPostponed && (
            <span className="text-amber-400 font-mono text-xs font-medium">Postponed</span>
          )}
          {isSuspended && (
            <span className="text-amber-400 font-mono text-xs font-medium">Suspended</span>
          )}
          {isCancelled && (
            <span className="text-rose-400 font-mono text-xs font-medium">Cancelled</span>
          )}
        </div>
      </div>

      {/* Main Teams & Score Section */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 py-1">
        {/* Home Team */}
        <div className="flex items-center gap-3 justify-end text-right">
          <div className="min-w-0">
            <p className="text-sm sm:text-base font-semibold text-white group-hover:text-emerald-300 transition-colors truncate">
              {homeShort}
            </p>
          </div>
          <div className="w-9 h-9 rounded-lg bg-slate-800/80 border border-slate-700/60 flex items-center justify-center overflow-hidden shrink-0">
            {fixture.homeTeam?.crest && !homeCrestError ? (
              <img
                src={fixture.homeTeam.crest}
                alt={homeName}
                className="w-6 h-6 object-contain"
                onError={() => setHomeCrestError(true)}
              />
            ) : (
              <span className="text-xs font-bold text-slate-300">{homeTla}</span>
            )}
          </div>
        </div>

        {/* Center: Score or VS */}
        <div className="flex flex-col items-center justify-center px-2 min-w-[70px]">
          {isFinished || isLive ? (
            fixture.score && fixture.score.home !== null && fixture.score.away !== null ? (
              <div className="flex items-center gap-2 font-mono text-xl sm:text-2xl font-bold tracking-tight text-white tabular-nums">
                <span>{fixture.score.home}</span>
                <span className="text-slate-600 font-normal">:</span>
                <span>{fixture.score.away}</span>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <span className="text-xs font-mono text-slate-400">– : –</span>
                <span className="text-[10px] text-slate-500">Score unrecorded</span>
              </div>
            )
          ) : isSuspended || isPostponed || isCancelled ? (
            <div className="flex flex-col items-center">
              <span className="text-xs font-medium text-slate-500 tracking-wider">VS</span>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <span className="text-xs font-medium text-slate-500 tracking-wider">VS</span>
              <span className="text-[11px] font-mono text-slate-400 mt-0.5">{kickoffStr}</span>
            </div>
          )}
        </div>

        {/* Away Team */}
        <div className="flex items-center gap-3 justify-start text-left">
          <div className="w-9 h-9 rounded-lg bg-slate-800/80 border border-slate-700/60 flex items-center justify-center overflow-hidden shrink-0">
            {fixture.awayTeam?.crest && !awayCrestError ? (
              <img
                src={fixture.awayTeam.crest}
                alt={awayName}
                className="w-6 h-6 object-contain"
                onError={() => setAwayCrestError(true)}
              />
            ) : (
              <span className="text-xs font-bold text-slate-300">{awayTla}</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm sm:text-base font-semibold text-white group-hover:text-emerald-300 transition-colors truncate">
              {awayShort}
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Footer Details */}
      <div className="mt-3 pt-2.5 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
        <span className="text-[11px] text-slate-500">
          {isFinished && fixture.score?.halftime && fixture.score.halftime.home !== null && (
            <span>HT: {fixture.score.halftime.home}-{fixture.score.halftime.away}</span>
          )}
        </span>
        <div className="flex items-center gap-1 text-slate-400 group-hover:text-emerald-400 transition-colors font-medium text-xs">
          <span>Match details</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </div>
  );
};
