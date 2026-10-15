import { Competition, CompetitionStandings, Fixture } from '../types/football';
import { ProviderStatus } from '../types/footballData';
import { getDateKeyInTimezone } from '../utils/timezone';
import { deduplicateFixtures } from '../utils/matchIdentity';
import { buildCompetitionCatalogue, canonicalizeCompetition } from './competitionCatalogue';
import { getRegistryEntryById } from './competitionRegistry';

export interface FixtureFilterOptions {
  dateKey?: string; // YYYY-MM-DD or 'ALL'
  competitionId?: string;
  status?: 'ALL' | 'LIVE' | 'SCHEDULED' | 'FINISHED';
  searchQuery?: string;
  timezoneId?: string;
}

export class FixtureService {
  /**
   * Fetches provider status from the backend proxy.
   */
  static async getProviderStatus(): Promise<ProviderStatus> {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) {
        throw new Error(`Status check failed: HTTP ${res.status}`);
      }
      return await res.json();
    } catch {
      return {
        configured: false,
        provider: 'football-data.org',
        tier: 'free',
        rateLimitPerMinute: 10,
        latencyNotice: 'Delayed scores (free tier latency: up to 15 min).',
        supportedCompetitions: [
          { code: 'PL', id: 2021, name: 'Premier League', country: 'England' },
          { code: 'CL', id: 2001, name: 'UEFA Champions League', country: 'Europe' },
          { code: 'PD', id: 2014, name: 'La Liga (Primera División)', country: 'Spain' },
          { code: 'SA', id: 2019, name: 'Serie A', country: 'Italy' },
        ],
        unsupportedCompetitions: [
          {
            code: 'CAF',
            name: 'CAF Champions League',
            reason: 'Not covered by football-data.org free tier API.',
          },
        ],
      };
    }
  }

  /**
   * Fetches real fixtures from backend proxy and applies client filters.
   */
  static async getFixtures(filters: FixtureFilterOptions = {}): Promise<Fixture[]> {
    const { fixtures } = await FixtureService.getFixturesWithMeta(filters);
    return fixtures;
  }

  /**
   * Same as getFixtures, but also returns the provider degradation notice (if any)
   * so views can surface stale/unavailable data subtly without a disruptive banner.
   */
  static async getFixturesWithMeta(
    filters: FixtureFilterOptions = {}
  ): Promise<{ fixtures: Fixture[]; degraded: boolean; notice: string | null }> {
    const tzId = filters.timezoneId || 'Africa/Lagos';

    // Build URL query params for server proxy
    const queryParams = new URLSearchParams();
    if (filters.competitionId && filters.competitionId !== 'ALL') {
      queryParams.append('competition', filters.competitionId);
    }

    let rawMatches: Fixture[] = [];
    let degraded = false;
    let notice: string | null = null;
    try {
      const res = await fetch(`/api/fixtures?${queryParams.toString()}`);
      if (res.status === 503) {
        const err: any = new Error('Football data is not connected yet.');
        err.code = 'PROVIDER_NOT_CONFIGURED';
        throw err;
      }
      if (res.status === 429) {
        const err: any = new Error('Football data is temporarily unavailable. Try again.');
        err.code = 'RATE_LIMITED';
        throw err;
      }
      if (!res.ok) {
        const err: any = new Error('Football data is temporarily unavailable. Try again.');
        err.code = 'PROVIDER_ERROR';
        throw err;
      }
      const data = await res.json();
      rawMatches = Array.isArray(data.matches) ? data.matches : [];
      degraded = Boolean(data.degraded);
      notice = typeof data.notice === 'string' ? data.notice : null;
    } catch (err: any) {
      if (err?.code === 'PROVIDER_NOT_CONFIGURED' || err?.code === 'RATE_LIMITED') {
        throw err;
      }
      const genericErr: any = new Error('Football data is temporarily unavailable. Try again.');
      genericErr.code = 'PROVIDER_ERROR';
      throw genericErr;
    }

    // Canonicalize each fixture's competition so both providers collapse to one identity.
    let results = rawMatches.map((fixture) => {
      const canonical = canonicalizeCompetition(fixture.competition);
      return canonical ? { ...fixture, competition: canonical } : fixture;
    });

    // Filter by Date in selected timezone
    if (filters.dateKey && filters.dateKey !== 'ALL') {
      results = results.filter((f) => {
        if (!f?.utcKickoffTime) return false;
        const fixtureDateKey = getDateKeyInTimezone(f.utcKickoffTime, tzId);
        return fixtureDateKey === filters.dateKey;
      });
    }

    // Filter by Competition (if not already handled or for local refinement)
    if (filters.competitionId && filters.competitionId !== 'ALL') {
      results = results.filter(
        (f) =>
          f?.competition?.id === filters.competitionId ||
          f?.competition?.code === filters.competitionId
      );
    }

    // Filter by Match Status (strictly based on fixture.status, NEVER inferred from score)
    if (filters.status && filters.status !== 'ALL') {
      if (filters.status === 'LIVE') {
        results = results.filter((f) => f.status === 'IN_PLAY' || f.status === 'PAUSED');
      } else if (filters.status === 'SCHEDULED') {
        results = results.filter((f) => f.status === 'SCHEDULED' || f.status === 'TIMED');
      } else if (filters.status === 'FINISHED') {
        results = results.filter((f) => f.status === 'FINISHED');
      }
    }

    // Filter by Search Query
    if (filters.searchQuery && filters.searchQuery.trim().length > 0) {
      const q = filters.searchQuery.toLowerCase().trim();
      results = results.filter((f) => {
        const homeName = f.homeTeam?.name?.toLowerCase() || '';
        const homeShort = f.homeTeam?.shortName?.toLowerCase() || '';
        const homeTla = f.homeTeam?.tla?.toLowerCase() || '';
        const awayName = f.awayTeam?.name?.toLowerCase() || '';
        const awayShort = f.awayTeam?.shortName?.toLowerCase() || '';
        const awayTla = f.awayTeam?.tla?.toLowerCase() || '';
        const compName = f.competition?.name?.toLowerCase() || '';
        const venueName = f.venue?.name?.toLowerCase() || '';
        return (
          homeName.includes(q) ||
          homeShort.includes(q) ||
          homeTla.includes(q) ||
          awayName.includes(q) ||
          awayShort.includes(q) ||
          awayTla.includes(q) ||
          compName.includes(q) ||
          venueName.includes(q)
        );
      });
    }

    // Deduplicate equivalent matches across providers to ensure zero duplicate cards
    results = deduplicateFixtures(results);

    // Sort chronologically by kickoff time
    results.sort((a, b) => {
      const timeA = a.utcKickoffTime ? new Date(a.utcKickoffTime).getTime() : 0;
      const timeB = b.utcKickoffTime ? new Date(b.utcKickoffTime).getTime() : 0;
      const safeA = isNaN(timeA) ? 0 : timeA;
      const safeB = isNaN(timeB) ? 0 : timeB;
      return safeA - safeB;
    });

    return { fixtures: results, degraded, notice };
  }

  /**
   * Fetches single fixture by ID from backend proxy.
   */
  static async getFixtureById(id: string): Promise<Fixture | null> {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return null;
    }
    const cleanId = id.trim().replace(/^fd-/, '');

    try {
      const res = await fetch(`/api/matches/${cleanId}`);
      if (res.status === 404) {
        return null;
      }
      if (res.status === 503) {
        const err: any = new Error('Football data is not connected yet.');
        err.code = 'PROVIDER_NOT_CONFIGURED';
        throw err;
      }
      if (res.status === 429) {
        const err: any = new Error('Football data is temporarily unavailable. Try again.');
        err.code = 'RATE_LIMITED';
        throw err;
      }
      if (!res.ok) {
        const err: any = new Error('Football data is temporarily unavailable. Try again.');
        err.code = 'PROVIDER_ERROR';
        throw err;
      }
      const data = await res.json();
      return data.match || null;
    } catch (err: any) {
      if (err?.code === 'PROVIDER_NOT_CONFIGURED' || err?.code === 'RATE_LIMITED') {
        throw err;
      }
      const genericErr: any = new Error('Football data is temporarily unavailable. Try again.');
      genericErr.code = 'PROVIDER_ERROR';
      throw genericErr;
    }
  }

  /**
   * Returns the derived competition catalogue: every competition genuinely available
   * from the integrated providers, canonicalized and deduplicated. Fetches current
   * fixtures to admit any newly discovered competition safely (no invented metadata).
   */
  static async getCompetitions(): Promise<Competition[]> {
    let observedFixtures: Fixture[] = [];
    try {
      observedFixtures = await FixtureService.getFixtures({});
    } catch {
      // Catalogue still derives from the verified registry when fixtures are unavailable.
      observedFixtures = [];
    }
    return buildCompetitionCatalogue(observedFixtures);
  }

  /**
   * Returns the verified registry competitions only (no live fixture fetch).
   * Used by the standings selector, which is limited to competitions with a working
   * standings implementation.
   */
  static getStandingsSupportedCompetitions(): Competition[] {
    return buildCompetitionCatalogue([]).filter((c) => getRegistryEntryById(c.id)?.standings === true);
  }

  /**
   * Fetches real league standings table for a supported competition.
   */
  static async getStandings(competitionCode: string = 'PL'): Promise<CompetitionStandings | null> {
    try {
      const res = await fetch(`/api/standings?competition=${encodeURIComponent(competitionCode)}`);
      if (res.status === 503) {
        const err: any = new Error('Football data is not connected yet.');
        err.code = 'PROVIDER_NOT_CONFIGURED';
        throw err;
      }
      if (res.status === 429) {
        const err: any = new Error('Football data is temporarily unavailable. Try again.');
        err.code = 'RATE_LIMITED';
        throw err;
      }
      if (!res.ok) {
        const err: any = new Error('Football data is temporarily unavailable. Try again.');
        err.code = 'PROVIDER_ERROR';
        throw err;
      }
      const data = await res.json();
      return data.standings || null;
    } catch (err: any) {
      if (err?.code === 'PROVIDER_NOT_CONFIGURED' || err?.code === 'RATE_LIMITED') {
        throw err;
      }
      const genericErr: any = new Error('Football data is temporarily unavailable. Try again.');
      genericErr.code = 'PROVIDER_ERROR';
      throw genericErr;
    }
  }

  /**
   * Fetches standings for all verified supported competitions (PL, CL, PD, SA).
   */
  static async getAllSupportedStandings(): Promise<Record<string, CompetitionStandings | null>> {
    const codes = ['PL', 'CL', 'PD', 'SA'];
    const results: Record<string, CompetitionStandings | null> = {
      PL: null,
      CL: null,
      PD: null,
      SA: null,
    };
    const promises = codes.map(async (code) => {
      try {
        const standings = await FixtureService.getStandings(code);
        results[code] = standings;
      } catch {
        results[code] = null;
      }
    });
    await Promise.all(promises);
    return results;
  }
}
