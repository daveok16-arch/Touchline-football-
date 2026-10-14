export interface FootballDataArea {
  id: number;
  name: string;
  code: string;
  flag?: string;
}

export interface FootballDataCompetitionRef {
  id: number;
  name: string;
  code: string;
  type: string;
  emblem?: string;
}

export interface FootballDataSeason {
  id: number;
  startDate: string;
  endDate: string;
  currentMatchday?: number;
  winner?: any;
}

export interface FootballDataTeamRef {
  id: number;
  name: string;
  shortName?: string;
  tla?: string;
  crest?: string;
}

export interface FootballDataScoreTime {
  home: number | null;
  away: number | null;
}

export interface FootballDataScore {
  winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
  duration?: string;
  fullTime?: FootballDataScoreTime;
  halfTime?: FootballDataScoreTime;
  extraTime?: FootballDataScoreTime;
  penalties?: FootballDataScoreTime;
}

export interface FootballDataReferee {
  id: number;
  name: string;
  type?: string;
  nationality?: string;
}

export interface FootballDataMatch {
  id: number;
  utcDate: string;
  status: 'SCHEDULED' | 'TIMED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'SUSPENDED' | 'AWARDED';
  minute?: number;
  matchday?: number;
  stage?: string;
  group?: string | null;
  lastUpdated?: string;
  area?: FootballDataArea;
  competition: FootballDataCompetitionRef;
  season?: FootballDataSeason;
  homeTeam: FootballDataTeamRef;
  awayTeam: FootballDataTeamRef;
  score?: FootballDataScore;
  venue?: string;
  referees?: FootballDataReferee[];
  head2head?: {
    numberOfMatches?: number;
    totalGoals?: number;
    homeTeam?: {
      id: number;
      name: string;
      wins: number;
      draws: number;
      losses: number;
    };
    awayTeam?: {
      id: number;
      name: string;
      wins: number;
      draws: number;
      losses: number;
    };
  };
}

export interface FootballDataMatchesResponse {
  filters?: Record<string, any>;
  resultSet?: {
    count: number;
    competitions?: string;
    first?: string;
    last?: string;
    played?: number;
  };
  matches: FootballDataMatch[];
}

export interface FootballDataCompetition {
  id: number;
  area: FootballDataArea;
  name: string;
  code: string;
  type: 'LEAGUE' | 'CUP';
  emblem?: string;
  plan?: string;
  currentSeason?: FootballDataSeason;
  numberOfAvailableSeasons?: number;
  lastUpdated?: string;
}

export interface FootballDataCompetitionsResponse {
  count: number;
  competitions: FootballDataCompetition[];
}

export interface ProviderStatus {
  configured: boolean;
  provider: 'football-data.org';
  tier: 'free';
  rateLimitPerMinute: number;
  latencyNotice: string;
  supportedCompetitions: Array<{
    code: string;
    id: number;
    name: string;
    country: string;
  }>;
  unsupportedCompetitions: Array<{
    code: string;
    name: string;
    reason: string;
  }>;
}

export interface FootballDataStandingsTableEntry {
  position: number;
  team: {
    id: number;
    name: string;
    shortName?: string;
    tla?: string;
    crest?: string;
  };
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

export interface FootballDataStandingsResponse {
  competition: {
    id: number;
    name: string;
    code: string;
    type: string;
    emblem?: string;
  };
  season: {
    id: number;
    startDate: string;
    endDate: string;
    currentMatchday?: number;
  };
  standings?: Array<{
    stage: string;
    type: string;
    group?: string | null;
    table: FootballDataStandingsTableEntry[];
  }>;
}
