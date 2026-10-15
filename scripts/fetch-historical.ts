/**
 * Project Touchline – Phase 3 historical data fetcher (read-only, manual)
 *
 * Downloads finished historical matches for the four standings-supported competitions
 * from football-data.org (free tier) and writes them to a gitignored cache under
 * `.phase3-cache/`. This is a one-off evaluation utility, NOT part of the app runtime
 * and NOT part of the test suite. It never writes to the app's live data paths.
 *
 * Usage:  npx tsx scripts/fetch-historical.ts
 * Requires: FOOTBALL_DATA_API_KEY in the environment.
 *
 * The free tier allows 10 requests/minute; this script paces requests and respects 429s.
 */

import fs from 'fs';
import path from 'path';

const COMPETITIONS = ['PL', 'PD', 'SA', 'CL'] as const;
const SEASONS = [2023, 2024, 2025] as const;
const OUT_DIR = path.resolve(process.cwd(), '.phase3-cache');
const PACE_MS = 7000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSeason(comp: string, season: number, token: string): Promise<any | null> {
  const url = `https://api.football-data.org/v4/competitions/${comp}/matches?season=${season}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'X-Auth-Token': token } });
    if (res.status === 429) {
      console.log(`  ${comp} ${season}: 429, waiting 20s`);
      await sleep(20000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      console.log(`  ${comp} ${season}: HTTP ${res.status} ${text.slice(0, 100)}`);
      return null;
    }
    return res.json();
  }
  return null;
}

async function main() {
  const token = process.env.FOOTBALL_DATA_API_KEY;
  if (!token) {
    console.error('FOOTBALL_DATA_API_KEY is not set. Aborting.');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const comp of COMPETITIONS) {
    for (const season of SEASONS) {
      const outFile = path.join(OUT_DIR, `${comp}-${season}.json`);
      if (fs.existsSync(outFile)) {
        console.log(`${comp} ${season}: cached, skipping`);
        continue;
      }
      const data = await fetchSeason(comp, season, token);
      if (data) {
        fs.writeFileSync(outFile, JSON.stringify(data));
        const n = data?.matches?.length ?? 0;
        console.log(`${comp} ${season}: saved ${n} matches`);
      }
      await sleep(PACE_MS);
    }
  }
  console.log(`Done. Cache: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
