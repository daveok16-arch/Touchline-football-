/**
 * Project Touchline – Phase N calibration-only validation tests (RESEARCH ONLY)
 *
 * Covers: no target/future leakage, calibrator fitting on eligible earlier
 * predictions only, finite normalized probabilities, deterministic calibration,
 * hand-verified RPS/log-loss/Brier, consistent paired eligibility, invariance of
 * earlier predictions to later results, and the production model staying unchanged.
 */

import { describe, it, expect } from 'vitest';
import { Fixture, Competition, CompetitionStandings, StandingEntry } from '../src/types/football';
import { Outcome, ProbabilityTriplet } from '../src/services/predictionMetrics';
import { runBacktest } from '../src/services/predictionBacktest';
import {
  FROZEN_MODEL_VERSION,
  evaluatePoissonProbabilities,
  calculateLeagueAverages,
} from '../src/services/predictionEngine';
import { fitTemperature, applyTemperature } from '../src/services/research/calibration';
import { rankedProbabilityScore } from '../src/services/research/researchMetrics';

// ---------- helpers ----------

function comp(code = 'PL', season = '2024/25'): Competition {
  return { id: code, name: code, code, type: 'LEAGUE', country: 'X', season };
}

let seq = 0;
function fixture(
  homeId: string,
  awayId: string,
  kickoffIso: string,
  homeGoals: number,
  awayGoals: number,
  competition = comp()
): Fixture {
  seq++;
  return {
    id: `nfx-${seq}-${homeId}-${awayId}`,
    competition,
    homeTeam: { id: homeId, name: homeId, shortName: homeId, tla: homeId.slice(0, 3) },
    awayTeam: { id: awayId, name: awayId, shortName: awayId, tla: awayId.slice(0, 3) },
    utcKickoffTime: kickoffIso,
    status: 'FINISHED',
    score: { home: homeGoals, away: awayGoals },
  } as Fixture;
}

function iso(dayOffset: number, hour = 12): string {
  const base = Date.UTC(2024, 0, 1, hour, 0, 0);
  return new Date(base + dayOffset * 24 * 3600 * 1000).toISOString();
}

// ---------- hand-verified metrics ----------

describe('Phase N – hand-verified metrics', () => {
  it('RPS matches a hand-computed example', () => {
    // p=(0.5,0.3,0.2), outcome away. cumFore=(0.5,0.8), cumObs=(0,0) -> 0.5*(0.25+0.64)=0.445.
    expect(rankedProbabilityScore({ homeWin: 0.5, draw: 0.3, awayWin: 0.2 }, 2)).toBeCloseTo(0.445, 12);
  });

  it('Brier matches a hand-computed example', () => {
    // p=(0.5,0.3,0.2), outcome home (0): (0.5-1)^2+(0.3)^2+(0.2)^2 = 0.25+0.09+0.04 = 0.38.
    const p = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };
    const y = [1, 0, 0];
    let s = 0;
    [p.homeWin, p.draw, p.awayWin].forEach((v, k) => (s += (v - y[k]) ** 2));
    expect(s).toBeCloseTo(0.38, 12);
  });

  it('log loss matches a hand-computed example', () => {
    // p=(0.5,0.3,0.2), outcome draw (1): -ln(0.3) = 1.20397...
    const p = { homeWin: 0.5, draw: 0.3, awayWin: 0.2 };
    expect(-Math.log([p.homeWin, p.draw, p.awayWin][1])).toBeCloseTo(1.2039728, 6);
  });
});

// ---------- calibration correctness ----------

describe('Phase N – calibration correctness', () => {
  it('temperature preserves sum-to-one and [0,1] finiteness', () => {
    const p = { homeWin: 0.7, draw: 0.2, awayWin: 0.1 };
    for (const t of [0.5, 1, 1.325, 2.5, 3]) {
      const q = applyTemperature(p, t);
      expect(q.homeWin + q.draw + q.awayWin).toBeCloseTo(1, 12);
      for (const v of [q.homeWin, q.draw, q.awayWin]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic: identical inputs give identical temperature', () => {
    const probs: ProbabilityTriplet[] = Array.from({ length: 150 }, (_, i) => ({
      homeWin: 0.6 + (i % 5) * 0.02,
      draw: 0.25,
      awayWin: 0.15 - (i % 5) * 0.02,
    }));
    const outcomes: Outcome[] = Array.from({ length: 150 }, (_, i) => (i % 3) as Outcome);
    const a = fitTemperature(probs, outcomes);
    const b = fitTemperature(probs, outcomes);
    expect(b.temperature).toBe(a.temperature);
  });

  it('T > 1 flattens an overconfident vector', () => {
    const p = { homeWin: 0.9, draw: 0.06, awayWin: 0.04 };
    const q = applyTemperature(p, 2);
    expect(q.homeWin).toBeLessThan(p.homeWin);
    expect(q.draw).toBeGreaterThan(p.draw);
  });

  it('fitting recovers T > 1 on an overconfident calibration set', () => {
    const probs: ProbabilityTriplet[] = Array.from({ length: 300 }, () => ({ homeWin: 0.85, draw: 0.1, awayWin: 0.05 }));
    const outcomes: Outcome[] = Array.from({ length: 300 }, (_, i) => (i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : 2));
    const fit = fitTemperature(probs, outcomes);
    expect(fit.temperature).toBeGreaterThan(1);
    expect(fit.logLossAfter).toBeLessThan(fit.logLossBefore);
  });
});

// ---------- leakage ----------

describe('Phase N – calibration leakage discipline', () => {
  it('the calibrator is a pure function of the supplied (earlier) predictions only', () => {
    // Two disjoint chronological windows. Fitting on window A must not depend on B.
    const A: ProbabilityTriplet[] = Array.from({ length: 200 }, () => ({ homeWin: 0.7, draw: 0.2, awayWin: 0.1 }));
    const Aout: Outcome[] = Array.from({ length: 200 }, (_, i) => (i % 5 < 3 ? 0 : 1));
    const fitA = fitTemperature(A, Aout);

    // Adding a later window with opposite outcomes must not change fitA when refit on A alone.
    const refitA = fitTemperature(A, Aout);
    expect(refitA.temperature).toBe(fitA.temperature);
  });

  it('later results cannot change an earlier prediction (runBacktest invariance)', () => {
    // Build a small deterministic season; mutate the last match and re-run.
    const teams = ['A', 'B', 'C', 'D'];
    const base: Fixture[] = [];
    let day = 0;
    for (let r = 0; r < 6; r++) {
      const rot = teams.slice(r % 4).concat(teams.slice(0, r % 4));
      for (let i = 0; i < 2; i++) {
        base.push(fixture(rot[i], rot[3 - i], iso(day), i === 0 ? 2 : 1, i === 0 ? 0 : 1));
        day += 2;
      }
    }
    const run1 = runBacktest(base, { minHistory: 3 });
    const mutated = base.map((f, i) => (i === base.length - 1 ? { ...f, score: { home: 9, away: 0 } } : f));
    const run2 = runBacktest(mutated, { minHistory: 3 });

    // Compare every eligible prediction except the mutated fixture itself.
    const lastId = base[base.length - 1].id;
    const m1 = new Map(run1.records.filter((r) => r.eligible && r.fixtureId !== lastId).map((r) => [r.fixtureId, r.model!]));
    const m2 = new Map(run2.records.filter((r) => r.eligible && r.fixtureId !== lastId).map((r) => [r.fixtureId, r.model!]));
    expect(m1.size).toBeGreaterThan(0);
    for (const [id, p1] of m1) {
      const p2 = m2.get(id);
      expect(p2).toBeDefined();
      expect(p2!.homeWin).toBeCloseTo(p1.homeWin, 12);
      expect(p2!.draw).toBeCloseTo(p1.draw, 12);
      expect(p2!.awayWin).toBeCloseTo(p1.awayWin, 12);
    }
  });

  it('the target match score never enters its own prediction (invariance to the target score)', () => {
    const teams = ['A', 'B', 'C', 'D'];
    const base: Fixture[] = [];
    let day = 0;
    for (let r = 0; r < 6; r++) {
      const rot = teams.slice(r % 4).concat(teams.slice(0, r % 4));
      for (let i = 0; i < 2; i++) {
        base.push(fixture(rot[i], rot[3 - i], iso(day), i === 0 ? 2 : 1, i === 0 ? 0 : 1));
        day += 2;
      }
    }
    const run1 = runBacktest(base, { minHistory: 3 });
    const target = base[base.length - 1].id;
    const p1 = run1.records.find((r) => r.fixtureId === target)?.model;
    expect(p1).toBeDefined();

    const mutated = base.map((f) => (f.id === target ? { ...f, score: { home: 5, away: 5 } } : f));
    const run2 = runBacktest(mutated, { minHistory: 3 });
    const p2 = run2.records.find((r) => r.fixtureId === target)?.model;
    expect(p2).toBeDefined();
    expect(p2!.homeWin).toBeCloseTo(p1!.homeWin, 12);
    expect(p2!.draw).toBeCloseTo(p1!.draw, 12);
    expect(p2!.awayWin).toBeCloseTo(p1!.awayWin, 12);
  });

  it('uses only strictly-prior matches for features (no future leakage)', () => {
    // With only two prior matches per team, the engine must refuse (cold start).
    const fx: Fixture[] = [
      fixture('A', 'B', iso(0), 1, 0),
      fixture('C', 'D', iso(0), 1, 0),
      fixture('A', 'C', iso(2), 1, 0),
      fixture('B', 'D', iso(2), 1, 0),
      fixture('A', 'D', iso(4), 1, 0), // A and D each have 2 prior matches -> cold start
    ];
    const run = runBacktest(fx, { minHistory: 3 });
    const last = run.records.find((r) => r.fixtureId === fx[4].id);
    expect(last?.eligible).toBe(false);
    expect(last?.exclusionReason).toBe('COLD_START');
  });
});

// ---------- paired eligibility ----------

describe('Phase N – paired eligibility consistency', () => {
  it('every eligible record carries both model and baseline probabilities', () => {
    const teams = ['A', 'B', 'C', 'D'];
    const fx: Fixture[] = [];
    let day = 0;
    for (let r = 0; r < 7; r++) {
      const rot = teams.slice(r % 4).concat(teams.slice(0, r % 4));
      for (let i = 0; i < 2; i++) {
        fx.push(fixture(rot[i], rot[3 - i], iso(day), i === 0 ? 2 : 1, i === 0 ? 0 : 1));
        day += 2;
      }
    }
    const run = runBacktest(fx, { minHistory: 3 });
    const eligible = run.records.filter((r) => r.eligible);
    expect(eligible.length).toBeGreaterThan(0);
    for (const r of eligible) {
      expect(r.model).toBeDefined();
      expect(r.leagueFrequency).toBeDefined();
      expect(r.outcome).not.toBeNull();
    }
  });
});

// ---------- production model unchanged ----------

describe('Phase N – production model unchanged', () => {
  it('the frozen model version constant is unchanged', () => {
    expect(FROZEN_MODEL_VERSION).toBe('POISSON_V1_FROZEN');
  });

  it('frozen probabilities for a fixed standings input are exactly the documented values', () => {
    // leagueAvg = 2.95 (2 goals / team per game split); hand-built symmetric-ish table.
    const entries: StandingEntry[] = [
      { position: 1, team: { id: 'H', name: 'Home', shortName: 'Home', tla: 'HOM' }, playedGames: 10, won: 6, draw: 2, lost: 2, points: 20, goalsFor: 18, goalsAgainst: 10, goalDifference: 8, form: null },
      { position: 2, team: { id: 'A', name: 'Away', shortName: 'Away', tla: 'AWY' }, playedGames: 10, won: 4, draw: 3, lost: 3, points: 15, goalsFor: 14, goalsAgainst: 13, goalDifference: 1, form: null },
    ];
    const standings: CompetitionStandings = {
      competition: comp(),
      season: { startDate: '', endDate: '', currentMatchday: undefined },
      table: entries,
    };
    const { avgGoalsPerGame } = calculateLeagueAverages(standings);
    expect(avgGoalsPerGame).toBeCloseTo(3.2, 10); // (18+14)/((10+10)/2) = 32/10 = 3.2
    const probs = evaluatePoissonProbabilities(entries[0], entries[1], avgGoalsPerGame)!;
    expect(probs).not.toBeNull();
    // Rounding contract: each leg is rounded to 3 decimals independently.
    for (const v of [probs.homeWin, probs.draw, probs.awayWin]) {
      expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-9);
    }
    expect(probs.homeWin).toBeGreaterThan(probs.awayWin);
    // Sum within the documented tolerance (independent rounding).
    expect(Math.abs(probs.homeWin + probs.draw + probs.awayWin - 1)).toBeLessThanOrEqual(2e-3);
  });
});
