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
const provider = loadTs('src/main/custom/provider.ts');
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
  // Boolean levers default on; list levers (T-038 leanDisabledPlugins) default to a non-empty list.
  assert.ok(Object.values(COST_LEVERS_ON).every((v) => v === true || (Array.isArray(v) && v.length > 0)));
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
  provider.setProviderSource((id) => hive.registry().agents[id]?.provider ?? null);
  t.after(() => provider.setProviderSource(() => null));
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

test('rosterKey (T-042): god\'s own row, live/idle and inbox within a bucket are not changes', async (t) => {
  withLevers(t);
  const { hive, home } = await floor(t);
  const root = path.join(home, 'hive');
  const key = (god = {}, jim = {}, more = []) => {
    hive.writeFleetSnapshot({ ts: Date.now(), agents: [
      { id: 'god-1', name: 'Michael', isGod: true, lastActiveSecAgo: 900, inboxBacklog: 0, ...god },
      { id: 'jim-1', name: 'Jim', role: 'engineer', lastActiveSecAgo: 900, inboxBacklog: 0, ...jim },
      ...more
    ] });
    return roster.rosterKey(root, () => ({ tokens: 50000, limit: 200000 }));
  };
  const base = key();
  assert.equal(key({ inboxBacklog: 1 }), base, 'god inbox 0->1');
  assert.equal(key({ lastActiveSecAgo: 2 }), base, 'god idle->live');
  assert.equal(key({ inboxBacklog: 7, lastActiveSecAgo: 1 }), base, 'god row ignored entirely');
  assert.equal(key({}, { lastActiveSecAgo: 2 }), base, 'worker idle->live');
  assert.equal(key({}, { tokens: 99000, usd: 3 }), base, 'spend');
  const some = key({}, { inboxBacklog: 1 });
  assert.notEqual(some, base, 'worker inbox 0 -> 1-4');
  assert.equal(key({}, { inboxBacklog: 4 }), some, 'within 1-4');
  assert.notEqual(key({}, { inboxBacklog: 5 }), some, '1-4 -> 5+');
  assert.notEqual(key({}, {}, [{ id: 'pam-1', name: 'Pam', role: 'designer' }]), base, 'a hire');
  assert.notEqual(key({}, { onHold: true }), base, 'a hold');
  assert.notEqual(key({}, { breaker: 'steering' }), base, 'an armed breaker');
  assert.equal(key({}, { breaker: 'healthy' }), base, 'a healthy breaker is not news');
});

test('renderer wake levers (T-042) start from the fork defaults, not upstream', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/custom/wake.ts'), 'utf8');
  assert.match(src, /let levers: CostLevers = COST_LEVERS_ON;/, 'first wake after a start uses the levers');
  assert.doesNotMatch(src, /COST_LEVERS_OFF/);
  assert.equal(COST_LEVERS_ON.shortNudge && COST_LEVERS_ON.digestWakes, true);
});

test('rosterOnChange (T-040): a non-Claude or unknown god keeps the roster on every prompt', async (t) => {
  withLevers(t);
  roster.resetRosterGate();
  const { hive } = await floor(t);
  hive.writeFleetSnapshot({ ts: Date.now(), agents: [{ id: 'god-1', name: 'Michael', isGod: true, lastActiveSecAgo: 3 }] });
  const providers = { 'god-1': 'copilot' };
  provider.setProviderSource((id) => (id in providers ? providers[id] : null));
  t.after(() => provider.setProviderSource(() => null));
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  const fire = (event) => server.handle({ agent_id: 'god-1', hook_event_name: event, session_id: 's1' });
  const ctx = (r) => r?.hookSpecificOutput?.additionalContext ?? '';

  assert.match(ctx(await fire('SessionStart')), /LIVE ROSTER/);
  assert.match(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/, 'copilot god: unchanged floor is still sent');
  assert.match(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/);

  delete providers['god-1'];
  assert.match(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/, 'unknown agent: upstream path');

  providers['god-1'] = undefined; // no provider recorded = launched as claude
  await fire('SessionStart');
  assert.doesNotMatch(ctx(await fire('UserPromptSubmit')), /LIVE ROSTER/, 'unset provider = claude: gated');
  assert.equal(provider.isClaudeAgent('god-1'), true);
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
  assert.equal(mech({ from: 'jim-1', act: 'inform', subject: 'started T-032' }), true, 'a plain status note waits');
  assert.equal(mech({ from: 'jim-1', act: 'done', subject: 'T-032 done' }), false, 'T-041: done wakes');
  const godSent = (id) => id === 'god-msg';
  const mech2 = (m) => isMechanicalMail({ requires_reply: false, ...m }, isAgent, godSent);
  assert.equal(mech2({ from: 'jim-1', act: 'inform', subject: 're: T-9', in_reply_to: 'god-msg' }), false, 'T-041: a reply to god wakes');
  assert.equal(mech2({ from: 'jim-1', act: 'agree', subject: 'ok', in_reply_to: 'god-msg' }), false, '...whatever its act');
  assert.equal(mech2({ from: 'jim-1', act: 'inform', subject: 'more', in_reply_to: 'jim-msg' }), true, 'a reply to someone else waits');
  assert.equal(mech2({ from: 'jim-1', act: 'inform', subject: 'CLOSING-TIME-ACK', in_reply_to: 'god-msg' }), true, 'an ACK waits even as a reply');
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
  hive.send({ to: 'god-1', act: 'inform', subject: 'T-9 progress', body: 'ok', requires_reply: false }, 'jim-1');
  hive.send({ to: 'god-1', act: 'request', subject: 'need a call', body: '?' }, 'jim-1');
  const msgs = hive.inbox('god-1');
  levers.setCostLeversSource(null);
  assert.equal(msgs.filter((m) => mainWake.wakesGod(hive, m)).length, 2, 'off = upstream: all count');
  assert.equal(mainWake.slimHeartbeatDigest(hive, 300000, 2), null, 'off = upstream digest');
  withLevers(t);
  assert.deepEqual(msgs.filter((m) => mainWake.wakesGod(hive, m)).map((m) => m.subject), ['need a call']);
  const digest = mainWake.slimHeartbeatDigest(hive, 300000, 1);
  assert.match(digest, /Reports waiting in your inbox \(1, did not wake you\): jim-1: T-9 progress/);
  assert.match(digest, /Recent log: .*\(full: log\.jsonl\)/);
  assert.doesNotMatch(digest, /\{"ts":/, 'no raw log JSON');
  assert.match(digest, /Re-engage anyone stalled/);
});

test('digestWakes (T-041): done and replies to god wake god; replies to own mail and ACKs wait', async (t) => {
  withLevers(t);
  mainWake.resetWakeCache();
  const { hive } = await floor(t);
  assert.equal(hive.registry().godId, 'god-1');
  // god sends the way it really does: a file in its outbox, routed (→ outbox/.sent).
  const outbox = path.join(hive.root(), 'agents', 'god-1', 'outbox');
  fs.writeFileSync(path.join(outbox, 'g1.json'), JSON.stringify({ id: 'god-req-1', from: 'god-1', to: 'jim-1', act: 'request', subject: 'T-9: do it', body: 'go' }));
  hive.routeOnce();
  const own = hive.send({ to: 'god-1', act: 'inform', subject: 'T-9 started', body: '', requires_reply: false }, 'jim-1');
  const send = (m) => hive.send({ to: 'god-1', body: '', requires_reply: false, ...m }, 'jim-1');
  send({ act: 'done', subject: 'T-9 done' });
  send({ act: 'inform', subject: 'T-9 answer', in_reply_to: 'god-req-1' });
  send({ act: 'inform', subject: 'T-9 follow-up', in_reply_to: own.id });
  send({ act: 'inform', subject: 'CLOSING-TIME-ACK', in_reply_to: 'god-req-1' });
  send({ act: 'inform', subject: 'unknown ref', in_reply_to: 'no-such-id' });
  const woke = hive.inbox('god-1').filter((m) => mainWake.wakesGod(hive, m)).map((m) => m.subject).sort();
  assert.deepEqual(woke, ['T-9 answer', 'T-9 done']);
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
  closing.noteHookForClosing('idle-1', 'Stop');
  closing.noteHookForClosing('idle-1', 'Status'); // telemetry tick after the turn: still idle
  closing.noteHookForClosing('dirty-1', 'Stop');
  closing.noteHookForClosing('busy-1', 'PreToolUse');
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
  closing.noteHookForClosing('busy-1', 'Stop');
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

// — T-048: cancel withdraws pending closing-time steers, and only those —

const queued = (control, id) => { const out = []; let n; while ((n = control.takeSteer(id)) !== undefined) out.push(n); return out; };

test('T-048: cancel withdraws an unconsumed closing steer (busy worker and god)', async (t) => {
  const { control, ct } = await closingFloor(t);
  ct.start();
  assert.equal(control.snapshot('busy-1').pendingSteers, 1);
  assert.equal(control.snapshot('god-1').pendingSteers, 1);
  ct.cancel();
  assert.deepEqual(queued(control, 'busy-1'), [], 'the next hook boundary gets no CLOSING TIME');
  assert.deepEqual(queued(control, 'god-1'), []);
});

test('T-048: cancel keeps an unrelated steer queued for the same agent', async (t) => {
  const { control, ct } = await closingFloor(t);
  control.steer('busy-1', '[voice] check the flaky test first');
  ct.start();
  control.steer('busy-1', 'operator: also bump the version');
  ct.cancel();
  assert.deepEqual(queued(control, 'busy-1'), ['[voice] check the flaky test first', 'operator: also bump the version']);
});

test('T-048: cancel then a quick re-press leaves exactly the new run\'s steer', async (t) => {
  const { control, ct } = await closingFloor(t);
  ct.start();
  ct.cancel();
  ct.start();
  assert.deepEqual(queued(control, 'busy-1'), [closing.WORKER_BRIEF]);
});

test('T-048: lever off, upstream cancel withdraws its steers but keeps unrelated ones', async (t) => {
  const { control, ct } = await closingFloor(t);
  levers.setCostLeversSource(() => ({ costLevers: { harnessClosingTime: false } }));
  control.steer('idle-1', 'operator note');
  ct.start();
  ct.cancel();
  assert.deepEqual(queued(control, 'idle-1'), ['operator note']);
  for (const id of ['god-1', 'dirty-1', 'busy-1']) assert.deepEqual(queued(control, id), [], id);
});

test('T-048: withdrawClosingSteers drops only CLOSING TIME notes, in order, for the named agents', () => {
  const control = new ControlRegistry();
  for (const n of ['a', closing.WORKER_BRIEF, '[voice] CLOSING TIME is a band', 'b']) control.steer('w-1', n);
  control.steer('w-2', closing.WORKER_BRIEF);
  closing.withdrawClosingSteers(control, ['w-1', 'nobody']);
  assert.deepEqual(queued(control, 'w-1'), ['a', '[voice] CLOSING TIME is a band', 'b']);
  assert.equal(control.snapshot('w-2').pendingSteers, 1, 'an agent not named keeps its steer');
});

test('T-049: every closing brief says it supersedes an earlier CANCELLED and keeps the CLOSING TIME prefix', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  ct.start();
  ct.cancel();
  ct.start();
  const sup = /supersedes any earlier CLOSING TIME CANCELLED/;
  const steer = queued(control, 'busy-1');
  assert.equal(steer.length, 1);
  assert.match(steer[0], sup, 'worker steer');
  assert.match(steer[0], /^CLOSING TIME\b/);
  assert.match(steer[0], /subject is exactly "CLOSING-TIME-ACK"/);
  const inbox = hive.inbox('dirty-1').filter((m) => m.subject === 'CLOSING TIME');
  assert.ok(inbox.length >= 1);
  for (const m of inbox) assert.match(m.body, sup, 'worker inbox brief');
  const godSteer = queued(control, 'god-1');
  assert.equal(godSteer.length, 1);
  assert.match(godSteer[0], sup, 'god steer');
  assert.match(godSteer[0], /^CLOSING TIME\b/);
  const godBriefs = hive.inbox('god-1').filter((m) => /run the shutdown protocol/.test(m.subject));
  assert.equal(godBriefs.length, 2);
  for (const m of godBriefs) assert.match(m.body, sup, 'god brief');
});

// — T-040: closing time on non-Claude providers —

async function mixedFloor(t) {
  withLevers(t);
  closing.resetClosingState();
  t.after(() => closing.resetClosingState());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-closing-mixed-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const repo = (n) => { const d = path.join(home, 'repos', n); gitRepo(d, false); return d; };
  const agents = [
    ['proxy-mid', 'qwen'],      // proxy shim: PostToolUse but never PreToolUse, quiet TUI mid-turn
    ['proxy-done', 'qwen'],     // proxy shim that sent Stop: positively idle
    ['custom-1', 'custom'],     // no hooks at all
    ['claude-nohook', 'claude'],// hooks never fired
    ['copilot-busy', 'copilot'] // busy, but its bridge may not show a steer to the model
  ];
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  for (const [id, p] of agents) await hive.ensureAgent({ id, name: id, provider: p, cwd: repo(id) });
  const now = Date.now();
  closing.setClosingFacts({ lastOutputAt: (id) => (id === 'copilot-busy' ? now - 1000 : now - 60_000) });
  closing.noteHookForClosing('proxy-mid', 'PostToolUse');
  closing.noteHookForClosing('proxy-done', 'PostToolUse');
  closing.noteHookForClosing('proxy-done', 'Stop');
  closing.noteHookForClosing('proxy-done', 'CostSample');
  closing.noteHookForClosing('copilot-busy', 'PreToolUse');
  const control = new ControlRegistry();
  const ct = new ClosingTimeController(hive, () => ['god-1', ...agents.map(([id]) => id)], () => null, () => {}, control);
  t.after(() => ct.cancel());
  return { hive, control, ct };
}

/** One brief reached the worker: its inbox, or (qwen/custom, no renderer in
 *  tests) upstream's terminal-handoff bounce to god naming it. */
const briefs = (hive, id) => hive.inbox(id).filter((m) => m.subject === 'CLOSING TIME').length
  + hive.inbox('god-1').filter((m) => m.subject.includes(`"${id}"`) && m.subject.includes('CLOSING TIME')).length;

test('harnessClosingTime (T-040): only a positive turn-end signal parks a worker', async (t) => {
  const { hive, control, ct } = await mixedFloor(t);
  ct.start();
  const parked = (id) => /parked it/.test(fs.readFileSync(path.join(hive.root(), 'agents', id, 'memory.md'), 'utf8'));

  assert.ok(parked('proxy-done'), 'a proxy worker that sent Stop is parked like a Claude one');
  assert.equal(briefs(hive, 'proxy-done'), 0);
  for (const id of ['proxy-mid', 'custom-1', 'claude-nohook']) {
    assert.ok(!parked(id), `${id}: no turn-end signal, so not parked`);
    assert.equal(briefs(hive, id), 1, `${id}: one brief`);
    assert.equal(control.snapshot(id).pendingSteers, 0, `${id}: no steer`);
  }
});

test('harnessClosingTime (T-040): a busy non-Claude worker gets the inbox brief, not a steer', async (t) => {
  const { hive, control, ct } = await mixedFloor(t);
  ct.start();
  assert.equal(control.snapshot('copilot-busy').pendingSteers, 0);
  assert.equal(hive.inbox('copilot-busy').length, 1);
  assert.match(hive.inbox('copilot-busy')[0].body, /subject is exactly "CLOSING-TIME-ACK"/);
});

test('harnessClosingTime (T-040): telemetry after a tool call does not count as a turn end', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  ct.start();
  closing.setClosingFacts({ lastOutputAt: () => Date.now() - 60_000 }); // quiet TUI mid-tool
  closing.noteHookForClosing('busy-1', 'Status');
  closing.noteHookForClosing('busy-1', 'Notification');
  const run = { hive, control, godId: 'god-1', workers: new Set(['busy-1']), acked: new Set(), isActive: () => true, progress: () => {} };
  closing.poll(run);
  assert.equal(control.snapshot('busy-1').pendingSteers, 1, 'still mid-turn: the steer stays');
  assert.equal(hive.inbox('busy-1').length, 0);
  closing.noteHookForClosing('busy-1', 'Stop');
  closing.poll(run);
  assert.equal(control.snapshot('busy-1').pendingSteers, 0, 'turn ended: withdrawn');
  assert.equal(hive.inbox('busy-1').length, 1, 'inbox brief instead');
});

// — T-045: the closing-time choice reads the turn-end hook, not PTY quiet (T-044 incident) —

const closingLog = (hive, kind) => fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind);

test('harnessClosingTime (T-045): an idle Claude worker with a chatty PTY gets the inbox brief, not a steer', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  const now = Date.now();
  closing.setClosingFacts({ lastOutputAt: () => now - 1000 }); // the 11:40 case: idle at a prompt, PTY never reads quiet
  ct.start();
  for (const id of ['idle-1', 'dirty-1']) {
    assert.ok(!/parked it/.test(fs.readFileSync(path.join(hive.root(), 'agents', id, 'memory.md'), 'utf8')), `${id}: PTY quiet still gates parking`);
    assert.equal(control.snapshot(id).pendingSteers, 0, `${id}: no steer at a turn end`);
    assert.equal(hive.inbox(id).filter((m) => m.subject === 'CLOSING TIME').length, 1, `${id}: one inbox brief`);
  }
  assert.equal(control.snapshot('busy-1').pendingSteers, 1, 'mid-turn: still one steer');
  assert.equal(hive.inbox('busy-1').length, 0);
});

test('harnessClosingTime (T-045): a steered worker that reaches a turn end is re-briefed even if its PTY is chatty', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  ct.start();
  closing.setClosingFacts({ lastOutputAt: () => Date.now() - 500 });
  closing.noteHookForClosing('busy-1', 'Stop');
  const run = { hive, control, godId: 'god-1', workers: new Set(['busy-1']), acked: new Set(), isActive: () => true, progress: () => {} };
  closing.poll(run);
  assert.equal(control.snapshot('busy-1').pendingSteers, 0, 'steer withdrawn');
  assert.equal(hive.inbox('busy-1').length, 1, 'one inbox brief instead');
  closing.poll(run);
  assert.equal(hive.inbox('busy-1').length, 1, 'never doubled');
  assert.deepEqual(closingLog(hive, 'closing-convert').map((e) => [e.agentId, e.reason]), [['busy-1', 'turn-end']]);
});

test('harnessClosingTime (T-045): a steer still pending after the deadline becomes the inbox brief', async (t) => {
  const { hive, control, ct } = await closingFloor(t);
  ct.start();
  const run = { hive, control, godId: 'god-1', workers: new Set(['busy-1']), acked: new Set(), isActive: () => true, progress: () => {} };
  closing.poll(run, Date.now() + closing.STEER_DEADLINE_MS - 5_000);
  assert.equal(control.snapshot('busy-1').pendingSteers, 1, 'before the deadline: the steer stays');
  closing.poll(run, Date.now() + closing.STEER_DEADLINE_MS + 1_000);
  assert.equal(control.snapshot('busy-1').pendingSteers, 0);
  assert.equal(hive.inbox('busy-1').length, 1);
  assert.equal(closingLog(hive, 'closing-convert')[0].reason, 'deadline');
});

test('harnessClosingTime (T-045): one closing-facts line per worker in log.jsonl', async (t) => {
  const { hive, ct } = await closingFloor(t);
  ct.start();
  const facts = closingLog(hive, 'closing-facts');
  assert.deepEqual(facts.map((e) => [e.agentId, e.via]).sort(), [['busy-1', 'steer'], ['dirty-1', 'inbox'], ['idle-1', 'parked']]);
  const idle = facts.find((e) => e.agentId === 'idle-1');
  assert.equal(idle.turnEnded, true);
  assert.equal(idle.clean, true);
  assert.equal(idle.provider, 'claude');
  assert.ok(idle.quietMs >= closing.CLOSING_IDLE_MS);
  assert.equal(facts.find((e) => e.agentId === 'dirty-1').clean, false);
});

test('harnessClosingTime (T-045): every provider gets exactly one delivery; only a mid-turn Claude worker is steered; no hook = never parked', async (t) => {
  withLevers(t);
  closing.resetClosingState();
  t.after(() => closing.resetClosingState());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-closing-all-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const providers = ['claude', 'codex', 'grok', 'kimi', 'gemini', 'antigravity', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor', 'custom'];
  const states = ['nohook', 'midturn', 'ended'];
  const ids = [];
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  for (const p of providers) for (const s of states) {
    const id = `${p}-${s}`; ids.push(id);
    const d = path.join(home, 'repos', id); gitRepo(d, false);
    await hive.ensureAgent({ id, name: id, provider: p, cwd: d });
    if (s === 'midturn') closing.noteHookForClosing(id, 'PreToolUse');
    if (s === 'ended') { closing.noteHookForClosing(id, 'PostToolUse'); closing.noteHookForClosing(id, 'Stop'); }
  }
  const now = Date.now();
  closing.setClosingFacts({ lastOutputAt: () => now - 1000 }); // chatty PTYs: nobody may be parked on output alone
  const control = new ControlRegistry();
  const ct = new ClosingTimeController(hive, () => ['god-1', ...ids], () => null, () => {}, control);
  t.after(() => ct.cancel());
  ct.start();
  for (const id of ids) {
    const steered = id === 'claude-midturn';
    assert.ok(!/parked it/.test(fs.readFileSync(path.join(hive.root(), 'agents', id, 'memory.md'), 'utf8')), `${id}: not parked`);
    assert.equal(control.snapshot(id).pendingSteers, steered ? 1 : 0, `${id}: steer only for a mid-turn Claude worker`);
    assert.equal(briefs(hive, id), steered ? 0 : 1, `${id}: exactly one brief`);
  }
  // Fallback for every provider: a steer that never lands is replaced at the deadline.
  const run = { hive, control, godId: 'god-1', workers: new Set(ids), acked: new Set(), isActive: () => true, progress: () => {} };
  closing.poll(run, now + closing.STEER_DEADLINE_MS + 1_000);
  assert.equal(control.snapshot('claude-midturn').pendingSteers, 0);
  assert.equal(briefs(hive, 'claude-midturn'), 1);
});
