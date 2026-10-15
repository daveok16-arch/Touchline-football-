/**
 * Project Touchline – Competition Catalogue Builder
 *
 * Derives the set of competitions the application can genuinely serve from
 * *verified* sources only:
 *   1. the canonical registry (built from provider data actually observed), and
 *   2. competitions observed in live provider fixtures.
 *
 * Overlapping competitions (supplied by both football-data.org and SportAPI.ai)
 * collapse to a single canonical entry. Competitions that appear in provider data
 * but are not yet in the registry are admitted with the provider's own metadata —
 * never invented.
 */

import { Competition, Fixture } from '../types/football';
import {
  COMPETITION_REGISTRY,
  CompetitionRegistryEntry,
  ORIGINAL_CORE_COMPETITION_IDS,
  getRegistryEntryByFdCode,
  getRegistryEntryById,
  getRegistryEntryByName,
  getRegistryEntryBySportApiId,
} from './competitionRegistry';

const CATALOGUE_SEASON = '2026/27';

/** Converts a registry entry into the app's Competition contract. */
export function registryEntryToCompetition(entry: CompetitionRegistryEntry): Competition {
  return {
    id: entry.id,
    name: entry.name,
    code: entry.id,
    type: entry.type,
    country: entry.country,
    season: CATALOGUE_SEASON,
    emblem: entry.emblem,
    isDemo: false,
    isSupported: true,
  };
}

function parseSportApiId(value?: string | null): number | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const spMatch = trimmed.match(/^SP-(\d+)$/i);
  if (spMatch) return Number(spMatch[1]);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return undefined;
}

/** Resolves the canonical registry entry for a provider-supplied competition, if known. */
export function resolveRegistryEntry(competition?: Competition | null): CompetitionRegistryEntry | undefined {
  if (!competition) return undefined;
  const rawId = (competition.id || '').trim();
  const rawCode = (competition.code || '').trim();

  return (
    getRegistryEntryByFdCode(rawCode) ||
    getRegistryEntryByFdCode(rawId) ||
    getRegistryEntryBySportApiId(parseSportApiId(rawId)) ||
    getRegistryEntryBySportApiId(parseSportApiId(rawCode)) ||
    getRegistryEntryById(rawId) ||
    getRegistryEntryById(rawCode) ||
    getRegistryEntryByName(competition.name)
  );
}

/**
 * Produces a canonical Competition for a provider-supplied competition.
 * Known competitions map to their registry identity; unknown ones keep the
 * provider's own metadata (no fabrication).
 */
export function canonicalizeCompetition(competition?: Competition | null): Competition | null {
  if (!competition) return null;
  const entry = resolveRegistryEntry(competition);
  if (entry) return registryEntryToCompetition(entry);

  const fallbackId = (competition.id || competition.code || '').trim();
  if (!fallbackId) return null;
  return {
    ...competition,
    id: fallbackId,
    code: competition.code || fallbackId,
    country: competition.country || 'International',
    isDemo: false,
    isSupported: competition.isSupported !== false,
  };
}

const CORE_ORDER = new Map<string, number>(ORIGINAL_CORE_COMPETITION_IDS.map((id, i) => [id, i]));

function sortCatalogue(list: Competition[]): Competition[] {
  return [...list].sort((a, b) => {
    const ca = CORE_ORDER.get(a.id);
    const cb = CORE_ORDER.get(b.id);
    if (ca !== undefined || cb !== undefined) {
      return (ca ?? Number.MAX_SAFE_INTEGER) - (cb ?? Number.MAX_SAFE_INTEGER);
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Builds the unique competition catalogue.
 * @param observedFixtures Fixtures already returned by the providers (optional). Any
 *   competition found here that is missing from the registry is added safely.
 */
export function buildCompetitionCatalogue(observedFixtures: Fixture[] = []): Competition[] {
  const byId = new Map<string, Competition>();

  for (const entry of COMPETITION_REGISTRY) {
    byId.set(entry.id, registryEntryToCompetition(entry));
  }

  for (const fixture of observedFixtures) {
    if (!fixture?.competition) continue;
    const canonical = canonicalizeCompetition(fixture.competition);
    if (canonical && !byId.has(canonical.id)) {
      byId.set(canonical.id, canonical);
    }
  }

  return sortCatalogue(Array.from(byId.values()));
}

/**
 * Extracts the unique competitions present in a set of fixtures, canonicalized and
 * deduplicated (both providers collapse to one entry).
 */
export function competitionsFromFixtures(fixtures: Fixture[] = []): Competition[] {
  const byId = new Map<string, Competition>();
  for (const fixture of fixtures) {
    if (!fixture?.competition) continue;
    const canonical = canonicalizeCompetition(fixture.competition);
    if (canonical) byId.set(canonical.id, canonical);
  }
  return sortCatalogue(Array.from(byId.values()));
}
