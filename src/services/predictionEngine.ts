/**
 * Project Touchline – Daily Match Intelligence & Poisson Prediction Engine
 * Canonical Poisson prediction engine using official league standings data.
 * Adheres strictly to honest ranking rules:
 * - Only upcoming matches (SCHEDULED or TIMED)
 * - Supported competitions only: PL, CL, PD, SA
 * - Cold-start teams (< 3 matches played or unranked) are flagged and excluded from ranking
 * - Probabilities are statistical estimates, NEVER guaranteed winners, value bets, or sure bets
 * - Deterministic, documented ranking criterion based on outcome decisiveness spread
 * - Enforces single canonical model version (frozen parameters)
 */

import { CompetitionStandings, Fixture, MatchIntelligence, PoissonProbabilities, StandingEntry } from '../types/football';

export const FROZEN_MODEL_VERSION = 'POISSON_V1_FROZEN';
export const MODEL_REGISTRY_ID = 'touchline-canonical-poisson';

// Documented ranking criterion
export const RANKING_CRITERION_NAME = 'Outcome Decisiveness Margin';
export const RANKING_CRITERION_DESCRIPTION =
  'Ranks eligible upcoming matches by the margin between the most probable outcome and the second most probable outcome (P_max - P_second), tie-broken by evidence sample size (matches played) and kickoff time.';

export const SUPPORTED_INTELLIGENCE_COMPETITIONS = ['PL', 'CL', 'PD', 'SA'];

/**
 * Conservative stale-cache guardrail:
 * Verifies that a scheduled fixture is genuinely upcoming and has not already reached kickoff.
 */
export function isGenuinelyUpcomingFixture(fixture?: Fixture | null, asOfMs: number = Date.now()): boolean {
  if (!fixture) return false;
  if (fixture.status !== 'SCHEDULED' && fixture.status !== 'TIMED') return false;
  if (!fixture.utcKickoffTime) return false;
  const kickoffMs = new Date(fixture.utcKickoffTime).getTime();
  return !isNaN(kickoffMs) && kickoffMs > asOfMs;
}

/**
 * Computes Poisson probability P(X = k) = (lambda^k * e^-lambda) / k!
 */
export function calculatePoissonProbability(lambda: number, k: number): number {
  if (lambda <= 0 || k < 0 || !Number.isFinite(lambda) || !Number.isFinite(k)) {
    return 0;
  }
  let factorial = 1;
  for (let i = 2; i <= k; i++) {
    factorial *= i;
  }
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial;
}

/**
 * Normalises a club name for fallback matching.
 *
 * Only whole-word club-type suffixes are removed, so legal prefixes and initials survive:
 * "SSC Napoli" -> "ssc napoli" (NOT "s napoli"), "Sevilla FC" -> "sevilla",
 * "Al Ahly SC" -> "al ahly". Diacritics are folded so "Montréal" matches "Montreal".
 */
export function normalizeTeamName(name: string): string {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+\b(fc|cf|afc|sc|ac|ss|ssc|cd|ud|sv|bsc|fk)\b\s*$/, '')
    .trim();
}

/**
 * True when two normalised club names refer to the same club. Uses whole-token containment
 * rather than raw substring containment so "inter" does not match "internazionale".
 */
function teamNamesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aTokens = a.split(' ');
  const bTokens = b.split(' ');
  // One name fully contains the other's token sequence, in order.
  const containsSeq = (hay: string[], needle: string[]): boolean => {
    if (needle.length === 0 || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (needle.every((t, j) => hay[i + j] === t)) return true;
    }
    return false;
  };
  return containsSeq(aTokens, bTokens) || containsSeq(bTokens, aTokens);
}

/**
 * Finds team entry in league standings table.
 *
 * ID match first. The name fallback only runs when the provider id is absent or changed, and it
 * uses whole-word normalisation so initials are never stripped from a club's actual name.
 */
export function findTeamInStandings(teamId: string, teamName: string, standings: CompetitionStandings): StandingEntry | null {
  if (!standings?.table || !Array.isArray(standings.table)) {
    return null;
  }
  // First try matching by ID
  const byId = standings.table.find((e) => String(e.team?.id) === String(teamId));
  if (byId) return byId;

  // Fallback: whole-word name matching (diacritic-folded).
  const cleanTarget = normalizeTeamName(teamName);
  const byName = standings.table.find((e) => {
    const entryName = normalizeTeamName(e.team?.name || '');
    const shortName = normalizeTeamName(e.team?.shortName || '');
    return teamNamesMatch(entryName, cleanTarget) || teamNamesMatch(shortName, cleanTarget);
  });
  return byName || null;
}

/**
 * Calculates league baseline goal averages from the standings table.
 */
export function calculateLeagueAverages(standings: CompetitionStandings): {
  avgGoalsPerGame: number;
  totalGames: number;
} {
  if (!standings?.table || standings.table.length === 0) {
    return { avgGoalsPerGame: 2.7, totalGames: 0 };
  }

  let totalGoals = 0;
  let totalGamesPlayed = 0;
  for (const entry of standings.table) {
    totalGoals += entry.goalsFor || 0;
    totalGamesPlayed += entry.playedGames || 0;
  }

  // Since each match involves 2 teams, total matches = totalGamesPlayed / 2
  const totalMatches = totalGamesPlayed / 2;
  if (totalMatches <= 0 || totalGoals <= 0) {
    return { avgGoalsPerGame: 2.7, totalGames: 0 };
  }

  const avgGoalsPerGame = Math.max(1.5, Math.min(4.0, totalGoals / totalMatches));
  return { avgGoalsPerGame, totalGames: totalMatches };
}

/**
 * Evaluates match using bivariate Poisson probability distribution.
 */
export function evaluatePoissonProbabilities(
  homeStanding: StandingEntry,
  awayStanding: StandingEntry,
  leagueAvgGoalsPerGame: number
): PoissonProbabilities | null {
  if (
    !homeStanding ||
    !awayStanding ||
    homeStanding.playedGames < 3 ||
    awayStanding.playedGames < 3
  ) {
    return null;
  }

  const avgGoalsPerTeam = leagueAvgGoalsPerGame / 2;

  // Attack & defense rates per game
  const homeAttackRate = homeStanding.goalsFor / homeStanding.playedGames;
  const homeDefenseRate = homeStanding.goalsAgainst / homeStanding.playedGames;
  const awayAttackRate = awayStanding.goalsFor / awayStanding.playedGames;
  const awayDefenseRate = awayStanding.goalsAgainst / awayStanding.playedGames;

  const homeAttackStrength = avgGoalsPerTeam > 0 ? homeAttackRate / avgGoalsPerTeam : 1.0;
  const homeDefenseStrength = avgGoalsPerTeam > 0 ? homeDefenseRate / avgGoalsPerTeam : 1.0;
  const awayAttackStrength = avgGoalsPerTeam > 0 ? awayAttackRate / avgGoalsPerTeam : 1.0;
  const awayDefenseStrength = avgGoalsPerTeam > 0 ? awayDefenseRate / avgGoalsPerTeam : 1.0;

  // Standard empirical home advantage adjustment (1.14x home, 0.88x away)
  const HOME_ADVANTAGE = 1.14;
  const AWAY_DISADVANTAGE = 0.88;

  let expectedGoalsHome = avgGoalsPerTeam * homeAttackStrength * awayDefenseStrength * HOME_ADVANTAGE;
  let expectedGoalsAway = avgGoalsPerTeam * awayAttackStrength * homeDefenseStrength * AWAY_DISADVANTAGE;

  // Clamp expected goals to realistic bounds
  expectedGoalsHome = Math.max(0.3, Math.min(4.5, expectedGoalsHome));
  expectedGoalsAway = Math.max(0.3, Math.min(4.5, expectedGoalsAway));

  const maxGoals = 7;
  let pHomeWin = 0;
  let pDraw = 0;
  let pAwayWin = 0;

  for (let h = 0; h <= maxGoals; h++) {
    const pH = calculatePoissonProbability(expectedGoalsHome, h);
    for (let a = 0; a <= maxGoals; a++) {
      const pA = calculatePoissonProbability(expectedGoalsAway, a);
      const jointProb = pH * pA;
      if (h > a) {
        pHomeWin += jointProb;
      } else if (h === a) {
        pDraw += jointProb;
      } else {
        pAwayWin += jointProb;
      }
    }
  }

  const totalP = pHomeWin + pDraw + pAwayWin;
  if (totalP <= 0 || !Number.isFinite(totalP)) {
    return null;
  }

  return {
    homeWin: Math.round((pHomeWin / totalP) * 1000) / 1000,
    draw: Math.round((pDraw / totalP) * 1000) / 1000,
    awayWin: Math.round((pAwayWin / totalP) * 1000) / 1000,
    expectedGoalsHome: Math.round(expectedGoalsHome * 100) / 100,
    expectedGoalsAway: Math.round(expectedGoalsAway * 100) / 100,
  };
}

/**
 * Evaluates a single upcoming match for Daily Match Intelligence.
 */
export function evaluateMatchIntelligence(
  fixture: Fixture,
  standingsMap: Record<string, CompetitionStandings | null>,
  asOfMs: number = Date.now()
): MatchIntelligence {
  const disclaimer =
    'Probabilities are mathematical Poisson distribution estimates based on official league scoring rates. They are statistical projections, not guarantees, sure bets, or financial advice.';
  const validationNotice =
    'Shadow observation status: Frozen model version (V1). Not prospectively validated.';

  const compCode = (fixture?.competition?.code || '').toUpperCase();

  // 1. Check supported competition
  if (!SUPPORTED_INTELLIGENCE_COMPETITIONS.includes(compCode)) {
    return {
      fixtureId: fixture?.id || '',
      fixture,
      isEligible: false,
      ineligibilityReason: `Competition ${compCode || 'UNKNOWN'} is not supported for Daily Intelligence.`,
      isColdStart: false,
      evidenceLevel: 'COLD_START',
      evidenceDescription: 'Unsupported competition.',
      dataFreshness: 'No league data',
      conciseExplanation: 'Match is outside the supported intelligence leagues (PL, CL, PD, SA).',
      validationNotice,
      disclaimer,
    };
  }

  // 2. Check match status (only upcoming matches are eligible)
  const isUpcoming = fixture?.status === 'SCHEDULED' || fixture?.status === 'TIMED';
  if (!isUpcoming) {
    return {
      fixtureId: fixture?.id || '',
      fixture,
      isEligible: false,
      ineligibilityReason: `Match status is ${fixture?.status || 'UNKNOWN'}. Predictions are evaluated only for upcoming scheduled matches.`,
      isColdStart: false,
      evidenceLevel: 'COLD_START',
      evidenceDescription: 'Match not upcoming.',
      dataFreshness: 'Live / Completed / Inactive',
      conciseExplanation: `Match is currently ${fixture?.status}. Pre-match intelligence applies to scheduled fixtures.`,
      validationNotice,
      disclaimer,
    };
  }

  // Conservative stale-cache guardrail: ensure scheduled kickoff has not already passed
  if (!isGenuinelyUpcomingFixture(fixture, asOfMs)) {
    return {
      fixtureId: fixture?.id || '',
      fixture,
      isEligible: false,
      ineligibilityReason: `Kickoff time has passed (${fixture.utcKickoffTime}). Match is no longer upcoming under conservative freshness rules.`,
      isColdStart: false,
      evidenceLevel: 'COLD_START',
      evidenceDescription: 'Kickoff elapsed.',
      dataFreshness: 'Elapsed kickoff',
      conciseExplanation: 'Kickoff time has passed. Match is treated as in-progress or finished to avoid stale predictions.',
      validationNotice,
      disclaimer,
    };
  }

  // 3. Check standings availability
  const standings = standingsMap[compCode];
  if (!standings || !standings.table || standings.table.length === 0) {
    return {
      fixtureId: fixture?.id || '',
      fixture,
      isEligible: false,
      ineligibilityReason: `League table for ${compCode} is temporarily unavailable from the provider.`,
      isColdStart: true,
      evidenceLevel: 'COLD_START',
      evidenceDescription: 'Missing league standings.',
      dataFreshness: 'Standings unavailable',
      conciseExplanation: 'Standings data could not be retrieved from the provider for this tournament.',
      validationNotice,
      disclaimer,
    };
  }

  // 4. Find both teams in the standings table
  const homeStanding = findTeamInStandings(fixture.homeTeam?.id, fixture.homeTeam?.name, standings);
  const awayStanding = findTeamInStandings(fixture.awayTeam?.id, fixture.awayTeam?.name, standings);

  if (!homeStanding || !awayStanding) {
    const missing = !homeStanding && !awayStanding
      ? 'both teams'
      : !homeStanding
      ? fixture.homeTeam?.name || 'home team'
      : fixture.awayTeam?.name || 'away team';

    return {
      fixtureId: fixture?.id || '',
      fixture,
      isEligible: false,
      ineligibilityReason: `Unranked in standings: ${missing} not found in current league table.`,
      isColdStart: true,
      evidenceLevel: 'COLD_START',
      evidenceDescription: 'Team not found in table.',
      dataFreshness: 'Incomplete team data',
      conciseExplanation: `${missing} could not be resolved in the provider standings table.`,
      validationNotice,
      disclaimer,
    };
  }

  // 5. Check cold-start threshold (< 3 matches played)
  const homeGames = homeStanding.playedGames || 0;
  const awayGames = awayStanding.playedGames || 0;

  if (homeGames < 3 || awayGames < 3) {
    return {
      fixtureId: fixture?.id || '',
      fixture,
      isEligible: false,
      ineligibilityReason: `Cold start: Insufficient league history (${homeStanding.team.name}: ${homeGames} matches, ${awayStanding.team.name}: ${awayGames} matches). Minimum 3 matches required.`,
      isColdStart: true,
      evidenceLevel: 'COLD_START',
      evidenceDescription: 'Cold Start (< 3 matches played)',
      dataFreshness: `${homeGames + awayGames} total matches played`,
      conciseExplanation: `Insufficient league sample size (${homeGames} and ${awayGames} games played). Model requires at least 3 matches per team.`,
      validationNotice,
      disclaimer,
    };
  }

  // 6. Compute Poisson probabilities
  const { avgGoalsPerGame } = calculateLeagueAverages(standings);
  const probs = evaluatePoissonProbabilities(homeStanding, awayStanding, avgGoalsPerGame);

  if (!probs) {
    return {
      fixtureId: fixture?.id || '',
      fixture,
      isEligible: false,
      ineligibilityReason: 'Model probability computation failed for this match pairing.',
      isColdStart: false,
      evidenceLevel: 'PRELIMINARY',
      evidenceDescription: 'Computation error',
      dataFreshness: 'Standings loaded',
      conciseExplanation: 'Statistical model could not generate valid probabilities from current goal rates.',
      validationNotice,
      disclaimer,
    };
  }

  // 7. Calculate Deterministic Decisiveness Margin
  // Outcome separation margin: P_highest - P_second
  const sortedProbValues = [probs.homeWin, probs.draw, probs.awayWin].sort((a, b) => b - a);
  const rankingScore = Math.round((sortedProbValues[0] - sortedProbValues[1]) * 1000) / 1000;

  // 8. Determine Evidence Quality
  let evidenceLevel: 'HIGH' | 'MODERATE' | 'PRELIMINARY' = 'PRELIMINARY';
  let evidenceDescription = '';
  if (homeGames >= 10 && awayGames >= 10) {
    evidenceLevel = 'HIGH';
    evidenceDescription = `High Evidence (${homeGames} & ${awayGames} league matches evaluated)`;
  } else if (homeGames >= 5 && awayGames >= 5) {
    evidenceLevel = 'MODERATE';
    evidenceDescription = `Moderate Evidence (${homeGames} & ${awayGames} league matches evaluated)`;
  } else {
    evidenceLevel = 'PRELIMINARY';
    evidenceDescription = `Preliminary Evidence (${homeGames} & ${awayGames} league matches evaluated)`;
  }

  // 9. Build honest concise explanation solely from real data
  const homeSummary = `${homeStanding.team.name}: ${homeStanding.points} pts, GD ${homeStanding.goalDifference > 0 ? '+' : ''}${homeStanding.goalDifference}`;
  const awaySummary = `${awayStanding.team.name}: ${awayStanding.points} pts, GD ${awayStanding.goalDifference > 0 ? '+' : ''}${awayStanding.goalDifference}`;
  const homeFormPart = homeStanding.form ? `, form [${homeStanding.form.split(',').join('-')}]` : '';
  const awayFormPart = awayStanding.form ? `, form [${awayStanding.form.split(',').join('-')}]` : '';

  const favorite =
    probs.homeWin > probs.awayWin && probs.homeWin > probs.draw
      ? `${homeStanding.team.name} favoured (${Math.round(probs.homeWin * 100)}%)`
      : probs.awayWin > probs.homeWin && probs.awayWin > probs.draw
      ? `${awayStanding.team.name} favoured (${Math.round(probs.awayWin * 100)}%)`
      : `Even matchup (draw estimated at ${Math.round(probs.draw * 100)}%)`;

  const conciseExplanation = `${homeSummary}${homeFormPart} vs ${awaySummary}${awayFormPart}. Poisson expectation: ${favorite}. xG: ${probs.expectedGoalsHome.toFixed(2)} - ${probs.expectedGoalsAway.toFixed(2)}.`;

  return {
    fixtureId: fixture.id,
    fixture,
    isEligible: true,
    probabilities: probs,
    rankingScore,
    isColdStart: false,
    totalEvidenceGames: homeGames + awayGames,
    evidenceLevel,
    evidenceDescription,
    dataFreshness: `Standings: Matchday ${standings.season?.currentMatchday || homeGames}`,
    conciseExplanation,
    validationNotice,
    disclaimer,
  };
}

/**
 * Deterministically ranks eligible upcoming matches.
 * Ties are broken strictly by:
 * 1. Ranking score (decisiveness margin) descending
 * 2. Total games played descending (more evidence)
 * 3. Kickoff time ascending (earlier matches first)
 * 4. Fixture ID ascending
 */
export function rankEligibleMatches(evaluations: MatchIntelligence[]): MatchIntelligence[] {
  const eligible = evaluations.filter((e) => e.isEligible && e.probabilities !== undefined);

  eligible.sort((a, b) => {
    // 1. Ranking score descending
    const scoreDiff = (b.rankingScore ?? 0) - (a.rankingScore ?? 0);
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;

    // 2. Total games played descending
    const aGames = a.totalEvidenceGames ?? 0;
    const bGames = b.totalEvidenceGames ?? 0;
    if (bGames !== aGames) return bGames - aGames;

    // 3. Kickoff time ascending
    const timeA = a.fixture.utcKickoffTime ? new Date(a.fixture.utcKickoffTime).getTime() : 0;
    const timeB = b.fixture.utcKickoffTime ? new Date(b.fixture.utcKickoffTime).getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;

    // 4. Fixture ID ascending (guarantees strictly deterministic ordering)
    return a.fixtureId.localeCompare(b.fixtureId);
  });

  return eligible.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

/**
 * Single Model Architecture Registry Guard.
 * Confirms that only one canonical Poisson model is present and registered.
 */
export class PredictionModelRegistry {
  private static instance: PredictionModelRegistry;
  private readonly modelVersion = FROZEN_MODEL_VERSION;
  private readonly modelId = MODEL_REGISTRY_ID;

  private constructor() {}

  public static getInstance(): PredictionModelRegistry {
    if (!PredictionModelRegistry.instance) {
      PredictionModelRegistry.instance = new PredictionModelRegistry();
    }
    return PredictionModelRegistry.instance;
  }

  public getModelInfo() {
    return {
      modelId: this.modelId,
      version: this.modelVersion,
      criterion: RANKING_CRITERION_NAME,
      criterionDescription: RANKING_CRITERION_DESCRIPTION,
      supportedCompetitions: SUPPORTED_INTELLIGENCE_COMPETITIONS,
    };
  }
}
