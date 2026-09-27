'use strict';

/**
 * Office-floor small talk overrides: validation of <userData>/office-lines.json
 * (src/shared/officeLinesPayload.ts), the replace/append merge and the innuendo
 * filter (src/renderer/src/scene/office/officeLinesOverride.ts), and the pickers
 * in cafeteriaLines.ts that read through them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const payload = loadTs('src/shared/officeLinesPayload.ts');
const { parseOfficeLines, parseOfficeLinesText, cleanLine, MAX_LINE_CHARS, MAX_POOL_ITEMS, MAX_BEATS } = payload;
const layer = loadTs('src/renderer/src/scene/office/officeLinesOverride.ts');
const { resolveOfficeLines, isInnuendo, applyOfficeLinesOverride, applyOfficeLinesSettings, officeSmallTalkEnabled, CLEAN_KEYED, CLEAN_SOLO } = layer;
const { pickSoloLine, pickExchange } = loadTs('src/renderer/src/scene/office/cafeteriaLines.ts');
const { loadOfficeLines } = loadTs('src/main/officeLinesOverride.ts');

const CAST = ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley',
  'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'];
const SPOTS = ['coffee', 'vending', 'snack', 'table'];
const EXAMPLE = path.join(__dirname, '..', 'docs', 'office-lines.example.json');

test.afterEach(() => {
  applyOfficeLinesOverride(null);
  applyOfficeLinesSettings({ smallTalk: true, innuendo: false });
});

/** Everything the pickers can return, found by sweeping the seed. */
function allSolo(character, spot, { spotOnly = false } = {}) {
  const out = new Set();
  // seed % 5 >= 3 is the spot pool; below that, the character's own lines.
  for (let s = 0; s < 4000; s++) if (!spotOnly || s % 5 >= 3) out.add(pickSoloLine(character, spot, s));
  return out;
}
function allExchanges(character) {
  const out = new Set();
  for (let s = 0; s < 4000; s++) out.add(JSON.stringify(pickExchange(character, s)));
  return [...out].map((x) => JSON.parse(x));
}
const anyInnuendo = (lines) => [...lines].some((l) => (Array.isArray(l) ? l.some(isInnuendo) : isInnuendo(l)));

const BUILTIN = {
  spots: { coffee: ['c1', 'c2'], vending: ['v1'], snack: ['s1'], table: ['t1'] },
  characters: { michael: ['m1', "that's what she said"], jim: ['...that’s what she said'], pam: ['p1'] },
  exchanges: [['e1', 'e2'], ['that’s what she said.', 'every time.']],
  twss: [['setup', 'that’s what she said.']],
  keyed: { michael: ['that’s what she said.', '...there it is.'], dwight: ['d1', 'd2'] }
};
const parse = (raw) => parseOfficeLines(raw);

// ─── validation ──────────────────────────────────────────────────────────────

test('validation: strings only; control and bidi characters stripped; length capped', () => {
  assert.equal(cleanLine(42), null);
  assert.equal(cleanLine({}), null);
  assert.equal(cleanLine('   '), null);
  assert.equal(cleanLine('a\u0000b\u001b[31mc\u007f\u202ed\ne'), 'a b [31mc d e');
  const long = cleanLine('x'.repeat(500));
  assert.equal(Array.from(long).length, MAX_LINE_CHARS);
  assert.ok(long.endsWith('…'));
});

test('validation: bad entries are dropped one by one, bad files are null', () => {
  const o = parse({ coffee: ['ok', 7, null, '', 'fine'], snack: 'not a list', table: [] });
  assert.deepEqual(o.spots.coffee, { mode: 'replace', lines: ['ok', 'fine'] });
  assert.equal(o.spots.snack, undefined);
  assert.equal(o.spots.table, undefined, 'an empty pool is ignored, so the built-in one stays');
  assert.equal(parse(null), null);
  assert.equal(parse([]), null);
  assert.equal(parse({ coffee: [1, 2] }), null);
  assert.equal(parse({ vending: { mode: 'shuffle', lines: ['x'] } }), null, 'unknown mode rejects the pool');
  assert.equal(parseOfficeLinesText('{ not json'), null);
  assert.equal(parseOfficeLinesText(JSON.stringify({ coffee: ['x'.repeat(100)] }).padEnd(300 * 1024)), null);
});

test('validation: exchanges need 2+ string beats; one bad beat drops the exchange', () => {
  const o = parse({ exchanges: [['a', 'b'], ['solo'], ['a', 5, 'c'], 'x', Array(20).fill('b')] });
  assert.deepEqual(o.exchanges.lines, [['a', 'b'], Array(MAX_BEATS).fill('b')]);
});

test('validation: pools and character maps are capped; odd character keys are skipped', () => {
  const o = parse({
    coffee: Array.from({ length: 500 }, (_, i) => `l${i}`),
    characters: { Michael: ['hi'], '__proto__': ['x'], 'bad key!': ['x'], jim: 'nope' }
  });
  assert.equal(o.spots.coffee.lines.length, MAX_POOL_ITEMS);
  assert.deepEqual(Object.keys(o.characters), ['michael']);
  assert.equal(Object.getPrototypeOf(o.characters), null);
});

test('validation: a keyed entry may be one exchange or a list of them', () => {
  const o = parse({ keyed: { dwight: ['FALSE.', 'here we go.'], kevin: [['a', 'b'], ['c', 'd']],
    oscar: { mode: 'append', lines: ['well, actually—', '...'] } } });
  assert.deepEqual(o.keyed.dwight.lines, [['FALSE.', 'here we go.']]);
  assert.equal(o.keyed.kevin.lines.length, 2);
  assert.deepEqual(o.keyed.oscar, { mode: 'append', lines: [['well, actually—', '...']] });
});

// ─── merge rules ─────────────────────────────────────────────────────────────

test('merge: pools left out keep the built-in lines', () => {
  const r = resolveOfficeLines(BUILTIN, parse({ coffee: ['mine'] }), { innuendo: true });
  assert.deepEqual(r.spots.coffee, ['mine']);
  assert.deepEqual(r.spots.vending, ['v1']);
  assert.deepEqual(r.characters.pam, ['p1']);
  assert.deepEqual(r.keyed.dwight, [['d1', 'd2']]);
  assert.equal(r.pairs.length, 3);
});

test('merge: replace is the default, append adds after the built-ins', () => {
  const r = resolveOfficeLines(BUILTIN, parse({
    coffee: { mode: 'append', lines: ['c3'] },
    vending: { lines: ['only'] },
    characters: { pam: { mode: 'append', lines: ['p2'] }, dwight: ['FALSE.'] },
    exchanges: [['x', 'y']],
    keyed: { dwight: { mode: 'append', lines: [['d3', 'd4']] } }
  }), { innuendo: true });
  assert.deepEqual(r.spots.coffee, ['c1', 'c2', 'c3']);
  assert.deepEqual(r.spots.vending, ['only']);
  assert.deepEqual(r.characters.pam, ['p1', 'p2']);
  assert.deepEqual(r.characters.dwight, ['FALSE.'], 'a character with no built-in lines can be added');
  assert.deepEqual(r.characters.michael, BUILTIN.characters.michael);
  assert.deepEqual(r.pairs, [['x', 'y'], ...BUILTIN.twss]);
  assert.deepEqual(r.keyed.dwight, [['d1', 'd2'], ['d3', 'd4']]);
});

test('merge: the twss pool is only drawn from when innuendo is allowed', () => {
  const o = parse({ twss: { mode: 'append', lines: [['more', 'that’s what she said.']] } });
  assert.equal(resolveOfficeLines(BUILTIN, o, { innuendo: true }).pairs.length, 4);
  assert.deepEqual(resolveOfficeLines(BUILTIN, o, { innuendo: false }).pairs, [['e1', 'e2']]);
});

// ─── innuendo filter ─────────────────────────────────────────────────────────

test('filter: the catchphrase matches with straight, curly or no apostrophe', () => {
  for (const s of ["that's what she said", 'That’s what she said.', '*whispers* thats  what she said'])
    assert.ok(isInnuendo(s), s);
  assert.ok(!isInnuendo('that is what she wrote'));
});

test('filter: off drops TWSS from every pool and gives Michael and Jim clean lines', () => {
  const r = resolveOfficeLines(BUILTIN, null, { innuendo: false });
  assert.deepEqual(r.characters.michael, ['m1', CLEAN_SOLO.michael]);
  assert.deepEqual(r.characters.jim, [CLEAN_SOLO.jim]);
  assert.deepEqual(r.pairs, [['e1', 'e2']]);
  assert.deepEqual(r.keyed.michael, [CLEAN_KEYED.michael]);
  assert.deepEqual(r.keyed.dwight, [['d1', 'd2']]);
});

test('filter: override lines are filtered too; an emptied spot pool falls back to the built-in', () => {
  const r = resolveOfficeLines(BUILTIN, parse({ coffee: ["that's what she said"], exchanges: [['a', 'that’s what she said']] }), { innuendo: false });
  assert.deepEqual(r.spots.coffee, ['c1', 'c2']);
  assert.deepEqual(r.pairs, [['e1', 'e2']]);
});

test('pickers: with the built-in lines and innuendo off, nobody says it', () => {
  for (const who of CAST) {
    for (const spot of SPOTS) assert.ok(!anyInnuendo(allSolo(who, spot)), `${who} @ ${spot}`);
    assert.ok(!anyInnuendo(allExchanges(who)), `${who} exchanges`);
  }
  assert.ok(allExchanges('michael').some((ex) => ex[0] === CLEAN_KEYED.michael[0]), 'Michael gets his clean opener');
  assert.ok(allSolo('jim', 'coffee').has(CLEAN_SOLO.jim), 'Jim gets his clean catchphrase');
});

test('pickers: innuendo on brings the built-in bits back', () => {
  applyOfficeLinesSettings({ innuendo: true });
  assert.ok(anyInnuendo(allSolo('michael', 'coffee')));
  assert.ok(anyInnuendo(allExchanges('pam')));
  assert.ok(allExchanges('michael').some((ex) => ex[0] === 'that’s what she said.'));
});

test('pickers: read the live override, and small talk can be switched off', () => {
  applyOfficeLinesOverride(parse({ coffee: ['only this'], characters: { toby: ['hi'] } }));
  assert.deepEqual([...allSolo('pam', 'coffee', { spotOnly: true })], ['only this']);
  assert.ok(allSolo('toby', 'table').has('hi'));
  assert.equal(officeSmallTalkEnabled(), true);
  applyOfficeLinesSettings({ smallTalk: false });
  assert.equal(officeSmallTalkEnabled(), false);
});

// ─── main-side loader and the shipped example ───────────────────────────────

test('loader: a missing or broken file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-lines-'));
  assert.equal(loadOfficeLines(dir), null);
  fs.writeFileSync(path.join(dir, 'office-lines.json'), '{ nope');
  assert.equal(loadOfficeLines(dir), null);
  fs.writeFileSync(path.join(dir, 'office-lines.json'), JSON.stringify({ snack: ['cake'] }));
  assert.deepEqual(loadOfficeLines(dir).spots.snack.lines, ['cake']);
});

test('example: docs/office-lines.example.json is a full, innuendo-free set', () => {
  const raw = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  const o = parseOfficeLines(raw);
  for (const spot of SPOTS) assert.ok(o.spots[spot].lines.length >= 4, spot);
  for (const who of CAST) assert.ok(o.characters[who]?.lines.length >= 2, `characters.${who}`);
  assert.ok(o.exchanges.lines.length >= 20);
  assert.ok(o.keyed.michael && o.keyed.jim);
  assert.equal(o.twss, undefined);
  // Nothing was dropped or trimmed by validation…
  for (const spot of SPOTS) assert.deepEqual(o.spots[spot].lines, raw[spot], spot);
  for (const who of CAST) assert.deepEqual(o.characters[who].lines, raw.characters[who], who);
  assert.deepEqual(o.exchanges.lines, raw.exchanges);
  const flat = JSON.stringify(raw);
  // …and it is clean even with innuendo allowed.
  const r = resolveOfficeLines({ spots: {}, characters: {}, exchanges: [], twss: [], keyed: {} }, o, { innuendo: true });
  assert.ok(!anyInnuendo(Object.values(r.characters).flat()));
  assert.ok(!anyInnuendo(r.pairs));
  assert.ok(!isInnuendo(flat));
});
