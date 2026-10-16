/**
 * Project Touchline – Model prediction count CLI (READ-ONLY)
 *
 * Prints how many matches the frozen model predicted for a given day, the per-competition
 * breakdown, why the other fixtures were excluded, and the ranked predictions themselves.
 * It reuses the exact pipeline the HomeView overview runs, so the headline matches the live UI.
 *
 * Requires the app's data API to be reachable (default http://127.0.0.1:3000).
 * It only reads; it writes no state and never enables a flag.
 *
 * Usage:
 *   npx tsx scripts/model-predictions.ts [--date YYYY-MM-DD] [--tz Africa/Lagos]
 *                                        [--base-url http://127.0.0.1:3000] [--json]
 */

import { pathToFileURL } from 'node:url';
import {
  collectMatchPredictionReport,
  formatMatchPredictionReport,
  MatchPredictionReportOptions,
} from '../src/analysis/matchPredictionReport';

interface CliArgs extends MatchPredictionReportOptions {
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = (flag: string): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    switch (token) {
      case '--date':
      case '-d':
        args.dateKey = value(token);
        break;
      case '--tz':
      case '--timezone':
        args.timezoneId = value(token);
        break;
      case '--base-url':
        args.baseUrl = value(token);
        break;
      case '--competition':
      case '-c':
        args.competitionId = value(token);
        break;
      case '--search':
      case '-q':
        args.searchQuery = value(token);
        break;
      case '--at': {
        const iso = value(token);
        const ms = new Date(iso).getTime();
        if (Number.isNaN(ms)) throw new Error(`--at expects an ISO date, got "${iso}"`);
        args.asOfMs = ms;
        break;
      }
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (token.startsWith('--date=')) args.dateKey = token.slice('--date='.length);
        else if (token.startsWith('--base-url=')) args.baseUrl = token.slice('--base-url='.length);
        else if (token.startsWith('--tz=')) args.timezoneId = token.slice('--tz='.length);
        else if (token.startsWith('--search=')) args.searchQuery = token.slice('--search='.length);
        else throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(
    [
      'Usage: npx tsx scripts/model-predictions.ts [options]',
      '',
      '  --date, -d <YYYY-MM-DD>   Day to report on (default: today in the timezone)',
      '  --tz <IANA>               Timezone for the day boundary (default: Africa/Lagos)',
      '  --base-url <url>          App data API base URL (default: http://127.0.0.1:3000)',
      '  --competition, -c <code>  Restrict to one competition code (default: all)',
      '  --search, -q <text>       Restrict to fixtures matching a team/competition name',
      '  --at <ISO>                Evaluate as of an instant (default: now)',
      '  --json                    Emit the report as JSON',
      '  --help, -h                Show this help',
    ].join('\n')
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const baseUrl = args.baseUrl ?? 'http://127.0.0.1:3000';

  const report = await collectMatchPredictionReport({ ...args, baseUrl });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMatchPredictionReport(report));
    console.log('');
    const scope = report.usedUpcomingFallback ? 'next upcoming fixtures' : report.dateKey;
    console.log(`Answer: the model predicted ${report.eligibleCount} match(es) for ${scope}.`);
  }

  // An empty day can be legitimate (no fixtures, or a filter that matched nothing). Only hint at a
  // connection problem when no filter was applied and nothing at all came back.
  const filtered = args.competitionId !== undefined || args.searchQuery !== undefined;
  if (report.totalFixtures === 0 && !filtered) {
    console.error(`\nNote: no fixtures found. Is the app running at ${baseUrl}?`);
  }
}

// Only run when invoked directly, so tests can import parseArgs without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // parseArgs throws inside the async main(), so its rejection is handled here too.
  main().catch((err) => {
    console.error('model-predictions failed:', err?.message || err);
    process.exit(1);
  });
}
