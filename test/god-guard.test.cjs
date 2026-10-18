'use strict';

/**
 * T-053: the god write guard and the compaction anchor
 * (src/main/custom/godGuard.ts), through the pure decision function and
 * through the real HookServer PreToolUse / SessionStart path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { decide, shellDecision, splitCommands } = loadTs('src/main/custom/godGuard.ts');
const orch = loadTs('src/main/custom/orchestrator.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { resolveOrchestratorLevers, ORCHESTRATOR_LEVERS_OFF } = loadTs('src/shared/custom/orchestratorLevers.ts');

const ROOT = path.join(__dirname, '..');
const HIVE = '/home/u/harness/hive';
const PROJ = '/home/u/code/shop';
const sh = (command, cwd = PROJ) => decide({ hiveRoot: HIVE, cwd, toolName: 'Bash', toolInput: { command } });
const blocked = (r) => assert.ok(r, 'expected a block');
const allowed = (r) => assert.equal(r, null, r ? `unexpected block: ${r.blocked}` : '');

// — levers —

test('levers: guard and anchor on by default, off before install', () => {
  const l = resolveOrchestratorLevers({});
  assert.deepEqual([l.godWriteGuard, l.compactAnchor], [true, true]);
  assert.deepEqual([ORCHESTRATOR_LEVERS_OFF.godWriteGuard, ORCHESTRATOR_LEVERS_OFF.compactAnchor], [false, false]);
  assert.equal(resolveOrchestratorLevers({ orchestrator: { godWriteGuard: false } }).godWriteGuard, false);
});

// — file tools —

test('file tools: project writes blocked; hive, temp and reads allowed; every engine\'s names', () => {
  const t = (toolName, toolInput, cwd = PROJ) => decide({ hiveRoot: HIVE, cwd, toolName, toolInput });
  blocked(t('Edit', { file_path: `${PROJ}/app.js` }));
  blocked(t('Write', { file_path: 'lib/price.js' }), 'relative to the project cwd');
  blocked(t('MultiEdit', { file_path: `${PROJ}/a.js` }));
  blocked(t('NotebookEdit', { notebook_path: `${PROJ}/n.ipynb` }));
  blocked(t('edit', { path: `${PROJ}/a.js` }), 'copilot');
  blocked(t('create', { path: `${PROJ}/new.js` }), 'copilot');
  blocked(t('apply_patch', { input: '*** Begin Patch\n*** Update File: app.js\n@@\n-a\n+b\n*** End Patch' }), 'codex patch');
  allowed(t('Write', { file_path: `${HIVE}/board.md` }));
  allowed(t('Write', { file_path: `${HIVE}/agents/god/outbox/m1.json` }));
  allowed(t('Write', { file_path: path.join(os.tmpdir(), 'notes.md') }));
  allowed(t('Read', { file_path: `${PROJ}/app.js` }));
  allowed(t('view', { path: `${PROJ}/app.js` }));
  allowed(t('apply_patch', { input: `*** Begin Patch\n*** Add File: ${HIVE}/research/x.md\n+hi\n*** End Patch` }));
});

// — git —

test('git: reads allowed, repository changes blocked', () => {
  for (const c of ['git status', 'git log --oneline -5', 'git --no-pager diff stable...x', 'git show-ref --verify refs/heads/x', 'git merge-base --is-ancestor stable x', 'git branch', 'git branch --show-current', 'git branch -a', 'git stash list', 'git tag -l', 'git config --get user.name', 'git remote -v']) allowed(sh(c));
  for (const c of ['git commit -m x', 'git push origin stable', 'git reset --hard HEAD~1', 'git rebase stable', 'git checkout stable', 'git switch -c x', 'git add -A', 'git restore app.js', 'git cherry-pick abc', 'git branch -D old', 'git branch newbranch', 'git tag v1', 'git stash', 'git pull', 'git clean -fd', 'git config user.name x', 'git fetch origin +stable:stable']) blocked(sh(c));
});

test('git merge: only --ff-only; fetch . <sha>:<branch> is the other landing path', () => {
  allowed(sh('git merge --ff-only 188d4a1'));
  allowed(sh('git merge --ff-only 188d4a1 && test "$(git rev-parse HEAD)" = 188d4a1'));
  allowed(sh('git fetch . 188d4a1:stable'));
  const m = sh('git merge clear-all');
  blocked(m);
  assert.match(m.reason, /--ff-only <reported SHA>/);
  assert.match(m.reason, /git fetch \. <reported SHA>:<branch>/);
  blocked(sh('git merge --no-ff --ff-only x'));
});

test('git: the hive repo itself, -C and cd are followed', () => {
  allowed(sh('git commit -m board', HIVE));
  allowed(sh(`git -C ${HIVE} commit -m board`));
  blocked(sh(`git -C ${PROJ} commit -m x`, HIVE));
  blocked(sh(`cd ${PROJ} && git commit -m x`, HIVE));
  allowed(sh(`cd ${HIVE} && git commit -m x`, PROJ));
  blocked(sh('GIT_AUTHOR_NAME=x git commit -m y'), 'env prefix');
});

// — other shell writes —

test('shell writes: rm/mv/cp/sed -i/redirects into a project blocked; into the hive allowed', () => {
  blocked(sh('rm app.js'));
  blocked(sh(`mv ${HIVE}/x.md ${PROJ}/x.md`));
  blocked(sh(`cp ${HIVE}/x.md ${PROJ}/x.md`));
  allowed(sh(`cp ${PROJ}/app.js ${HIVE}/research/app.js`), 'copying out of a project is a read');
  blocked(sh("sed -i 's/a/b/' app.js"));
  allowed(sh("sed -n '1,5p' app.js"));
  blocked(sh('echo hi > notes.md'));
  blocked(sh(`cat > ${PROJ}/x.js <<'EOF'\nx\nEOF`));
  allowed(sh(`echo hi > ${HIVE}/board.md`));
  allowed(sh(`mkdir -p ${HIVE}/spawn-requests && printf '{}' > ${HIVE}/spawn-requests/r1.json`));
  allowed(sh('npm test 2>&1 | tail -5'));
  allowed(sh('ls > /dev/null'));
  allowed(sh('node -e "[1].map(x => x)"'), 'an arrow inside quotes is not a redirect');
  allowed(sh(`rm ${HIVE}/agents/god/inbox/m1.json`));
});

test('codex-style command arrays and unknown tools', () => {
  blocked(decide({ hiveRoot: HIVE, cwd: PROJ, toolName: 'shell', toolInput: { command: ['bash', '-lc', 'git push'] } }));
  allowed(decide({ hiveRoot: HIVE, cwd: PROJ, toolName: 'shell', toolInput: { command: ['git', 'status'] } }));
  allowed(decide({ hiveRoot: HIVE, cwd: PROJ, toolName: 'WebFetch', toolInput: { url: 'https://x' } }));
  allowed(decide({ hiveRoot: HIVE, cwd: PROJ, toolName: 'Bash', toolInput: null }));
  assert.deepEqual(splitCommands("a && b || c; d | e\nf 'g; h'"), ['a', 'b', 'c', 'd', 'e', "f 'g; h'"]);
  assert.equal(shellDecision('', PROJ, HIVE), null);
});

// — through the real hook server —

async function floor(t, config) {
  orch.setOrchestratorLeversSource(config === null ? null : () => config);
  t.after(() => orch.setOrchestratorLeversSource(null));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  // A project under the temp dir (as the eval's repos are): its .git makes it a project, not scratch.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'md-guard-proj-'));
  fs.mkdirSync(path.join(proj, '.git'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  return { hive, server, proj };
}
const pre = (server, agent, tool_name, tool_input, cwd) => server.handle({ agent_id: agent, hook_event_name: 'PreToolUse', tool_name, tool_input, cwd });
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('hook: god is denied a project edit (and it is logged); a worker is not; hive writes pass', async (t) => {
  const { hive, server, proj } = await floor(t, {});
  const r = await pre(server, 'god-1', 'Edit', { file_path: path.join(proj, 'app.js') }, proj);
  assert.ok(denied(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /Orchestrator rule 1/);
  assert.ok(!denied(await pre(server, 'jim-1', 'Edit', { file_path: path.join(proj, 'app.js') }, proj)), 'workers change projects');
  assert.ok(!denied(await pre(server, 'god-1', 'Write', { file_path: path.join(hive.root(), 'board.md') }, proj)));
  const log = fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8');
  assert.match(log, /"kind":"god-guard"/);
});

test('hook: lever off, or no source installed, means no guard (upstream)', async (t) => {
  const off = await floor(t, { orchestrator: { godWriteGuard: false } });
  assert.ok(!denied(await pre(off.server, 'god-1', 'Bash', { command: 'git commit -m x' }, off.proj)));
  const none = await floor(t, null);
  assert.ok(!denied(await pre(none.server, 'god-1', 'Bash', { command: 'git commit -m x' }, none.proj)));
});

test('anchor: god gets a role reminder on SessionStart after compact/resume only', async (t) => {
  const { server, hive } = await floor(t, {});
  hive.writeFleetSnapshot({ ts: Date.now(), agents: [{ id: 'god-1', name: 'Michael', isGod: true, tokens: 1, lastActiveSecAgo: 1 }, { id: 'jim-1', name: 'Jim', tokens: 1, lastActiveSecAgo: 1 }] });
  const ctx = async (agent, source) => (await server.handle({ agent_id: agent, hook_event_name: 'SessionStart', session_id: `s-${source}`, source }))?.hookSpecificOutput?.additionalContext ?? '';
  const c = await ctx('god-1', 'compact');
  assert.match(c, /ROLE REMINDER \(your context was compacted\): you are Michael, the orchestrator/);
  assert.match(c, /LIVE ROSTER/, 'merged with the roster, not replacing it');
  assert.match(await ctx('god-1', 'resume'), /ROLE REMINDER \(your context was resumed\)/);
  assert.doesNotMatch(await ctx('god-1', 'startup'), /ROLE REMINDER/);
  assert.doesNotMatch(await ctx('jim-1', 'compact'), /ROLE REMINDER/);
  const off = await floor(t, { orchestrator: { compactAnchor: false } });
  assert.doesNotMatch((await off.server.handle({ agent_id: 'god-1', hook_event_name: 'SessionStart', session_id: 'x', source: 'compact' }))?.hookSpecificOutput?.additionalContext ?? '', /ROLE REMINDER/);
});

test('seams: three marked lines in hooks.ts; the guard runs before the operator approval gate', () => {
  const hooks = fs.readFileSync(path.join(ROOT, 'src/main/hooks.ts'), 'utf8');
  assert.equal(hooks.split('\n').filter((l) => l.includes('// fork: T-053')).length, 3, 'import, guard, anchor');
  const at = (s) => { const i = hooks.indexOf(s); assert.ok(i >= 0, `anchor gone: ${s}`); return i; };
  assert.ok(at('godWriteGuard(this.hive, agentId, event, p)') < at('// 7C.1 — HITL gate'));
  assert.ok(at('this.control?.shouldHalt(agentId)') < at('godWriteGuard(this.hive, agentId, event, p)'), 'an operator HALT still wins');
  assert.ok(at('steer = this.control.takeSteer(agentId)') < at('compactAnchor(this.hive, agentId, event, p.source)'));
  assert.ok(at('compactAnchor(this.hive, agentId, event, p.source)') < at('if (steer || roster || goal)'));
});
