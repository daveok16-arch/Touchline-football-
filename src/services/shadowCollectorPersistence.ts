/**
 * Project Touchline – Phase T2 crash-safe collector persistence (RESEARCH ONLY)
 *
 * Persists the collector state and the shadow snapshot as a SINGLE atomic commit so a crash
 * can never leave the two out of step (a divergence would cause duplicate observations and
 * misflagged corrections). Writes go to a temp file, then rename onto the target; the
 * previous good file is kept as `.bak`, and every commit appends a forensic journal line.
 *
 * No network I/O. Never throws from `load`; `save` returns a diagnostic.
 */

import fs from 'fs';
import path from 'path';
import { CollectorState, emptyCollectorState, COLLECTOR_STATE_SCHEMA_VERSION } from './shadowCollector';
import { ShadowSnapshot, EMPTY_SHADOW, serializeShadowSnapshot, parseShadowSnapshot, SHADOW_SCHEMA_VERSION } from './shadowLedger';

/** Default research-only combined-state location (gitignored). */
export const SHADOW_COLLECTOR_BUNDLE_PATH = path.resolve(process.cwd(), '.phaseS-collector', 'collector-bundle.json');

export interface CollectorBundle {
  bundleSchemaVersion: number;
  collectorSchemaVersion: number;
  shadowSchemaVersion: number;
  /** Monotonic commit counter. */
  commit: number;
  state: CollectorState;
  snapshot: ShadowSnapshot;
}

export const BUNDLE_SCHEMA_VERSION = 1;

export function emptyBundle(): CollectorBundle {
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    collectorSchemaVersion: COLLECTOR_STATE_SCHEMA_VERSION,
    shadowSchemaVersion: SHADOW_SCHEMA_VERSION,
    commit: 0,
    state: emptyCollectorState(),
    snapshot: EMPTY_SHADOW,
  };
}

export interface BundleLoadResult {
  bundle: CollectorBundle;
  diagnostic: { ok: boolean; source: 'main' | 'bak' | 'empty'; error?: string };
}

export interface BundleSaveResult {
  ok: boolean;
  error?: string;
  commit?: number;
}

/**
 * Atomic bundle store. `save` writes temp → rename, rotating the previous file to `.bak`.
 * `load` prefers the main file and falls back to `.bak` when main is missing or corrupt;
 * a bundle whose collector/shadow schema versions are incompatible is rejected.
 */
export class CollectorBundleStore {
  constructor(private readonly filePath: string) {}

  get mainPath(): string {
    return this.filePath;
  }
  private get bakPath(): string {
    return `${this.filePath}.bak`;
  }
  private get journalPath(): string {
    return `${this.filePath}.journal`;
  }

  load(): BundleLoadResult {
    for (const [source, p] of [['main', this.filePath], ['bak', this.bakPath]] as const) {
      if (!fs.existsSync(p)) continue;
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw) as Partial<CollectorBundle>;
        const bundle = this.coerce(parsed);
        if (bundle) return { bundle, diagnostic: { ok: true, source } };
      } catch {
        /* try next source */
      }
    }
    return { bundle: emptyBundle(), diagnostic: { ok: true, source: 'empty' } };
  }

  /** Validates schema versions and the embedded snapshot; returns null when incompatible. */
  private coerce(parsed: Partial<CollectorBundle> | null | undefined): CollectorBundle | null {
    if (!parsed || parsed.bundleSchemaVersion !== BUNDLE_SCHEMA_VERSION) return null;
    if (parsed.collectorSchemaVersion !== COLLECTOR_STATE_SCHEMA_VERSION) return null;
    if (parsed.shadowSchemaVersion !== SHADOW_SCHEMA_VERSION) return null;
    if (!parsed.state || !Array.isArray(parsed.state.pending)) return null;
    // Validate the snapshot through the ledger parser (rejects incompatible schemas).
    const parsedSnap = parseShadowSnapshot(JSON.stringify(parsed.snapshot ?? {}));
    if (parsedSnap.error) return null;
    return {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      collectorSchemaVersion: COLLECTOR_STATE_SCHEMA_VERSION,
      shadowSchemaVersion: SHADOW_SCHEMA_VERSION,
      commit: typeof parsed.commit === 'number' ? parsed.commit : 0,
      state: parsed.state,
      snapshot: parsedSnap.snapshot,
    };
  }

  /**
   * Atomically persists state + snapshot together. Both are written into one file, so an
   * interrupted write leaves either the old file or the new file — never a mix.
   */
  save(state: CollectorState, snapshot: ShadowSnapshot, journalLine?: string): BundleSaveResult {
    try {
      const existing = this.load().bundle;
      const commit = existing.commit + 1;
      const bundle: CollectorBundle = {
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        collectorSchemaVersion: COLLECTOR_STATE_SCHEMA_VERSION,
        shadowSchemaVersion: SHADOW_SCHEMA_VERSION,
        commit,
        state,
        snapshot: JSON.parse(serializeShadowSnapshot(snapshot)) as ShadowSnapshot,
      };
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, this.bakPath);
        } catch {
          /* best effort */
        }
      }
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(bundle), 'utf8');
      fs.renameSync(tmp, this.filePath);
      if (journalLine) {
        try {
          fs.appendFileSync(this.journalPath, `${new Date().toISOString()} commit=${commit} ${journalLine}\n`, 'utf8');
        } catch {
          /* journal is best effort */
        }
      }
      return { ok: true, commit };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
