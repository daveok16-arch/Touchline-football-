/**
 * Project Touchline – Canonical Competition Registry
 *
 * Single source of truth for competition identity across the integrated providers
 * (football-data.org and SportAPI.ai). The registry is built from *verified* provider
 * data — competition IDs and names actually returned by the providers — plus the
 * configured code mappings. It is intentionally a superset of what the UI currently
 * lists, so newly discovered competitions can be resolved safely without inventing
 * metadata.
 *
 * Rules honoured here:
 * - Canonical identity, not display name alone: each row carries the provider codes
 *   (football-data.org code and SportAPI.ai league id) that map to the same competition.
 * - No fabricated metadata: name and country come from the provider response. Only
 *   core competitions carry a curated country/emblem.
 * - Overlapping competitions (both providers supply them) are represented once.
 */

export type CompetitionType = 'LEAGUE' | 'CUP' | 'SUPER_CUP' | 'INTERNATIONAL';

export interface CompetitionRegistryEntry {
  /** Stable canonical id used by the app (provider-independent). */
  id: string;
  /** Canonical display name. */
  name: string;
  /** Verified country/region metadata (provider zone, or curated for core competitions). */
  country: string;
  type: CompetitionType;
  /** football-data.org competition code, when this competition is supplied by it. */
  fdCode?: string;
  /** SportAPI.ai league id, when this competition is supplied by it. */
  sportApiId?: number;
  /** True only where a working standings implementation exists (football-data.org). */
  standings: boolean;
  /** Emblem/crest URL, when verified. */
  emblem?: string;
}

export const COMPETITION_REGISTRY: CompetitionRegistryEntry[] = [
  // Core verified competitions (football-data.org primary; SportAPI.ai alias).
  { id: 'PL', name: 'Premier League', country: 'England', type: 'LEAGUE', emblem: 'https://crests.football-data.org/PL.png', fdCode: 'PL', sportApiId: 24, standings: true },
  { id: 'CL', name: 'UEFA Champions League', country: 'Europe', type: 'CUP', emblem: 'https://crests.football-data.org/CL.png', fdCode: 'CL', sportApiId: 18, standings: true },
  { id: 'PD', name: 'La Liga (Primera División)', country: 'Spain', type: 'LEAGUE', emblem: 'https://crests.football-data.org/laliga.png', fdCode: 'PD', sportApiId: 1, standings: true },
  { id: 'SA', name: 'Serie A', country: 'Italy', type: 'LEAGUE', emblem: 'https://crests.football-data.org/SA.png', fdCode: 'SA', sportApiId: 3, standings: true },
  { id: 'BL1', name: 'German Bundesliga', country: 'Germany', type: 'LEAGUE', sportApiId: 2, standings: false },
  { id: 'SP-4', name: 'Austrian Bundesliga', country: 'Austria', type: 'LEAGUE', sportApiId: 4, standings: false },
  { id: 'SP-5', name: 'Belgian Pro League', country: 'Belgium', type: 'LEAGUE', sportApiId: 5, standings: false },
  { id: 'SP-6', name: 'Croatia Prva HNL', country: 'Croatia', type: 'LEAGUE', sportApiId: 6, standings: false },
  { id: 'SP-7', name: 'Czech First League', country: 'Czechia', type: 'LEAGUE', sportApiId: 7, standings: false },
  { id: 'SP-8', name: 'Dutch Eredivisie', country: 'Netherlands', type: 'LEAGUE', sportApiId: 8, standings: false },
  { id: 'SP-9', name: 'French Ligue 1', country: 'France', type: 'LEAGUE', sportApiId: 9, standings: false },
  { id: 'SP-10', name: 'Greek Super League', country: 'Greece', type: 'LEAGUE', sportApiId: 10, standings: false },
  { id: 'SP-11', name: 'Norwegian Eliteserien', country: 'Norway', type: 'LEAGUE', sportApiId: 11, standings: false },
  { id: 'SP-12', name: 'Polish Ekstraklasa', country: 'Poland', type: 'LEAGUE', sportApiId: 12, standings: false },
  { id: 'SP-13', name: 'Portuguese Primeira Liga', country: 'Portugal', type: 'LEAGUE', sportApiId: 13, standings: false },
  { id: 'SP-14', name: 'Serbian Super Liga', country: 'Serbia', type: 'LEAGUE', sportApiId: 14, standings: false },
  { id: 'SP-15', name: 'Swiss Super League', country: 'Switzerland', type: 'LEAGUE', sportApiId: 15, standings: false },
  { id: 'SP-16', name: 'Turkish Super Lig', country: 'Türkiye', type: 'LEAGUE', sportApiId: 16, standings: false },
  { id: 'SP-17', name: 'Ukraine Premier League', country: 'Ukraine', type: 'LEAGUE', sportApiId: 17, standings: false },
  { id: 'SP-19', name: 'Danish Superligaen', country: 'Denmark', type: 'LEAGUE', sportApiId: 19, standings: false },
  { id: 'SP-20', name: 'Finnish Veikkausliiga', country: 'Finland', type: 'LEAGUE', sportApiId: 20, standings: false },
  { id: 'SP-21', name: 'Swedish Allsvenskan', country: 'Sweden', type: 'LEAGUE', sportApiId: 21, standings: false },
  { id: 'EL', name: 'UEFA Europa League', country: 'Europe', type: 'CUP', sportApiId: 22, standings: false },
  { id: 'ECL', name: 'UEFA Conference League', country: 'Europe', type: 'CUP', sportApiId: 23, standings: false },
  { id: 'SP-25', name: 'English League Cup', country: 'England', type: 'CUP', sportApiId: 25, standings: false },
  { id: 'CIT', name: 'Coppa Italia', country: 'Italy', type: 'CUP', sportApiId: 30, standings: false },
  { id: 'DFB', name: 'German DFB Pokal', country: 'Germany', type: 'CUP', sportApiId: 31, standings: false },
  { id: 'CDR', name: 'Spanish Copa Del Rey', country: 'Spain', type: 'CUP', sportApiId: 32, standings: false },
  { id: 'SP-35', name: 'UEFA Nations League', country: 'Europe', type: 'CUP', sportApiId: 35, standings: false },
  { id: 'BSA', name: 'Brazilian Serie A', country: 'Brazil', type: 'LEAGUE', sportApiId: 36, standings: false },
  { id: 'SP-53', name: 'Championship', country: 'England', type: 'LEAGUE', sportApiId: 53, standings: false },
  { id: 'SP-54', name: 'League One', country: 'England', type: 'LEAGUE', sportApiId: 54, standings: false },
  { id: 'SP-55', name: 'League Two', country: 'England', type: 'LEAGUE', sportApiId: 55, standings: false },
  { id: 'SP-56', name: 'National League', country: 'England', type: 'LEAGUE', sportApiId: 56, standings: false },
  { id: 'SP-57', name: 'National League N / S', country: 'England', type: 'LEAGUE', sportApiId: 57, standings: false },
  { id: 'FAC', name: 'FA Cup', country: 'England', type: 'CUP', sportApiId: 58, standings: false },
  { id: 'SP-59', name: "Women's Super League", country: 'England', type: 'LEAGUE', sportApiId: 59, standings: false },
  { id: 'SP-60', name: 'English Football League Trophy', country: 'England', type: 'CUP', sportApiId: 60, standings: false },
  { id: 'SP-61', name: 'English FA Trophy', country: 'England', type: 'CUP', sportApiId: 61, standings: false },
  { id: 'SP-62', name: 'National League Cup', country: 'England', type: 'CUP', sportApiId: 62, standings: false },
  { id: 'SP-64', name: 'Indian Super League', country: 'India', type: 'LEAGUE', sportApiId: 64, standings: false },
  { id: 'SP-65', name: 'Liga MX', country: 'Mexico', type: 'LEAGUE', sportApiId: 65, standings: false },
  { id: 'SP-66', name: 'Nigerian Premier League', country: 'Nigeria', type: 'LEAGUE', sportApiId: 66, standings: false },
  { id: 'SP-67', name: "UEFA Women's Champions League", country: 'Europe', type: 'CUP', sportApiId: 67, standings: false },
  { id: 'SP-68', name: 'Scottish Championship', country: 'Scotland', type: 'LEAGUE', sportApiId: 68, standings: false },
  { id: 'SP-69', name: 'Scottish League Two', country: 'Scotland', type: 'LEAGUE', sportApiId: 69, standings: false },
  { id: 'SP-70', name: 'Highland / Lowland', country: 'Scotland', type: 'LEAGUE', sportApiId: 70, standings: false },
  { id: 'SP-71', name: 'Internationals', country: 'World', type: 'INTERNATIONAL', sportApiId: 71, standings: false },
  { id: 'AFCONQ', name: 'CAF Africa Cup of Nations Qualifiers', country: 'Africa', type: 'CUP', sportApiId: 72, standings: false },
  { id: 'SP-73', name: "Welsh Premier Women's League", country: 'Wales', type: 'LEAGUE', sportApiId: 73, standings: false },
  { id: 'SP-76', name: 'UEFA Under 21 Championship Qualifiers', country: 'Europe', type: 'CUP', sportApiId: 76, standings: false },
  { id: 'SP-77', name: 'Under 21 Internationals', country: 'World', type: 'INTERNATIONAL', sportApiId: 77, standings: false },
  { id: 'SP-78', name: 'Scottish League One', country: 'Scotland', type: 'LEAGUE', sportApiId: 78, standings: false },
  { id: 'SP-79', name: 'Cymru Premier', country: 'Wales', type: 'LEAGUE', sportApiId: 79, standings: false },
  { id: 'SP-80', name: 'English WSL 2', country: 'England', type: 'LEAGUE', sportApiId: 80, standings: false },
  { id: 'SP-81', name: 'Northern Irish Premiership', country: 'Northern Ireland', type: 'LEAGUE', sportApiId: 81, standings: false },
  { id: 'SP-82', name: 'Scottish SWPL 1', country: 'Scotland', type: 'LEAGUE', sportApiId: 82, standings: false },
  { id: 'SP-83', name: 'Australian A-League Men', country: 'Australia', type: 'LEAGUE', sportApiId: 83, standings: false },
  { id: 'SP-84', name: 'League of Ireland Premier Division', country: 'Republic of Ireland', type: 'LEAGUE', sportApiId: 84, standings: false },
  { id: 'SP-85', name: 'Chinese Super League', country: 'China', type: 'LEAGUE', sportApiId: 85, standings: false },
  { id: 'SPL', name: 'Saudi Arabian League', country: 'Saudi Arabia', type: 'LEAGUE', sportApiId: 87, standings: false },
  { id: 'SP-88', name: 'Scottish Premiership', country: 'Scotland', type: 'LEAGUE', sportApiId: 88, standings: false },
  { id: 'MLS', name: 'US Major League Soccer', country: 'USA', type: 'LEAGUE', sportApiId: 89, standings: false },
  { id: 'SP-91', name: 'Scottish Challenge Cup', country: 'Scotland', type: 'CUP', sportApiId: 91, standings: false },
  { id: 'SP-92', name: 'South Africa PSL', country: 'South Africa', type: 'LEAGUE', sportApiId: 92, standings: false },
  { id: 'SP-93', name: 'Internationals Women', country: 'World', type: 'INTERNATIONAL', sportApiId: 93, standings: false },
  { id: 'SP-94', name: 'CONMEBOL Libertadores', country: 'South America', type: 'CUP', sportApiId: 94, standings: false },
  { id: 'SP-95', name: "Women's League Cup", country: 'England', type: 'CUP', sportApiId: 95, standings: false },
  { id: 'SP-97', name: 'Northern Ireland League Cup', country: 'Northern Ireland', type: 'CUP', sportApiId: 97, standings: false },
  { id: 'SP-99', name: 'Scottish Cup', country: 'Scotland', type: 'CUP', sportApiId: 99, standings: false },
  { id: 'J1', name: 'Japanese J1 League', country: 'Japan', type: 'LEAGUE', sportApiId: 100, standings: false },
  { id: 'SP-101', name: 'Scottish League Cup', country: 'Scotland', type: 'CUP', sportApiId: 101, standings: false },
  { id: 'SP-102', name: 'Irish FAI Cup', country: 'Republic of Ireland', type: 'CUP', sportApiId: 102, standings: false },
  { id: 'SP-106', name: 'Welsh Cup', country: 'Wales', type: 'CUP', sportApiId: 106, standings: false },
  { id: 'SP-108', name: 'Campeones Cup', country: 'N/C America', type: 'CUP', sportApiId: 108, standings: false },
  { id: 'SP-112', name: 'Scottish SWF Cup', country: 'Scotland', type: 'CUP', sportApiId: 112, standings: false },
  { id: 'SP-42234', name: 'Friendly', country: 'World', type: 'INTERNATIONAL', sportApiId: 42234, standings: false },
  { id: 'SP-43635', name: 'Concacaf Nations League', country: 'N/C America', type: 'CUP', sportApiId: 43635, standings: false },
];

/** Competitions that existed before the SportAPI expansion — used for reporting. */
export const ORIGINAL_CORE_COMPETITION_IDS = ['PL', 'CL', 'PD', 'SA'] as const;

/** Competitions with a working standings implementation (football-data.org free tier). */
export const STANDINGS_SUPPORTED_IDS = COMPETITION_REGISTRY.filter((c) => c.standings).map((c) => c.id);

const BY_ID = new Map<string, CompetitionRegistryEntry>();
const BY_FD_CODE = new Map<string, CompetitionRegistryEntry>();
const BY_SPORTAPI_ID = new Map<number, CompetitionRegistryEntry>();

for (const entry of COMPETITION_REGISTRY) {
  BY_ID.set(entry.id, entry);
  if (entry.fdCode) BY_FD_CODE.set(entry.fdCode.toUpperCase(), entry);
  if (entry.sportApiId !== undefined) BY_SPORTAPI_ID.set(entry.sportApiId, entry);
}

/**
 * Normalizes a competition name for robust cross-provider matching.
 * Diacritics, punctuation, and case are removed; a small alias table maps the
 * known provider name variants onto a shared canonical key.
 */
export function normalizeCompetitionKey(name?: string | null): string {
  if (!name || typeof name !== 'string') return '';
  const norm = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const aliases: Record<string, string> = {
    'spanish la liga': 'la liga',
    'primera division': 'la liga',
    'la liga primera division': 'la liga',
    'la liga': 'la liga',
    laliga: 'la liga',
    'italian serie a': 'serie a',
    'serie a': 'serie a',
    'german bundesliga': 'bundesliga',
    bundesliga: 'bundesliga',
    'us major league soccer': 'mls',
    mls: 'mls',
    'saudi arabian league': 'saudi pro league',
    'saudi pro league': 'saudi pro league',
    'japanese j1 league': 'j1 league',
    'j1 league': 'j1 league',
    'dutch eredivisie': 'eredivisie',
    eredivisie: 'eredivisie',
    'french ligue 1': 'ligue 1',
    'ligue 1': 'ligue 1',
    'portuguese primeira liga': 'primeira liga',
    'primeira liga': 'primeira liga',
    'champions league': 'uefa champions league',
    'uefa champions league': 'uefa champions league',
    'brazilian serie a': 'brazilian serie a',
    'austrian bundesliga': 'austrian bundesliga',
  };
  return aliases[norm] || norm;
}

/** Resolves a registry entry from a canonical id. */
export function getRegistryEntryById(id?: string | null): CompetitionRegistryEntry | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

/** Resolves a registry entry from a football-data.org competition code. */
export function getRegistryEntryByFdCode(code?: string | null): CompetitionRegistryEntry | undefined {
  if (!code) return undefined;
  return BY_FD_CODE.get(code.toUpperCase());
}

/** Resolves a registry entry from a SportAPI.ai league id. */
export function getRegistryEntryBySportApiId(id?: number | null): CompetitionRegistryEntry | undefined {
  if (id === undefined || id === null) return undefined;
  return BY_SPORTAPI_ID.get(id);
}

/** Resolves a registry entry from a provider competition name (canonical, not display-only). */
export function getRegistryEntryByName(name?: string | null): CompetitionRegistryEntry | undefined {
  const key = normalizeCompetitionKey(name);
  if (!key) return undefined;
  return COMPETITION_REGISTRY.find((c) => normalizeCompetitionKey(c.name) === key);
}

/**
 * True when a competition is verified as genuinely available from an integrated
 * provider. "Verified" means the competition is a mapped/core entry or was observed
 * in provider data — never merely advertised.
 */
export function isVerifiedCompetitionId(id?: string | null): boolean {
  return Boolean(getRegistryEntryById(id));
}
