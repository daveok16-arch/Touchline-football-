/**
 * Project Touchline – Chronological Backtest Harness
 *
 * Replays historical finished matches through the FROZEN Poisson engine and records
 * what the model would have predicted *before* each kickoff. Nothing here re-implements
 * or alters the model: the core probability math is imported from predictionEngine.ts
 * (`calculateLeagueAverages` + `evaluatePoissonProbabilities`), which is the frozen model.
 *
 * Leakage guarantee: for a match kicking off at time T, the standings used as features
 * are built ONLY from matches in the same competition whose kickoff is strictly before T.
 * A team's own result and every later result are excluded from its feature row.
 */

import { Fixture, CompetitionStandings, StandingEntry, Competition } from '../types/football';
import {
  calculateLeagueAverages,
  evaluatePoissonProbabilities,
  findTeamInStandings,
} from './predictionEngine';
import { EvaluationSample, Outcome, outcomeFromScore, ProbabilityTriplet } from './predictionMetrics';

export interface HistoricalMatchRecord {
  fixture: Fixture;
  kickoffMs: number;
  competitionCode: string;
  season: string;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  homeGoals: number | null;
  awayGoals: number | null;
  outcome: Outcome | null;
}

export type ExclusionReason =
  | 'NOT_FINISHED'
  | 'MISSING_SCORE'
  | 'MISSING_KICKOFF'
  | 'TEAM_NOT_IN_TABLE'
  | 'COLD_START'
  | 'MODEL_NULL';

export interface BacktestRecord {
  fixtureId: string;
  competitionCode: string;
  season: string;
  kickoffMs: number;
  outcome: Outcome | null;
  /** Frozen-model probabilities, present only when the match was eligible. */
  model?: ProbabilityTriplet;
  /** League-frequency baseline probabilities, present when history allowed it. */
  leagueFrequency?: ProbabilityTriplet;
  eligible: boolean;
  exclusionReason?: ExclusionReason;
}

/** Extracts a deterministic, chronological record list from adapted fixtures. */
export function toHistoricalRecords(fixtures: Fixture[]): HistoricalMatchRecord[] {
  const records: HistoricalMatchRecord[] = [];
  for (const fixture of fixtures) {
    const kickoffMs = fixture.utcKickoffTime ? new Date(fixture.utcKickoffTime).getTime() : NaN;
    records.push({
      fixture,
      kickoffMs: isNaN(kickoffMs) ? NaN : kickoffMs,
      competitionCode: (fixture.competition?.code || '').toUpperCase(),
      season: fixture.competition?.season || 'unknown',
      homeTeamId: String(fixture.homeTeam?.id ?? ''),
      homeTeamName: fixture.homeTeam?.name || '',
      awayTeamId: String(fixture.awayTeam?.id ?? ''),
      awayTeamName: fixture.awayTeam?.name || '',
      homeGoals: fixture.score?.home ?? null,
      awayGoals: fixture.score?.away ?? null,
      outcome: outcomeFromScore(fixture.score?.home, fixture.score?.away),
    });
  }
  // Strict chronological order; ties broken by fixture id for determinism.
  records.sort((a, b) => {
    const ta = isNaN(a.kickoffMs) ? Infinity : a.kickoffMs;
    const tb = isNaN(b.kickoffMs) ? Infinity : b.kickoffMs;
    if (ta !== tb) return ta - tb;
    return a.fixture.id.localeCompare(b.fixture.id);
  });
  return records;
}

interface TeamAggregate {
  teamId: string;
  name: string;
  shortName: string;
  tla: string;
  crest?: string;
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
}

/**
 * Builds a standings table for one competition from matches strictly before `beforeMs`.
 * Teams with no prior matches simply do not appear (so they resolve as "not in table").
 */
export function buildRollingTable(
  priorMatches: HistoricalMatchRecord[],
  beforeMs: number,
  competition: Competition
): CompetitionStandings {
  const teams = new Map<string, TeamAggregate>();

  const ensure = (id: string, name: string, fixture: Fixture, side: 'home' | 'away'): TeamAggregate => {
    let agg = teams.get(id);
    if (!agg) {
      const team = side === 'home' ? fixture.homeTeam : fixture.awayTeam;
      agg = {
        teamId: id,
        name: team?.name || name,
        shortName: team?.shortName || name,
        tla: team?.tla || 'TM',
        crest: team?.crest,
        playedGames: 0,
        won: 0,
        draw: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
      };
      teams.set(id, agg);
    }
    return agg;
  };

  for (const rec of priorMatches) {
    if (isNaN(rec.kickoffMs) || rec.kickoffMs >= beforeMs) continue;
    if (rec.homeGoals == null || rec.awayGoals == null) continue;
    if (rec.outcome == null) continue;

    const home = ensure(rec.homeTeamId, rec.homeTeamName, rec.fixture, 'home');
    const away = ensure(rec.awayTeamId, rec.awayTeamName, rec.fixture, 'away');

    home.playedGames++;
    away.playedGames++;
    home.goalsFor += rec.homeGoals;
    home.goalsAgainst += rec.awayGoals;
    away.goalsFor += rec.awayGoals;
    away.goalsAgainst += rec.homeGoals;

    if (rec.outcome === 0) {
      home.won++; away.lost++;
    } else if (rec.outcome === 1) {
      home.draw++; away.draw++;
    } else {
      away.won++; home.lost++;
    }
  }

  const entries: StandingEntry[] = [...teams.values()].map((t) => ({
    position: 0,
    team: { id: t.teamId, name: t.name, shortName: t.shortName, tla: t.tla, crest: t.crest },
    playedGames: t.playedGames,
    won: t.won,
    draw: t.draw,
    lost: t.lost,
    points: t.won * 3 + t.draw,
    goalsFor: t.goalsFor,
    goalsAgainst: t.goalsAgainst,
    goalDifference: t.goalsFor - t.goalsAgainst,
    form: null,
  }));

  // Deterministic ranking: points, then GD, then GF, then team id.
  entries.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    return String(a.team.id).localeCompare(String(b.team.id));
  });
  entries.forEach((e, i) => (e.position = i + 1));

  return {
    competition,
    season: { startDate: '', endDate: '', currentMatchday: undefined },
    table: entries,
  };
}


/**
 * League-frequency baseline: empirical home/draw/away frequencies from the same
 * competition's prior matches, with additive (Laplace) smoothing so a cold competition
 * still yields valid, finite probabilities. Uses ONLY prior matches (no leakage).
 */
export function leagueFrequencyBaseline(
  priorMatches: HistoricalMatchRecord[],
  beforeMs: number,
  smoothing = 1
): ProbabilityTriplet {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (const rec of priorMatches) {
    if (isNaN(rec.kickoffMs) || rec.kickoffMs >= beforeMs) continue;
    if (rec.outcome == null) continue;
    if (rec.outcome === 0) home++;
    else if (rec.outcome === 1) draw++;
    else away++;
  }
  const total = home + draw + away + 3 * smoothing;
  return {
    homeWin: (home + smoothing) / total,
    draw: (draw + smoothing) / total,
    awayWin: (away + smoothing) / total,
  };
}

export interface BacktestOptions {
  /**
   * Minimum prior matches per team before the model is asked. The frozen engine
   * hard-enforces a floor of 3 inside evaluatePoissonProbabilities, so any smaller
   * value here is clamped up to 3 (it only affects exclusion attribution, not the model).
   */
  minHistory?: number;
  /** Optional cap: only evaluate matches at/after this time. */
  fromMs?: number;
  /** Optional cap: only evaluate matches before this time. */
  toMs?: number;
}

export interface BacktestResult {
  records: BacktestRecord[];
  exclusions: Record<ExclusionReason, number>;
  totalConsidered: number;
}

/**
 * Runs the frozen model over a chronological set of historical matches.
 *
 * Faithfulness to production: the engine reads the CURRENT-season standings table, so
 * each feature table is built from strictly-prior matches within the same
 * competition+season bucket. This also guarantees no cross-season or future leakage.
 */
export function runBacktest(fixtures: Fixture[], options: BacktestOptions = {}): BacktestResult {
  const allRecords = toHistoricalRecords(fixtures);

  const byBucket = new Map<string, HistoricalMatchRecord[]>();
  for (const rec of allRecords) {
    const key = `${rec.competitionCode}::${rec.season}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key)!.push(rec);
  }

  const records: BacktestRecord[] = [];
  const exclusions: Record<ExclusionReason, number> = {
    NOT_FINISHED: 0,
    MISSING_SCORE: 0,
    MISSING_KICKOFF: 0,
    TEAM_NOT_IN_TABLE: 0,
    COLD_START: 0,
    MODEL_NULL: 0,
  };
  let totalConsidered = 0;

  // Deterministic bucket order (competition then season).
  const bucketKeys = [...byBucket.keys()].sort();

  for (const bucketKey of bucketKeys) {
    const bucketRecords = byBucket.get(bucketKey)!; // already chronological
    const competition = bucketRecords[0]?.fixture.competition;

    for (const rec of bucketRecords) {
      if (options.fromMs !== undefined && (isNaN(rec.kickoffMs) || rec.kickoffMs < options.fromMs)) continue;
      if (options.toMs !== undefined && (isNaN(rec.kickoffMs) || rec.kickoffMs >= options.toMs)) continue;
      totalConsidered++;

      const base: BacktestRecord = {
        fixtureId: rec.fixture.id,
        competitionCode: rec.competitionCode,
        season: rec.season,
        kickoffMs: rec.kickoffMs,
        outcome: rec.outcome,
        eligible: false,
      };

      if (isNaN(rec.kickoffMs)) {
        exclusions.MISSING_KICKOFF++;
        records.push({ ...base, exclusionReason: 'MISSING_KICKOFF' });
        continue;
      }
      if (rec.fixture.status !== 'FINISHED') {
        exclusions.NOT_FINISHED++;
        records.push({ ...base, exclusionReason: 'NOT_FINISHED' });
        continue;
      }
      if (rec.outcome == null) {
        exclusions.MISSING_SCORE++;
        records.push({ ...base, exclusionReason: 'MISSING_SCORE' });
        continue;
      }

      // Build the feature table from strictly-prior matches in the same season only.
      const table = buildRollingTable(bucketRecords, rec.kickoffMs, competition);

      const homeStanding = findTeamInStandings(rec.homeTeamId, rec.homeTeamName, table);
      const awayStanding = findTeamInStandings(rec.awayTeamId, rec.awayTeamName, table);

      if (!homeStanding || !awayStanding) {
        exclusions.TEAM_NOT_IN_TABLE++;
        records.push({ ...base, exclusionReason: 'TEAM_NOT_IN_TABLE' });
        continue;
      }

      const minHistory = options.minHistory ?? 3;
      if (homeStanding.playedGames < minHistory || awayStanding.playedGames < minHistory) {
        exclusions.COLD_START++;
        records.push({ ...base, exclusionReason: 'COLD_START' });
        continue;
      }

      const { avgGoalsPerGame } = calculateLeagueAverages(table);
      const probs = evaluatePoissonProbabilities(homeStanding, awayStanding, avgGoalsPerGame);

      if (!probs) {
        exclusions.MODEL_NULL++;
        records.push({ ...base, exclusionReason: 'MODEL_NULL' });
        continue;
      }

      const baseline = leagueFrequencyBaseline(bucketRecords, rec.kickoffMs);

      records.push({
        ...base,
        eligible: true,
        model: { homeWin: probs.homeWin, draw: probs.draw, awayWin: probs.awayWin },
        leagueFrequency: baseline,
      });
    }
  }

  return { records, exclusions, totalConsidered };
}

/** Converts eligible backtest records into evaluation samples for a chosen probability source. */
export function toEvaluationSamples(
  records: BacktestRecord[],
  source: 'model' | 'leagueFrequency'
): EvaluationSample[] {
  const samples: EvaluationSample[] = [];
  for (const r of records) {
    if (!r.eligible || r.outcome == null) continue;
    const probs = source === 'model' ? r.model : r.leagueFrequency;
    if (!probs) continue;
    samples.push({
      probabilities: probs,
      outcome: r.outcome,
      competitionCode: r.competitionCode,
      season: r.season,
    });
  }
  return samples;
}
