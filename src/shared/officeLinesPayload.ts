/**
 * The office-lines override file (`<userData>/office-lines.json`): a total
 * parser that turns whatever is on disk into a checked, partial override of the
 * break-spot small talk in renderer/scene/office/cafeteriaLines.ts.
 *
 * Every pool is optional. A pool is either a bare list (mode "replace") or
 * `{ "mode": "replace" | "append", "lines": [...] }`. Map pools (`characters`,
 * `keyed`) take one such entry per character; characters the file leaves out
 * keep their built-in lines.
 *
 *   {
 *     "coffee":     ["who took my mug?"],
 *     "vending":    { "mode": "append", "lines": ["B4. it's always B4."] },
 *     "characters": { "michael": ["I DECLARE… BANKRUPTCY!"] },
 *     "exchanges":  [["setup", "reply", "tag"]],
 *     "keyed":      { "dwight": [["FALSE.", "...here we go."]] }
 *   }
 *
 * Lines are strings only: control and bidi-override characters are stripped,
 * whitespace is collapsed, and anything over MAX_LINE_CHARS is cut. Bad entries
 * are dropped one by one; a pool left empty after that is ignored (so it keeps
 * the built-in lines). Nothing here throws.
 */

export const OFFICE_LINES_FILE = 'office-lines.json';
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_LINE_CHARS = 120;
export const MAX_POOL_ITEMS = 200;
export const MAX_CHARACTERS = 64;
export const MIN_BEATS = 2;
export const MAX_BEATS = 8;

export type PoolMode = 'replace' | 'append';
export type SpotPoolName = 'coffee' | 'vending' | 'snack' | 'table';
export const SPOT_POOLS: readonly SpotPoolName[] = ['coffee', 'vending', 'snack', 'table'];

export interface PoolOverride<T> { mode: PoolMode; lines: T[] }

/** Beats alternate between the two agents at the table, speaker first. */
export type ExchangeLines = string[];

export interface OfficeLinesOverride {
  spots: Partial<Record<SpotPoolName, PoolOverride<string>>>;
  /** Solo lines per character (keys are cast names, e.g. "michael"). */
  characters: Record<string, PoolOverride<string>>;
  /** Generic two-agent banter. */
  exchanges?: PoolOverride<ExchangeLines>;
  /** "That's what she said" exchanges; only used when innuendo is allowed. */
  twss?: PoolOverride<ExchangeLines>;
  /** A character's signature openers, used when they sit down first. */
  keyed: Record<string, PoolOverride<ExchangeLines>>;
}

// C0/C1 controls, plus the bidi overrides/isolates that can reorder a bubble.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const CHARACTER_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** One bubble line, or null when there is nothing printable left. */
export function cleanLine(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length > MAX_LINE_CHARS ? `${chars.slice(0, MAX_LINE_CHARS - 1).join('').trimEnd()}…` : s;
}

function cleanExchange(v: unknown): ExchangeLines | null {
  if (!Array.isArray(v)) return null;
  const beats = v.slice(0, MAX_BEATS).map(cleanLine);
  // A dropped beat would hand the next line to the wrong speaker, so one bad
  // beat drops the whole exchange rather than shifting it.
  if (beats.length < MIN_BEATS || beats.some((b) => b === null)) return null;
  return beats as string[];
}

/** A bare list (replace) or `{ mode, lines }`; null when nothing survives. */
function parsePool<T>(v: unknown, item: (x: unknown) => T | null): PoolOverride<T> | null {
  let mode: PoolMode = 'replace';
  let raw: unknown = v;
  if (isObject(v)) {
    if (v.mode === 'append') mode = 'append';
    else if (v.mode !== undefined && v.mode !== 'replace') return null;
    raw = v.lines;
  }
  if (!Array.isArray(raw)) return null;
  const lines: T[] = [];
  for (const x of raw) {
    if (lines.length >= MAX_POOL_ITEMS) break;
    const c = item(x);
    if (c !== null) lines.push(c);
  }
  return lines.length ? { mode, lines } : null;
}

/** A keyed entry may be one exchange (["a", "b"]) or a list of them. */
function parseKeyedPool(v: unknown): PoolOverride<ExchangeLines> | null {
  const one = (x: unknown): boolean => Array.isArray(x) && typeof x[0] === 'string';
  if (one(v)) return parsePool([v], cleanExchange);
  if (isObject(v) && one(v.lines)) return parsePool({ ...v, lines: [v.lines] }, cleanExchange);
  return parsePool(v, cleanExchange);
}

function parseMap<T>(v: unknown, pool: (x: unknown) => PoolOverride<T> | null): Record<string, PoolOverride<T>> {
  const out: Record<string, PoolOverride<T>> = Object.create(null);
  if (!isObject(v)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(v)) {
    if (n >= MAX_CHARACTERS) break;
    const name = key.trim().toLowerCase();
    if (!CHARACTER_KEY.test(name)) continue;
    const p = pool(value);
    if (p) { out[name] = p; n++; }
  }
  return out;
}

/** The checked override, or null when the input has nothing usable in it. */
export function parseOfficeLines(raw: unknown): OfficeLinesOverride | null {
  if (!isObject(raw)) return null;
  const spots: OfficeLinesOverride['spots'] = {};
  for (const name of SPOT_POOLS) {
    const p = parsePool(raw[name], cleanLine);
    if (p) spots[name] = p;
  }
  const out: OfficeLinesOverride = {
    spots,
    characters: parseMap(raw.characters, (x) => parsePool(x, cleanLine)),
    keyed: parseMap(raw.keyed, parseKeyedPool)
  };
  const exchanges = parsePool(raw.exchanges, cleanExchange);
  if (exchanges) out.exchanges = exchanges;
  const twss = parsePool(raw.twss, cleanExchange);
  if (twss) out.twss = twss;

  const empty = Object.keys(spots).length === 0 && !exchanges && !twss
    && Object.keys(out.characters).length === 0 && Object.keys(out.keyed).length === 0;
  return empty ? null : out;
}

/** Parse the file's text; null for anything too big, not JSON, or empty. */
export function parseOfficeLinesText(text: string): OfficeLinesOverride | null {
  if (text.length > MAX_FILE_BYTES) return null;
  try { return parseOfficeLines(JSON.parse(text)); } catch { return null; }
}
