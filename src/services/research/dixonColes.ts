/**
 * Project Touchline – Phase M Dixon–Coles challenger (RESEARCH ONLY)
 *
 * An isolated, time-decayed, regularized Dixon–Coles style model. It is never
 * imported by the production app and never replaces POISSON_V1_FROZEN. It exists
 * only to be scored against the frozen model offline.
 *
 * Model (Dixon & Coles, 1997, JRSS-C 46(2):265-280):
 *   goals_home ~ Poisson(lambda_h), goals_away ~ Poisson(lambda_a), with the
 *   low-score dependence correction tau on the (0,0), (1,0), (0,1), (1,1) cells.
 *
 *   log(lambda_h) = mu + attack_home + defence_away + gamma
 *   log(lambda_a) = mu + attack_away + defence_home
 *
 *   tau(0,0) = 1 - lambda_h*lambda_a*rho
 *   tau(0,1) = 1 + lambda_h*rho
 *   tau(1,0) = 1 + lambda_a*rho
 *   tau(1,1) = 1 - rho
 *   tau(x,y) = 1 otherwise
 *
 * Fitting: maximum likelihood by gradient ascent with backtracking line search.
 * The gradient is analytic (including the tau term) so each step costs O(matches).
 * A time-decay weight w = exp(-decay * daysBeforeForecast) is applied to each
 * historical match; the decay reference is the forecast time, so only strictly
 * prior information is used. L2 regularization shrinks attack/defence toward zero
 * (the competition mean, because the gauge below centres both to mean zero).
 *
 * Gauge / identifiability: attack and defence means are confounded with mu. After
 * every update both are centred to mean zero (a likelihood-invariant gauge fix),
 * and mu absorbs the overall level. This gives stable, identifiable estimates.
 *
 * Valid tau range: to keep every tau non-negative for the fitted lambdas we require
 * rho <= 1 / (lambda_h_max * lambda_a_max) in principle; we bound |rho| to a small
 * range and additionally clamp the four tau cells to a positive floor at prediction
 * time, documented as a numerical safeguard.
 */

export interface DCConfig {
  /** Time-decay rate per day. 0 disables decay. */
  decay: number;
  /** L2 regularization strength on attack and defence (log scale). */
  regularization: number;
  /** Low-score dependence parameter rho. */
  rho: number;
  /** Max goals per side when building the scoreline grid. */
  maxGoals: number;
  /** Max gradient-ascent iterations per fit. */
  maxIterations: number;
  /** Relative log-likelihood improvement required to keep iterating. */
  convergenceTol: number;
  /** Minimum prior matches per team for a prediction (cold-start policy). */
  minHistory: number;
}

export const DEFAULT_DC_CONFIG: DCConfig = {
  decay: 0.0055,
  regularization: 0.02,
  rho: -0.05,
  maxGoals: 10,
  maxIterations: 80,
  convergenceTol: 1e-7,
  minHistory: 3,
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A single training observation: goals and kickoff, with a home/away team key. */
export interface DCMatch {
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number;
  awayGoals: number;
  kickoffMs: number;
}

export interface DCParams {
  mu: number;
  homeAdvantage: number;
  /** teamId -> log attack strength (mean-centred to 0). */
  attack: Record<string, number>;
  /** teamId -> log defence strength (mean-centred to 0). */
  defence: Record<string, number>;
  /** Team ids seen during fitting, in deterministic order. */
  teams: string[];
  converged: boolean;
  iterations: number;
  finalLogLikelihood: number;
  trainMatches: number;
}

export interface DCFitDiagnostics {
  converged: boolean;
  iterations: number;
  finalLogLikelihood: number;
  trainMatches: number;
  regularizedObjective: number;
}

/** tau correction applied to the joint probability of a scoreline. */
export function tauCorrection(h: number, a: number, lambdaH: number, lambdaA: number, rho: number): number {
  if (h === 0 && a === 0) return 1 - lambdaH * lambdaA * rho;
  if (h === 0 && a === 1) return 1 + lambdaH * rho;
  if (h === 1 && a === 0) return 1 + lambdaA * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function meanCentre(v: Record<string, number>, teams: string[]): number {
  if (teams.length === 0) return 0;
  let s = 0;
  for (const t of teams) s += v[t];
  const m = s / teams.length;
  for (const t of teams) v[t] -= m;
  return m;
}

/**
 * Fits Dixon–Coles parameters from matches strictly before `asOfMs`.
 * Deterministic: zero initialization, fixed iteration order, fixed seed-free maths.
 */
export function fitDixonColes(matches: DCMatch[], asOfMs: number, config: DCConfig): DCParams {
  const train = matches.filter((m) => m.kickoffMs < asOfMs);
  const teamSet = new Set<string>();
  for (const m of train) {
    teamSet.add(m.homeTeamId);
    teamSet.add(m.awayTeamId);
  }
  const teams = [...teamSet].sort();

  const attack: Record<string, number> = {};
  const defence: Record<string, number> = {};
  for (const t of teams) {
    attack[t] = 0;
    defence[t] = 0;
  }
  let mu = 0;
  let homeAdvantage = 0.25;

  const n = teams.length;
  const nParams = 2 * n + 2;
  const diagnostics: DCFitDiagnostics = {
    converged: false,
    iterations: 0,
    finalLogLikelihood: 0,
    trainMatches: train.length,
    regularizedObjective: 0,
  };

  if (train.length === 0 || n === 0) {
    return {
      mu,
      homeAdvantage,
      attack,
      defence,
      teams,
      converged: true,
      iterations: 0,
      finalLogLikelihood: 0,
      trainMatches: 0,
    };
  }

  // Precompute per-match decay weights relative to the forecast time.
  const weights = train.map((m) => Math.exp(-config.decay * ((asOfMs - m.kickoffMs) / DAY_MS)));
  let weightSum = 0;
  for (const w of weights) weightSum += w;
  if (weightSum <= 0) weightSum = 1;

  const rho = config.rho;

  // Regularized objective: sum_m w_m * logP_m  -  (reg/2) * (sum a^2 + sum d^2).
  const objective = (): number => {
    let ll = 0;
    for (let i = 0; i < train.length; i++) {
      const m = train[i];
      const lambdaH = Math.exp(mu + attack[m.homeTeamId] + defence[m.awayTeamId] + homeAdvantage);
      const lambdaA = Math.exp(mu + attack[m.awayTeamId] + defence[m.homeTeamId]);
      const base = poissonPmf(lambdaH, m.homeGoals) * poissonPmf(lambdaA, m.awayGoals);
      const tau = Math.max(tauCorrection(m.homeGoals, m.awayGoals, lambdaH, lambdaA, rho), 1e-12);
      ll += weights[i] * (Math.log(Math.max(base, 1e-300)) + Math.log(tau));
    }
    let pen = 0;
    for (const t of teams) pen += attack[t] * attack[t] + defence[t] * defence[t];
    return ll - (config.regularization / 2) * pen;
  };

  let current = objective();

  for (let iter = 0; iter < config.maxIterations; iter++) {
    diagnostics.iterations = iter + 1;

    // Analytic gradient of the objective.
    const gA: Record<string, number> = {};
    const gD: Record<string, number> = {};
    for (const t of teams) {
      gA[t] = 0;
      gD[t] = 0;
    }
    let gMu = 0;
    let gGamma = 0;

    for (let i = 0; i < train.length; i++) {
      const m = train[i];
      const lambdaH = Math.exp(mu + attack[m.homeTeamId] + defence[m.awayTeamId] + homeAdvantage);
      const lambdaA = Math.exp(mu + attack[m.awayTeamId] + defence[m.homeTeamId]);
      const w = weights[i];

      // d log tau / d log lambdaH and / d log lambdaA
      let dTauH = 0;
      let dTauA = 0;
      const tau = Math.max(tauCorrection(m.homeGoals, m.awayGoals, lambdaH, lambdaA, rho), 1e-12);
      if (m.homeGoals === 0 && m.awayGoals === 0) {
        dTauH = (-lambdaH * lambdaA * rho) / tau;
        dTauA = (-lambdaH * lambdaA * rho) / tau;
      } else if (m.homeGoals === 0 && m.awayGoals === 1) {
        dTauH = (lambdaH * rho) / tau;
      } else if (m.homeGoals === 1 && m.awayGoals === 0) {
        dTauA = (lambdaA * rho) / tau;
      }

      const gH = w * (m.homeGoals - lambdaH + dTauH);
      const gAway = w * (m.awayGoals - lambdaA + dTauA);

      gA[m.homeTeamId] += gH;
      gD[m.awayTeamId] += gH;
      gMu += gH + gAway;
      gGamma += gH;
      gA[m.awayTeamId] += gAway;
      gD[m.homeTeamId] += gAway;
    }

    // Regularization gradient.
    for (const t of teams) {
      gA[t] -= config.regularization * attack[t];
      gD[t] -= config.regularization * defence[t];
    }

    // Backtracking line search on a normalized gradient step.
    const gradNorm =
      Math.sqrt(
        gMu * gMu +
          gGamma * gGamma +
          teams.reduce((s, t) => s + gA[t] * gA[t] + gD[t] * gD[t], 0)
      ) / Math.max(1, Math.sqrt(nParams));
    if (!Number.isFinite(gradNorm) || gradNorm < 1e-12) {
      diagnostics.converged = true;
      break;
    }

    let step = 1 / Math.max(1, weightSum) * 20; // scale so first step is meaningful
    let improved = false;
    for (let bt = 0; bt < 25; bt++) {
      const candA: Record<string, number> = {};
      const candD: Record<string, number> = {};
      for (const t of teams) {
        candA[t] = attack[t] + step * gA[t];
        candD[t] = defence[t] + step * gD[t];
      }
      // Gauge fix: centre attack and defence, compensating mu so every fitted
      // lambda is unchanged (the transform is likelihood-invariant).
      const shiftA = meanCentre(candA, teams);
      const shiftD = meanCentre(candD, teams);
      const candMu = mu + step * gMu + shiftA + shiftD;
      const candGamma = homeAdvantage + step * gGamma;

      // Evaluate candidate objective inline.
      let ll = 0;
      for (let i = 0; i < train.length; i++) {
        const m = train[i];
        const lH = Math.exp(candMu + candA[m.homeTeamId] + candD[m.awayTeamId] + candGamma);
        const lA = Math.exp(candMu + candA[m.awayTeamId] + candD[m.homeTeamId]);
        const base = poissonPmf(lH, m.homeGoals) * poissonPmf(lA, m.awayGoals);
        const tau = Math.max(tauCorrection(m.homeGoals, m.awayGoals, lH, lA, rho), 1e-12);
        ll += weights[i] * (Math.log(Math.max(base, 1e-300)) + Math.log(tau));
      }
      let pen = 0;
      for (const t of teams) pen += candA[t] * candA[t] + candD[t] * candD[t];
      const candObj = ll - (config.regularization / 2) * pen;

      if (Number.isFinite(candObj) && candObj > current) {
        mu = candMu;
        homeAdvantage = candGamma;
        for (const t of teams) {
          attack[t] = candA[t];
          defence[t] = candD[t];
        }
        const improvement = candObj - current;
        current = candObj;
        improved = true;
        if (improvement / Math.max(1e-9, Math.abs(current)) < config.convergenceTol) {
          diagnostics.converged = true;
        }
        break;
      }
      step /= 2;
    }

    if (!improved) {
      diagnostics.converged = true;
      break;
    }
    if (diagnostics.converged) break;
  }

  diagnostics.finalLogLikelihood = current;
  diagnostics.regularizedObjective = current;

  return {
    mu,
    homeAdvantage,
    attack,
    defence,
    teams,
    converged: diagnostics.converged,
    iterations: diagnostics.iterations,
    finalLogLikelihood: diagnostics.finalLogLikelihood,
    trainMatches: train.length,
  };
}

export interface DCPrediction {
  homeWin: number;
  draw: number;
  awayWin: number;
  lambdaHome: number;
  lambdaAway: number;
  /** Raw (unnormalized) sum of the tau-corrected scoreline grid. */
  gridSum: number;
}

/**
 * Predicts 1X2 probabilities from fitted parameters. Returns null when a team is
 * unseen or when the parameters do not produce a valid, finite grid.
 */
export function predictDixonColes(
  params: DCParams,
  homeTeamId: string,
  awayTeamId: string,
  config: DCConfig
): DCPrediction | null {
  const aH = params.attack[homeTeamId];
  const aA = params.attack[awayTeamId];
  const dH = params.defence[homeTeamId];
  const dA = params.defence[awayTeamId];
  if (aH === undefined || aA === undefined || dH === undefined || dA === undefined) return null;

  const lambdaH = Math.exp(params.mu + aH + dA + params.homeAdvantage);
  const lambdaA = Math.exp(params.mu + aA + dH);
  if (!Number.isFinite(lambdaH) || !Number.isFinite(lambdaA) || lambdaH <= 0 || lambdaA <= 0) return null;

  const maxG = config.maxGoals;
  const pHome: number[] = [];
  const pAway: number[] = [];
  for (let k = 0; k <= maxG; k++) {
    pHome.push(poissonPmf(lambdaH, k));
    pAway.push(poissonPmf(lambdaA, k));
  }

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let gridSum = 0;
  for (let h = 0; h <= maxG; h++) {
    for (let a = 0; a <= maxG; a++) {
      const tau = Math.max(tauCorrection(h, a, lambdaH, lambdaA, config.rho), 1e-12);
      const joint = pHome[h] * pAway[a] * tau;
      if (!Number.isFinite(joint) || joint < 0) continue;
      gridSum += joint;
      if (h > a) homeWin += joint;
      else if (h === a) draw += joint;
      else awayWin += joint;
    }
  }
  if (!Number.isFinite(gridSum) || gridSum <= 0) return null;

  return {
    homeWin: homeWin / gridSum,
    draw: draw / gridSum,
    awayWin: awayWin / gridSum,
    lambdaHome: lambdaH,
    lambdaAway: lambdaA,
    gridSum,
  };
}
