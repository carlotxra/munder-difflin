'use strict';

/**
 * config.askFirst ("Workers ask before ambiguous decisions", default ON) adds
 * the ask-first rule to the hive prompts: workers get the DECISION NEEDED rule,
 * god gets the dispatch-BOUNDARIES clause plus how to answer one. OFF must leave
 * the prompts exactly as they were, and an unset value must read as ON.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { ASK_FIRST_CLAUSE, askFirstPromptLine } = loadTs('src/main/askFirst.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WORKER = { id: 'worker-x', name: 'Worker X', provider: 'claude' };
const GOD = { id: 'god-1', name: 'Michael', provider: 'claude', isGod: true };
const ASSISTANT = { id: 'prep-1', name: 'Prep', provider: 'claude', isAssistant: true };

/** The injected system prompt for one agent, with the toggle set (or left unset). */
async function promptFor(t, meta, askFirst) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-askfirst-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  if (askFirst !== undefined) hive.setAskFirst(askFirst);
  const inj = await hive.ensureAgent({ ...meta, cwd: home }, {});
  const i = inj.args.indexOf('--append-system-prompt');
  assert.ok(i >= 0, 'the hive protocol must be on argv');
  // Each call gets its own temp home; mask it so two prompts compare byte-for-byte.
  return inj.args[i + 1].split(home).join('<HOME>');
}

test('ON: a worker gets the DECISION NEEDED rule in its HIVE PROTOCOL', async (t) => {
  const p = await promptFor(t, WORKER, true);
  assert.ok(p.includes(ASK_FIRST_CLAUSE));
  assert.ok(p.indexOf('HIVE PROTOCOL') < p.indexOf(ASK_FIRST_CLAUSE), 'inside the protocol block');
  assert.ok(p.includes("subject 'DECISION NEEDED: <topic>'"));
  assert.ok(p.includes('NOT for tool calls, routine implementation choices'));
});

test('ON: god must carry the clause in BOUNDARIES and knows how to answer', async (t) => {
  const p = await promptFor(t, GOD, true);
  assert.match(p, /BOUNDARIES part of every dispatch contract must carry this clause, verbatim: "ASK FIRST: If you reach/);
  assert.ok(p.includes(ASK_FIRST_CLAUSE));
  assert.ok(p.includes("When a worker sends you a 'DECISION NEEDED: <topic>' message, decide it yourself"));
  assert.ok(p.includes('humanQA'), 'escalates through the card, not a side file');
  assert.ok(p.includes('set the card "blocked"'));
});

test('unset reads as ON', async (t) => {
  assert.equal(await promptFor(t, WORKER, undefined), await promptFor(t, WORKER, true));
  assert.equal(await promptFor(t, GOD, undefined), await promptFor(t, GOD, true));
});

test('OFF: nothing is emitted, and the only difference from ON is the added line', async (t) => {
  for (const meta of [WORKER, GOD]) {
    const on = await promptFor(t, meta, true);
    const off = await promptFor(t, meta, false);
    assert.ok(!off.includes('DECISION NEEDED'), `${meta.id}: no rule when off`);
    assert.ok(!off.includes('ASK FIRST'), `${meta.id}: no rule when off`);
    const added = askFirstPromptLine(meta, true);
    assert.equal(on.split('\n').filter((l) => l !== added).join('\n'), off, `${meta.id}: off == on minus the one line`);
  }
});

test('the prep assistant never gets the rule (it makes no design calls)', async (t) => {
  const p = await promptFor(t, ASSISTANT, true);
  assert.ok(!p.includes('DECISION NEEDED'));
});

test('config: default ON in main DEFAULTS, mirrored in preload and renderer types', () => {
  assert.match(read('src/main/config.ts'), /askFirst\?: boolean;/);
  assert.match(read('src/main/config.ts'), /askFirst: true,/);
  assert.match(read('src/preload/index.ts'), /askFirst\?: boolean;/);
  assert.match(read('src/renderer/src/store/config.ts'), /askFirst\?: boolean;/);
});

test('main keeps the hive mirror current at bootstrap and on every config write', () => {
  const src = read('src/main/index.ts');
  assert.ok(src.includes('hive.setAskFirst(readConfig().askFirst !== false)'), 'bootstrap: unset = ON');
  assert.ok(src.includes("if (typeof patch?.askFirst === 'boolean') hive.setAskFirst(patch.askFirst)"), 'config write');
});

test('Settings toggle reads unset as ON and is labelled in every locale', () => {
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(modal.includes('config.askFirst !== false'));
  assert.ok(modal.includes('stage({ askFirst: next })'));
  assert.ok(modal.includes("t('settings.autonomy.workersAskFirst')"));
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const a = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`)).settings.autonomy;
    assert.ok(a.workersAskFirst && a.workersAskFirstDesc, `${loc} carries both strings`);
  }
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json')).settings.autonomy;
  assert.equal(en.workersAskFirst, 'Workers ask before ambiguous decisions');
});
