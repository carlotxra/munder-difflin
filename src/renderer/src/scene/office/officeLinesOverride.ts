// Office-lines override: the layer between the built-in break-spot lines in
// cafeteriaLines.ts and what the floor actually says.
//
//   built-in pools  →  user file (<userData>/office-lines.json, replace/append
//   per pool)  →  innuendo filter (Settings → General, default OFF)
//
// cafeteriaLines.ts keeps its data and hands it to `officeLines()` from its two
// pickers; everything else lives here so the upstream file stays close to
// unchanged. The 'Office small talk' toggle is read by OfficeFloor directly.

import type { OfficeLinesOverride, PoolOverride, SpotPoolName } from '@shared/officeLinesPayload';

type Exchange = readonly string[];

/** The built-in data, as cafeteriaLines.ts declares it. */
export interface BuiltinOfficeLines {
  spots: Readonly<Record<SpotPoolName, readonly string[]>>;
  characters: Readonly<Partial<Record<string, readonly string[]>>>;
  exchanges: readonly Exchange[];
  twss: readonly Exchange[];
  keyed: Readonly<Partial<Record<string, Exchange>>>;
}

/** What the pickers draw from. Every list here is non-empty. */
export interface ResolvedOfficeLines {
  spots: Record<SpotPoolName, readonly string[]>;
  characters: Partial<Record<string, readonly string[]>>;
  pairs: readonly Exchange[];
  keyed: Partial<Record<string, readonly Exchange[]>>;
}

export interface OfficeLinesSettings {
  /** Break-spot bubbles at all. Default on. */
  smallTalk: boolean;
  /** "That's what she said" and friends. Default OFF. */
  innuendo: boolean;
}

export const DEFAULT_OFFICE_LINES_SETTINGS: OfficeLinesSettings = { smallTalk: true, innuendo: false };

/** Matches the catchphrase with a straight or curly apostrophe (or none). */
const TWSS = /that['’‘`]?s\s+what\s+she\s+said/i;
export const isInnuendo = (line: string): boolean => TWSS.test(line);
const exchangeIsInnuendo = (ex: Exchange): boolean => ex.some(isInnuendo);

/** Clean stand-ins for the characters whose signature line is the innuendo. */
export const CLEAN_SOLO: Partial<Record<string, string>> = {
  michael: 'World’s Best Boss. it says so on the mug.',
  jim: '*looks at the camera*'
};
export const CLEAN_KEYED: Partial<Record<string, Exchange>> = {
  michael: ['I DECLARE… BANKRUPTCY!', 'you can’t just say it, Michael.', 'I didn’t say it. I declared it.'],
  jim: ['*looks at the camera*', '...what did Dwight do now?', 'nothing. yet.']
};

function applyPool<T>(base: readonly T[], o: PoolOverride<T> | undefined): readonly T[] {
  if (!o) return base;
  return o.mode === 'append' ? [...base, ...o.lines] : o.lines;
}

const own = <T,>(m: Partial<Record<string, T>>, k: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;

/** Built-in + override + filter. Pure; exported for the tests. */
export function resolveOfficeLines(
  builtin: BuiltinOfficeLines,
  override: OfficeLinesOverride | null,
  settings: Pick<OfficeLinesSettings, 'innuendo'>
): ResolvedOfficeLines {
  const o = override;
  const clean = !settings.innuendo;
  const lines = (l: readonly string[]): readonly string[] => (clean ? l.filter((x) => !isInnuendo(x)) : l);
  const exchanges = (l: readonly Exchange[]): readonly Exchange[] =>
    (clean ? l.filter((x) => !exchangeIsInnuendo(x)) : l);

  // Spots: a pool the filter empties falls back to the (filtered) built-in one.
  const spots = {} as Record<SpotPoolName, readonly string[]>;
  for (const name of Object.keys(builtin.spots) as SpotPoolName[]) {
    const merged = lines(applyPool(builtin.spots[name], o?.spots[name]));
    spots[name] = merged.length ? merged : lines(builtin.spots[name]);
  }

  // Characters: per character; one left empty drops back to the spot pools.
  const characters: Partial<Record<string, readonly string[]>> = {};
  const names = new Set([...Object.keys(builtin.characters), ...Object.keys(o?.characters ?? {})]);
  for (const name of names) {
    const base = own(builtin.characters, name) ?? [];
    const merged = applyPool(base, o ? own(o.characters, name) : undefined);
    let kept = lines(merged);
    const stand = own(CLEAN_SOLO, name);
    if (clean && stand && kept.length < merged.length && !kept.includes(stand)) kept = [...kept, stand];
    if (kept.length) characters[name] = kept;
  }

  // Pairs: generic banter, plus the TWSS set only when innuendo is allowed.
  const generic = applyPool(builtin.exchanges, o?.exchanges);
  const twss = clean ? [] : applyPool(builtin.twss, o?.twss);
  let pairs = exchanges([...generic, ...twss]);
  if (!pairs.length) pairs = exchanges(builtin.exchanges);

  // Keyed openers: a character whose opener was filtered out gets a clean one.
  const keyed: Partial<Record<string, readonly Exchange[]>> = {};
  const keyedNames = new Set([...Object.keys(builtin.keyed), ...Object.keys(o?.keyed ?? {})]);
  for (const name of keyedNames) {
    const b = own(builtin.keyed, name);
    const merged = applyPool(b ? [b] : [], o ? own(o.keyed, name) : undefined);
    let kept = exchanges(merged);
    const stand = own(CLEAN_KEYED, name);
    if (clean && stand && !kept.length && merged.length) kept = [stand];
    if (kept.length) keyed[name] = kept;
  }

  return { spots, characters, pairs, keyed };
}

// ─── live state (fed from App.tsx / Settings; read by the pickers) ──────────

let settings: OfficeLinesSettings = { ...DEFAULT_OFFICE_LINES_SETTINGS };
let override: OfficeLinesOverride | null = null;
let cache: { builtin: BuiltinOfficeLines; value: ResolvedOfficeLines } | null = null;

export function applyOfficeLinesSettings(next: Partial<OfficeLinesSettings>): void {
  const merged = { ...settings, ...next };
  if (merged.innuendo !== settings.innuendo) cache = null;
  settings = merged;
}

export function applyOfficeLinesOverride(next: OfficeLinesOverride | null): void {
  override = next;
  cache = null;
}

export const officeSmallTalkEnabled = (): boolean => settings.smallTalk;

/** The pools the pickers use right now (memoised until something changes). */
export function officeLines(builtin: BuiltinOfficeLines): ResolvedOfficeLines {
  if (cache?.builtin !== builtin) cache = { builtin, value: resolveOfficeLines(builtin, override, settings) };
  return cache.value;
}
