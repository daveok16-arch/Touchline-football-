import { describe, it, expect, vi, afterEach } from 'vitest';
import { Fixture } from '../src/types/football';
import {
  COMPETITION_REGISTRY,
  ORIGINAL_CORE_COMPETITION_IDS,
  STANDINGS_SUPPORTED_IDS,
  getRegistryEntryById,
  getRegistryEntryByFdCode,
  getRegistryEntryBySportApiId,
  normalizeCompetitionKey,
} from '../src/services/competitionRegistry';
import {
  buildCompetitionCatalogue,
  canonicalizeCompetition,
  competitionsFromFixtures,
} from '../src/services/competitionCatalogue';
import { buildProviderStatus } from '../src/services/providerStatus';
import { FixtureService } from '../src/services/fixtureService';

const baseFixture = (overrides: Partial<Fixture>): Fixture => ({
  id: 'x-1',
  utcKickoffTime: '2030-01-01T19:00:00Z',
  status: 'SCHEDULED',
  competition: {
    id: 'PL',
    name: 'Premier League',
    code: 'PL',
    type: 'LEAGUE',
    country: 'England',
    season: '2026/27',
  },
  homeTeam: { id: 'h', name: 'Home', shortName: 'Home', tla: 'HOM' },
  awayTeam: { id: 'a', name: 'Away', shortName: 'Away', tla: 'AWY' },
  ...overrides,
});

describe('Phase 1B – Competition catalogue reconciliation', () => {
  describe('Registry integrity', () => {
    it('has stable unique canonical ids and no duplicate SportAPI league ids', () => {
      const ids = COMPETITION_REGISTRY.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);

      const sportApiIds = COMPETITION_REGISTRY.filter((c) => c.sportApiId !== undefined).map((c) => c.sportApiId);
      expect(new Set(sportApiIds).size).toBe(sportApiIds.length);
    });

    it('preserves the four core competitions and reports them once', () => {
      for (const id of ORIGINAL_CORE_COMPETITION_IDS) {
        expect(getRegistryEntryById(id)).toBeTruthy();
      }
      const catalogue = buildCompetitionCatalogue([]);
      const core = catalogue.filter((c) => (ORIGINAL_CORE_COMPETITION_IDS as readonly string[]).includes(c.id));
      expect(core.map((c) => c.id).sort()).toEqual([...ORIGINAL_CORE_COMPETITION_IDS].sort());
    });

    it('represents overlapping competitions (both providers) exactly once', () => {
      const overlap = COMPETITION_REGISTRY.filter((c) => c.fdCode && c.sportApiId !== undefined);
      // Only the core four are supplied by both providers.
      expect(overlap.map((c) => c.id).sort()).toEqual([...ORIGINAL_CORE_COMPETITION_IDS].sort());
      // And each overlap row appears a single time in the catalogue.
      const catalogue = buildCompetitionCatalogue([]);
      for (const entry of overlap) {
        expect(catalogue.filter((c) => c.id === entry.id)).toHaveLength(1);
      }
    });

    it('resolves provider codes to the same canonical identity (not display name alone)', () => {
      // football-data.org "PD" and SportAPI.ai "Spanish La Liga" (id 1) must be the same competition.
      const fd = getRegistryEntryByFdCode('PD');
      const sp = getRegistryEntryBySportApiId(1);
      expect(fd?.id).toBe('PD');
      expect(sp?.id).toBe('PD');

      const fdFixture = baseFixture({
        id: 'fd-1',
        competition: { id: 'PD', name: 'Primera Division', code: 'PD', type: 'LEAGUE', country: 'Spain', season: '2026/27' },
      });
      const spFixture = baseFixture({
        id: 'sp-1',
        competition: { id: 'SP-1', name: 'Spanish La Liga', code: 'SP-1', type: 'LEAGUE', country: 'Spain', season: '2026/27' },
      });
      expect(canonicalizeCompetition(fdFixture.competition)?.id).toBe('PD');
      expect(canonicalizeCompetition(spFixture.competition)?.id).toBe('PD');
    });

    it('normalizes known provider name variants to one canonical key', () => {
      expect(normalizeCompetitionKey('Spanish La Liga')).toBe(normalizeCompetitionKey('La Liga (Primera División)'));
      expect(normalizeCompetitionKey('Champions League')).toBe(normalizeCompetitionKey('UEFA Champions League'));
      expect(normalizeCompetitionKey('German Bundesliga')).toBe(normalizeCompetitionKey('German Bundesliga'));
    });
  });

  describe('Deduplication and safe discovery', () => {
    it('produces a unique catalogue with no duplicate ids', () => {
      const catalogue = buildCompetitionCatalogue([]);
      const ids = catalogue.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(catalogue.length).toBe(COMPETITION_REGISTRY.length);
    });

    it('collapses both providers of the same competition into one catalogue entry', () => {
      const fixtures = [
        baseFixture({
          id: 'fd-10',
          competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        }),
        baseFixture({
          id: 'sp-10',
          competition: { id: 'SP-18', name: 'UEFA Champions League', code: 'SP-18', type: 'CUP', country: 'Europe', season: '2026/27' },
        }),
      ];
      const competitions = competitionsFromFixtures(fixtures);
      expect(competitions).toHaveLength(1);
      expect(competitions[0].id).toBe('CL');
    });

    it('admits a newly discovered competition without inventing metadata', () => {
      const unknown = baseFixture({
        id: 'sp-new',
        competition: { id: 'SP-999999', name: 'Newly Seen League', code: 'SP-999999', type: 'LEAGUE', country: 'Nowhere', season: '2026/27' },
      });
      const catalogue = buildCompetitionCatalogue([unknown]);
      const found = catalogue.find((c) => c.id === 'SP-999999');
      expect(found).toBeTruthy();
      // Metadata comes from the provider payload, not invented.
      expect(found?.name).toBe('Newly Seen League');
      expect(found?.country).toBe('Nowhere');
    });

    it('derives the count from verified data rather than a hardcoded total', () => {
      const baseline = buildCompetitionCatalogue([]).length;
      const withExtra = buildCompetitionCatalogue([
        baseFixture({
          id: 'sp-extra',
          competition: { id: 'SP-424242', name: 'Extra League', code: 'SP-424242', type: 'LEAGUE', country: 'Extra', season: '2026/27' },
        }),
      ]).length;
      expect(withExtra).toBe(baseline + 1);
    });
  });

  describe('UI / filter consistency', () => {
    it('exposes a filter entry for every competition present in fixtures', () => {
      const fixtures = [
        baseFixture({
          id: 'sp-53',
          competition: { id: 'SP-53', name: 'Championship', code: 'SP-53', type: 'LEAGUE', country: 'England', season: '2026/27' },
        }),
        baseFixture({
          id: 'sp-93',
          competition: { id: 'SP-93', name: 'Internationals Women', code: 'SP-93', type: 'LEAGUE', country: 'World', season: '2026/27' },
        }),
      ];
      const catalogue = buildCompetitionCatalogue(fixtures);
      const ids = new Set(catalogue.map((c) => c.id));
      for (const f of fixtures) {
        expect(ids.has(canonicalizeCompetition(f.competition)!.id)).toBe(true);
      }
    });

    it('limits the standings selector to competitions with a working implementation', () => {
      const standingsCompetitions = FixtureService.getStandingsSupportedCompetitions();
      expect(standingsCompetitions.map((c) => c.id).sort()).toEqual([...STANDINGS_SUPPORTED_IDS].sort());
      // Every standings competition must also be in the full catalogue.
      const catalogueIds = new Set(buildCompetitionCatalogue([]).map((c) => c.id));
      for (const c of standingsCompetitions) {
        expect(catalogueIds.has(c.id)).toBe(true);
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the derived catalogue from FixtureService.getCompetitions', async () => {
      vi.spyOn(FixtureService, 'getFixtures').mockResolvedValue([
        baseFixture({
          id: 'sp-53',
          competition: { id: 'SP-53', name: 'Championship', code: 'SP-53', type: 'LEAGUE', country: 'England', season: '2026/27' },
        }),
      ]);
      const comps = await FixtureService.getCompetitions();
      expect(comps.length).toBeGreaterThanOrEqual(COMPETITION_REGISTRY.length);
      expect(new Set(comps.map((c) => c.id)).size).toBe(comps.length);
    });
  });

  describe('Truthful provider status', () => {
    const status = buildProviderStatus({
      footballDataConfigured: true,
      sportApiConfigured: true,
      fiveDollarConfigured: true,
      oddsApiTokenConfigured: true,
      oddsApiEnabled: false,
      rateLimitPerMinute: 10,
      requestsUsedInLastMinute: 0,
    });

    const provider = (id: string) => status.providers.find((p) => p.id === id)!;

    it('reports the verified unique catalogue count, not advertised coverage', () => {
      expect(status.competitionCatalogue.uniqueCompetitions).toBe(COMPETITION_REGISTRY.length);
      expect(status.competitionCatalogue.standingsSupported).toBe(STANDINGS_SUPPORTED_IDS.length);
    });

    it('does not claim standings support where no working implementation exists', () => {
      expect(provider('football-data.org').capabilities.standingsSupport).toBe(true);
      expect(provider('sportapi.ai').capabilities.standingsSupport).toBe(false);
      expect(provider('5dollarfootballapi').capabilities.standingsSupport).toBe(false);
      expect(provider('the-odds-api').capabilities.standingsSupport).toBe(false);
    });

    it('distinguishes availability, coverage, fixtures, standings and live scores', () => {
      const fd = provider('football-data.org');
      expect(fd.capabilities.availability).toBe('active');
      expect(fd.capabilities.competitionCatalogueCoverage).toBe(4);
      expect(fd.capabilities.competitionCatalogueIds.sort()).toEqual([...ORIGINAL_CORE_COMPETITION_IDS].sort());
      expect(fd.capabilities.fixtureAvailability).toBe('verified');
      // football-data.org free tier is delayed, never claimed as live.
      expect(fd.capabilities.liveScoreSupport).toBe('delayed');

      const sp = provider('sportapi.ai');
      expect(sp.capabilities.competitionCatalogueCoverage).toBe(
        COMPETITION_REGISTRY.filter((c) => c.sportApiId !== undefined).length
      );
      expect(sp.capabilities.liveScoreSupport).toBe('live');
    });

    it('never claims fixture/standings/live coverage for odds-only providers', () => {
      for (const id of ['5dollarfootballapi', 'the-odds-api']) {
        const p = provider(id);
        expect(p.capabilities.competitionCatalogueCoverage).toBe(0);
        expect(p.capabilities.fixtureAvailability).toBe('none');
        expect(p.capabilities.standingsSupport).toBe(false);
        expect(p.capabilities.liveScoreSupport).toBe('none');
      }
    });

    it('keeps The Odds API disabled and reports the 5Dollar upstream error honestly', () => {
      expect(provider('the-odds-api').status).toBe('disabled');
      expect(provider('the-odds-api').capabilities.availability).toBe('disabled');
      expect(provider('5dollarfootballapi').status).toBe('error');
      expect(provider('5dollarfootballapi').capabilities.availability).toBe('error');
    });

    it('marks providers unconfigured (coverage 0) when keys are absent', () => {
      const unconfigured = buildProviderStatus({
        footballDataConfigured: false,
        sportApiConfigured: false,
        fiveDollarConfigured: false,
        oddsApiTokenConfigured: false,
        oddsApiEnabled: false,
        rateLimitPerMinute: 10,
        requestsUsedInLastMinute: 0,
      });
      for (const id of ['football-data.org', 'sportapi.ai']) {
        const p = unconfigured.providers.find((x) => x.id === id)!;
        expect(p.status).toBe('unconfigured');
        expect(p.capabilities.competitionCatalogueCoverage).toBe(0);
        expect(p.capabilities.fixtureAvailability).toBe('unavailable');
      }
    });
  });
});
