/**
 * Project Touchline – Canonical Competition Grouping
 * Guarantees exactly one competition heading per competition across filtered results.
 * Groups fixtures into chronological kickoff order beneath their respective headings.
 */

import { Fixture } from '../types/football';
import { deduplicateFixtures } from './matchIdentity';

export interface CompetitionGroup {
  id: string; // canonical unique key
  name: string; // canonical display name
  code?: string;
  country?: string;
  emblem?: string;
  fixtures: Fixture[];
}

/**
 * Normalizes competition name for robust matching across providers and data variations.
 * Strips diacritics, punctuation, excess whitespace, and lowercases.
 */
export function normalizeCompetitionName(name?: string | null): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves a canonical competition key and display name.
 * Handles known provider codes, international variants, women's tournaments,
 * and fuzzy name variants (e.g. Lens/RC Lens, UEFA Champions League / Champions League).
 */
export function getCanonicalCompetitionMeta(competition?: Fixture['competition']): {
  id: string;
  name: string;
  code?: string;
  country?: string;
  emblem?: string;
} {
  const rawId = (competition?.id || '').trim();
  const rawCode = (competition?.code || '').trim().toUpperCase();
  const rawName = (competition?.name || '').trim();
  const normName = normalizeCompetitionName(rawName);

  // 1. Premier League
  if (
    rawCode === 'PL' ||
    rawId === 'PL' ||
    rawId === '2021' ||
    rawCode === 'SP-24' ||
    normName === 'premier league' ||
    normName === 'english premier league'
  ) {
    return {
      id: 'PL',
      code: 'PL',
      name: 'Premier League',
      country: competition?.country || 'England',
      emblem: competition?.emblem || 'https://crests.football-data.org/PL.png',
    };
  }

  // 2. UEFA Champions League
  if (
    rawCode === 'CL' ||
    rawId === 'CL' ||
    rawId === '2001' ||
    rawCode === 'SP-18' ||
    normName === 'uefa champions league' ||
    normName === 'champions league' ||
    normName === 'ucl'
  ) {
    return {
      id: 'CL',
      code: 'CL',
      name: 'UEFA Champions League',
      country: competition?.country || 'Europe',
      emblem: competition?.emblem || 'https://crests.football-data.org/CL.png',
    };
  }

  // 3. La Liga
  if (
    rawCode === 'PD' ||
    rawId === 'PD' ||
    rawId === '2014' ||
    rawCode === 'SP-1' ||
    normName === 'la liga' ||
    normName === 'la liga primera division' ||
    normName === 'primera division' ||
    normName === 'laliga'
  ) {
    return {
      id: 'PD',
      code: 'PD',
      name: 'La Liga (Primera División)',
      country: competition?.country || 'Spain',
      emblem: competition?.emblem || 'https://crests.football-data.org/laliga.png',
    };
  }

  // 4. Serie A
  if (
    rawCode === 'SA' ||
    rawId === 'SA' ||
    rawId === '2019' ||
    rawCode === 'SP-3' ||
    normName === 'serie a' ||
    normName === 'italian serie a'
  ) {
    return {
      id: 'SA',
      code: 'SA',
      name: 'Serie A',
      country: competition?.country || 'Italy',
      emblem: competition?.emblem || 'https://crests.football-data.org/SA.png',
    };
  }

  // 5. Bundesliga
  if (
    rawCode === 'BL1' ||
    rawId === 'BL1' ||
    rawId === '2002' ||
    rawCode === 'SP-2' ||
    normName === 'bundesliga' ||
    normName === 'german bundesliga'
  ) {
    return {
      id: 'BL1',
      code: 'BL1',
      name: 'Bundesliga',
      country: competition?.country || 'Germany',
      emblem: competition?.emblem || 'https://crests.football-data.org/BL1.png',
    };
  }

  // 6. Brazilian Serie A
  if (
    rawCode === 'BSA' ||
    rawId === 'BSA' ||
    rawId === '2013' ||
    rawCode === 'SP-36' ||
    normName.includes('brasileiro') ||
    normName === 'brazilian serie a'
  ) {
    return {
      id: 'BSA',
      code: 'BSA',
      name: 'Campeonato Brasileiro Série A',
      country: competition?.country || 'Brazil',
      emblem: competition?.emblem,
    };
  }

  // 7. Internationals Women
  if (
    rawCode === 'SP-93' ||
    rawId === 'SP-93' ||
    rawId === '93' ||
    rawCode === 'INT_W' ||
    rawId === 'INT_W' ||
    normName === 'internationals women' ||
    normName === 'international women' ||
    normName === 'women international' ||
    normName === 'womens internationals' ||
    normName === 'womens international friendlies' ||
    normName === 'women international friendlies' ||
    (normName.includes('international') && normName.includes('women'))
  ) {
    return {
      id: 'SP-93',
      code: 'SP-93',
      name: 'Internationals Women',
      country: competition?.country || 'World',
      emblem: competition?.emblem,
    };
  }

  // 8. Women's European World Cup Qualifiers
  if (
    rawCode === 'SP-125' ||
    rawId === 'SP-125' ||
    rawId === '125' ||
    rawCode === 'WEWCQ' ||
    rawId === 'WEWCQ' ||
    normName === 'women s european world cup qualifiers' ||
    normName === 'womens european world cup qualifiers' ||
    normName === 'womens world cup qualifiers europe' ||
    normName === 'women world cup qualifiers europe'
  ) {
    return {
      id: 'SP-125',
      code: 'SP-125',
      name: "Women's European World Cup Qualifiers",
      country: competition?.country || 'Europe',
      emblem: competition?.emblem,
    };
  }

  // Generic canonical resolution:
  // If normalized name is available, group by normName so that minor differences or missing IDs don't duplicate
  const canonicalId = normName || (rawCode && rawCode !== 'COMP' ? rawCode : rawId) || 'tournament';
  const displayName = rawName || rawCode || rawId || 'Tournament';

  return {
    id: canonicalId,
    code: rawCode || undefined,
    name: displayName,
    country: competition?.country,
    emblem: competition?.emblem,
  };
}

/**
 * Groups an array of fixtures by canonical competition.
 * Guarantees:
 * 1. Exactly one group (and one heading) per competition.
 * 2. All matching fixture cards are placed in that group.
 * 3. Fixtures within each group are ordered strictly chronologically by kickoff time.
 * 4. Preserves all fixture data, live scores, crests, and statuses.
 */
export function groupFixturesByCompetition(fixtures: Fixture[]): CompetitionGroup[] {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return [];
  }

  const dedupedFixtures = deduplicateFixtures(fixtures);
  const groupMap = new Map<string, CompetitionGroup>();

  for (const fixture of dedupedFixtures) {
    if (!fixture) continue;
    const meta = getCanonicalCompetitionMeta(fixture.competition);
    let group = groupMap.get(meta.id);

    if (!group) {
      group = {
        id: meta.id,
        name: meta.name,
        code: meta.code,
        country: meta.country,
        emblem: meta.emblem,
        fixtures: [],
      };
      groupMap.set(meta.id, group);
    }

    group.fixtures.push(fixture);
  }

  const groups = Array.from(groupMap.values());

  // 1. Sort fixtures chronologically within each competition group
  for (const group of groups) {
    group.fixtures.sort((a, b) => {
      const timeA = a.utcKickoffTime ? new Date(a.utcKickoffTime).getTime() : 0;
      const timeB = b.utcKickoffTime ? new Date(b.utcKickoffTime).getTime() : 0;
      const safeA = isNaN(timeA) ? 0 : timeA;
      const safeB = isNaN(timeB) ? 0 : timeB;
      return safeA - safeB;
    });
  }

  // 2. Sort groups stably (by earliest kickoff time of fixtures in the group)
  groups.sort((a, b) => {
    const earliestA =
      a.fixtures.length > 0 && a.fixtures[0].utcKickoffTime
        ? new Date(a.fixtures[0].utcKickoffTime).getTime()
        : Infinity;
    const earliestB =
      b.fixtures.length > 0 && b.fixtures[0].utcKickoffTime
        ? new Date(b.fixtures[0].utcKickoffTime).getTime()
        : Infinity;
    const safeA = isNaN(earliestA) ? Infinity : earliestA;
    const safeB = isNaN(earliestB) ? Infinity : earliestB;

    if (safeA !== safeB) {
      return safeA - safeB;
    }
    return a.name.localeCompare(b.name);
  });

  return groups;
}
