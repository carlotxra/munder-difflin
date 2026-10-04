'use strict';
/**
 * T-034 cost levers (src/main/custom, src/shared/custom, src/renderer/src/custom).
 *
 * Every lever is off until the app installs a config source, so upstream's own
 * tests keep testing upstream behaviour. These tests turn the levers on and pin
 * what each one does, and that every prompt override still matches upstream's
 * wording (an upstream rewrite makes the override miss, and the test names it).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { resolveCostLevers, COST_LEVERS_ON, COST_LEVERS_OFF } = loadTs('src/shared/custom/costLevers.ts');
const levers = loadTs('src/main/custom/levers.ts');
const { toonTable, toonCell, shortRole, breakerArmed } = loadTs('src/shared/custom/rosterTable.ts');
const roster = loadTs('src/main/custom/roster.ts');
const trim = loadTs('src/main/custom/promptTrim.ts');
const { isMechanicalMail, shortNudgeText } = loadTs('src/shared/custom/wake.ts');
const mainWake = loadTs('src/main/custom/wake.ts');
const closing = loadTs('src/main/custom/closingTime.ts');
const { isInboxNudge, inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { ClosingTimeController } = loadTs('src/main/closingTime.ts');
const { ControlRegistry } = loadTs('src/main/control.ts');
const { ASK_FIRST_CLAUSE } = loadTs('src/main/askFirst.ts');

/** Turn levers on for one test (all on, or a partial override). */
function withLevers(t, overrides = {}) {
  const cfg = { costLevers: overrides };
  levers.setCostLeversSource(() => cfg);
  t.after(() => levers.setCostLeversSource(null));
  return cfg;
}

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-levers-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home, role: 'I work on the munder-difflin app. Expert senior software engineer agent.' });
  return { home, hive };
}

// — config block —

test('levers are all off until the app installs a source, and all on by default after', () => {
  levers.setCostLeversSource(null);
  assert.deepEqual(levers.costLevers(), COST_LEVERS_OFF);
  assert.ok(Object.values(COST_LEVERS_ON).every((v) => v === true));
  assert.deepEqual(resolveCostLevers({}), COST_LEVERS_ON);
  const r = resolveCostLevers({ costLevers: { rosterToon: false, digestWakes: 'no', bogus: true } });
  assert.equal(r.rosterToon, false, 'a boolean override wins');
  assert.equal(r.digestWakes, true, 'a non-boolean is ignored');
  assert.equal('bogus' in r, false);
});

// — roster (F1-F4) —

test('TOON cells are quoted only when a row would otherwise change', () => {
  assert.equal(toonCell('plain'), 'plain');
  assert.equal(toonCell('a,b'), '"a,b"');
  assert.equal(toonCell(''), '""');
  assert.equal(toonCell(null), '-');
  assert.equal(toonTable('x', ['a', 'b'], [[1, 'y']]), 'x[1]{a,b}:\n  1,y');
  assert.equal(shortRole('I work on the munder-difflin app. Expert senior engineer.'), 'I work on the munder-difflin app');
  assert.equal(shortRole(undefined), 'agent');
  assert.ok(shortRole('x'.repeat(80)).length <= 32);
  assert.equal(breakerArmed('healthy'), false, "breaker.ts's healthy level is not news");
  assert.equal(breakerArmed('steering'), true);
});

test('rosterToon: god gets a table with short roles and only armed breakers', async (t) => {
  withLevers(t);
  const { hive } = await floor(t);
  hive.writeFleetSnapshot({ ts: Date.now(), agents: [
    { id: 'god-1', name: 'Michael', role: 'orchestrator (god)', isGod: true, breaker: 'healthy', tokens: 695000, usd: 48.5, lastActiveSecAgo: 4, inboxBacklog: 0 },
    { id: 'jim-1', name: 'Jim', role: 'I work on the munder-difflin app. Expert senior software engineer agent.', breaker: 'steering', tokens: 3618000, usd: 19.74, lastActiveSecAgo: 400, inboxBacklog: 3, onHold: true }
  ] });
  const text = hive.rosterContext(() => ({ tokens: 60000, limit: 200000 }));
  assert.match(text, /agents\[2\]\{id,name,role,lastActive,ktok,usd,inbox,breaker,ctx,hold\}:/);
  assert.match(text, /\n  god-1,Michael,orchestrator \(god\) \(you\),4s,695,48\.50,0,-,30%,-\n/);
  assert.match(text, /\n  jim-1,Jim,I work on the munder-difflin app,7m,3618,19\.74,3,steering,30%,ON HOLD\n/);
  for (const rule of ['SUPERSEDES', 'do not message it', 'Do NOT message them', 'do NOT dispatch to them', 'do NOT count them']) {
    assert.ok(text.includes(rule), `kept upstream rule: ${rule}`);
  }
  assert.doesNotMatch(text, /breaker healthy/);
  levers.setCostLeversSource(() => ({ costLevers: { rosterToon: false } }));
  assert.match(hive.rosterContext(), /breaker healthy|ACTIVE agent\(s\)/, 'off = upstream line');
});

test('rosterOnChange: start, then only on a change god routes by, and on a new session', async (t) => {
  withLevers(t);
  roster.resetRosterGate();
  const { hive } = await floor(t);
  const snap = (extra = {}) => hive.writeFleetSnapshot({ ts: Date.now(), agents: [
    { id: 'god-1', name: 'Michael', isGod: true, tokens: 1000, lastActiveSecAgo: 3 },
    { id: 'jim-1', name: 'Jim', tokens: 2000, lastActiveSecAgo: 10, ...extra }
  ] });
  snap();
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  const fire = (event, sid = 's1') => server.handle({ agent_id: 'god-1', hook_event_name: event, session_id: sid });
  const ctx = (r) => r?.hookSpecificOutput?.additionalContext ?? '';

  assert.match(ctx(await fire('SessionStart')), /LIVE ROSTER/);
  assert.doesNotMatch(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/, 'unchanged floor is not re-sent');
  snap({ tokens: 9000, lastActiveSecAgo: 40 });
  assert.doesNotMatch(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/, 'spend and seconds are not a change');
  snap({ inboxBacklog: 2 });
  assert.match(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/, 'unread mail is a routing change');
  assert.doesNotMatch(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/);
  assert.match(ctx(await fire('UserPromptSubmit', 's2')), /LIVE ROSTER/, 'a new session may resume an old floor');

  levers.setCostLeversSource(() => ({ costLevers: { rosterOnChange: false } }));
  assert.match(ctx(await fire('UserPromptSubmit', 's2')), /LIVE ROSTER/, 'off = every prompt (upstream)');
});

// — prompt wording (F5, F8-F12, F14) and PROTOCOL.md (F13) —

function render(hive, meta) {
  hive.setRuntimeInfo?.({ version: '0.5.3-custom', packaged: false, appPath: '/app' });
  hive._runtime = { version: '0.5.3-custom', packaged: false, appPath: '/app' };
  hive.setOrchestratorMaySpawn(true);
  const root = hive.root();
  return hive.injectedPrompt(meta, path.join(root, 'agents', meta.id), root, true, true, '/opt/kg.cjs');
}

test('every prompt override still matches upstream wording (fails here when upstream rewrites it)', async (t) => {
  const { hive } = await floor(t);
  levers.setCostLeversSource(null); // upstream text
  const god = render(hive, { id: 'god-1', name: 'Michael', isGod: true, cwd: '/x' });
  const worker = render(hive, { id: 'jim-1', name: 'Jim', cwd: '/x' });
  const godMiss = trim.applyOverrides(god, trim.PROMPT_OVERRIDES).missed;
  const workerMiss = trim.applyOverrides(worker, trim.PROMPT_OVERRIDES).missed.filter((id) => id !== 'F12-spawn-queue');
  assert.deepEqual(godMiss, [], `stale overrides (god): ${godMiss}`);
  assert.deepEqual(workerMiss, [], `stale overrides (worker): ${workerMiss}`);
  const proto = fs.readFileSync(path.join(hive.root(), 'PROTOCOL.md'), 'utf8');
  assert.deepEqual(trim.applyOverrides(proto, trim.PROTOCOL_OVERRIDES).missed, []);
});

test('promptTrim: shorter prompts that keep every behaviour-critical rule', async (t) => {
  const { hive } = await floor(t);
  levers.setCostLeversSource(null);
  const before = { god: render(hive, { id: 'god-1', name: 'Michael', isGod: true, cwd: '/x' }), worker: render(hive, { id: 'jim-1', name: 'Jim', cwd: '/x' }) };
  withLevers(t);
  trim.setSlackProbe(() => false);
  const after = { god: render(hive, { id: 'god-1', name: 'Michael', isGod: true, cwd: '/x' }), worker: render(hive, { id: 'jim-1', name: 'Jim', cwd: '/x' }) };

  for (const k of ['god', 'worker']) assert.ok(after[k].length < before[k].length, `${k} prompt shrinks`);
  assert.doesNotMatch(after.worker, /LIVE CONTEXT/, 'F5: workers get no roster');
  assert.match(after.god, /LIVE CONTEXT/);
  assert.doesNotMatch(after.god + after.worker, /SLACK REPLIES/, 'F11: no Slack, no Slack lines');
  trim.setSlackProbe(() => true);
  assert.match(render(hive, { id: 'jim-1', name: 'Jim', cwd: '/x' }), /SLACK REPLIES/);
  trim.setSlackProbe(() => false);

  // Behaviour-critical text, unchanged (T-034 boundary).
  assert.ok(after.worker.includes(ASK_FIRST_CLAUSE), 'ask-first clause verbatim (worker)');
  assert.ok(after.god.includes(ASK_FIRST_CLAUSE), 'ask-first clause verbatim (god)');
  for (const rule of ['"assignee"', 'humanQA', 'ASK ME', 'HumanQuestion.md', 'Circuit breaker: steer/constrain', 'NEVER write into another agent', 'END of a task']) {
    assert.ok(after.god.includes(rule), `god keeps: ${rule}`);
  }
  const root = hive.root();
  for (const p of [path.join(root, 'agents', 'jim-1', 'memory.md'), path.join(root, 'agents', 'jim-1', 'inbox', '.done'), path.join(root, 'agents', 'jim-1', 'outbox')]) {
    assert.ok(after.worker.includes(p), `native path kept: ${p}`);
  }
  t.diagnostic(`tokens (chars/4): god ${Math.round(before.god.length / 4)} -> ${Math.round(after.god.length / 4)}, worker ${Math.round(before.worker.length / 4)} -> ${Math.round(after.worker.length / 4)}`);
});

test('tasksOwnerProtocol: PROTOCOL.md names god as the sole writer of tasks.json', async (t) => {
  withLevers(t);
  const { hive } = await floor(t);
  hive.refreshGeneratedDocs();
  const proto = fs.readFileSync(path.join(hive.root(), 'PROTOCOL.md'), 'utf8');
  assert.match(proto, /God is its sole writer: report your task's status to god by message/);
  assert.doesNotMatch(proto, /Keep the task you're working reflected in its status/);
});

// — wakes (J1, F15) and heartbeat (F17) —

test('mechanical mail: reports wait, anything that needs god now still wakes it', () => {
  const isAgent = (id) => id === 'jim-1' || id === 'harness';
  const mech = (m) => isMechanicalMail({ requires_reply: false, ...m }, isAgent);
  assert.equal(mech({ from: 'jim-1', act: 'inform', subject: 'CLOSING-TIME-ACK' }), true);
  assert.equal(mech({ from: 'harness', act: 'inform', subject: 'CLOSING-TIME-ACK' }), true);
  assert.equal(mech({ from: 'jim-1', act: 'done', subject: 'T-032 done' }), true);
  assert.equal(mech({ from: 'jim-1', act: 'request', subject: 'please review' }), false, 'requests wake');
  assert.equal(mech({ from: 'jim-1', act: 'query', subject: 'DECISION NEEDED: x', requires_reply: true }), false);
  assert.equal(mech({ from: 'jim-1', act: 'inform', subject: 'DECISION NEEDED: x' }), false, 'decisions wake');
  assert.equal(mech({ from: 'jim-1', act: 'inform', subject: 'x', needs_human: true }), false, 'needs_human wakes');
  assert.equal(mech({ from: 'jim-1', act: 'inform', subject: 'x', requires_reply: true }), false);
  assert.equal(mech({ from: 'human', act: 'inform', subject: 'answer' }), false, 'human answers wake');
  assert.equal(mech({ from: 'ephemeral-worker', act: 'inform', subject: 'worker failed' }), false, 'failure notices wake');
  assert.equal(mech({ from: 'jim-1', act: 'refuse', subject: 'no' }), false, 'pushback wakes');
});

test('shortNudge: shorter, and still recognised as a nudge by the queue', () => {
  const ids = ['2026-10-04T-god045'];
  assert.ok(isInboxNudge(shortNudgeText(ids)), 'one-pending rule keys on the head');
  assert.ok(shortNudgeText(ids).length < inboxNudgeText(ids).length);
  for (const k of ['inbox/.done/', 'authoritative', 'autonomously', 'god', ids[0]]) assert.ok(shortNudgeText(ids).includes(k), k);
});

test('digestWakes + slimHeartbeat: reports do not count as actionable, and the beat lists them', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'god-1', act: 'done', subject: 'T-9 done', body: 'ok', requires_reply: false }, 'jim-1');
  hive.send({ to: 'god-1', act: 'request', subject: 'need a call', body: '?' }, 'jim-1');
  const msgs = hive.inbox('god-1');
  levers.setCostLeversSource(null);
  assert.equal(msgs.filter((m) => mainWake.wakesGod(hive, m)).length, 2, 'off = upstream: all count');
  assert.equal(mainWake.slimHeartbeatDigest(hive, 300000, 2), null, 'off = upstream digest');
  withLevers(t);
  assert.deepEqual(msgs.filter((m) => mainWake.wakesGod(hive, m)).map((m) => m.subject), ['need a call']);
  const digest = mainWake.slimHeartbeatDigest(hive, 300000, 1);
  assert.match(digest, /Reports waiting in your inbox \(1, did not wake you\): jim-1: T-9 done/);
  assert.match(digest, /Recent log: .*\(full: log\.jsonl\)/);
  assert.doesNotMatch(digest, /\{"ts":/, 'no raw log JSON');
  assert.match(digest, /Re-engage anyone stalled/);
});

// — closing time (J5 + F18) —

function gitRepo(dir, dirty) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
  if (dirty) fs.writeFileSync(path.join(dir, 'wip.txt'), 'x');
}

async function closingFloor(t) {
  withLevers(t);
  closing.resetClosingState();
  t.after(() => closing.resetClosingState());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-closing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const repo = (n, dirty) => { const d = path.join(home, 'repos', n); gitRepo(d, dirty); return d; };
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'idle-1', name: 'Idle', provider: 'claude', cwd: repo('idle', false) });
  await hive.ensureAgent({ id: 'dirty-1', name: 'Dirty', provider: 'claude', cwd: repo('dirty', true) });
  await hive.ensureAgent({ id: 'busy-1', name: 'Busy', provider: 'claude', cwd: repo('busy', false) });
  const now = Date.now();
  closing.setClosingFacts({ lastOutputAt: (id) => (id === 'busy-1' ? now - 1000 : now - 60_000) });
  const control = new ControlRegistry();
  const ct = new ClosingTimeController(hive, () => ['god-1', 'idle-1', 'dirty-1', 'busy-1'], () => null, () => { ct.concluded = true; }, control);
  t.after(() => ct.cancel());
  return { hive, control, ct };
}

test('harnessClosingTime: idle parked with a harness ACK, dirty briefed by inbox, busy by one steer', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  assert.deepEqual(ct.start(), { ok: true });

  const mem = fs.readFileSync(path.join(hive.root(), 'agents', 'idle-1', 'memory.md'), 'utf8');
  assert.match(mem, /closing time: idle with a clean worktree .* harness parked it/);
  const god = hive.inbox('god-1');
  assert.ok(god.some((m) => m.from === 'harness' && m.subject === 'CLOSING-TIME-ACK' && /Idle \(idle-1\)/.test(m.body)));
  const brief = god.find((m) => /run the shutdown protocol/.test(m.subject));
  assert.match(brief.body, /do NOT broadcast/);
  assert.match(brief.body, /Parked by the harness .*Idle \(idle-1\)/);
  assert.match(brief.body, /Dirty \(dirty-1\).*Busy \(busy-1\)|Busy \(busy-1\).*Dirty \(dirty-1\)/);

  assert.deepEqual(hive.inbox('idle-1'), [], 'the parked worker takes no turn');
  assert.equal(control.snapshot('idle-1').pendingSteers, 0);
  assert.equal(hive.inbox('dirty-1').length, 1, 'dirty: one inbox brief');
  assert.equal(control.snapshot('dirty-1').pendingSteers, 0, '...and no steer');
  assert.equal(hive.inbox('busy-1').length, 0, 'busy: no inbox brief');
  assert.equal(control.snapshot('busy-1').pendingSteers, 1, '...one steer');
  assert.match(hive.inbox('dirty-1')[0].body, /subject is exactly "CLOSING-TIME-ACK"/);
});

test('harnessClosingTime: a premature COMPLETE is still rejected, and god is woken once at the last ACK', async (t) => {
  const { hive, ct } = await closingFloor(t);
  ct.start();
  const route = (from, subject) => ct.onRouted({ from, subject, to: 'god', act: 'inform', body: '' }, ['god-1']);

  route('god-1', 'CLOSING-TIME-COMPLETE');
  assert.equal(ct.concluded, undefined);
  const refusal = hive.inbox('god-1').find((m) => /conclusion rejected/.test(m.subject));
  assert.match(refusal.body, /Dirty \(dirty-1\)/);
  assert.match(refusal.body, /Busy \(busy-1\)/);
  assert.doesNotMatch(refusal.body, /Idle \(idle-1\)/, 'the harness ACK counts');

  route('dirty-1', 'CLOSING-TIME-ACK');
  route('busy-1', 'CLOSING-TIME-ACK');
  const run = { hive, godId: 'god-1', workers: new Set(['idle-1', 'dirty-1', 'busy-1']), acked: new Set(['idle-1', 'dirty-1', 'busy-1']), isActive: () => true, progress: () => {} };
  closing.poll(run);
  closing.poll(run);
  assert.equal(hive.inbox('god-1').filter((m) => /every worker has acked/.test(m.subject)).length, 1);
});

test('harnessClosingTime: an unconsumed steer becomes an inbox brief once the worker goes idle', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  ct.start();
  closing.setClosingFacts({ lastOutputAt: () => Date.now() - 60_000 });
  const run = { hive, control, godId: 'god-1', workers: new Set(['busy-1']), acked: new Set(), isActive: () => true, progress: () => {} };
  closing.poll(run);
  assert.equal(control.snapshot('busy-1').pendingSteers, 0, 'steer withdrawn');
  assert.equal(hive.inbox('busy-1').length, 1, 'one inbox brief instead');
});

test('harnessClosingTime off: upstream kickoff exactly (no harness ACKs, no direct briefs)', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  levers.setCostLeversSource(() => ({ costLevers: { harnessClosingTime: false } }));
  ct.start();
  assert.ok(!hive.inbox('god-1').some((m) => m.from === 'harness'));
  assert.match(hive.inbox('god-1')[0].body, /BROADCAST closing time/);
  assert.equal(control.snapshot('idle-1').pendingSteers, 1, 'upstream steers every worker');
});

test('harnessClosingTime: cancel tells the briefed workers directly, god is told not to broadcast', async (t) => {
  const { hive, ct } = await closingFloor(t);
  ct.start();
  ct.cancel();
  assert.ok(hive.inbox('dirty-1').some((m) => m.subject === 'CLOSING TIME CANCELLED'));
  assert.ok(hive.inbox('busy-1').some((m) => m.subject === 'CLOSING TIME CANCELLED'));
  assert.ok(!hive.inbox('idle-1').some((m) => m.subject === 'CLOSING TIME CANCELLED'), 'parked worker took no part');
  assert.match(hive.inbox('god-1').find((m) => m.subject === 'CLOSING TIME CANCELLED').body, /do not broadcast/);
});
