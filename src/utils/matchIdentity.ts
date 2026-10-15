/**
 * Project Touchline – Reliable Match Identity & Cross-Provider Deduplication
 * Generates canonical match identities across disparate data providers
 * using kickoff date, canonical competition, and normalized club names.
 */

import { Fixture, MatchScore } from '../types/football';
import { getCanonicalCompetitionMeta } from './competitionGrouping';

/**
 * Normalizes club name for robust cross-provider matching.
 * Strips accents, punctuation, founding years, common club designators (FC, CF, AFC, RC, etc.),
 * and canonicalizes team-name variants (LASK Linz/LASK, Feyenoord Rotterdam/Feyenoord,
 * Como 1907/Como, Real Betis Balompie/Real Betis, Lens/RC Lens, Inter/Inter Milan,
 * Slavia Praha/SK Slavia Praha, Sporting CP/Sporting Clube de Portugal,
 * Atletico Madrid/Club Atletico de Madrid, Bayern Munich/FC Bayern Munchen,
 * Shakhtar Donetsk/FK Shakhtar Donetsk, AEK Athens/PAE AEK).
 */
export function normalizeClubName(name?: string | null): string {
  if (!name || typeof name !== 'string') return '';
  let s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .toLowerCase();

  // Strip 4-digit founding years (e.g. 1907 for Como, 1905 for Bohemians, 1899 for Hoffenheim)
  s = s.replace(/\b(18|19|20)\d{2}\b/g, ' ');

  // Multi-word club & known alias harmonizations
  // 1. Inter Milan / FC Internazionale Milano / Inter
  s = s.replace(/\b(fc\s+)?internazionale(\s+milano)?\b/g, 'inter milan');
  s = s.replace(/\binter\b(?!\s+milan)/g, 'inter milan');

  // 2. Sporting CP / Sporting Clube de Portugal / Sporting Lisbon
  s = s.replace(/\bsporting\s+(clube\s+de\s+portugal|cp|lisbon|lisboa)\b/g, 'sporting');
  s = s.replace(/\bclube\s+de\s+portugal\b/g, 'sporting');

  // 3. RC Lens / Racing Club de Lens
  s = s.replace(/\bracing\s+club(\s+de)?\s+lens\b/g, 'lens');
  s = s.replace(/\brc\s+lens\b/g, 'lens');

  // 4. Slavia Praha / Slavia Prague / SK Slavia Praha
  s = s.replace(/\bslavia\s+(praha|prague)\b/g, 'slavia prague');

  // 5. Sparta Praha / Sparta Prague / AC Sparta Praha
  s = s.replace(/\bsparta\s+(praha|prague)\b/g, 'sparta prague');

  // 6. Bayern Munich / Bayern München / FC Bayern München
  s = s.replace(/\bbayern\s+(munchen|munich)\b/g, 'bayern munich');

  // 7. Red Bull / RB
  s = s.replace(/\bred\s+bull\b/g, 'rb');

  // 8. Paris Saint-Germain / PSG / Paris SG
  s = s.replace(/\b(paris\s+sg|psg)\b/g, 'paris saint germain');

  // 9. LASK Linz / Linzer ASK / LASK
  s = s.replace(/\blask\s+linz\b/g, 'lask');
  s = s.replace(/\blinzer\s+ask\b/g, 'lask');

  // 10. Feyenoord Rotterdam / Feyenoord
  s = s.replace(/\bfeyenoord\s+rotterdam\b/g, 'feyenoord');

  // 11. Real Betis Balompié / Real Betis
  s = s.replace(/\breal\s+betis\s+balompie\b/g, 'real betis');

  // 12. AEK Athens / PAE AEK / AEK
  s = s.replace(/\baek\s+athens\b/g, 'aek');
  s = s.replace(/\bpae\s+aek\b/g, 'aek');

  // 13. Shakhtar Donetsk / FK Shakhtar Donetsk / Shakhtar D
  s = s.replace(/\bshakhtar\s+d\b/g, 'shakhtar donetsk');

  // 14. Slovan Bratislava
  s = s.replace(/\b(sl\.|sk)\s+bratislava\b/g, 'slovan bratislava');

  // 15. Wolves & Spurs
  s = s.replace(/\bwolves\b/g, 'wolverhampton');
  s = s.replace(/\bspurs\b/g, 'tottenham');

  // 16. Sheffield variants
  s = s.replace(/\bsheff\s+utd\b/g, 'sheffield united');
  s = s.replace(/\bsheff\s+wed\b/g, 'sheffield wednesday');

  // 17. Manchester variants
  s = s.replace(/\bman\s+city\b/g, 'manchester city');
  s = s.replace(/\bman\s+(utd|united)\b/g, 'manchester united');

  // Common club designator abbreviations and prefixes
  s = s.replace(
    /\b(balompie|pae|club|clube|racing|deportivo|afc|cf|fc|sc|cd|ac|fk|sk|ssc|vfb|vfl|tsv|bsc|fsv|sv|as|us|ogc|osc|cp|ec|kv|rc|sad|sp|jk|rb)\b/g,
    ' '
  );

  // Common articles and prepositions
  s = s.replace(/\b(de|del|di|da|do|des|du|der|die|das|the)\b/g, ' ');

  return s.replace(/[^a-z0-9]/g, '').trim();
}

/**
 * Checks whether two club representations are equivalent across providers.
 */
export function areClubsEquivalent(
  teamA?: { name?: string; shortName?: string; tla?: string } | null,
  teamB?: { name?: string; shortName?: string; tla?: string } | null
): boolean {
  if (!teamA || !teamB) return false;

  const normNameA = normalizeClubName(teamA.name);
  const normNameB = normalizeClubName(teamB.name);
  if (normNameA && normNameB && normNameA === normNameB) return true;

  const normShortA = normalizeClubName(teamA.shortName);
  const normShortB = normalizeClubName(teamB.shortName);
  if (normShortA && normShortB && normShortA === normShortB) return true;

  if (normNameA && normShortB && normNameA === normShortB) return true;
  if (normShortA && normNameB && normShortA === normNameB) return true;

  if (teamA.tla && teamB.tla && teamA.tla.length === 3 && teamA.tla === teamB.tla) return true;

  return false;
}

/**
 * Checks whether two fixture records represent the same real-world match.
 */
export function areFixturesEquivalent(a?: Fixture | null, b?: Fixture | null): boolean {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;

  // 1. Canonical Competition identity must match
  const compMetaA = getCanonicalCompetitionMeta(a.competition);
  const compMetaB = getCanonicalCompetitionMeta(b.competition);
  if (compMetaA.id !== compMetaB.id) return false;

  // 2. Kickoff timestamp proximity (within 6 hours on same day/window)
  if (a.utcKickoffTime && b.utcKickoffTime) {
    const timeA = new Date(a.utcKickoffTime).getTime();
    const timeB = new Date(b.utcKickoffTime).getTime();
    if (!isNaN(timeA) && !isNaN(timeB)) {
      const diffMs = Math.abs(timeA - timeB);
      if (diffMs > 6 * 3600 * 1000) return false;
    }
  }

  // 3. Home and away clubs must match in direction (never swapped)
  const homeMatches = areClubsEquivalent(a.homeTeam, b.homeTeam);
  const awayMatches = areClubsEquivalent(a.awayTeam, b.awayTeam);

  return homeMatches && awayMatches;
}

/**
 * Derives a reliable, provider-agnostic canonical match identity key.
 * Format: YYYY-MM-DD_CANONICALCOMP_HOMETEAM_vs_AWAYTEAM
 */
export function generateMatchIdentity(fixture: Fixture): string {
  if (!fixture) return '';

  let datePart = 'unknown-date';
  if (fixture.utcKickoffTime) {
    try {
      const d = new Date(fixture.utcKickoffTime);
      if (!isNaN(d.getTime())) {
        datePart = d.toISOString().split('T')[0];
      }
    } catch {
      datePart = 'unknown-date';
    }
  }

  const compMeta = getCanonicalCompetitionMeta(fixture.competition);
  const compCode = (compMeta.code || compMeta.id || 'COMP').toUpperCase();
  const homeKey = normalizeClubName(fixture.homeTeam?.name || fixture.homeTeam?.shortName);
  const awayKey = normalizeClubName(fixture.awayTeam?.name || fixture.awayTeam?.shortName);

  return `${datePart}_${compCode}_${homeKey}_vs_${awayKey}`;
}

/**
 * Chooses the more trustworthy score between two equivalent fixtures.
 *
 * Trust rules (in order):
 * 1. FINISHED records carry the final score and always win.
 * 2. A fresher (non-delayed) provider wins over a delayed one, even if its goal
 *    count is lower — a live score must never be replaced by a lagging score.
 * 3. Otherwise the higher goal count wins (a live score that has advanced).
 */
function choosePreferredScore(
  canonical: Fixture,
  incoming: Fixture,
  canonicalWeight: number,
  incomingWeight: number
): { score: MatchScore; fromIncoming: boolean } | null {
  const a = canonical.score;
  const b = incoming.score;
  if (!a && !b) return null;
  if (!a) return { score: { ...b! }, fromIncoming: true };
  if (!b) return { score: { ...a }, fromIncoming: false };

  const aFinal = canonical.status === 'FINISHED';
  const bFinal = incoming.status === 'FINISHED';
  if (bFinal && !aFinal) return { score: { ...b }, fromIncoming: true };
  if (aFinal && !bFinal) return { score: { ...a }, fromIncoming: false };

  const aGoals = (a.home ?? 0) + (a.away ?? 0);
  const bGoals = (b.home ?? 0) + (b.away ?? 0);

  let preferIncoming: boolean;
  if (bFinal && aFinal) {
    preferIncoming = bGoals > aGoals;
  } else if (incoming.isDelayed === false && canonical.isDelayed === true) {
    preferIncoming = true;
  } else if (incoming.isDelayed === true && canonical.isDelayed === false) {
    preferIncoming = false;
  } else {
    preferIncoming = bGoals > aGoals || (incomingWeight > canonicalWeight && (b.home != null || b.away != null));
  }

  return preferIncoming ? { score: { ...b }, fromIncoming: true } : { score: { ...a }, fromIncoming: false };
}

/**
 * Merges metadata between equivalent fixtures from multiple providers.
 * Retains the primary fixture's structural identity while adopting updated
 * live scores, minutes, match statuses, and enriching missing details.
 */
export function mergeFixtureMetadata(canonical: Fixture, incoming: Fixture): Fixture {
  const merged: Fixture = { ...canonical };

  // Status priority hierarchy: CANCELLED/POSTPONED/SUSPENDED > FINISHED > IN_PLAY/PAUSED > SCHEDULED/TIMED
  const getStatusWeight = (st?: string): number => {
    switch (st) {
      case 'CANCELLED':
      case 'POSTPONED':
      case 'SUSPENDED':
        return 5;
      case 'FINISHED':
        return 4;
      case 'IN_PLAY':
      case 'PAUSED':
      case 'LIVE':
        return 3;
      case 'SCHEDULED':
      case 'TIMED':
        return 1;
      default:
        return 0;
    }
  };

  const canonicalWeight = getStatusWeight(canonical.status);
  const incomingWeight = getStatusWeight(incoming.status);

  // Upgrade status when incoming is more advanced in lifecycle
  if (incomingWeight > canonicalWeight) {
    merged.status = incoming.status;
  }

  // Minute retention for live in-play matches
  if (incoming.minute && (merged.status === 'IN_PLAY' || merged.status === 'PAUSED')) {
    merged.minute = incoming.minute;
  }

  // Score resolution (see choosePreferredScore for the trust rules)
  const preferred = choosePreferredScore(canonical, incoming, canonicalWeight, incomingWeight);
  if (preferred) {
    const halftime = merged.score?.halftime ?? incoming.score?.halftime;
    merged.score = {
      home: preferred.score.home ?? null,
      away: preferred.score.away ?? null,
      halftime,
    };
    // Latency follows the provider that supplied the retained score, so a delayed
    // provider's score is never presented as real-time.
    merged.isDelayed = preferred.fromIncoming ? incoming.isDelayed : canonical.isDelayed;
  } else if (canonical.isDelayed === false || incoming.isDelayed === false) {
    // No score to mislabel; a real-time provider still supplies fresher live state.
    merged.isDelayed = false;
  }

  // Enrich non-conflicting metadata
  if (!merged.venue && incoming.venue) merged.venue = incoming.venue;
  if (!merged.referee && incoming.referee) merged.referee = incoming.referee;
  if (!merged.stage && incoming.stage) merged.stage = incoming.stage;
  if (!merged.matchday && incoming.matchday) merged.matchday = incoming.matchday;
  if (!merged.stats && incoming.stats) merged.stats = incoming.stats;
  if (!merged.homeForm && incoming.homeForm) merged.homeForm = incoming.homeForm;
  if (!merged.awayForm && incoming.awayForm) merged.awayForm = incoming.awayForm;
  if (!merged.h2h && incoming.h2h) merged.h2h = incoming.h2h;

  // Enrich crests
  if (merged.homeTeam && incoming.homeTeam && !merged.homeTeam.crest && incoming.homeTeam.crest) {
    merged.homeTeam = { ...merged.homeTeam, crest: incoming.homeTeam.crest };
  }
  if (merged.awayTeam && incoming.awayTeam && !merged.awayTeam.crest && incoming.awayTeam.crest) {
    merged.awayTeam = { ...merged.awayTeam, crest: incoming.awayTeam.crest };
  }

  // Provenance: prefer the fresher provider's notice when it supplied the retained data.
  if (preferred?.fromIncoming && incoming.providerNotice) {
    merged.providerNotice = incoming.providerNotice;
  }
  if (preferred?.fromIncoming && incoming.lastUpdated) {
    merged.lastUpdated = incoming.lastUpdated;
  }

  return merged;
}

/**
 * Deduplicates fixtures from multiple providers without dropping genuine matches.
 * Prioritizes the primary provider's record while retaining genuine kickoff instants,
 * updated live scores, competition details, and enriching missing metadata from secondary records.
 */
export function deduplicateFixtures(fixtures: Fixture[]): Fixture[] {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return [];
  }

  const seenMap = new Map<string, Fixture>();
  const canonicalList: Fixture[] = [];

  for (const f of fixtures) {
    if (!f || !f.id) continue;
    const identityKey = generateMatchIdentity(f);

    let existingCanonical: Fixture | undefined = seenMap.get(identityKey);

    // Equivalence fallback: check already recorded fixtures if exact key didn't hit
    if (!existingCanonical) {
      existingCanonical = canonicalList.find((c) => areFixturesEquivalent(c, f));
    }

    if (!existingCanonical) {
      seenMap.set(identityKey, f);
      canonicalList.push(f);
    } else {
      let canonical = existingCanonical;
      let incoming = f;

      // Prefer primary provider (fd- or non-sp-) as the base structural record
      const existingIsSecondary = String(canonical.id).startsWith('sp-');
      const incomingIsPrimary = !String(incoming.id).startsWith('sp-');

      if (existingIsSecondary && incomingIsPrimary) {
        const temp = canonical;
        canonical = incoming;
        incoming = temp;

        // Update reference in canonicalList
        const index = canonicalList.indexOf(existingCanonical);
        if (index !== -1) {
          canonicalList[index] = canonical;
        }
      }

      const merged = mergeFixtureMetadata(canonical, incoming);
      const mergedKey = generateMatchIdentity(merged);

      seenMap.set(mergedKey, merged);
      seenMap.set(identityKey, merged);

      const index = canonicalList.indexOf(canonical);
      if (index !== -1) {
        canonicalList[index] = merged;
      }
    }
  }

  // Sort chronologically by kickoff instant
  canonicalList.sort((a, b) => {
    const timeA = a.utcKickoffTime ? new Date(a.utcKickoffTime).getTime() : 0;
    const timeB = b.utcKickoffTime ? new Date(b.utcKickoffTime).getTime() : 0;
    return (isNaN(timeA) ? 0 : timeA) - (isNaN(timeB) ? 0 : timeB);
  });

  return canonicalList;
}
