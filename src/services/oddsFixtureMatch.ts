/**
 * Project Touchline – Odds Event → Canonical Fixture Matching
 *
 * The Odds API identifies events by team names and a kickoff time, not by our
 * canonical fixture id. This module maps an event onto a canonical fixture using
 * normalised club names *and* a kickoff tolerance, and refuses to guess.
 *
 * Safety rules (default posture is refusal):
 * - A candidate must match both club names after normalisation (via the shared
 *   `normalizeClubName`, so cross-provider aliases behave the same as elsewhere).
 * - The candidate's kickoff must be within the tolerance of the event's commence time.
 * - Zero name-matching candidates            → `no_candidate` (no odds attached).
 * - More than one name-matching candidate    → `ambiguous` (rejected, never guessed).
 * - Names match but the time is outside the tolerance → `kickoff_mismatch` (rejected).
 * - A single, unambiguous, in-window match   → `matched`.
 *
 * This module never fabricates a fixture id and never attaches odds to a fixture
 * it is not certain about.
 */

import { normalizeClubName } from '../utils/matchIdentity';

export interface MatchCandidate {
  fixtureId: string;
  homeName: string;
  awayName: string;
  /** ISO kickoff time. */
  kickoffIso: string;
}

export type FixtureMatchStatus =
  | 'matched'
  | 'no_candidate'
  | 'ambiguous'
  | 'kickoff_mismatch';

export interface FixtureMatchResult {
  status: FixtureMatchStatus;
  /** Set only when status is `matched`. */
  fixtureId: string | null;
  /** Ids of every candidate whose club names matched (before the kickoff test). */
  candidates: string[];
  detail: string;
}

/** Default tolerance between the event commence time and a fixture kickoff. */
export const DEFAULT_KICKOFF_TOLERANCE_MS = 15 * 60 * 1000;

function kickoffMs(iso: string | undefined): number {
  if (!iso) return NaN;
  return new Date(iso).getTime();
}

/**
 * Resolves a single event (home/away names + commence time) to exactly one canonical
 * fixture, or refuses. `toleranceMs` defaults to 15 minutes.
 */
export function matchEventToFixture(
  event: { homeName: string; awayName: string; commenceIso: string },
  candidates: MatchCandidate[],
  toleranceMs: number = DEFAULT_KICKOFF_TOLERANCE_MS
): FixtureMatchResult {
  const eventHome = normalizeClubName(event.homeName);
  const eventAway = normalizeClubName(event.awayName);

  if (!eventHome || !eventAway) {
    return { status: 'no_candidate', fixtureId: null, candidates: [], detail: 'Event has no usable team names.' };
  }

  const nameMatches = candidates.filter(
    (c) => normalizeClubName(c.homeName) === eventHome && normalizeClubName(c.awayName) === eventAway
  );

  if (nameMatches.length === 0) {
    return {
      status: 'no_candidate',
      fixtureId: null,
      candidates: [],
      detail: `No fixture matches ${event.homeName} vs ${event.awayName}.`,
    };
  }

  if (nameMatches.length > 1) {
    // Two different fixtures with the same two clubs (e.g. a replayed cup tie) — refuse.
    return {
      status: 'ambiguous',
      fixtureId: null,
      candidates: nameMatches.map((c) => c.fixtureId),
      detail: `${nameMatches.length} fixtures match ${event.homeName} vs ${event.awayName}; refusing to guess.`,
    };
  }

  const only = nameMatches[0];
  const eventMs = kickoffMs(event.commenceIso);
  const fixtureMs = kickoffMs(only.kickoffIso);

  if (!Number.isFinite(eventMs) || !Number.isFinite(fixtureMs)) {
    return {
      status: 'kickoff_mismatch',
      fixtureId: null,
      candidates: [only.fixtureId],
      detail: 'Missing or invalid kickoff time; refusing to attach odds.',
    };
  }

  if (Math.abs(eventMs - fixtureMs) > toleranceMs) {
    return {
      status: 'kickoff_mismatch',
      fixtureId: null,
      candidates: [only.fixtureId],
      detail: `Kickoff differs by ${Math.round(Math.abs(eventMs - fixtureMs) / 60000)} min (tolerance ${Math.round(toleranceMs / 60000)} min).`,
    };
  }

  return {
    status: 'matched',
    fixtureId: only.fixtureId,
    candidates: [only.fixtureId],
    detail: `Matched ${only.fixtureId}.`,
  };
}
