/**
 * Project Touchline – SportAPI.ai Provider Adapter
 * Normalizes SportAPI.ai REST JSON responses into Touchline domain contracts.
 * Free tier: 2,000 requests/day, 1-min score refresh, 117 supported leagues.
 */

import { Competition, CompetitionStandings, Fixture, MatchScore, MatchStatus, StandingEntry } from '../types/football';
import { COMPETITION_REGISTRY, getRegistryEntryBySportApiId } from './competitionRegistry';

export interface SportApiTeamRef {
  id: number;
  name: string;
  short_name?: string;
  slug?: string;
  logo?: string;
}

export interface SportApiFixture {
  id: number;
  home_id: number;
  away_id: number;
  date: string;
  datetime: string;
  kickoff_utc: string;
  updated_at: string;
  home_score: number | null;
  away_score: number | null;
  ht_home?: number | null;
  ht_away?: number | null;
  result: number | null;
  status: string;
  minute: number | null;
  stage?: string;
  league_id: number;
  league_name: string;
  league_geo?: string;
  league_zone?: string;
  home_team: string;
  home_short?: string;
  home_logo?: string;
  home_stadium?: string;
  home_city?: string;
  away_team: string;
  away_short?: string;
  away_logo?: string;
  away_stadium?: string;
  away_city?: string;
  penalty_home?: number | null;
  penalty_away?: number | null;
  winner?: string;
}

export interface SportApiStandingsEntry {
  position: number;
  team: SportApiTeamRef;
  played: number;
  won: number;
  draw: number;
  lost: number;
  goals_for: number;
  goals_against: number;
  goal_difference: number;
  points: number;
  form?: Array<{
    result: string;
    date: string;
    home_team: string;
    away_team: string;
    home_score: number;
    away_score: number;
    is_home: boolean;
  }>;
}

/**
 * Bi-directional mapping between SportAPI league IDs and Touchline competition codes.
 */
export const SPORTAPI_LEAGUE_MAP: Record<number, { code: string; name: string; country: string; type: 'LEAGUE' | 'CUP' }> = Object.fromEntries(
  COMPETITION_REGISTRY.filter((c) => c.sportApiId !== undefined).map((c) => [
    c.sportApiId as number,
    { code: c.id, name: c.name, country: c.country, type: c.type === 'LEAGUE' || c.type === 'CUP' ? c.type : 'CUP' },
  ])
);

export const CODE_TO_SPORTAPI_ID: Record<string, number> = Object.fromEntries(
  COMPETITION_REGISTRY.filter((c) => c.sportApiId !== undefined).map((c) => [c.id, c.sportApiId as number])
);

/**
 * Maps SportAPI status string into internal MatchStatus enum.
 */
export function mapSportApiStatus(status: string): MatchStatus {
  switch (status?.toLowerCase()) {
    case 'live':
    case 'in_play':
      return 'IN_PLAY';
    case 'ht':
    case 'paused':
      return 'PAUSED';
    case 'ft':
    case 'aet':
    case 'pens':
    case 'finished':
      return 'FINISHED';
    case 'postp.':
    case 'postponed':
      return 'POSTPONED';
    case 'susp.':
    case 'suspended':
      return 'SUSPENDED';
    case 'canc.':
    case 'cancelled':
      return 'CANCELLED';
    case 'scheduled':
    case 'timed':
    default:
      return 'SCHEDULED';
  }
}

/**
 * Adapts raw SportApiFixture into Touchline Fixture domain model.
 */
export function adaptSportApiFixture(raw: SportApiFixture): Fixture {
  const leagueMeta = SPORTAPI_LEAGUE_MAP[raw.league_id];
  const registryEntry = getRegistryEntryBySportApiId(raw.league_id);
  const compCode = registryEntry?.id || leagueMeta?.code || `SP-${raw.league_id}`;

  const competition: Competition = {
    id: compCode,
    name: registryEntry?.name || raw.league_name || leagueMeta?.name || compCode,
    code: compCode,
    type: registryEntry?.type || leagueMeta?.type || 'LEAGUE',
    country: registryEntry?.country || raw.league_zone || leagueMeta?.country || 'International',
    season: '2026/27',
    isDemo: false,
    isSupported: true,
  };

  const score: MatchScore | undefined =
    raw.home_score !== null && raw.away_score !== null
      ? {
          home: raw.home_score,
          away: raw.away_score,
          halftime:
            raw.ht_home !== null && raw.ht_home !== undefined && raw.ht_away !== null && raw.ht_away !== undefined
              ? {
                  home: raw.ht_home,
                  away: raw.ht_away,
                }
              : undefined,
        }
      : undefined;

  return {
    id: `sp-${raw.id}`,
    utcKickoffTime: raw.kickoff_utc,
    status: mapSportApiStatus(raw.status),
    minute: raw.minute ?? undefined,
    competition,
    stage: raw.stage || undefined,
    homeTeam: {
      id: String(raw.home_id),
      name: raw.home_team,
      shortName: raw.home_short || raw.home_team,
      tla: (raw.home_short || raw.home_team).slice(0, 3).toUpperCase(),
      crest: raw.home_logo?.startsWith('http')
        ? raw.home_logo
        : raw.home_logo
        ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/${raw.home_logo.replace('espn-', '')}`
        : undefined,
    },
    awayTeam: {
      id: String(raw.away_id),
      name: raw.away_team,
      shortName: raw.away_short || raw.away_team,
      tla: (raw.away_short || raw.away_team).slice(0, 3).toUpperCase(),
      crest: raw.away_logo?.startsWith('http')
        ? raw.away_logo
        : raw.away_logo
        ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/${raw.away_logo.replace('espn-', '')}`
        : undefined,
    },
    score,
    venue: raw.home_stadium
      ? {
          name: raw.home_stadium,
          city: raw.home_city || '',
        }
      : undefined,
    stats: null,
    homeForm: null,
    awayForm: null,
    h2h: null,
    isDemo: false,
    isDelayed: false,
    lastUpdated: raw.updated_at,
    providerNotice: 'Data supplied by SportAPI.ai (2,000 req/day free tier).',
  };
}

/**
 * Adapts an array of SportApi fixtures.
 */
export function adaptSportApiFixturesResponse(matches: SportApiFixture[]): Fixture[] {
  if (!Array.isArray(matches)) return [];
  return matches.map(adaptSportApiFixture);
}

/**
 * Adapts SportAPI standings table into Touchline CompetitionStandings domain contract.
 */
export function adaptSportApiStandings(
  leagueId: number,
  entries: SportApiStandingsEntry[]
): CompetitionStandings | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const leagueMeta = SPORTAPI_LEAGUE_MAP[leagueId];
  const registryEntry = getRegistryEntryBySportApiId(leagueId);
  const compCode = registryEntry?.id || leagueMeta?.code || `SP-${leagueId}`;

  const competition: Competition = {
    id: compCode,
    name: registryEntry?.name || leagueMeta?.name || compCode,
    code: compCode,
    type: registryEntry?.type || leagueMeta?.type || 'LEAGUE',
    country: registryEntry?.country || leagueMeta?.country || 'International',
    season: '2026/27',
    isDemo: false,
    isSupported: true,
  };

  const table: StandingEntry[] = entries.map((e) => {
    const formString = Array.isArray(e.form)
      ? e.form.map((f) => f.result).join(',')
      : null;

    return {
      position: e.position,
      team: {
        id: String(e.team.id),
        name: e.team.name,
        shortName: e.team.short_name || e.team.name,
        tla: (e.team.short_name || e.team.name).slice(0, 3).toUpperCase(),
        crest: e.team.logo?.startsWith('http')
          ? e.team.logo
          : e.team.logo
          ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/${e.team.logo.replace('espn-', '')}`
          : undefined,
      },
      playedGames: e.played,
      form: formString,
      won: e.won,
      draw: e.draw,
      lost: e.lost,
      points: e.points,
      goalsFor: e.goals_for,
      goalsAgainst: e.goals_against,
      goalDifference: e.goal_difference,
    };
  });

  return {
    competition,
    season: {
      startDate: '2026-08-01',
      endDate: '2027-05-31',
    },
    table,
  };
}
