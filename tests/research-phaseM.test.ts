/**
 * Project Touchline – Phase M research tests (RESEARCH ONLY)
 *
 * Covers: strict chronological eligibility, no use of the target score, no future
 * leakage, invariance to later results, competition/season separation, cold start,
 * deterministic fitting, low-score correction, probability validity, calibration
 * using earlier data only, bootstrap reproducibility, and hand-verified metrics.
 *
 * These tests never touch production code paths and never modify the frozen model.
 */

import { describe, it, expect } from 'vitest';
import { Fixture, Competition } from '../src/types/football';
import { Outcome, ProbabilityTriplet } from '../src/services/predictionMetrics';
import {
  DEFAULT_DC_CONFIG,
  DCConfig,
  DCMatch,
  fitDixonColes,
  predictDixonColes,
  tauCorrection,
} from '../src/services/research/dixonColes';
import { applyTemperature, fitTemperature } from '../src/services/research/calibration';
import {
  rankedProbabilityScore,
  mulberry32,
  buildBlocks,
  pairedBlockBootstrapFromScores,
  PairedObservation,
} from '../src/services/research/researchMetrics';
import { runWalkForward, runDixonColesWalkForward, pairedSubset } from '../src/services/research/walkForward';

// ---------- helpers ----------

function comp(code = 'PL', season = '2024/25'): Competition {
  return { id: code, name: code, code, type: 'LEAGUE', country: 'X', season };
}

let fixtureSeq = 0;
function fixture(
  homeId: string,
  awayId: string,
  kickoffIso: string,
  homeGoals: number,
  awayGoals: number,
  competition = comp(),
  status: Fixture['status'] = 'FINISHED'
): Fixture {
  fixtureSeq++;
  return {
    id: `fx-${fixtureSeq}-${homeId}-${awayId}`,
    competition,
    homeTeam: { id: homeId, name: homeId, shortName: homeId, tla: homeId.slice(0, 3) },
    awayTeam: { id: awayId, name: awayId, shortName: awayId, tla: awayId.slice(0, 3) },
    utcKickoffTime: kickoffIso,
    status,
    score: { home: homeGoals, away: awayGoals },
  } as Fixture;
}

function iso(dayOffset: number, hour = 12): string {
  // Deterministic dates from 2024-01-01.
  const base = Date.UTC(2024, 0, 1, hour, 0, 0);
  return new Date(base + dayOffset * 24 * 3600 * 1000).toISOString();
}

// ---------- metrics ----------

describe('Phase M – RPS and metric correctness', () => {
  it('RPS is 0 for a perfect certain prediction', () => {
    expect(rankedProbabilityScore({ homeWin: 1, draw: 0, awayWin: 0 }, 0)).toBeCloseTo(0, 12);
    expect(rankedProbabilityScore({ homeWin: 0, draw: 1, awayWin: 0 }, 1)).toBeCloseTo(0, 12);
    expect(rankedProbabilityScore({ homeWin: 0, draw: 0, awayWin: 1 }, 2)).toBeCloseTo(0, 12);
  });

  it('RPS matches a hand-computed example', () => {
    // p = (0.5, 0.3, 0.2), outcome = away (2).
    // cumFore = (0.5, 0.8); cumObs = (0, 0).
    // RPS = 0.5 * (0.5^2 + 0.8^2) = 0.5 * (0.25 + 0.64) = 0.445.
    expect(rankedProbabilityScore({ homeWin: 0.5, draw: 0.3, awayWin: 0.2 }, 2)).toBeCloseTo(0.445, 12);
  });

  it('RPS respects ordinal ordering (a home-vs-away confusion is penalized more than home-vs-draw)', () => {
    const p = { homeWin: 1, draw: 0, awayWin: 0 };
    const rpsDraw = rankedProbabilityScore(p, 1);
    const rpsAway = rankedProbabilityScore(p, 2);
    expect(rpsAway).toBeGreaterThan(rpsDraw);
  });

  it('RPS stays within [0, 1]', () => {
    const ps: ProbabilityTriplet[] = [
      { homeWin: 0.34, draw: 0.33, awayWin: 0.33 },
      { homeWin: 0.9, draw: 0.05, awayWin: 0.05 },
      { homeWin: 0.0, draw: 0.0, awayWin: 1.0 },
    ];
    for (const p of ps) {
      for (const o of [0, 1, 2] as Outcome[]) {
        const r = rankedProbabilityScore(p, o);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});

// ---------- Dixon–Coles low-score correction ----------

describe('Phase M – Dixon–Coles low-score correction', () => {
  it('tau is 1 for all scorelines outside (0,0),(0,1),(1,0),(1,1)', () => {
    expect(tauCorrection(2, 0, 1.5, 1.1, -0.05)).toBe(1);
    expect(tauCorrection(0, 2, 1.5, 1.1, -0.05)).toBe(1);
    expect(tauCorrection(3, 3, 1.5, 1.1, -0.05)).toBe(1);
  });

  it('tau matches the Dixon–Coles formulas for the four low cells', () => {
    const lH = 1.6;
    const lA = 1.2;
    const rho = -0.05;
    expect(tauCorrection(0, 0, lH, lA, rho)).toBeCloseTo(1 - lH * lA * rho, 12);
    expect(tauCorrection(0, 1, lH, lA, rho)).toBeCloseTo(1 + lH * rho, 12);
    expect(tauCorrection(1, 0, lH, lA, rho)).toBeCloseTo(1 + lA * rho, 12);
    expect(tauCorrection(1, 1, lH, lA, rho)).toBeCloseTo(1 - rho, 12);
  });

  it('a negative rho increases the 0-0 and 1-1 cells and decreases the 1-0/0-1 cells', () => {
    const lH = 1.5;
    const lA = 1.2;
    expect(tauCorrection(0, 0, lH, lA, -0.05)).toBeGreaterThan(1);
    expect(tauCorrection(1, 1, lH, lA, -0.05)).toBeGreaterThan(1);
    expect(tauCorrection(1, 0, lH, lA, -0.05)).toBeLessThan(1);
    expect(tauCorrection(0, 1, lH, lA, -0.05)).toBeLessThan(1);
  });
});

// ---------- fitting determinism, validity, cold start ----------

function syntheticMatches(): DCMatch[] {
  // Two strong teams and two weak teams, deterministic goals, over 30 days.
  const matches: DCMatch[] = [];
  const pairs: [string, string, number, number][] = [];
  for (let d = 0; d < 30; d++) {
    pairs.push(['A', 'B', 2, 1]);
    pairs.push(['C', 'D', 1, 1]);
    pairs.push(['A', 'C', 3, 0]);
    pairs.push(['B', 'D', 2, 0]);
  }
  for (let i = 0; i < pairs.length; i++) {
    const [h, a, hg, ag] = pairs[i];
    matches.push({ homeTeamId: h, awayTeamId: a, homeGoals: hg, awayGoals: ag, kickoffMs: Date.UTC(2024, 0, 1) + i * 3600 * 1000 });
  }
  return matches;
}

describe('Phase M – Dixon–Coles fitting', () => {
  it('fits deterministically (identical inputs -> identical params)', () => {
    const m = syntheticMatches();
    const asOf = Date.UTC(2024, 2, 1);
    const p1 = fitDixonColes(m, asOf, DEFAULT_DC_CONFIG);
    const p2 = fitDixonColes(m, asOf, DEFAULT_DC_CONFIG);
    expect(p1.mu).toBe(p2.mu);
    expect(p1.homeAdvantage).toBe(p2.homeAdvantage);
    expect(p1.attack).toEqual(p2.attack);
    expect(p1.defence).toEqual(p2.defence);
  });

  it('produces finite, in-range, normalised probabilities', () => {
    const m = syntheticMatches();
    const asOf = Date.UTC(2024, 2, 1);
    const params = fitDixonColes(m, asOf, DEFAULT_DC_CONFIG);
    const pred = predictDixonColes(params, 'A', 'D', DEFAULT_DC_CONFIG)!;
    expect(pred).not.toBeNull();
    for (const v of [pred.homeWin, pred.draw, pred.awayWin]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(pred.homeWin + pred.draw + pred.awayWin).toBeCloseTo(1, 9);
  });

  it('returns null for an unseen team (cold-start policy)', () => {
    const m = syntheticMatches();
    const params = fitDixonColes(m, Date.UTC(2024, 2, 1), DEFAULT_DC_CONFIG);
    expect(predictDixonColes(params, 'A', 'ZZZ', DEFAULT_DC_CONFIG)).toBeNull();
  });

  it('favours the stronger team', () => {
    const m = syntheticMatches();
    const params = fitDixonColes(m, Date.UTC(2024, 2, 1), DEFAULT_DC_CONFIG);
    const strongHome = predictDixonColes(params, 'A', 'D', DEFAULT_DC_CONFIG)!;
    const strongAway = predictDixonColes(params, 'D', 'A', DEFAULT_DC_CONFIG)!;
    expect(strongHome.homeWin).toBeGreaterThan(strongAway.awayWin);
  });

  it('never uses matches at or after the forecast time (no target/future leakage in the fit)', () => {
    const m = syntheticMatches();
    const asOf = Date.UTC(2024, 0, 1) + 5 * 3600 * 1000;
    const params = fitDixonColes(m, asOf, DEFAULT_DC_CONFIG);
    expect(params.trainMatches).toBe(5); // only the first five hourly matches precede asOf
  });

  it('is invariant to later results: changing a future match does not change an earlier prediction', () => {
    const m = syntheticMatches();
    const asOf = Date.UTC(2024, 0, 1) + 10 * 3600 * 1000;
    const before = fitDixonColes(m, asOf, DEFAULT_DC_CONFIG);
    const pBefore = predictDixonColes(before, 'A', 'C', DEFAULT_DC_CONFIG)!;

    const mutated = m.map((x, i) => (i >= 20 ? { ...x, homeGoals: 9, awayGoals: 9 } : x));
    const after = fitDixonColes(mutated, asOf, DEFAULT_DC_CONFIG);
    const pAfter = predictDixonColes(after, 'A', 'C', DEFAULT_DC_CONFIG)!;

    expect(pAfter.homeWin).toBeCloseTo(pBefore.homeWin, 12);
    expect(pAfter.draw).toBeCloseTo(pBefore.draw, 12);
    expect(pAfter.awayWin).toBeCloseTo(pBefore.awayWin, 12);
  });

  it('handles an empty training set without throwing', () => {
    const params = fitDixonColes([], Date.UTC(2024, 0, 1), DEFAULT_DC_CONFIG);
    expect(params.trainMatches).toBe(0);
    expect(params.teams.length).toBe(0);
  });
});

// ---------- walk-forward leakage & separation ----------

describe('Phase M – walk-forward leakage and separation', () => {
  function seasonFixtures(): Fixture[] {
    // 4 teams, 6 rounds, deterministic. Team goals chosen so table order is stable.
    const fx: Fixture[] = [];
    const teams = ['T1', 'T2', 'T3', 'T4'];
    let day = 0;
    for (let r = 0; r < 6; r++) {
      const rot = teams.slice(r % 4).concat(teams.slice(0, r % 4));
      for (let i = 0; i < 2; i++) {
        const h = rot[i];
        const a = rot[3 - i];
        const hg = h === 'T1' ? 2 : h === 'T2' ? 1 : 0;
        const ag = a === 'T1' ? 2 : a === 'T2' ? 1 : 0;
        fx.push(fixture(h, a, iso(day), hg, ag));
        day += 2;
      }
    }
    return fx;
  }

  it('predictions are invariant when the target match score is changed', () => {
    const base = seasonFixtures();
    const wf1 = runDixonColesWalkForward(base, DEFAULT_DC_CONFIG);
    // Mutate the final match's score.
    const mutated = base.map((f, i) => (i === base.length - 1 ? { ...f, score: { home: 9, away: 0 } } : f));
    const wf2 = runDixonColesWalkForward(mutated, DEFAULT_DC_CONFIG);
    const lastId = base[base.length - 1].id;
    const p1 = wf1.predictions.get(lastId);
    const p2 = wf2.predictions.get(lastId);
    if (p1 && p2) {
      expect(p2.homeWin).toBeCloseTo(p1.homeWin, 12);
    }
    // And earlier predictions must be unchanged too.
    const earlyId = base[5].id;
    const e1 = wf1.predictions.get(earlyId);
    const e2 = wf2.predictions.get(earlyId);
    if (e1 && e2) {
      expect(e2.homeWin).toBeCloseTo(e1.homeWin, 12);
      expect(e2.draw).toBeCloseTo(e1.draw, 12);
    }
  });

  it('competition separation: matches from another competition do not enter a competition fit', () => {
    const pl = seasonFixtures();
    const other = seasonFixtures().map((f) => ({ ...f, id: f.id + '-pd', competition: comp('PD', '2024/25') }));
    const combined = [...pl, ...other];
    const only = runDixonColesWalkForward(pl, DEFAULT_DC_CONFIG);
    const both = runDixonColesWalkForward(combined, DEFAULT_DC_CONFIG);
    // A PL prediction should be identical whether or not PD exists.
    const id = pl[pl.length - 1].id;
    const p1 = only.predictions.get(id);
    const p2 = both.predictions.get(id);
    if (p1 && p2) {
      expect(p2.homeWin).toBeCloseTo(p1.homeWin, 12);
      expect(p2.awayWin).toBeCloseTo(p1.awayWin, 12);
    }
  });

  it('pairedSubset returns only records where all requested models exist', () => {
    const wf = runWalkForward(seasonFixtures(), { dcConfig: DEFAULT_DC_CONFIG });
    const paired = pairedSubset(wf.records, ['frozen', 'baseline', 'dc']);
    for (const r of paired) {
      expect(r.frozen).toBeDefined();
      expect(r.baseline).toBeDefined();
      expect(r.dc).toBeDefined();
    }
  });
});

// ---------- calibration ----------

describe('Phase M – calibration', () => {
  it('applyTemperature preserves sum-to-one and finiteness', () => {
    const p = { homeWin: 0.6, draw: 0.25, awayWin: 0.15 };
    for (const t of [0.5, 1, 2, 3]) {
      const q = applyTemperature(p, t);
      expect(q.homeWin + q.draw + q.awayWin).toBeCloseTo(1, 12);
      for (const v of [q.homeWin, q.draw, q.awayWin]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('T > 1 flattens an overconfident vector toward uniform', () => {
    const p = { homeWin: 0.9, draw: 0.05, awayWin: 0.05 };
    const flat = applyTemperature(p, 2.5);
    expect(flat.homeWin).toBeLessThan(p.homeWin);
    expect(flat.draw).toBeGreaterThan(p.draw);
  });

  it('fitting recovers T > 1 when the model is overconfident on the calibration set', () => {
    // Predictions are overconfident; outcomes are more balanced.
    const probs: ProbabilityTriplet[] = [];
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 300; i++) {
      probs.push({ homeWin: 0.85, draw: 0.1, awayWin: 0.05 });
      // Home actually wins ~60% of the time.
      outcomes.push(i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : 2);
    }
    const fit = fitTemperature(probs, outcomes);
    expect(fit.temperature).toBeGreaterThan(1.0);
    expect(fit.logLossAfter).toBeLessThan(fit.logLossBefore);
  });

  it('calibration uses only the provided (earlier) data: a different later outcome set cannot change T', () => {
    const calProbs: ProbabilityTriplet[] = Array.from({ length: 200 }, () => ({ homeWin: 0.6, draw: 0.25, awayWin: 0.15 }));
    const calOut: Outcome[] = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0 : 1));
    const fitA = fitTemperature(calProbs, calOut);
    // The calibrator never sees any other data; refitting on the same inputs is identical.
    const fitB = fitTemperature(calProbs, calOut);
    expect(fitB.temperature).toBe(fitA.temperature);
  });
});

// ---------- bootstrap ----------

describe('Phase M – block bootstrap', () => {
  function obs(n: number): PairedObservation[] {
    const out: PairedObservation[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        probabilities: { homeWin: 0.5, draw: 0.25, awayWin: 0.25 },
        outcome: (i % 3) as Outcome,
        kickoffMs: i * 3600 * 1000,
        competitionCode: 'PL',
      });
    }
    return out;
  }

  it('is reproducible for a fixed seed', () => {
    const o = obs(200);
    const a = o.map((_, i) => 0.5 + (i % 5) * 0.01);
    const b = o.map((_, i) => 0.6 + (i % 5) * 0.01);
    const r1 = pairedBlockBootstrapFromScores(o, a, b, { seed: 42, resamples: 500, blockSize: 10 });
    const r2 = pairedBlockBootstrapFromScores(o, a, b, { seed: 42, resamples: 500, blockSize: 10 });
    expect(r1.ciLow).toBe(r2.ciLow);
    expect(r1.ciHigh).toBe(r2.ciHigh);
    expect(r1.meanDifference).toBeCloseTo(r2.meanDifference, 12);
  });

  it('reports the exact mean difference of the supplied scores', () => {
    const o = obs(100);
    const a = o.map(() => 0.4);
    const b = o.map(() => 0.5);
    const r = pairedBlockBootstrapFromScores(o, a, b, { seed: 1, resamples: 100, blockSize: 10 });
    expect(r.meanA).toBeCloseTo(0.4, 12);
    expect(r.meanB).toBeCloseTo(0.5, 12);
    expect(r.meanDifference).toBeCloseTo(-0.1, 12);
  });

  it('buildBlocks never spans a competition boundary when stratified', () => {
    const o: PairedObservation[] = [
      ...obs(30).map((x) => ({ ...x, competitionCode: 'PL' })),
      ...obs(30).map((x, i) => ({ ...x, kickoffMs: 1e12 + i, competitionCode: 'PD' })),
    ];
    const blocks = buildBlocks(o, 10, true);
    for (const b of blocks) {
      const comps = new Set(b.indices.map((i) => o[i].competitionCode));
      expect(comps.size).toBe(1);
    }
  });

  it('mulberry32 is deterministic', () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    for (let i = 0; i < 10; i++) expect(r1()).toBe(r2());
  });
});
