'use strict';
/**
 * Clone agent (T-029). The approved design is .lavish/clone-agent-mockups.html:
 * the clone is the Add Agent form pre-filled from a source agent, with field
 * tags, a locked new worktree for isolated sources, an opt-in memory snapshot,
 * clonedFrom in the registry and an inform message to god.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const {
  buildCloneDraft, stripSessionFlags, suggestCloneName, nameClash, nextAccent,
  cloneBlock, memorySnapshot, cloneInformBody
} = loadTs('src/shared/cloneAgent.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

const JIM = Object.freeze({
  id: 'jim-muma2v2m', name: 'Jim', character: 'jim', accent: 'sky',
  description: 'senior engineer', goal: 'ship T-029', cwd: '/repo/munder-difflin',
  command: 'claude --model opus --resume 4f07-88 --effort medium', provider: 'claude', model: 'opus',
  worktreePath: '/hive/worktrees/jim-muma2v2m', role: 'engineer', capabilities: Object.freeze(['dev', 'testing']),
  note: 'on T-029', onHold: true, status: 'working', ptyId: 'pty-jim'
});
const ctx = (over = {}) => ({ activeNames: ['Michael', 'Jim', 'Dwight'], usedAccents: ['lemon', 'sky', 'coral'], accents: ACCENTS, tokenCap: 2000000, ...over });

// ── field mapping ────────────────────────────────────────────────────────────

test('copied fields come across as is', () => {
  const d = buildCloneDraft(JIM, ctx());
  assert.equal(d.character, 'jim');
  assert.equal(d.provider, 'claude');
  assert.equal(d.model, 'opus');
  assert.equal(d.description, 'senior engineer');
  assert.equal(d.goal, 'ship T-029');
  assert.equal(d.cwd, '/repo/munder-difflin');
  assert.equal(d.role, 'engineer');
  assert.deepEqual(d.capabilities, ['dev', 'testing']);
  assert.equal(d.tokenCap, 2000000);
  for (const f of ['character', 'provider', 'model', 'description', 'goal', 'project', 'tokenCap']) {
    assert.equal(d.tags[f], 'copied', f);
  }
});

test('name, color and command are changed; session state is not copied', () => {
  const d = buildCloneDraft(JIM, ctx());
  assert.equal(d.name, 'Jim 2');
  assert.equal(d.tags.name, 'changed');
  assert.notEqual(d.accent, 'sky');
  assert.ok(!['lemon', 'sky', 'coral'].includes(d.accent), 'next UNUSED accent');
  assert.equal(d.tags.color, 'changed');
  assert.equal(d.command, 'claude --model opus --effort medium');
  assert.equal(d.tags.command, 'changed');
  assert.equal(d.tags.resumeSession, 'notCopied');
  for (const k of ['note', 'onHold', 'status', 'ptyId', 'sessionId', 'inbox']) assert.ok(!(k in d), k);
});

test('session-bound flags are stripped, everything else kept', () => {
  assert.equal(stripSessionFlags('claude --resume abc --model opus'), 'claude --model opus');
  assert.equal(stripSessionFlags('claude --session-id=1234 --model opus'), 'claude --model opus');
  assert.equal(stripSessionFlags('claude --continue --fork-session -p'), 'claude -p');
  assert.equal(stripSessionFlags('agy --conversation c-9 --model "Gemini 3.1 Pro (High)"'), 'agy --model "Gemini 3.1 Pro (High)"');
  assert.equal(stripSessionFlags('claude --resume --model opus'), 'claude --model opus', 'a bare --resume does not eat the next flag');
  const plain = buildCloneDraft({ ...JIM, command: 'claude --model opus' }, ctx());
  assert.equal(plain.tags.command, 'copied');
});

test('memory is opt-in; start now and tell god default on', () => {
  const d = buildCloneDraft(JIM, ctx());
  assert.equal(d.copyMemory, false);
  assert.equal(d.startNow, true);
  assert.equal(d.tellGod, true);
});

// ── names ────────────────────────────────────────────────────────────────────

test('the suggested name is the next free one, counting active agents only', () => {
  assert.equal(suggestCloneName('Jim', ['Jim']), 'Jim 2');
  assert.equal(suggestCloneName('Jim', ['Jim', 'jim 2']), 'Jim 3');
  assert.equal(suggestCloneName('Jim 2', ['Jim', 'Jim 2']), 'Jim 3');
  // An archived "Jim 2" is not in the active list, so the name is free again.
  assert.equal(suggestCloneName('Jim', ['Jim']), 'Jim 2');
});

test('a clash is reported for active names only, case-insensitively', () => {
  assert.equal(nameClash('dwight', ['Michael', 'Dwight']), true);
  assert.equal(nameClash('  Dwight ', ['Dwight']), true);
  assert.equal(nameClash('Pam', ['Michael', 'Dwight']), false, 'archived Pam is not in the active list');
  assert.equal(nameClash('', ['Dwight']), false);
});

test('nextAccent skips used colours and falls back to the source when all are used', () => {
  assert.equal(nextAccent('sky', ['sky', 'lemon'], ACCENTS), 'lilac');
  assert.equal(nextAccent('peach', ACCENTS, ACCENTS), 'peach');
});

// ── who can be cloned ────────────────────────────────────────────────────────

test('god and the prep assistant are not cloneable', () => {
  assert.equal(cloneBlock({ isGod: true }), 'god');
  assert.equal(cloneBlock({ isAssistant: true }), 'assistant');
  assert.equal(cloneBlock(JIM), null);
  const menu = read('src/renderer/src/components/AgentCardMenu.tsx');
  assert.match(menu, /disabled: !!blocked/);
  assert.match(read('src/renderer/src/components/CommandCenterPanel.tsx'), /!a\.isGod && !a\.isAssistant && \(/);
});

// ── worktree ─────────────────────────────────────────────────────────────────

test('an isolated source always gives the clone a NEW, locked worktree', () => {
  const d = buildCloneDraft(JIM, ctx());
  assert.equal(d.isolate, true);
  assert.equal(d.isolateLocked, true);
  assert.equal(d.tags.isolation, 'check');
  const plain = buildCloneDraft({ ...JIM, worktreePath: undefined }, ctx());
  assert.equal(plain.isolate, false);
  assert.equal(plain.isolateLocked, false);
  // The form locks the box; spawn sends isolate with the NEW id, so main cuts
  // worktrees/<newId> on branch agent/<newId>.
  const modal = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(modal, /disabled=\{resuming \|\| !!draft\?\.isolateLocked\}/);
  // The clone starts from the PROJECT folder, not the source's worktree.
  assert.match(modal, /window\.cth\.gitMainRepo\?\.\(cloneSrc\.worktreePath\)/);
  // A clone created stopped cuts its worktree on first start, never shares the folder.
  assert.match(read('src/renderer/src/hooks/useRestoreTeam.ts'), /isolate: a\.isolateOnStart === true && !a\.worktreePath/);
});

// ── archived source, missing folder ──────────────────────────────────────────

test('an archived source with a missing folder blocks hire until a folder is picked', () => {
  const d = buildCloneDraft({ ...JIM, archived: true, cwdValid: false }, ctx());
  assert.equal(d.cwdMissing, true);
  assert.equal(d.cwd, '', 'the form starts with no folder, so submit stops');
  assert.equal(d.tags.project, 'check');
  const modal = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(modal, /if \(!cwd\) \{ setError\(cloning && cwdMissing \? tr\('clone\.errFolderMissing'\)/);
  // Archived agents are a source: the modal looks them up too.
  assert.match(modal, /st\.archivedAgents\.find\(\(a\) => a\.id === cloneSourceId\)/);
});

test('building a draft never mutates the source', () => {
  const before = JSON.stringify(JIM);
  const d = buildCloneDraft(JIM, ctx());
  d.capabilities.push('x');
  assert.equal(JSON.stringify(JIM), before);
});

// ── main process: registry, memory, inform ───────────────────────────────────

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', cwd: home, role: 'engineer', capabilities: ['dev'] });
  fs.appendFileSync(path.join(hive.root(), 'agents', 'jim-1', 'memory.md'), '- knows the hook socket story\n');
  await hive.ensureAgent({ id: 'jim-2', name: 'Jim 2', cwd: home, role: 'engineer', capabilities: ['dev'] });
  return hive;
}

test('cloneSetup records clonedFrom and snapshots memory under a header line', async (t) => {
  const hive = await floor(t);
  const srcMemBefore = hive.memory('jim-1');
  const srcRegBefore = JSON.stringify(hive.registry().agents['jim-1']);
  const r = hive.cloneSetup({ sourceId: 'jim-1', newId: 'jim-2', copyMemory: true, date: '2026-10-04' });
  assert.deepEqual(r, { ok: true });
  assert.equal(hive.registry().agents['jim-2'].clonedFrom, 'jim-1');
  const mem = hive.memory('jim-2');
  assert.equal(mem.split('\n')[0], 'Cloned from Jim on 2026-10-04');
  assert.ok(mem.includes('knows the hook socket story'));
  // The source is untouched.
  assert.equal(hive.memory('jim-1'), srcMemBefore);
  const srcAfter = hive.registry().agents['jim-1'];
  assert.equal(JSON.stringify({ ...srcAfter, lastSeen: undefined }), JSON.stringify({ ...JSON.parse(srcRegBefore), lastSeen: undefined }));
  assert.equal(memorySnapshot('x', 'Jim', '2026-10-04').split('\n')[0], 'Cloned from Jim on 2026-10-04');
});

test('without the memory option the clone keeps its fresh memory.md', async (t) => {
  const hive = await floor(t);
  hive.cloneSetup({ sourceId: 'jim-1', newId: 'jim-2', copyMemory: false });
  const mem = hive.memory('jim-2');
  assert.ok(!mem.includes('knows the hook socket story'));
  assert.match(mem, /^# Memory — Jim 2/);
});

test('god gets an inform message about the clone when asked', async (t) => {
  const hive = await floor(t);
  hive.cloneSetup({ sourceId: 'jim-1', newId: 'jim-2', tellGod: true });
  const inbox = hive.inbox('god');
  const msg = inbox.find((m) => /clone of Jim/.test(m.subject ?? ''));
  assert.ok(msg, JSON.stringify(inbox.map((m) => m.subject)));
  assert.equal(msg.act, 'inform');
  assert.equal(msg.body, cloneInformBody('Jim 2', 'Jim'));
  const quiet = await floor(t);
  quiet.cloneSetup({ sourceId: 'jim-1', newId: 'jim-2', tellGod: false });
  assert.equal(quiet.inbox('god').filter((m) => /clone of/.test(m.subject ?? '')).length, 0);
});

test('cloneSetup refuses god as a source and unknown agents', async (t) => {
  const hive = await floor(t);
  assert.equal(hive.cloneSetup({ sourceId: 'god', newId: 'jim-2' }).ok, false);
  assert.equal(hive.cloneSetup({ sourceId: 'nobody', newId: 'jim-2' }).ok, false);
  assert.equal(hive.cloneSetup({ sourceId: 'jim-1', newId: 'nobody' }).ok, false);
  assert.equal(hive.registry().agents['jim-2'].clonedFrom, undefined);
});

// ── i18n ─────────────────────────────────────────────────────────────────────

test('every clone string exists in en, ar and zh-CN', () => {
  const keysOf = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keysOf(v, `${pre}${k}.`) : [`${pre}${k}`]);
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  const want = [...keysOf(en.clone, 'clone.'), ...keysOf(en.cardMenu, 'cardMenu.')];
  assert.ok(want.length > 30);
  for (const loc of ['ar', 'zh-CN']) {
    const d = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    const have = new Set([...keysOf(d.clone ?? {}, 'clone.'), ...keysOf(d.cardMenu ?? {}, 'cardMenu.')]);
    assert.deepEqual(want.filter((k) => !have.has(k)), [], loc);
  }
});
