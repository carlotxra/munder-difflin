/**
 * Local overrides for the model catalog, layered around the upstream remote
 * fetch in ./modelCatalog.ts (which this file wraps and never edits).
 *
 * Precedence, highest first — every layer may be PARTIAL and is merged per
 * provider (a provider a layer names replaces that provider's list; one it does
 * not name falls through to the next layer):
 *
 *   1. `--model-catalog=<path|https-url>` on the command line, else the
 *      `MUNDER_MODEL_CATALOG` env var (same value shape)
 *   2. `<userData>/model-catalog.override.json`, next to config.json
 *      (`model-catalog.json` there is already the remote cache)
 *   3. the remote upstream catalog (docs/model-catalog.json on main)
 *   4. the bundled src/shared/modelCatalog.json — merged in by the renderer
 *
 * The remote fetch is switched off by `"remote": false` in either override, or
 * by `MUNDER_MODEL_CATALOG_REMOTE=0|false|off`.
 *
 * An override goes through the same total parser as the remote copy, so it can
 * never put an unchecked string on a spawn command line. A missing or broken
 * override is skipped, never fatal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getText } from './fetchText';
import { loadModelCatalog, type RemoteCatalogResult } from './modelCatalog';
import {
  parseModelCatalog, CATALOG_SCHEMA_VERSION, type ModelCatalog
} from '../shared/modelCatalogPayload';

export const OVERRIDE_FLAG = '--model-catalog';
export const OVERRIDE_ENV = 'MUNDER_MODEL_CATALOG';
export const REMOTE_ENV = 'MUNDER_MODEL_CATALOG_REMOTE';
export const OVERRIDE_FILE = 'model-catalog.override.json';

export interface OverrideContext {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  userDataDir: string;
  /** Injected for tests; defaults to the https-only getText. */
  fetchText?: (url: string) => Promise<string>;
}

interface Layer { catalog: ModelCatalog | null; remote: boolean }

/** The flag's value (`--model-catalog=x` or `--model-catalog x`), else the env var. */
export function explicitSource(argv: readonly string[], env: OverrideContext['env']): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(`${OVERRIDE_FLAG}=`)) return a.slice(OVERRIDE_FLAG.length + 1).trim() || null;
    if (a === OVERRIDE_FLAG && argv[i + 1]) return argv[i + 1].trim() || null;
  }
  return env[OVERRIDE_ENV]?.trim() || null;
}

/** Read one override source. A missing `version` is taken as the current schema,
 *  so a hand-written partial file can be just `{ "providers": { … } }`. */
async function readLayer(source: string, ctx: OverrideContext): Promise<Layer | null> {
  try {
    const body = /^https?:\/\//i.test(source)
      ? await (ctx.fetchText ?? ((u) => getText(u, { timeoutMs: 8000 })))(source)
      : readFileSync(source, 'utf8');
    const raw = JSON.parse(body);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const catalog = raw.providers === undefined
      ? null
      : parseModelCatalog({ version: CATALOG_SCHEMA_VERSION, ...raw });
    return { catalog, remote: raw.remote !== false };
  } catch {
    return null;
  }
}

/** Per-provider merge; later arguments win. */
export function mergeCatalogs(...layers: (ModelCatalog | null | undefined)[]): ModelCatalog | null {
  const present = layers.filter((c): c is ModelCatalog => !!c);
  if (present.length === 0) return null;
  return {
    version: CATALOG_SCHEMA_VERSION,
    providers: Object.assign({}, ...present.map((c) => c.providers))
  };
}

/** The upstream result with the local overrides applied on top. */
export async function loadModelCatalogWithOverrides(
  cachePath: string,
  ctx: OverrideContext,
  opts: { force?: boolean; load?: typeof loadModelCatalog } = {}
): Promise<RemoteCatalogResult> {
  const explicit = explicitSource(ctx.argv, ctx.env);
  const wellKnown = join(ctx.userDataDir, OVERRIDE_FILE);
  const top = explicit ? await readLayer(explicit, ctx) : null;
  const file = existsSync(wellKnown) ? await readLayer(wellKnown, ctx) : null;

  const envOff = /^(0|false|off|no)$/i.test(ctx.env[REMOTE_ENV]?.trim() ?? '');
  const remoteOn = !envOff && top?.remote !== false && file?.remote !== false;

  const remote: RemoteCatalogResult = remoteOn
    ? await (opts.load ?? loadModelCatalog)(cachePath, { force: opts.force })
    : { catalog: null, fetchedAt: 0, stale: true };

  return { ...remote, catalog: mergeCatalogs(remote.catalog, file?.catalog, top?.catalog) };
}
