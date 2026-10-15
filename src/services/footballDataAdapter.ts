import { Competition, CompetitionStandings, Fixture, HeadToHead, MatchScore, MatchStatus, StandingEntry } from '../types/football';
import { FootballDataCompetition, FootballDataMatch, FootballDataMatchesResponse, FootballDataStandingsResponse } from '../types/footballData';
import {
  getRegistryEntryByFdCode,
  getRegistryEntryById,
} from './competitionRegistry';
import { registryEntryToCompetition } from './competitionCatalogue';

/**
 * Football-data.org free tier only returns these competitions, so this is the
 * allowlist the proxy requests. The broader app catalogue is derived separately
 * (see competitionCatalogue.ts) and must not be confused with this allowlist.
 */
export const SUPPORTED_COMPETITION_CODES = ['PL', 'CL', 'PD', 'SA'] as const;

export const FREE_PROVIDER_COMPETITIONS: Competition[] = [
  ...SUPPORTED_COMPETITION_CODES.map((code) => registryEntryToCompetition(getRegistryEntryById(code)!)).filter(Boolean),
  {
    id: 'CAF',
    name: 'CAF Champions League',
    code: 'CAF',
    type: 'CUP',
    country: 'Africa',
    season: '2024/25',
    isDemo: false,
    isSupported: false,
    unsupportedReason:
      'CAF Champions League is not covered by the football-data.org free tier API. Real-world data is currently unavailable for this competition.',
  },
];

export const VERIFIED_SUPPORTED_COMPETITIONS: Competition[] = FREE_PROVIDER_COMPETITIONS.filter(
  (c) => c.isSupported === true
);

/**
 * Maps football-data.org status strings into our internal MatchStatus type.
 */
export function mapFootballDataStatus(status: string): MatchStatus {
  switch (status) {
    case 'IN_PLAY':
      return 'IN_PLAY';
    case 'PAUSED':
      return 'PAUSED';
    case 'FINISHED':
    case 'AWARDED':
      return 'FINISHED';
    case 'POSTPONED':
      return 'POSTPONED';
    case 'SUSPENDED':
      return 'SUSPENDED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'TIMED':
      return 'TIMED';
    case 'SCHEDULED':
    default:
      return 'SCHEDULED';
  }
}

/**
 * Adapts a raw FootballDataMatch resource into the application's typed Fixture contract.
 */
export function adaptFootballDataMatch(match: FootballDataMatch): Fixture {
  const compCode = match.competition?.code || 'UNKNOWN';
  const registryEntry = getRegistryEntryByFdCode(compCode);
  const knownComp = FREE_PROVIDER_COMPETITIONS.find((c) => c.code === compCode);

  const competition: Competition = {
    id: registryEntry?.id || compCode,
    name: registryEntry?.name || match.competition?.name || knownComp?.name || compCode,
    code: compCode,
    type: registryEntry?.type || (match.competition?.type === 'CUP' ? 'CUP' : 'LEAGUE'),
    emblem: match.competition?.emblem || registryEntry?.emblem || knownComp?.emblem,
    country: registryEntry?.country || match.area?.name || knownComp?.country || 'International',
    season: match.season?.startDate
      ? `${new Date(match.season.startDate).getFullYear()}/${String(new Date(match.season.endDate).getFullYear()).slice(-2)}`
      : knownComp?.season || '2024/25',
    matchday: match.matchday || match.season?.currentMatchday,
    isDemo: false,
    isSupported: true,
  };

  const score: MatchScore | undefined = match.score
    ? {
        home: match.score.fullTime?.home ?? null,
        away: match.score.fullTime?.away ?? null,
        halftime: {
          home: match.score.halfTime?.home ?? null,
          away: match.score.halfTime?.away ?? null,
        },
      }
    : undefined;

  let h2h: HeadToHead | null = null;
  if (match.head2head && match.head2head.numberOfMatches !== undefined) {
    h2h = {
      matchesPlayed: match.head2head.numberOfMatches,
      homeWins: match.head2head.homeTeam?.wins ?? 0,
      awayWins: match.head2head.awayTeam?.wins ?? 0,
      draws: match.head2head.homeTeam?.draws ?? 0,
      recentMeetings: [],
    };
  }

  return {
    id: `fd-${match.id}`,
    utcKickoffTime: match.utcDate,
    status: mapFootballDataStatus(match.status),
    minute: match.minute,
    competition,
    stage: match.stage,
    group: match.group || undefined,
    matchday: match.matchday,
    homeTeam: {
      id: String(match.homeTeam?.id || 'home'),
      name: match.homeTeam?.name || 'Home Club',
      shortName: match.homeTeam?.shortName || match.homeTeam?.name || 'Home Club',
      tla: match.homeTeam?.tla || match.homeTeam?.shortName?.slice(0, 3).toUpperCase() || 'HOM',
      crest: match.homeTeam?.crest,
    },
    awayTeam: {
      id: String(match.awayTeam?.id || 'away'),
      name: match.awayTeam?.name || 'Away Club',
      shortName: match.awayTeam?.shortName || match.awayTeam?.name || 'Away Club',
      tla: match.awayTeam?.tla || match.awayTeam?.shortName?.slice(0, 3).toUpperCase() || 'AWY',
      crest: match.awayTeam?.crest,
    },
    score,
    venue: match.venue
      ? {
          name: match.venue,
          city: match.area?.name || '',
        }
      : undefined,
    referee: match.referees?.[0]
      ? {
          name: match.referees[0].name,
          nationality: match.referees[0].nationality,
          role: match.referees[0].type,
        }
      : undefined,
    // Free tier does not include in-match stats (possession, shots, xG). Anti-fabrication: preserve as null.
    stats: null,
    homeForm: null,
    awayForm: null,
    h2h,
    isDemo: false,
    isDelayed: true,
    lastUpdated: match.lastUpdated,
    providerNotice:
      'Data supplied by football-data.org Free Tier (Delayed scores – Rate limit 10 req/min).',
  };
}

/**
 * Adapts a list of football-data matches, filtering out unsupported leagues.
 */
export function adaptFootballDataMatchesResponse(data: FootballDataMatchesResponse): Fixture[] {
  if (!data?.matches || !Array.isArray(data.matches)) {
    return [];
  }
  return data.matches.map(adaptFootballDataMatch);
}

/**
 * Adapts football-data.org standings response into CompetitionStandings contract.
 */
export function adaptFootballDataStandingsResponse(data: FootballDataStandingsResponse): CompetitionStandings | null {
  if (!data || !data.standings || !Array.isArray(data.standings)) {
    return null;
  }
  const compCode = data.competition?.code || 'PL';
  const registryEntry = getRegistryEntryByFdCode(compCode);
  const knownComp = FREE_PROVIDER_COMPETITIONS.find((c) => c.code === compCode);

  const competition: Competition = {
    id: registryEntry?.id || compCode,
    name: registryEntry?.name || data.competition?.name || knownComp?.name || compCode,
    code: compCode,
    type: registryEntry?.type || (data.competition?.type === 'CUP' ? 'CUP' : 'LEAGUE'),
    emblem: data.competition?.emblem || registryEntry?.emblem || knownComp?.emblem,
    country: registryEntry?.country || knownComp?.country || 'International',
    season: data.season?.startDate
      ? `${new Date(data.season.startDate).getFullYear()}/${String(new Date(data.season.endDate).getFullYear()).slice(-2)}`
      : knownComp?.season || '2024/25',
    matchday: data.season?.currentMatchday,
    isDemo: false,
    isSupported: true,
  };

  // Find the TOTAL standings table (standard overall table) or first table
  const totalStanding = data.standings.find((s) => s.type === 'TOTAL') || data.standings[0];
  if (!totalStanding || !Array.isArray(totalStanding.table)) {
    return null;
  }

  const table: StandingEntry[] = totalStanding.table.map((entry) => ({
    position: entry.position,
    team: {
      id: String(entry.team.id),
      name: entry.team.name,
      shortName: entry.team.shortName || entry.team.name,
      tla: entry.team.tla || entry.team.shortName?.slice(0, 3).toUpperCase() || 'TM',
      crest: entry.team.crest,
    },
    playedGames: entry.playedGames,
    form: entry.form,
    won: entry.won,
    draw: entry.draw,
    lost: entry.lost,
    points: entry.points,
    goalsFor: entry.goalsFor,
    goalsAgainst: entry.goalsAgainst,
    goalDifference: entry.goalDifference,
  }));

  return {
    competition,
    season: {
      startDate: data.season?.startDate || '',
      endDate: data.season?.endDate || '',
      currentMatchday: data.season?.currentMatchday,
    },
    table,
  };
}
