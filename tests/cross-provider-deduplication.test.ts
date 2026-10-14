import { describe, it, expect } from 'vitest';
import { generateMatchIdentity, deduplicateFixtures, normalizeClubName, areFixturesEquivalent } from '../src/utils/matchIdentity';
import { Fixture } from '../src/types/football';
import { formatKickoffTime } from '../src/utils/timezone';

describe('Cross-Provider Match Identity & Deduplication', () => {
  it('normalizes club names across common prefixes, suffixes, diacritics, and team variants', () => {
    // Basic prefixes and suffixes
    expect(normalizeClubName('Arsenal FC')).toBe('arsenal');
    expect(normalizeClubName('Arsenal')).toBe('arsenal');
    expect(normalizeClubName('Lille OSC')).toBe('lille');
    expect(normalizeClubName('Galatasaray SK')).toBe('galatasaray');

    // Lens / RC Lens / Racing Club de Lens
    expect(normalizeClubName('Lens')).toBe('lens');
    expect(normalizeClubName('RC Lens')).toBe('lens');
    expect(normalizeClubName('Racing Club de Lens')).toBe('lens');

    // Inter / Inter Milan / FC Internazionale Milano
    expect(normalizeClubName('Inter')).toBe('intermilan');
    expect(normalizeClubName('Inter Milan')).toBe('intermilan');
    expect(normalizeClubName('FC Internazionale Milano')).toBe('intermilan');

    // Slavia Praha / SK Slavia Praha / Slavia Prague
    expect(normalizeClubName('Slavia Praha')).toBe('slaviaprague');
    expect(normalizeClubName('SK Slavia Praha')).toBe('slaviaprague');
    expect(normalizeClubName('Slavia Prague')).toBe('slaviaprague');

    // Sporting CP / Sporting Clube de Portugal
    expect(normalizeClubName('Sporting CP')).toBe('sporting');
    expect(normalizeClubName('Sporting Clube de Portugal')).toBe('sporting');

    // Club Atlético de Madrid / Atletico Madrid
    expect(normalizeClubName('Club Atlético de Madrid')).toBe('atleticomadrid');
    expect(normalizeClubName('Atletico Madrid')).toBe('atleticomadrid');

    // FC Bayern München / Bayern Munich
    expect(normalizeClubName('FC Bayern München')).toBe('bayernmunich');
    expect(normalizeClubName('Bayern Munich')).toBe('bayernmunich');

    // Red Bull / RB
    expect(normalizeClubName('Red Bull Bragantino')).toBe('bragantino');
    expect(normalizeClubName('RB Bragantino')).toBe('bragantino');
    expect(normalizeClubName('Cruzeiro EC')).toBe('cruzeiro');
    expect(normalizeClubName('Cruzeiro')).toBe('cruzeiro');
  });

  it('generates consistent match identity across disparate provider fixtures for the same game', () => {
    const fixtureProviderA: Fixture = {
      id: 'fd-575346',
      utcKickoffTime: '2026-10-13T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: '521', name: 'Lille OSC', shortName: 'Lille', tla: 'LIL' },
    };

    const fixtureProviderB: Fixture = {
      id: 'sp-998877',
      utcKickoffTime: '2026-10-13T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '10', name: 'Arsenal', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: '25', name: 'Lille', shortName: 'Lille', tla: 'LIL' },
    };

    const idA = generateMatchIdentity(fixtureProviderA);
    const idB = generateMatchIdentity(fixtureProviderB);

    expect(idA).toBe('2026-10-13_CL_arsenal_vs_lille');
    expect(idB).toBe('2026-10-13_CL_arsenal_vs_lille');
    expect(idA).toBe(idB);
  });

  it('deduplicates duplicate records while preserving primary fixture identity and kickoff time', () => {
    const fixtureFromFd: Fixture = {
      id: 'fd-575346',
      utcKickoffTime: '2026-10-13T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '57', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: '521', name: 'Lille OSC', shortName: 'Lille', tla: 'LIL' },
    };

    const duplicateFromSportApi: Fixture = {
      id: 'sp-998877',
      utcKickoffTime: '2026-10-13T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '10', name: 'Arsenal', shortName: 'Arsenal', tla: 'ARS' },
      awayTeam: { id: '25', name: 'Lille', shortName: 'Lille', tla: 'LIL' },
      venue: { name: 'Emirates Stadium', city: 'London' },
    };

    const distinctFixture: Fixture = {
      id: 'fd-575343',
      utcKickoffTime: '2026-10-13T19:00:00Z',
      status: 'SCHEDULED',
      competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
      homeTeam: { id: '108', name: 'FC Internazionale Milano', shortName: 'Inter', tla: 'INT' },
      awayTeam: { id: '851', name: 'Club Brugge KV', shortName: 'Club Brugge', tla: 'BRU' },
    };

    const pooled = [fixtureFromFd, duplicateFromSportApi, distinctFixture];
    const deduplicated = deduplicateFixtures(pooled);

    // Exactly 2 fixtures should remain
    expect(deduplicated).toHaveLength(2);
    expect(deduplicated[0].id).toBe('fd-575346');
    // Enriched venue from duplicate
    expect(deduplicated[0].venue?.name).toBe('Emirates Stadium');
    // Kickoff time in Africa/Lagos
    expect(formatKickoffTime(deduplicated[0].utcKickoffTime, 'Africa/Lagos')).toBe('20:00 WAT');
  });

  describe('Phase 3 Live Duplicate Regression Suite', () => {
    it('deduplicates Lens / RC Lens vs Sporting CP / Sporting Clube de Portugal', () => {
      const fdMatch: Fixture = {
        id: 'fd-575341',
        utcKickoffTime: '2026-10-13T16:45:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '64', name: 'Racing Club de Lens', shortName: 'RC Lens', tla: 'RCL' },
        awayTeam: { id: '82', name: 'Sporting Clube de Portugal', shortName: 'Sporting CP', tla: 'SCP' },
      };
      const spMatch: Fixture = {
        id: 'sp-13596700',
        utcKickoffTime: '2026-10-13T16:45:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '64', name: 'Lens', shortName: 'Lens', tla: 'LEN', crest: 'https://cdn.example.com/lens.png' },
        awayTeam: { id: '82', name: 'Sporting CP', shortName: 'Sporting', tla: 'SPO' },
      };

      expect(generateMatchIdentity(fdMatch)).toBe(generateMatchIdentity(spMatch));
      const deduped = deduplicateFixtures([fdMatch, spMatch]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].id).toBe('fd-575341');
      expect(deduped[0].homeTeam.crest).toBe('https://cdn.example.com/lens.png');
    });

    it('deduplicates Inter / Inter Milan / FC Internazionale Milano vs Club Brugge', () => {
      const fdMatch: Fixture = {
        id: 'fd-575343',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '108', name: 'FC Internazionale Milano', shortName: 'Inter', tla: 'INT' },
        awayTeam: { id: '851', name: 'Club Brugge KV', shortName: 'Club Brugge', tla: 'BRU' },
      };
      const spMatch: Fixture = {
        id: 'sp-13596705',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '135', name: 'Inter Milan', shortName: 'Inter Milan', tla: 'INT' },
        awayTeam: { id: '144', name: 'Club Brugge', shortName: 'Club Brugge', tla: 'CLU' },
      };

      expect(generateMatchIdentity(fdMatch)).toBe(generateMatchIdentity(spMatch));
      const deduped = deduplicateFixtures([fdMatch, spMatch]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].id).toBe('fd-575343');
    });

    it('deduplicates Slavia Praha / SK Slavia Praha vs Slavia Prague', () => {
      const fdMatch: Fixture = {
        id: 'fd-575342',
        utcKickoffTime: '2026-10-13T16:45:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '2393', name: 'Sabah FK', shortName: 'Sabah', tla: 'SAB' },
        awayTeam: { id: '162', name: 'SK Slavia Praha', shortName: 'Slavia Praha', tla: 'SLA' },
      };
      const spMatch: Fixture = {
        id: 'sp-13596701',
        utcKickoffTime: '2026-10-13T16:45:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '2393', name: 'Sabah FK', shortName: 'Sabah FK', tla: 'SAB' },
        awayTeam: { id: '162', name: 'Slavia Prague', shortName: 'Slavia Prague', tla: 'SLA' },
      };

      expect(generateMatchIdentity(fdMatch)).toBe(generateMatchIdentity(spMatch));
      const deduped = deduplicateFixtures([fdMatch, spMatch]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].id).toBe('fd-575342');
    });

    it('deduplicates Club Atlético de Madrid vs Atletico Madrid', () => {
      const fdMatch: Fixture = {
        id: 'fd-575345',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '78', name: 'Club Atlético de Madrid', shortName: 'Atlético', tla: 'ATM' },
        awayTeam: { id: '66', name: 'Manchester United FC', shortName: 'Man United', tla: 'MUN' },
      };
      const spMatch: Fixture = {
        id: 'sp-13596703',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '5', name: 'Atletico Madrid', shortName: 'Atlético', tla: 'ATL' },
        awayTeam: { id: '350', name: 'Manchester United', shortName: 'Man Utd', tla: 'MAN' },
      };

      expect(generateMatchIdentity(fdMatch)).toBe(generateMatchIdentity(spMatch));
      const deduped = deduplicateFixtures([fdMatch, spMatch]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].id).toBe('fd-575345');
    });

    it('deduplicates Viking FK vs FC Bayern München and Bayern Munich', () => {
      const fdMatch: Fixture = {
        id: 'fd-575347',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '69', name: 'Viking FK', shortName: 'Viking', tla: 'VIK' },
        awayTeam: { id: '5', name: 'FC Bayern München', shortName: 'Bayern', tla: 'FCB' },
      };
      const spMatch: Fixture = {
        id: 'sp-13596707',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '69', name: 'Viking', shortName: 'Viking', tla: 'VIK' },
        awayTeam: { id: '16', name: 'Bayern Munich', shortName: 'Bayern Munich', tla: 'BAY' },
      };

      expect(generateMatchIdentity(fdMatch)).toBe(generateMatchIdentity(spMatch));
      const deduped = deduplicateFixtures([fdMatch, spMatch]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].id).toBe('fd-575347');
    });

    it('does NOT merge distinct fixtures with similar names or different dates', () => {
      const match1: Fixture = {
        id: 'fd-101',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '1', name: 'Real Madrid CF', shortName: 'Real Madrid', tla: 'RMA' },
        awayTeam: { id: '2', name: 'FC Barcelona', shortName: 'Barcelona', tla: 'BAR' },
      };
      const match2: Fixture = {
        id: 'fd-102',
        utcKickoffTime: '2026-10-13T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '3', name: 'Club Atlético de Madrid', shortName: 'Atlético', tla: 'ATM' },
        awayTeam: { id: '2', name: 'FC Barcelona', shortName: 'Barcelona', tla: 'BAR' },
      };
      const match3: Fixture = {
        id: 'fd-103',
        utcKickoffTime: '2026-10-14T19:00:00Z', // Different date
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '1', name: 'Real Madrid CF', shortName: 'Real Madrid', tla: 'RMA' },
        awayTeam: { id: '2', name: 'FC Barcelona', shortName: 'Barcelona', tla: 'BAR' },
      };

      const deduped = deduplicateFixtures([match1, match2, match3]);
      expect(deduped).toHaveLength(3);
    });

    it('ensures deduplication is idempotent with stable canonical identities on refresh', () => {
      const fdMatch: Fixture = {
        id: 'fd-575341',
        utcKickoffTime: '2026-10-13T16:45:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '64', name: 'Racing Club de Lens', shortName: 'RC Lens', tla: 'RCL' },
        awayTeam: { id: '82', name: 'Sporting Clube de Portugal', shortName: 'Sporting CP', tla: 'SCP' },
      };
      const spMatch: Fixture = {
        id: 'sp-13596700',
        utcKickoffTime: '2026-10-13T16:45:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '64', name: 'Lens', shortName: 'Lens', tla: 'LEN' },
        awayTeam: { id: '82', name: 'Sporting CP', shortName: 'Sporting', tla: 'SPO' },
      };

      // First deduplication pass
      const pass1 = deduplicateFixtures([fdMatch, spMatch]);
      expect(pass1).toHaveLength(1);
      const identity1 = generateMatchIdentity(pass1[0]);

      // Re-run (simulating refresh)
      const pass2 = deduplicateFixtures([fdMatch, spMatch]);
      expect(pass2).toHaveLength(1);
      const identity2 = generateMatchIdentity(pass2[0]);

      // Re-run on already deduplicated array
      const pass3 = deduplicateFixtures(pass1);
      expect(pass3).toHaveLength(1);

      expect(pass1[0].id).toBe('fd-575341');
      expect(pass2[0].id).toBe('fd-575341');
      expect(pass3[0].id).toBe('fd-575341');
      expect(identity1).toBe(identity2);
    });

    it('deduplicates live LASK Linz vs Liverpool FC and retains updated live score and minute', () => {
      const fdRecord: Fixture = {
        id: 'fd-575350',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '2016', name: 'LASK Linz', shortName: 'LASK', tla: 'LIN', crest: 'https://crests.football-data.org/2016.png' },
        awayTeam: { id: '64', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV', crest: 'https://crests.football-data.org/64.png' },
        score: { home: 1, away: 5, halftime: { home: 0, away: 3 } },
        referee: { name: 'Tobias Stieler', nationality: 'Germany', role: 'REFEREE' },
        isDelayed: true,
      };

      const spRecord: Fixture = {
        id: 'sp-13596817',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        minute: 74,
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '137', name: 'LASK', shortName: 'LASK', tla: 'LAS' },
        awayTeam: { id: '312', name: 'Liverpool', shortName: 'Liverpool', tla: 'LIV' },
        score: { home: 1, away: 6 },
        isDelayed: false,
      };

      expect(generateMatchIdentity(fdRecord)).toBe(generateMatchIdentity(spRecord));

      const deduped = deduplicateFixtures([fdRecord, spRecord]);
      expect(deduped).toHaveLength(1);

      const m = deduped[0];
      expect(m.id).toBe('fd-575350');
      expect(m.status).toBe('IN_PLAY');
      // Live updated score from real-time provider (1-6) must be retained, with halftime (0-3) preserved
      expect(m.score).toEqual({ home: 1, away: 6, halftime: { home: 0, away: 3 } });
      expect(m.minute).toBe(74);
      expect(m.referee?.name).toBe('Tobias Stieler');
      expect(m.isDelayed).toBe(false);
    });

    it('deduplicates live Feyenoord Rotterdam vs Como 1907 across both provider representations', () => {
      const fdRecord: Fixture = {
        id: 'fd-575351',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '675', name: 'Feyenoord Rotterdam', shortName: 'Feyenoord', tla: 'FEY', crest: 'https://crests.football-data.org/675.png' },
        awayTeam: { id: '7397', name: 'Como 1907', shortName: 'Como 1907', tla: 'COM', crest: 'https://crests.football-data.org/7397.png' },
        score: { home: 2, away: 1, halftime: { home: 1, away: 1 } },
        referee: { name: 'Donatas Rumšas', nationality: 'Lithuania', role: 'REFEREE' },
        isDelayed: true,
      };

      const spRecord: Fixture = {
        id: 'sp-13596816',
        utcKickoffTime: '2026-10-14T16:45:00Z',
        status: 'IN_PLAY',
        minute: 69,
        competition: { id: 'CL', name: 'UEFA Champions League', code: 'CL', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: '180', name: 'Feyenoord', shortName: 'Feyenoord', tla: 'FEY' },
        awayTeam: { id: '19', name: 'Como', shortName: 'Como', tla: 'COM' },
        score: { home: 2, away: 1 },
        isDelayed: false,
      };

      expect(generateMatchIdentity(fdRecord)).toBe(generateMatchIdentity(spRecord));

      const deduped = deduplicateFixtures([fdRecord, spRecord]);
      expect(deduped).toHaveLength(1);

      const m = deduped[0];
      expect(m.id).toBe('fd-575351');
      expect(m.status).toBe('IN_PLAY');
      expect(m.score).toEqual({ home: 2, away: 1, halftime: { home: 1, away: 1 } });
      expect(m.minute).toBe(69);
      expect(m.referee?.name).toBe('Donatas Rumšas');
      expect(m.isDelayed).toBe(false);
    });

    it('advances match status from SCHEDULED to IN_PLAY and to FINISHED during deduplication', () => {
      const scheduledMatch: Fixture = {
        id: 'fd-900',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-bet', name: 'Real Betis Balompié', shortName: 'Real Betis', tla: 'BET' },
        awayTeam: { id: 't-por', name: 'FC Porto', shortName: 'Porto', tla: 'POR' },
      };

      const liveMatch: Fixture = {
        id: 'sp-900',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'IN_PLAY',
        minute: 22,
        score: { home: 1, away: 0 },
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-bet-sp', name: 'Real Betis', shortName: 'Betis', tla: 'BET' },
        awayTeam: { id: 't-por-sp', name: 'Porto', shortName: 'Porto', tla: 'POR' },
      };

      // When scheduled and live arrive together, IN_PLAY status and live score must prevail
      const dedupedLive = deduplicateFixtures([scheduledMatch, liveMatch]);
      expect(dedupedLive).toHaveLength(1);
      expect(dedupedLive[0].status).toBe('IN_PLAY');
      expect(dedupedLive[0].score).toEqual({ home: 1, away: 0 });
      expect(dedupedLive[0].minute).toBe(22);

      // When finished arrives, FINISHED status must prevail over IN_PLAY
      const finishedMatch: Fixture = {
        ...liveMatch,
        status: 'FINISHED',
        score: { home: 2, away: 1, halftime: { home: 1, away: 0 } },
      };

      const dedupedFinished = deduplicateFixtures([dedupedLive[0], finishedMatch]);
      expect(dedupedFinished).toHaveLength(1);
      expect(dedupedFinished[0].status).toBe('FINISHED');
      expect(dedupedFinished[0].score?.home).toBe(2);
      expect(dedupedFinished[0].score?.away).toBe(1);
    });

    it('ensures legitimate separate matches are NEVER accidentally merged', () => {
      const manCityMatch: Fixture = {
        id: 'fd-city',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'TIMED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-mci', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
        awayTeam: { id: 't-psg', name: 'Paris Saint-Germain FC', shortName: 'PSG', tla: 'PSG' },
      };

      const manUtdMatch: Fixture = {
        id: 'fd-utd',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'TIMED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-mun', name: 'Manchester United FC', shortName: 'Man United', tla: 'MUN' },
        awayTeam: { id: 't-psg2', name: 'Paris Saint-Germain FC', shortName: 'PSG', tla: 'PSG' },
      };

      const interMatch: Fixture = {
        id: 'fd-inter',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'TIMED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-int', name: 'Inter Milan', shortName: 'Inter', tla: 'INT' },
        awayTeam: { id: 't-rma', name: 'Real Madrid CF', shortName: 'Real Madrid', tla: 'RMA' },
      };

      const acMilanMatch: Fixture = {
        id: 'fd-acmilan',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'TIMED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-mil', name: 'AC Milan', shortName: 'Milan', tla: 'MIL' },
        awayTeam: { id: 't-rma2', name: 'Real Madrid CF', shortName: 'Real Madrid', tla: 'RMA' },
      };

      const deduped = deduplicateFixtures([manCityMatch, manUtdMatch, interMatch, acMilanMatch]);
      expect(deduped).toHaveLength(4);
    });

    it('ensures reversed home and away fixtures (e.g. 1st leg vs 2nd leg) are NEVER merged', () => {
      const leg1: Fixture = {
        id: 'fd-leg1',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-liv', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
        awayTeam: { id: 't-lask', name: 'LASK Linz', shortName: 'LASK', tla: 'LIN' },
      };

      const leg2: Fixture = {
        id: 'fd-leg2',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-lask', name: 'LASK Linz', shortName: 'LASK', tla: 'LIN' },
        awayTeam: { id: 't-liv', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
      };

      expect(areFixturesEquivalent(leg1, leg2)).toBe(false);
      const deduped = deduplicateFixtures([leg1, leg2]);
      expect(deduped).toHaveLength(2);
    });

    it('ensures fixtures between the same clubs in different competitions are NEVER merged', () => {
      const championsLeagueMatch: Fixture = {
        id: 'fd-cl',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'CL', code: 'CL', name: 'UEFA Champions League', type: 'CUP', country: 'Europe', season: '2026/27' },
        homeTeam: { id: 't-ars', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: 't-mci', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
      };

      const premierLeagueMatch: Fixture = {
        id: 'fd-pl',
        utcKickoffTime: '2026-10-14T19:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2026/27' },
        homeTeam: { id: 't-ars', name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
        awayTeam: { id: 't-mci', name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
      };

      expect(areFixturesEquivalent(championsLeagueMatch, premierLeagueMatch)).toBe(false);
      const deduped = deduplicateFixtures([championsLeagueMatch, premierLeagueMatch]);
      expect(deduped).toHaveLength(2);
    });

    it('ensures fixtures separated by more than 6 hours are treated as separate fixtures', () => {
      const match1: Fixture = {
        id: 'fd-sat',
        utcKickoffTime: '2026-10-14T12:00:00Z',
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2026/27' },
        homeTeam: { id: 't-liv', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
        awayTeam: { id: 't-eve', name: 'Everton FC', shortName: 'Everton', tla: 'EVE' },
      };

      const match2: Fixture = {
        id: 'fd-next',
        utcKickoffTime: '2026-10-15T12:00:00Z', // 24 hours later
        status: 'SCHEDULED',
        competition: { id: 'PL', code: 'PL', name: 'Premier League', type: 'LEAGUE', country: 'England', season: '2026/27' },
        homeTeam: { id: 't-liv', name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
        awayTeam: { id: 't-eve', name: 'Everton FC', shortName: 'Everton', tla: 'EVE' },
      };

      expect(areFixturesEquivalent(match1, match2)).toBe(false);
      const deduped = deduplicateFixtures([match1, match2]);
      expect(deduped).toHaveLength(2);
    });
  });
});


