'use strict';

/**
 * T-056: drift visibility (src/main/custom/drift.ts). The harness checks god's
 * cards, asks, spawn requests and unreadable outbox messages against his rules,
 * tells him once per breach through the hook context, logs it as god-drift, and
 * counts open breaches in the heartbeat digest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const orch = loadTs('src/main/custom/orchestrator.ts');
const levers = loadTs('src/main/custom/levers.ts');
const { scanDrift, askProblems, driftDigestLine, resetDriftReports } = loadTs('src/main/custom/drift.ts');
const { slimHeartbeatDigest } = loadTs('src/main/custom/wake.ts');
const { resolveOrchestratorLevers, ORCHESTRATOR_LEVERS_OFF } = loadTs('src/shared/custom/orchestratorLevers.ts');

const ROOT = path.join(__dirname, '..');
const GOOD_ASK = '**Pick the provider for T-1.**\n\n- Stripe\n- PayPal';

async function floor(t, config = {}) {
  orch.setOrchestratorLeversSource(config === null ? null : () => config);
  levers.setCostLeversSource(config === null ? null : () => config);
  t.after(() => { orch.setOrchestratorLeversSource(null); levers.setCostLeversSource(null); });
  resetDriftReports();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-drift-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Kevin', provider: 'claude', cwd: home });
  const root = hive.root();
  const setTasks = (tasks) => fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }));
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  const prompt = async (agent = 'god', sid = 's1') => (await server.handle({ agent_id: agent, hook_event_name: 'UserPromptSubmit', session_id: sid }))?.hookSpecificOutput?.additionalContext ?? '';
  return { hive, root, setTasks, prompt };
}

test('lever: on by default, off before install', () => {
  assert.equal(resolveOrchestratorLevers({}).driftNotice, true);
  assert.equal(ORCHESTRATOR_LEVERS_OFF.driftNotice, false);
});

test('ask shape rules match the prompt and the CLI', () => {
  assert.deepEqual(askProblems(GOOD_ASK), []);
  assert.equal(askProblems('x'.repeat(800)).length, 3);
  assert.deepEqual(askProblems('**Bold.** no list'), ['no listed options']);
});

test('scan: each rule fires on a real breach and stays quiet on the healthy case', async (t) => {
  const { hive, root, setTasks } = await floor(t);
  setTasks([
    { id: 'T-1', status: 'doing', assignee: 'w1', humanQA: [{ q: GOOD_ASK, askedAt: 'x' }] },
    { id: 'T-2', status: 'todo', assignee: null },
    { id: 'T-3', status: 'done', assignee: null },
    { id: 'T-4', status: 'blocked', assignee: 'w1', humanQA: [{ q: 'A long report. '.repeat(60), askedAt: 'x' }, { q: 'answered, any shape', a: 'yes' }] }
  ]);
  fs.mkdirSync(path.join(root, 'spawn-requests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'spawn-requests', 'qa-1.json'), '{}');
  fs.mkdirSync(path.join(root, 'agents', 'god', 'outbox', '.sent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'god', 'outbox', '.sent', 'bad-m7.json'), '{oops');
  fs.writeFileSync(path.join(root, 'agents', 'god', 'outbox', '.sent', 'm8.json'), '{}');
  const keys = scanDrift(hive).map((b) => b.key).sort();
  assert.deepEqual(keys, ['ask:T-4:0', 'assignee:T-3:done', 'outbox:bad-m7.json', 'spawn:qa-1.json']);
  hive.setOrchestratorMaySpawn(true);
  assert.ok(!scanDrift(hive).some((b) => b.rule === 'spawn'), 'a spawn request is fine when spawning is on');
});

test('notice: god is told once per breach, through the hook context; logged as god-drift', async (t) => {
  const { root, setTasks, prompt } = await floor(t);
  setTasks([{ id: 'T-3', status: 'done', assignee: null }]);
  const first = await prompt();
  assert.match(first, /RULE CHECK: the harness found 1 thing/);
  assert.match(first, /Card T-3 is done with no assignee/);
  assert.doesNotMatch(await prompt(), /RULE CHECK/, 'not repeated');
  setTasks([{ id: 'T-3', status: 'done', assignee: null }, { id: 'T-5', status: 'doing', assignee: null }]);
  const next = await prompt();
  assert.match(next, /Card T-5 is doing/);
  assert.doesNotMatch(next, /T-3/, 'only the new one');
  assert.doesNotMatch(await prompt('w1'), /RULE CHECK/, 'workers are not checked');
  const log = fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8');
  assert.equal((log.match(/"kind":"god-drift"/g) ?? []).length, 2);
});

test('notice: off with the lever, or before install', async (t) => {
  const off = await floor(t, { orchestrator: { driftNotice: false } });
  off.setTasks([{ id: 'T-3', status: 'done', assignee: null }]);
  assert.doesNotMatch(await off.prompt(), /RULE CHECK/);
  const none = await floor(t, null);
  none.setTasks([{ id: 'T-3', status: 'done', assignee: null }]);
  assert.doesNotMatch(await none.prompt(), /RULE CHECK/);
});

test('heartbeat: the slim digest carries one rule-check line when something is open', async (t) => {
  const { hive, setTasks } = await floor(t);
  setTasks([{ id: 'T-1', status: 'doing', assignee: 'w1' }]);
  assert.equal(driftDigestLine(hive), '');
  assert.doesNotMatch(slimHeartbeatDigest(hive, 600000, 0), /Rule check/);
  setTasks([{ id: 'T-3', status: 'done', assignee: null }]);
  hive.appendLog({ kind: 'god-guard', agentId: 'god', tool: 'Bash', blocked: 'git commit' });
  const line = driftDigestLine(hive);
  assert.equal(line, 'Rule check: 1 open breach(es) (assignee 1); 1 blocked attempt(s) to change a project in the recent log.');
  assert.ok(slimHeartbeatDigest(hive, 600000, 0).includes(line));
});

test('seams: hooks.ts reuses the T-053 lines; no new upstream line', () => {
  const hooks = fs.readFileSync(path.join(ROOT, 'src/main/hooks.ts'), 'utf8');
  assert.equal(hooks.split('\n').filter((l) => l.includes('T-056')).length, 2, 'the T-053 import and anchor lines only');
  assert.ok(hooks.includes('driftNotice(this.hive, agentId, event)'));
  const index = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  assert.ok(!index.includes('T-056'), 'index.ts untouched');
});
