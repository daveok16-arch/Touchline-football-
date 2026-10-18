import { describe, it, expect } from 'vitest';
import {
  calculatePoissonProbability,
  calculateLeagueAverages,
  evaluatePoissonProbabilities,
  evaluateMatchIntelligence,
  findTeamInStandings,
  normalizeTeamName,
  isGenuinelyUpcomingFixture,
  FROZEN_MODEL_VERSION,
  SUPPORTED_INTELLIGENCE_COMPETITIONS,
} from '../src/services/predictionEngine';
import {
  runBacktest,
  buildRollingTable,
  toHistoricalRecords,
  leagueFrequencyBaseline,
  toEvaluationSamples,
} from '../src/services/predictionBacktest';
import {
  evaluateSamples,
  calibrationForClass,
  multiclassLogLoss,
  multiclassBrier,
  outcomeFromScore,
  probabilitiesSumToOne,
  areProbabilitiesValid,
  probabilitySum,
} from '../src/services/predictionMetrics';
import {
  EMPTY_LEDGER,
  recordPrediction,
  settlePrediction,
  verifyLedger,
  getEntry,
} from '../src/services/predictionLedger';
import { CompetitionStandings, Fixture, StandingEntry } from '../src/types/football';

function entry(name: string, played: number, gf: number, ga: number, id = name): StandingEntry {
  return {
    position: 1,
    team: { id, name, shortName: name, tla: name.slice(0, 3).toUpperCase() },
    playedGames: played,
    won: Math.round(played / 2),
    draw: 0,
    lost: Math.round(played / 2),
    points: Math.round(played / 2) * 3,
    goalsFor: gf,
    goalsAgainst: ga,
    goalDifference: gf - ga,
    form: null,
  };
}

function standings(table: StandingEntry[], code = 'PL'): CompetitionStandings {
  return {
    competition: { id: code, code, name: code, type: 'LEAGUE', country: 'X', season: '2024/25' },
    season: { startDate: '', endDate: '', currentMatchday: 10 },
    table,
  };
}

function finishedFixture(
  id: string,
  kickoff: string,
  home: string,
  away: string,
  hg: number,
  ag: number,
  code = 'PL',
  season = '2024/25'
): Fixture {
  return {
    id,
    utcKickoffTime: kickoff,
    status: 'FINISHED',
    competition: { id: code, code, name: code, type: 'LEAGUE', country: 'X', season },
    homeTeam: { id: home, name: home, shortName: home, tla: home.slice(0, 3).toUpperCase() },
    awayTeam: { id: away, name: away, shortName: away, tla: away.slice(0, 3).toUpperCase() },
    score: { home: hg, away: ag },
  };
}

describe('Phase 3 – probability validity', () => {
  it('calculatePoissonProbability returns 0 for invalid inputs and valid PMF values otherwise', () => {
    expect(calculatePoissonProbability(0, 0)).toBe(0);
    expect(calculatePoissonProbability(-1, 2)).toBe(0);
    expect(calculatePoissonProbability(1.5, -1)).toBe(0);
    expect(calculatePoissonProbability(NaN, 1)).toBe(0);
    // Sum over k of PMF(lambda=1.5) ≈ 1
    let sum = 0;
    for (let k = 0; k <= 30; k++) sum += calculatePoissonProbability(1.5, k);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('produces finite probabilities within [0,1] that sum to 1 within the documented tolerance', () => {
    const table = standings([
      entry('Arsenal', 10, 22, 6, '57'),
      entry('Chelsea', 10, 16, 12, '61'),
    ]);
    const { avgGoalsPerGame } = calculateLeagueAverages(table);
    const probs = evaluatePoissonProbabilities(table.table[0], table.table[1], avgGoalsPerGame);
    expect(probs).not.toBeNull();
    expect(areProbabilitiesValid(probs!)).toBe(true);
    expect(probabilitiesSumToOne(probs!)).toBe(true);
    expect(probs!.expectedGoalsHome).toBeGreaterThan(0);
    expect(probs!.expectedGoalsAway).toBeGreaterThan(0);
  });

  it('documents the frozen engine rounding drift (<= 0.001) and rejects it as un-normalised', () => {
    // The engine rounds each leg to 3dp, so the sum may be off by one rounding unit.
    const rounded = { homeWin: 0.334, draw: 0.333, awayWin: 0.334 }; // sums to 1.001
    expect(probabilitySum(rounded)).toBeCloseTo(1.001, 10);
    expect(probabilitiesSumToOne(rounded)).toBe(true); // within 2e-3 documented tolerance
    const unnormalised = { homeWin: 0.5, draw: 0.4, awayWin: 0.4 }; // sums to 1.3
    expect(probabilitiesSumToOne(unnormalised)).toBe(false);
  });

  it('is deterministic for identical inputs', () => {
    const table = standings([entry('A', 12, 20, 10, '1'), entry('B', 12, 14, 16, '2')]);
    const { avgGoalsPerGame } = calculateLeagueAverages(table);
    const a = evaluatePoissonProbabilities(table.table[0], table.table[1], avgGoalsPerGame);
    const b = evaluatePoissonProbabilities(table.table[0], table.table[1], avgGoalsPerGame);
    expect(a).toEqual(b);
  });

  it('clamps the league average into the documented [1.5, 4.0] band', () => {
    const tiny = calculateLeagueAverages(standings([entry('A', 10, 1, 0, '1')]));
    expect(tiny.avgGoalsPerGame).toBeGreaterThanOrEqual(1.5);
    const huge = calculateLeagueAverages(standings([entry('A', 10, 500, 0, '1')]));
    expect(huge.avgGoalsPerGame).toBeLessThanOrEqual(4.0);
    const empty = calculateLeagueAverages(standings([]));
    expect(empty.avgGoalsPerGame).toBe(2.7);
    expect(empty.totalGames).toBe(0);
  });

  it('evaluation metrics are correct on hand-computed examples', () => {
    // Perfect confidence on the realised outcome -> zero log loss and zero Brier.
    expect(multiclassLogLoss({ homeWin: 1, draw: 0, awayWin: 0 }, 0)).toBeCloseTo(0, 10);
    expect(multiclassBrier({ homeWin: 1, draw: 0, awayWin: 0 }, 0)).toBeCloseTo(0, 10);
    // Uniform 1/3 each, home wins: log loss = ln(3); Brier = (2/3)^2 + 2*(1/3)^2 = 6/9
    expect(multiclassLogLoss({ homeWin: 1 / 3, draw: 1 / 3, awayWin: 1 / 3 }, 0)).toBeCloseTo(Math.log(3), 10);
    expect(multiclassBrier({ homeWin: 1 / 3, draw: 1 / 3, awayWin: 1 / 3 }, 0)).toBeCloseTo(6 / 9, 10);
  });

  it('outcomeFromScore maps results and rejects incomplete scores', () => {
    expect(outcomeFromScore(2, 1)).toBe(0);
    expect(outcomeFromScore(1, 1)).toBe(1);
    expect(outcomeFromScore(0, 3)).toBe(2);
    expect(outcomeFromScore(null, 1)).toBeNull();
    expect(outcomeFromScore(1, undefined)).toBeNull();
  });

  it('calibration ECE is zero when predicted equals observed', () => {
    // 100 predictions of 0.3, exactly 30 positives -> perfect calibration.
    const probs = new Array(100).fill(0.3);
    const outcomes = [...new Array(30).fill(0), ...new Array(70).fill(2)] as (0 | 2)[];
    const cal = calibrationForClass(probs, outcomes as any, 0, 10);
    expect(cal.expectedCalibrationError).toBeCloseTo(0, 10);
  });
});

describe('Phase 3 – cold-start, missing data, neutral venues', () => {
  it('flags teams with fewer than 3 matches as cold start and excludes them', () => {
    const table = standings([
      entry('Newly Promoted', 2, 1, 4, '100'),
      entry('Established', 10, 18, 8, '200'),
    ]);
    const { avgGoalsPerGame } = calculateLeagueAverages(table);
    expect(evaluatePoissonProbabilities(table.table[0], table.table[1], avgGoalsPerGame)).toBeNull();
  });

  it('evaluateMatchIntelligence reports cold start for <3 games and never leaks probabilities', () => {
    const fixture: Fixture = {
      ...finishedFixture('fd-1', '2099-01-01T15:00:00Z', 'Newly Promoted', 'Established', 0, 0),
      status: 'SCHEDULED',
    };
    const intel = evaluateMatchIntelligence(
      fixture,
      { PL: standings([entry('Newly Promoted', 1, 0, 3, '100'), entry('Established', 10, 18, 8, '200')]) },
      new Date('2026-01-01T00:00:00Z').getTime()
    );
    expect(intel.isEligible).toBe(false);
    expect(intel.isColdStart).toBe(true);
    expect(intel.probabilities).toBeUndefined();
    expect(intel.evidenceLevel).toBe('COLD_START');
  });

  it('excludes fixtures whose team is absent from the table (promoted/unranked)', () => {
    const fixture: Fixture = {
      ...finishedFixture('fd-2', '2099-01-01T15:00:00Z', 'Unknown FC', 'Established', 0, 0),
      status: 'SCHEDULED',
    };
    const intel = evaluateMatchIntelligence(
      fixture,
      { PL: standings([entry('Established', 10, 18, 8, '200')]) },
      new Date('2026-01-01T00:00:00Z').getTime()
    );
    expect(intel.isEligible).toBe(false);
    expect(intel.isColdStart).toBe(true);
  });

  it('treats a neutral-venue fixture as an ordinary home/away row (documented limitation)', () => {
    // The engine has no neutral-venue flag; venue is informational only. A neutral
    // fixture is therefore modelled with the standard home advantage. This test pins
    // that documented behaviour so a future change is deliberate.
    const table = standings([entry('A', 12, 20, 10, '1'), entry('B', 12, 20, 10, '2')]);
    const { avgGoalsPerGame } = calculateLeagueAverages(table);
    const probs = evaluatePoissonProbabilities(table.table[0], table.table[1], avgGoalsPerGame)!;
    expect(probs.homeWin).toBeGreaterThan(probs.awayWin);
  });

  it('rejects unsupported competitions and non-upcoming statuses', () => {
    const fixture: Fixture = {
      ...finishedFixture('fd-3', '2099-01-01T15:00:00Z', 'A', 'B', 0, 0, 'SP-53'),
      status: 'SCHEDULED',
    };
    const intel = evaluateMatchIntelligence(fixture, {}, Date.now());
    expect(intel.isEligible).toBe(false);
    expect(intel.ineligibilityReason).toContain('not supported');
  });

  it('does not treat a past-kickoff SCHEDULED fixture as upcoming', () => {
    const fixture: Fixture = {
      ...finishedFixture('fd-4', '2020-01-01T15:00:00Z', 'A', 'B', 0, 0),
      status: 'SCHEDULED',
    };
    expect(isGenuinelyUpcomingFixture(fixture, new Date('2026-01-01T00:00:00Z').getTime())).toBe(false);
  });
});

describe('Phase 3 – temporal leakage prevention', () => {
  // Round-robin so the target match (m7) has 3 prior games for both teams.
  const seasonFixtures: Fixture[] = [
    finishedFixture('m1', '2024-08-03T15:00:00Z', 'A', 'B', 2, 0),
    finishedFixture('m2', '2024-08-03T17:00:00Z', 'C', 'D', 1, 1),
    finishedFixture('m3', '2024-08-10T15:00:00Z', 'A', 'C', 3, 1),
    finishedFixture('m4', '2024-08-10T17:00:00Z', 'B', 'D', 1, 1),
    finishedFixture('m5', '2024-08-17T15:00:00Z', 'A', 'D', 1, 0),
    finishedFixture('m6', '2024-08-17T17:00:00Z', 'B', 'C', 2, 2),
    finishedFixture('m7', '2024-08-24T15:00:00Z', 'A', 'B', 5, 0),
    finishedFixture('m8', '2024-08-31T15:00:00Z', 'C', 'D', 3, 3),
  ];

  it('a match prediction is unchanged when later results are altered', () => {
    const first = runBacktest(seasonFixtures);
    const recordForM7 = first.records.find((r) => r.fixtureId === 'm7')!;
    expect(recordForM7.eligible).toBe(true);

    // Mutate the result of a match that kicks off AFTER m7.
    const mutated = seasonFixtures.map((f) => (f.id === 'm8' ? { ...f, score: { home: 9, away: 9 } } : f));
    const second = runBacktest(mutated);
    const recordForM7After = second.records.find((r) => r.fixtureId === 'm7')!;

    expect(recordForM7After.model).toEqual(recordForM7.model);
  });

  it('a team’s own result does not enter its own feature row', () => {
    const records = toHistoricalRecords(seasonFixtures);
    const m7 = records.find((r) => r.fixture.id === 'm7')!;
    const table = buildRollingTable(records, m7.kickoffMs, m7.fixture.competition);
    const a = findTeamInStandings('A', 'A', table)!;
    const b = findTeamInStandings('B', 'B', table)!;
    // A prior: m1 (2-0), m3 (3-1), m5 (1-0) -> 3 games, 6 GF, 1 GA. m7's own 5-0 excluded.
    expect(a.playedGames).toBe(3);
    expect(a.goalsFor).toBe(6);
    expect(a.goalsAgainst).toBe(1);
    // B prior: m1 (0-2), m4 (1-1), m6 (2-2) -> 3 games, 3 GF, 5 GA.
    expect(b.playedGames).toBe(3);
    expect(b.goalsFor).toBe(3);
    expect(b.goalsAgainst).toBe(5);
  });

  it('the frequency baseline uses only prior matches', () => {
    const fixtures = [
      finishedFixture('b1', '2024-08-03T15:00:00Z', 'A', 'B', 2, 0), // home
      finishedFixture('b2', '2024-08-10T15:00:00Z', 'C', 'D', 1, 1), // draw
      finishedFixture('b3', '2024-08-17T15:00:00Z', 'A', 'C', 3, 1), // home
      finishedFixture('b4', '2024-08-24T15:00:00Z', 'B', 'D', 0, 2), // away
      finishedFixture('b5', '2024-08-31T15:00:00Z', 'A', 'B', 0, 0), // target
    ];
    const records = toHistoricalRecords(fixtures);
    const b5 = records.find((r) => r.fixture.id === 'b5')!;
    const before = leagueFrequencyBaseline(records, b5.kickoffMs, 0);
    expect(before.homeWin).toBeCloseTo(0.5, 10);
    expect(before.draw).toBeCloseTo(0.25, 10);
    expect(before.awayWin).toBeCloseTo(0.25, 10);
  });

  it('does not build a table across different seasons', () => {
    const mixed = [
      finishedFixture('s1', '2023-08-10T15:00:00Z', 'A', 'B', 2, 0, 'PL', '2023/24'),
      finishedFixture('s2', '2024-08-10T15:00:00Z', 'A', 'B', 2, 0, 'PL', '2024/25'),
      finishedFixture('s3', '2024-08-17T15:00:00Z', 'A', 'B', 1, 1, 'PL', '2024/25'),
    ];
    const recs = toHistoricalRecords(mixed);
    const s3rec = recs.find((r) => r.fixture.id === 's3')!;
    const bucket = recs.filter((r) => r.season === '2024/25');
    const table = buildRollingTable(bucket, s3rec.kickoffMs, s3rec.fixture.competition);
    const a = findTeamInStandings('A', 'A', table)!;
    // Only s2 is a prior match within 2024/25; the 2023/24 result must not contribute.
    expect(a.playedGames).toBe(1);
    expect(a.goalsFor).toBe(2);
  });

  it('exposes the frozen model version and a fixed competition allowlist', () => {
    expect(FROZEN_MODEL_VERSION).toBe('POISSON_V1_FROZEN');
    expect(SUPPORTED_INTELLIGENCE_COMPETITIONS).toEqual(['PL', 'CL', 'PD', 'SA']);
  });
});

describe('Phase 3 – prediction ledger integrity', () => {
  const baseInput = {
    fixtureId: 'fd-100',
    competitionCode: 'PL',
    season: '2024/25',
    modelVersion: FROZEN_MODEL_VERSION,
    recordedAt: '2026-10-14T10:00:00Z',
    kickoffTime: '2026-10-14T18:00:00Z',
    probabilities: { homeWin: 0.5, draw: 0.3, awayWin: 0.2 },
  };

  it('records a pre-match prediction with full provenance', () => {
    const r = recordPrediction(EMPTY_LEDGER, baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.entry;
    expect(e.recordedAt).toBe(baseInput.recordedAt);
    expect(e.kickoffTime).toBe(baseInput.kickoffTime);
    expect(e.modelVersion).toBe(FROZEN_MODEL_VERSION);
    expect(e.probabilities).toEqual(baseInput.probabilities);
    expect(e.settlement).toBeUndefined();
    expect(verifyLedger(r.snapshot).ok).toBe(true);
  });

  it('rejects duplicate predictions for the same fixture+model', () => {
    const r1 = recordPrediction(EMPTY_LEDGER, baseInput);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = recordPrediction(r1.snapshot, baseInput);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('DUPLICATE');
  });

  it('rejects post-kickoff predictions', () => {
    const r = recordPrediction(EMPTY_LEDGER, { ...baseInput, recordedAt: '2026-10-14T18:00:00Z' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('POST_KICKOFF');
    const r2 = recordPrediction(EMPTY_LEDGER, { ...baseInput, recordedAt: '2026-10-14T19:00:00Z' });
    expect(r2.ok).toBe(false);
  });

  it('rejects invalid probabilities and invalid timestamps', () => {
    expect(recordPrediction(EMPTY_LEDGER, { ...baseInput, probabilities: { homeWin: 1.5, draw: 0, awayWin: -0.5 } }).ok).toBe(false);
    expect(recordPrediction(EMPTY_LEDGER, { ...baseInput, recordedAt: 'not-a-date' }).ok).toBe(false);
  });

  it('attaches a settlement without mutating the original prediction', () => {
    const r1 = recordPrediction(EMPTY_LEDGER, baseInput);
    if (!r1.ok) throw new Error('setup failed');
    const original = r1.snapshot.entries[0];

    const s = settlePrediction(r1.snapshot, 'fd-100', FROZEN_MODEL_VERSION, 3, 1, '2026-10-14T20:00:00Z');
    expect(s.ok).toBe(true);
    if (!s.ok) return;

    // Original prediction object is untouched (same reference, same fields).
    expect(original.settlement).toBeUndefined();
    const after = getEntry(s.snapshot, 'fd-100', FROZEN_MODEL_VERSION)!;
    expect(after.recordedAt).toBe(baseInput.recordedAt);
    expect(after.kickoffTime).toBe(baseInput.kickoffTime);
    expect(after.probabilities).toEqual(baseInput.probabilities);
    expect(after.modelVersion).toBe(FROZEN_MODEL_VERSION);
    // Home win realised; log loss = -ln(0.5), Brier = (0.5-1)^2+(0.3)^2+(0.2)^2
    expect(after.settlement!.outcome).toBe(0);
    expect(after.settlement!.logLoss).toBeCloseTo(-Math.log(0.5), 10);
    expect(after.settlement!.brier).toBeCloseTo(0.25 + 0.09 + 0.04, 10);
    expect(verifyLedger(s.snapshot).ok).toBe(true);
  });

  it('rejects double settlement and settlement without a final score', () => {
    const r1 = recordPrediction(EMPTY_LEDGER, baseInput);
    if (!r1.ok) throw new Error('setup failed');
    const s1 = settlePrediction(r1.snapshot, 'fd-100', FROZEN_MODEL_VERSION, 3, 1, '2026-10-14T20:00:00Z');
    if (!s1.ok) throw new Error('settle failed');
    const s2 = settlePrediction(s1.snapshot, 'fd-100', FROZEN_MODEL_VERSION, 0, 0, '2026-10-14T21:00:00Z');
    expect(s2.ok).toBe(false);
    if (s2.ok) return;
    expect(s2.reason).toBe('ALREADY_SETTLED');

    const r2 = recordPrediction(s1.snapshot, { ...baseInput, fixtureId: 'fd-101' });
    if (!r2.ok) throw new Error('record2 failed');
    const missing = settlePrediction(r2.snapshot, 'fd-101', FROZEN_MODEL_VERSION, null, null, '2026-10-14T20:00:00Z');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe('MISSING_SCORE');
  });

  it('never mutates the input snapshot (immutability)', () => {
    const r1 = recordPrediction(EMPTY_LEDGER, baseInput);
    if (!r1.ok) throw new Error('setup failed');
    const before = r1.snapshot.version;
    const beforeLen = r1.snapshot.entries.length;
    settlePrediction(r1.snapshot, 'fd-100', FROZEN_MODEL_VERSION, 1, 0, '2026-10-14T20:00:00Z');
    expect(r1.snapshot.version).toBe(before);
    expect(r1.snapshot.entries.length).toBe(beforeLen);
    expect(r1.snapshot.entries[0].settlement).toBeUndefined();
    expect(Object.isFrozen(r1.snapshot)).toBe(true);
  });

  it('verifyLedger detects a hand-crafted post-kickoff record', () => {
    const bad = {
      version: 1,
      entries: [
        {
          id: 'POISSON_V1_FROZEN:fd-x',
          fixtureId: 'fd-x',
          competitionCode: 'PL',
          season: '2024/25',
          modelVersion: FROZEN_MODEL_VERSION,
          recordedAt: '2026-10-14T19:00:00Z',
          kickoffTime: '2026-10-14T18:00:00Z',
          probabilities: { homeWin: 0.5, draw: 0.3, awayWin: 0.2 },
        },
      ],
    };
    const v = verifyLedger(bad as any);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('not made before kickoff');
  });
});

describe('Phase 3 – evaluation aggregation', () => {
  it('evaluateSamples reports count and means over samples', () => {
    const samples = [
      { probabilities: { homeWin: 0.5, draw: 0.3, awayWin: 0.2 }, outcome: 0 as const, competitionCode: 'PL', season: '2024/25' },
      { probabilities: { homeWin: 0.2, draw: 0.3, awayWin: 0.5 }, outcome: 2 as const, competitionCode: 'PL', season: '2024/25' },
    ];
    const s = evaluateSamples(samples);
    expect(s.count).toBe(2);
    expect(s.accuracy).toBe(1);
    expect(s.logLoss).toBeCloseTo((-Math.log(0.5) - Math.log(0.5)) / 2, 10);
    expect(probabilitySum(samples[0].probabilities)).toBeCloseTo(1, 10);
  });

  it('an empty evaluation reports zero count (never a valid score)', () => {
    const s = evaluateSamples([]);
    expect(s.count).toBe(0);
  });

  it('toEvaluationSamples returns only eligible settled records', () => {
    const records = runBacktest([
      finishedFixture('m1', '2024-08-03T15:00:00Z', 'A', 'B', 2, 0),
      finishedFixture('m2', '2024-08-10T15:00:00Z', 'A', 'B', 1, 1),
      finishedFixture('m3', '2024-08-17T15:00:00Z', 'A', 'B', 3, 1),
      finishedFixture('m4', '2024-08-24T15:00:00Z', 'A', 'B', 0, 2),
    ]);
    const samples = toEvaluationSamples(records.records, 'model');
    expect(samples.length).toBe(1); // only m4 has both teams >= 3 prior games
    expect(samples[0].outcome).toBe(2);
  });
});

describe('findTeamInStandings name normalisation', () => {
  const table = (names: string[]): StandingEntry[] =>
    names.map((n, i) => entry(n, 10, 10, 10, `id-${i}`));

  it('keeps club initials instead of stripping them mid-word', () => {
    // Regression: /fc|cf|afc|sc/g used to turn "SSC Napoli" into "s napoli".
    const t = standings(table(['SSC Napoli', 'Sevilla FC', 'SC Freiburg', 'Al Ahly SC']));
    expect(normalizeTeamName('SSC Napoli')).toBe('ssc napoli');
    expect(normalizeTeamName('Sevilla FC')).toBe('sevilla');
    // Only trailing club-type words are dropped; a leading "SC" is part of the name.
    expect(normalizeTeamName('SC Freiburg')).toBe('sc freiburg');
    expect(normalizeTeamName('Al Ahly SC')).toBe('al ahly');
    // None of these mangled forms should be produced.
    expect(normalizeTeamName('SSC Napoli')).not.toBe('s napoli');
  });

  it('matches when one side carries a leading club-type word', () => {
    const t = standings(table(['SC Freiburg']));
    expect(findTeamInStandings('x', 'Freiburg', t)?.team.name).toBe('SC Freiburg');
  });

  it('matches a club whose provider id changed, using the name fallback', () => {
    const t = standings(table(['SSC Napoli', 'Genoa CFC']));
    const found = findTeamInStandings('CHANGED-ID', 'SSC Napoli', t);
    expect(found?.team.name).toBe('SSC Napoli');
  });

  it('folds diacritics so accented names still match', () => {
    const t = standings(table(['CF Montreal']));
    expect(findTeamInStandings('x', 'CF Montréal', t)?.team.name).toBe('CF Montreal');
  });

  it('does not match a shorter name against an unrelated longer word', () => {
    // "inter" must not match "internazionale" as a raw substring.
    const t = standings(table(['FC Internazionale Milano']));
    expect(findTeamInStandings('x', 'Inter', t)).toBeNull();
  });

  it('still prefers an exact id match over the name fallback', () => {
    const t = standings(table(['Alpha FC', 'Beta FC']));
    const found = findTeamInStandings('id-1', 'Alpha FC', t);
    expect(found?.team.name).toBe('Beta FC'); // id wins even when the name disagrees
  });
});


describe('evaluatePoissonProbabilities xG bounds (frozen parity)', () => {
  // A high-scoring attack vs a leaky defence so the raw xG would exceed the 4.5 ceiling.
  const attacker = entry('Attack FC', 20, 80, 40);
  const leaky = entry('Leaky FC', 20, 20, 60);

  it('applies the frozen [0.3, 4.5] clamp when no override is given', () => {
    const p = evaluatePoissonProbabilities(attacker, leaky, 2.7)!;
    expect(p.expectedGoalsHome).toBeLessThanOrEqual(4.5);
    expect(p.expectedGoalsAway).toBeGreaterThanOrEqual(0.3);
  });

  it('reproduces the frozen numerics exactly when the override equals the frozen bounds', () => {
    const a = evaluatePoissonProbabilities(attacker, leaky, 2.7);
    const b = evaluatePoissonProbabilities(attacker, leaky, 2.7, { expectedGoalsBounds: [0.3, 4.5] });
    expect(b).toEqual(a);
  });

  it('honours a research override without touching the default behaviour', () => {
    const clamped = evaluatePoissonProbabilities(attacker, leaky, 2.7)!;
    const wide = evaluatePoissonProbabilities(attacker, leaky, 2.7, { expectedGoalsBounds: [0, 12] })!;
    expect(wide.expectedGoalsHome).toBeGreaterThanOrEqual(clamped.expectedGoalsHome);
  });
});

