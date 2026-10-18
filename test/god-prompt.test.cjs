'use strict';

/**
 * T-052: god prompt V2 and the spawn-off notice (src/main/custom/godPrompt.ts),
 * the orchestrator levers (src/shared/custom/orchestratorLevers.ts) and the V2
 * orientation prompt (src/shared/custom/godOrientation.ts).
 *
 * The drift guard at the bottom fails when upstream edits the god text V2
 * rewrites. When it does: read upstream's change, port what matters into
 * godPrompt.ts / godOrientation.ts, then update the hash here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const orch = loadTs('src/main/custom/orchestrator.ts');
const cost = loadTs('src/main/custom/levers.ts');
const { SPAWN_OFF_TEXT, buildGodPrompt } = loadTs('src/main/custom/godPrompt.ts');
const { resolveOrchestratorLevers, ORCHESTRATOR_LEVERS_ON } = loadTs('src/shared/custom/orchestratorLevers.ts');
const { godOrientation } = loadTs('src/shared/custom/godOrientation.ts');
const { ASK_FIRST_CLAUSE } = loadTs('src/main/askFirst.ts');

const ROOT = path.join(__dirname, '..');
const GOD = { id: 'god', name: 'Michael', isGod: true, provider: 'claude' };
const WORKER = { id: 'w1', name: 'Kevin', provider: 'claude' };

/** The prompt for one agent under a config (null = no source installed). */
async function promptFor(t, meta, config, { maySpawn = false } = {}) {
  orch.setOrchestratorLeversSource(config === null ? null : () => config);
  cost.setCostLeversSource(config === null ? null : () => config);
  t.after(() => { orch.setOrchestratorLeversSource(null); cost.setCostLeversSource(null); });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-godprompt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.setOrchestratorMaySpawn(maySpawn);
  const inj = await hive.ensureAgent({ ...meta, cwd: home }, {});
  const i = inj.args.indexOf('--append-system-prompt');
  return inj.args[i + 1].split(home).join('<HOME>');
}
const V2 = { orchestrator: { godPromptV2: true } };

// — levers —

test('levers: fork defaults, typed overrides, junk ignored', () => {
  assert.deepEqual(resolveOrchestratorLevers({}), ORCHESTRATOR_LEVERS_ON);
  assert.equal(ORCHESTRATOR_LEVERS_ON.godPromptV2, false, 'V2 ships off until the eval shows a win');
  assert.equal(ORCHESTRATOR_LEVERS_ON.spawnOffNotice, true);
  const l = resolveOrchestratorLevers({ orchestrator: { godPromptV2: true, reviewPolicy: 'always', integrationBranch: 'stable', autoMergeWhenGreen: 'yes' } });
  assert.deepEqual([l.godPromptV2, l.reviewPolicy, l.integrationBranch, l.autoMergeWhenGreen], [true, 'always', 'stable', false]);
  const bad = resolveOrchestratorLevers({ orchestrator: { reviewPolicy: 'never', integrationBranch: 'main`; rm -rf' } });
  assert.deepEqual([bad.reviewPolicy, bad.integrationBranch], ['nontrivial', '']);
});

// — upstream path (V2 off) —

test('no source installed: god prompt is upstream, no fork text', async (t) => {
  const p = await promptFor(t, GOD, null);
  assert.ok(p.includes('You are the GOD / ORCHESTRATOR of this hive'));
  assert.ok(!p.includes('SPAWNING IS OFF'));
  assert.ok(!p.includes('## Hard rules'));
});

test('levers switched off read the same as no source', async (t) => {
  const off = await promptFor(t, GOD, { orchestrator: { spawnOffNotice: false }, costLevers: Object.fromEntries(Object.keys(loadTs('src/shared/custom/costLevers.ts').COST_LEVERS_ON).map((k) => [k, k === 'leanDisabledPlugins' ? [] : false])) });
  assert.equal(off, await promptFor(t, GOD, null));
});

test('spawn-off notice (G4): only for god, only when spawning is off', async (t) => {
  assert.ok((await promptFor(t, GOD, {}, { maySpawn: false })).includes(SPAWN_OFF_TEXT));
  const on = await promptFor(t, GOD, {}, { maySpawn: true });
  assert.ok(!on.includes('SPAWNING IS OFF') && on.includes('SPAWNING A WORKER'));
  assert.ok(!(await promptFor(t, WORKER, {})).includes('SPAWNING IS OFF'));
});

test('V2 leaves worker prompts untouched', async (t) => {
  assert.equal(await promptFor(t, WORKER, V2), await promptFor(t, WORKER, {}));
});

// — V2 —

test('V2: identity first, hard rules in order, precedence, no worker protocol header', async (t) => {
  const p = await promptFor(t, GOD, V2);
  assert.match(p, /^You are "Michael" \(god\), the orchestrator of this hive/);
  assert.ok(!p.includes('an autonomous agent in a collaborating hive'));
  assert.ok(!p.includes('HIVE PROTOCOL'));
  assert.ok(!/fully autonomous/i.test(p));
  const at = (s) => { const i = p.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at('## Hard rules') < at('1. Never edit files, commit') && at('1. Never edit files') < at('2. Merge into') && at('2. Merge into') < at('3. You are the only writer') && at('3. You are the only writer') < at('5. Report outcomes faithfully'));
  at('## When rules conflict');
  at('for that one action only');
});

test('V2 keeps every upstream duty: inbox, outbox, memory, roster, contract, assignee, humanQA, heartbeat', async (t) => {
  const p = await promptFor(t, GOD, V2);
  for (const s of ['<HOME>/hive/agents/god/memory.md', '<HOME>/hive/agents/god/inbox/.done', '<HOME>/hive/agents/god/outbox',
    'registry.json', 'fleet.json', 'OBJECTIVE', 'OUTPUT', 'TOOLS', 'BOUNDARIES', '"assignee"', 'humanQA', '"blocked"', 'ASK ME',
    'heartbeat', 'Circuit breaker', 'LIVE CONTEXT', 'Env vars available to you']) {
    assert.ok(p.includes(s), `V2 lost: ${s}`);
  }
  assert.ok(p.includes(ASK_FIRST_CLAUSE), 'ask-first clause verbatim');
  assert.ok(p.includes('**Pick the payment provider for T-914.**'), 'worked example');
});

test('V2 spawn: upstream spawn line when on, plain refusal when off', async (t) => {
  const on = await promptFor(t, GOD, V2, { maySpawn: true });
  assert.ok(on.includes('SPAWNING A WORKER') && !on.includes('SPAWNING IS OFF'));
  const off = await promptFor(t, GOD, V2, { maySpawn: false });
  assert.ok(off.includes(SPAWN_OFF_TEXT) && !off.includes('SPAWNING A WORKER'));
  assert.equal(off.split(SPAWN_OFF_TEXT).length, 2, 'said once, not twice');
});

test('V2 is engine-aware: Claude-only advice only for Claude', () => {
  const parts = { dir: '/h/a', root: '/h', maySpawn: false, askFirst: true, guardrailsLine: 'G', memoryLine: '', knowledgeLine: '', spawnQueueLine: '', runtimeLine: '', slackLine: '', ctxLine: '' };
  const claude = buildGodPrompt(GOD, parts, ORCHESTRATOR_LEVERS_ON);
  const codex = buildGodPrompt({ ...GOD, provider: 'codex' }, parts, ORCHESTRATOR_LEVERS_ON);
  assert.ok(claude.includes('claude agents') && claude.includes('COMMANDS.md'));
  assert.ok(!codex.includes('claude agents') && !codex.includes('COMMANDS.md'));
  assert.ok(!/\n\n\n/.test(codex) && !codex.includes('\nnull'), 'optional lines leave no gaps');
});

test('V2 merge and review rules follow the levers', () => {
  const parts = { dir: '/h/a', root: '/h', maySpawn: true, askFirst: false, guardrailsLine: '', memoryLine: '', knowledgeLine: '', spawnQueueLine: 'SQ', runtimeLine: '', slackLine: '', ctxLine: '' };
  const base = buildGodPrompt(GOD, parts, ORCHESTRATOR_LEVERS_ON);
  assert.ok(base.includes('only when the human has said yes for that task'));
  assert.ok(base.includes("the project's integration branch"));
  assert.ok(base.includes('more than one file'));
  assert.ok(!base.includes('ASK FIRST'), 'ask-first off: no clause, no DECISION NEEDED line');
  const auto = buildGodPrompt(GOD, parts, { ...ORCHESTRATOR_LEVERS_ON, autoMergeWhenGreen: true, reviewPolicy: 'always', integrationBranch: 'stable' });
  assert.ok(auto.includes('because auto-merge is switched on'));
  assert.ok(auto.includes('Every change is reviewed by a different agent'));
  assert.ok(auto.includes('(`stable`)') && auto.includes('up to date with `stable`'));
});

test('V2 is deterministic for the same agent (prompt-cache rule)', async (t) => {
  assert.equal(await promptFor(t, GOD, V2), await promptFor(t, GOD, V2));
});

// — orientation —

test('orientation: null with V2 off (upstream text), engine-neutral with V2 on', () => {
  assert.equal(godOrientation({}, 'Michael'), null);
  assert.equal(godOrientation(null, 'Michael'), null);
  const o = godOrientation(V2, 'Dwight');
  assert.match(o, /^You're online as Dwight, the orchestrator/);
  assert.ok(!/fully autonomous|claude agents|COMMANDS\.md/.test(o));
  assert.ok(o.includes('hard rules'));
});

// — seams and drift —

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const hash = (s) => crypto.createHash('sha256').update(norm(s)).digest('hex').slice(0, 16);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `anchor gone: ${a}`); const j = s.indexOf(b, i); assert.ok(j > i, `anchor gone: ${b}`); return s.slice(i, j); };

test('seams: each T-052 seam is one marked line', () => {
  const hive = read('src/main/hive.ts');
  assert.equal(hive.split('\n').filter((l) => l.includes('// fork: T-052')).length, 3, 'import, V2 switch, spawn-off line');
  assert.ok(/godPromptV2\(meta, \{[^\n]*\}\); if \(v2 !== null\) return v2; \/\/ fork: T-052/.test(hive));
  assert.ok(/spawnOffLine\(meta, this\.orchestratorMaySpawn\(\)\), \/\/ fork: T-052/.test(hive));
  const ui = read('src/renderer/src/hooks/useHive.ts');
  assert.equal(ui.split('\n').filter((l) => l.includes('// fork: T-052')).length, 2, 'import, orientation call');
  assert.ok(ui.includes('godOrientation(config, godName) ?? INITIAL_GOD_PROMPT'));
  assert.ok(read('src/main/custom/install.ts').includes('setOrchestratorLeversSource(readConfig)'));
});

test('drift: upstream god text that V2 rewrites is unchanged (else review godPrompt.ts)', () => {
  const hive = read('src/main/hive.ts');
  const ui = read('src/renderer/src/hooks/useHive.ts');
  const parts = {
    // Upstream's god paragraph, rewritten by buildGodPrompt.
    godLine: between(hive, 'const godLine = meta.isGod', ': meta.isAssistant'),
    // The worker protocol header and steps, rewritten as V2's "Each turn".
    protocol: between(hive, '`You are "${meta.name}" (${meta.id}), an autonomous agent', 'guardrailsLine,'),
    // The orientation prompt, rewritten by godOrientation.
    orientation: between(ui, 'const INITIAL_GOD_PROMPT', "].join('\\n');")
  };
  const want = { godLine: 'a35f371e6d35596e', protocol: 'dc91ec37574b7615', orientation: 'a69a979f1c38f29c' };
  for (const [k, h] of Object.entries(want)) {
    assert.equal(hash(parts[k]), h, `upstream changed the ${k} text that god prompt V2 rewrites: port the change into src/main/custom/godPrompt.ts or src/shared/custom/godOrientation.ts, then update this hash`);
  }
});
