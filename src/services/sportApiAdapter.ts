/**
 * Project Touchline – SportAPI.ai Provider Adapter
 * Normalizes SportAPI.ai REST JSON responses into Touchline domain contracts.
 * Free tier: 2,000 requests/day, 1-min score refresh, 117 supported leagues.
 */

import { Competition, CompetitionStandings, Fixture, MatchScore, MatchStatus, StandingEntry } from '../types/football';

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
export const SPORTAPI_LEAGUE_MAP: Record<number, { code: string; name: string; country: string; type: 'LEAGUE' | 'CUP' }> = {
  24: { code: 'PL', name: 'Premier League', country: 'England', type: 'LEAGUE' },
  18: { code: 'CL', name: 'UEFA Champions League', country: 'Europe', type: 'CUP' },
  22: { code: 'EL', name: 'UEFA Europa League', country: 'Europe', type: 'CUP' },
  23: { code: 'ECL', name: 'UEFA Conference League', country: 'Europe', type: 'CUP' },
  1: { code: 'PD', name: 'La Liga (Primera División)', country: 'Spain', type: 'LEAGUE' },
  3: { code: 'SA', name: 'Serie A', country: 'Italy', type: 'LEAGUE' },
  2: { code: 'BL1', name: 'Bundesliga', country: 'Germany', type: 'LEAGUE' },
  58: { code: 'FAC', name: 'FA Cup', country: 'England', type: 'CUP' },
  32: { code: 'CDR', name: 'Copa Del Rey', country: 'Spain', type: 'CUP' },
  30: { code: 'CIT', name: 'Coppa Italia', country: 'Italy', type: 'CUP' },
  31: { code: 'DFB', name: 'DFB Pokal', country: 'Germany', type: 'CUP' },
  89: { code: 'MLS', name: 'US Major League Soccer', country: 'USA', type: 'LEAGUE' },
  87: { code: 'SPL', name: 'Saudi Pro League', country: 'Saudi Arabia', type: 'LEAGUE' },
  100: { code: 'J1', name: 'Japanese J1 League', country: 'Japan', type: 'LEAGUE' },
  36: { code: 'BSA', name: 'Campeonato Brasileiro Série A', country: 'Brazil', type: 'LEAGUE' },
  123: { code: 'AFCON', name: 'CAF Africa Cup of Nations', country: 'Africa', type: 'CUP' },
  72: { code: 'AFCONQ', name: 'CAF AFCON Qualifiers', country: 'Africa', type: 'CUP' },
};

export const CODE_TO_SPORTAPI_ID: Record<string, number> = {
  PL: 24,
  CL: 18,
  EL: 22,
  ECL: 23,
  PD: 1,
  SA: 3,
  BL1: 2,
  FAC: 58,
  CDR: 32,
  CIT: 30,
  DFB: 31,
  MLS: 89,
  SPL: 87,
  J1: 100,
  BSA: 36,
  AFCON: 123,
  AFCONQ: 72,
};

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
  const compCode = leagueMeta?.code || `SP-${raw.league_id}`;

  const competition: Competition = {
    id: compCode,
    name: raw.league_name || leagueMeta?.name || compCode,
    code: compCode,
    type: leagueMeta?.type || 'LEAGUE',
    country: raw.league_zone || leagueMeta?.country || 'International',
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
  const compCode = leagueMeta?.code || `SP-${leagueId}`;

  const competition: Competition = {
    id: compCode,
    name: leagueMeta?.name || compCode,
    code: compCode,
    type: leagueMeta?.type || 'LEAGUE',
    country: leagueMeta?.country || 'International',
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
