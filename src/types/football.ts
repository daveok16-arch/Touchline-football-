export type MatchStatus =
  | 'SCHEDULED'
  | 'TIMED'
  | 'IN_PLAY'
  | 'PAUSED'
  | 'FINISHED'
  | 'POSTPONED'
  | 'SUSPENDED'
  | 'CANCELLED';

export interface Team {
  id: string;
  name: string;
  shortName: string;
  tla: string;
  crest?: string;
  country?: string;
}

export interface Competition {
  id: string;
  name: string;
  code: string;
  type: 'LEAGUE' | 'CUP' | 'SUPER_CUP' | 'INTERNATIONAL';
  emblem?: string;
  country: string;
  season: string;
  matchday?: number;
  isDemo?: boolean;
  isSupported?: boolean;
  unsupportedReason?: string;
}

export interface MatchScore {
  home: number | null;
  away: number | null;
  halftime?: {
    home: number | null;
    away: number | null;
  };
}

export interface MatchVenue {
  name: string;
  city: string;
  capacity?: number;
  surface?: string;
}

export interface MatchReferee {
  name: string;
  nationality?: string;
  role?: string;
}

export interface TeamStats {
  possession: number; // percentage, e.g. 54
  shotsTotal: number;
  shotsOnTarget: number;
  corners: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  offsides?: number;
  passesTotal?: number;
  passAccuracy?: number; // percentage, e.g. 86
  xG?: number; // e.g. 1.84
}

export interface MatchStats {
  home: TeamStats;
  away: TeamStats;
}

export interface FormMatch {
  id: string;
  date: string;
  opponent: string;
  isHome: boolean;
  scoreFor: number;
  scoreAgainst: number;
  result: 'W' | 'D' | 'L';
  competitionCode: string;
}

export interface TeamForm {
  teamId: string;
  lastMatches: FormMatch[];
  summary: {
    won: number;
    drawn: number;
    lost: number;
  };
}

export interface HeadToHeadMatch {
  id: string;
  date: string;
  competitionName: string;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
}

export interface HeadToHead {
  matchesPlayed: number;
  homeWins: number;
  awayWins: number;
  draws: number;
  recentMeetings: HeadToHeadMatch[];
}

export interface Fixture {
  id: string;
  utcKickoffTime: string; // ISO 8601 string, e.g. 2026-10-11T16:30:00Z
  status: MatchStatus;
  minute?: number; // for live matches, e.g. 68
  competition: Competition;
  stage?: string;
  group?: string;
  matchday?: number;
  homeTeam: Team;
  awayTeam: Team;
  score?: MatchScore;
  venue?: MatchVenue;
  referee?: MatchReferee;
  stats?: MatchStats | null;
  homeForm?: TeamForm | null;
  awayForm?: TeamForm | null;
  h2h?: HeadToHead | null;
  isDemo?: boolean;
  isDelayed?: boolean;
  providerNotice?: string;
}

export interface StandingEntry {
  position: number;
  team: Team;
  playedGames: number;
  form?: string | null;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
}

export interface CompetitionStandings {
  competition: Competition;
  season: {
    startDate: string;
    endDate: string;
    currentMatchday?: number;
  };
  table: StandingEntry[];
}

export interface PoissonProbabilities {
  homeWin: number;
  draw: number;
  awayWin: number;
  expectedGoalsHome: number;
  expectedGoalsAway: number;
}

export type EvidenceLevel = 'HIGH' | 'MODERATE' | 'PRELIMINARY' | 'COLD_START';

export interface MatchIntelligence {
  fixtureId: string;
  fixture: Fixture;
  isEligible: boolean;
  ineligibilityReason?: string;
  probabilities?: PoissonProbabilities;
  rankingScore?: number;
  rank?: number;
  isColdStart: boolean;
  totalEvidenceGames?: number;
  evidenceLevel: EvidenceLevel;
  evidenceDescription: string;
  dataFreshness: string;
  conciseExplanation: string;
  validationNotice: string;
  disclaimer: string;
}

/**
 * Separate odds contract. Never conflated with real fixtures, results, or standings.
 */
export interface MatchOdds {
  matchId: string;
  provider: '5dollarfootballapi' | 'the-odds-api' | 'none';
  available: boolean;
  lastUpdated?: string;
  bookmaker?: string;
  h2h?: {
    home: number;
    draw: number;
    away: number;
  };
  overUnder25?: {
    over: number;
    under: number;
  };
  bothTeamsToScore?: {
    yes: number;
    no: number;
  };
  notice: string;
}

/**
 * Operational status of an integrated or configured sports data provider.
 */
export interface ProviderReadiness {
  id: string;
  name: string;
  role: 'primary_fixtures' | 'secondary_fixtures' | 'odds' | 'auxiliary';
  configured: boolean;
  status: 'active' | 'unconfigured' | 'disabled' | 'rate_limited' | 'error';
  tier: 'free' | 'paid';
  rateLimit: string;
  supportedCompetitions: string[];
  latencyNotice: string;
  missingConfig?: string;
}

