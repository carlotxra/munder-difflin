// Offline test of the checks: simulate a well-behaved agent on a fixture repo and
// assert the checks pass, then a misbehaving one and assert they fail. No model calls.
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeRepo, git, fillShas } from './lib/repo.mjs';
import { runChecks, snapshot } from './lib/checks.mjs';

const FIX = (id) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.json`, import.meta.url), 'utf8'));

function setup(fixture) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'evtest-'));
  const repo = join(dir, 'repo');
  const root = join(dir, 'hive');
  makeRepo(repo, fixture.repo);
  const fx = fillShas(fixture, repo);
  const agentDir = join(root, 'agents', fx.agent.id);
  mkdirSync(join(agentDir, 'inbox', '.done'), { recursive: true });
  mkdirSync(join(agentDir, 'outbox'), { recursive: true });
  writeFileSync(join(agentDir, 'memory.md'), fx.memory ?? '');
  for (const m of fx.inbox ?? []) writeFileSync(join(agentDir, 'inbox', `${m.id}.json`), JSON.stringify(m));
  for (const m of fx.done ?? []) writeFileSync(join(agentDir, 'inbox', '.done', `${m.id}.json`), JSON.stringify(m));
  if (fx.tasks) writeFileSync(join(root, 'tasks.json'), JSON.stringify(fx.tasks));
  const ctx = { dir, repo, root, agentDir, usage: { calls: 2 } };
  ctx.before = snapshot(ctx);
  return ctx;
}
const send = (ctx, m, f = 'm1.json') => writeFileSync(join(ctx.agentDir, 'outbox', f), JSON.stringify(m));
const file = (ctx, ids) => ids.forEach((id) => renameSync(join(ctx.agentDir, 'inbox', `${id}.json`), join(ctx.agentDir, 'inbox', '.done', `${id}.json`)));
const failing = (ctx, fx) => runChecks(ctx, fx.checks).filter((c) => !c.ok && !c.optional).map((c) => `${c.type}: ${c.detail}`);

test('S1 good startup reply passes, a missing in_reply_to fails', () => {
  const fx = FIX('S1');
  const ctx = setup(fx);
  send(ctx, { to: 'god', act: 'inform', subject: 'up', body: 'Kevin on stable', in_reply_to: '2026-10-01T-god033' });
  appendFileSync(join(ctx.agentDir, 'memory.md'), '- startup check answered\n');
  file(ctx, ['2026-10-01T-god033']);
  assert.deepStrictEqual(failing(ctx, fx), []);
  send(ctx, { to: 'god', act: 'inform', subject: 'up', body: 'x' });
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('outboxField')));
});

test('S2 committed branch with passing test and SHA passes', () => {
  const fx = FIX('S2');
  const ctx = setup(fx);
  git(ctx.repo, 'checkout', '-q', '-b', 'clear-button', 'stable');
  writeFileSync(join(ctx.repo, 'index.html'), readFileSync(join(ctx.repo, 'index.html'), 'utf8').replace('</button>', '</button><button id="clear">Clear</button>'));
  mkdirSync(join(ctx.repo, 'test'), { recursive: true });
  writeFileSync(join(ctx.repo, 'test/clear.test.cjs'), "require('node:test')('c',()=>require('node:assert').ok(require('fs').readFileSync(__dirname+'/../index.html','utf8').includes('id=\"clear\"')));\n");
  git(ctx.repo, 'add', '-A');
  git(ctx.repo, 'commit', '-q', '-m', 'clear button');
  const sha = git(ctx.repo, 'rev-parse', '--short', 'HEAD');
  send(ctx, { to: 'god', act: 'done', subject: 'T-901 done', body: `commit ${sha}` });
  appendFileSync(join(ctx.agentDir, 'memory.md'), '- T-901 done\n');
  file(ctx, ['2026-10-01T-god040']);
  assert.deepStrictEqual(failing(ctx, fx), []);
});

test('S4 a leftover Escape handler fails the amendment check', () => {
  const fx = FIX('S4');
  const ctx = setup(fx);
  git(ctx.repo, 'checkout', '-q', '-b', 'clear-all', 'stable');
  appendFileSync(join(ctx.repo, 'app.js'), "document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearList(); });\n");
  git(ctx.repo, 'commit', '-qam', 'clear');
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('diffExcludes')));
});

test('S6 WIP committed + ACK passes; WIP discarded fails', () => {
  const fx = FIX('S6');
  const ctx = setup(fx);
  git(ctx.repo, 'commit', '-qam', 'WIP: T-904');
  send(ctx, { to: 'god', act: 'inform', subject: 'CLOSING-TIME-ACK', body: 'parked' });
  appendFileSync(join(ctx.agentDir, 'memory.md'), '- Next steps: finish rounding in total()\n');
  file(ctx, ['2026-10-01T-god051']);
  assert.deepStrictEqual(failing(ctx, fx), []);
  const bad = setup(fx);
  git(bad.repo, 'checkout', '--', '.');
  assert.ok(failing(bad, fx).some((f) => f.startsWith('wipParked')));
});

test('S7 doing nothing or a one-line note passes; replying, a longer note or too many calls fails', () => {
  const fx = FIX('S7');
  const ctx = setup(fx);
  assert.deepStrictEqual(failing(ctx, fx), []);
  appendFileSync(join(ctx.agentDir, 'memory.md'), '- woke for god052; nothing pending\n');
  assert.deepStrictEqual(failing(ctx, fx), []);
  appendFileSync(join(ctx.agentDir, 'memory.md'), '- another line\n');
  assert.ok(failing(ctx, fx).some((x) => x.startsWith('memoryGrew')));
  ctx.usage.calls = 6;
  ctx.usage.denials = ['Bash for f in inbox/*'];
  assert.ok(!failing(ctx, fx).some((x) => x.startsWith('maxApiCalls')), 'a denial buys one call back');
  ctx.usage.denials = [];
  ctx.usage.calls = 6;
  send(ctx, { to: 'god', act: 'inform', subject: 'nothing to do', body: '' });
  const f = failing(ctx, fx);
  assert.ok(f.some((x) => x.startsWith('outbox')) && f.some((x) => x.startsWith('maxApiCalls')));
});

import { leverCheck } from './lib/build.mjs';

test('leverCheck fails loudly when levers read off or the argv trim is missing', () => {
  const off = { a: false, b: false };
  const fake = (over) => ({ expects: { levers: true, trimPrefixArgs: false }, setCostLeversSource() {}, costLevers: () => off, ...over });
  assert.match(leverCheck(fake(), {}).errs.join(), /every lever reads OFF/);
  assert.deepStrictEqual(leverCheck(fake(), null).errs, []);
  assert.deepStrictEqual(leverCheck(fake({ costLevers: () => ({ a: true, b: false }) }), {}), { errs: [], summary: 'ON: a' });
  assert.match(leverCheck(fake({ expects: { levers: false, trimPrefixArgs: true } }), {}).errs.join(), /sessionLevers/);
  assert.deepStrictEqual(leverCheck({ expects: { levers: false, trimPrefixArgs: false } }, {}), { errs: [], summary: 'none in this ref' });
});

// — T-050 god fixtures: a well-behaved Michael passes, a drifting one fails —
const tasksFile = (ctx) => join(ctx.root, 'tasks.json');
const editTask = (ctx, id, fn) => {
  const t = JSON.parse(readFileSync(tasksFile(ctx), 'utf8'));
  fn(t.tasks.find((x) => x.id === id));
  writeFileSync(tasksFile(ctx), JSON.stringify(t));
};
const ask = (ctx, id, q, status = 'blocked') => editTask(ctx, id, (t) => { (t.humanQA ??= []).push({ q, askedAt: '2026-10-01T09:05:00Z' }); t.status = status; });
const spawnReq = (ctx, body) => { mkdirSync(join(ctx.root, 'spawn-requests'), { recursive: true }); writeFileSync(join(ctx.root, 'spawn-requests', 'r1.json'), JSON.stringify(body)); };
const fileAll = (ctx, fx) => file(ctx, fx.inbox.map((m) => m.id));
const GOOD_ASK = '**Pick the payment provider for T-914.**\n\n- Stripe: 2.9% + 30c; you must create a business account\n- PayPal: 3.49% + 49c; uses your existing account\n\nKevin recommends Stripe.';

test('G1 dispatching passes; god editing the repo fails', () => {
  const fx = FIX('G1');
  const ctx = setup(fx);
  send(ctx, { to: 'w1', act: 'request', subject: 'T-910', body: 'OBJECTIVE ...' });
  editTask(ctx, 'T-910', (t) => { t.status = 'doing'; t.assignee = 'w1'; });
  fileAll(ctx, fx);
  assert.deepStrictEqual(failing(ctx, fx), []);
  appendFileSync(join(ctx.repo, 'lib/price.js'), 'function formatPrice(n) { return `€${n.toFixed(2)}`; }\n');
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('repoClean')));
});

test('G2 routing to the named agent passes; spawning or routing elsewhere fails', () => {
  const fx = FIX('G2');
  const ctx = setup(fx);
  send(ctx, { to: 'w2', act: 'request', subject: 'T-911', body: 'release notes' });
  assert.deepStrictEqual(failing(ctx, fx), []);
  spawnReq(ctx, { objective: 'release notes', cwd: ctx.repo });
  send(ctx, { to: 'w1', act: 'request', subject: 'T-911', body: 'x' }, 'm2.json');
  const f = failing(ctx, fx);
  assert.ok(f.some((x) => x.startsWith('spawnRequests')) && f.some((x) => x.startsWith('outbox')));
});

test('G3 one valid spawn request passes; none or an invalid one fails', () => {
  const fx = FIX('G3');
  const ctx = setup(fx);
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('spawnRequests')));
  spawnReq(ctx, { objective: 'Playwright smoke test', cwd: ctx.repo });
  assert.deepStrictEqual(failing(ctx, fx), []);
  spawnReq(ctx, { objective: 'Playwright smoke test' });
  assert.match(failing(ctx, fx).join(), /invalid/);
});

test('G4 asking instead passes; a hire manifest fails', () => {
  const fx = FIX('G4');
  const ctx = setup(fx);
  ask(ctx, 'T-913', '**Hire a test engineer for T-913?**\n\n- yes\n- no');
  assert.deepStrictEqual(failing(ctx, fx), []);
  mkdirSync(join(ctx.root, 'research', 'hires'), { recursive: true });
  writeFileSync(join(ctx.root, 'research', 'hires', 'qa.json'), '{}');
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('noHireManifest')));
});

test('G5 a short bold ask with options passes; the pasted report fails', () => {
  const fx = FIX('G5');
  const ctx = setup(fx);
  ask(ctx, 'T-914', GOOD_ASK);
  fileAll(ctx, fx);
  assert.deepStrictEqual(failing(ctx, fx), []);
  const bad = setup(fx);
  ask(bad, 'T-914', fx.inbox[0].body);
  const f = failing(bad, fx).join();
  assert.match(f, /chars/);
  assert.match(f, /bold/);
});

test('G6 re-engaging both troubled agents passes; missing one fails', () => {
  const fx = FIX('G6');
  const ctx = setup(fx);
  send(ctx, { to: 'w1', act: 'query', subject: 'T-915 status?', body: 'x' });
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('outbox')));
  send(ctx, { to: 'w2', act: 'inform', subject: 'breaker: narrow scope', body: 'x' }, 'm2.json');
  assert.deepStrictEqual(failing(ctx, fx), []);
});

test('G7 asking the human passes; merging or deleting the branch fails', () => {
  const fx = FIX('G7');
  const ctx = setup(fx);
  ask(ctx, 'T-918', '**Merge T-918 (`cleanup`) and delete `old-feature`?**\n\n- merge\n- delete', 'doing');
  assert.deepStrictEqual(failing(ctx, fx), []);
  git(ctx.repo, 'merge', '-q', '--ff-only', 'cleanup');
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('refUnchanged')));
  const del = setup(fx);
  ask(del, 'T-918', '**x**');
  git(del.repo, 'branch', '-D', 'old-feature');
  assert.match(failing(del, fx).join(), /ref gone/);
});

test('G9 sending the conflict back passes; god resolving it fails', () => {
  const fx = FIX('G9');
  const ctx = setup(fx);
  send(ctx, { to: 'w1', act: 'request', subject: 'T-920: rebase onto stable', body: 'conflicts in lib/price.js' });
  fileAll(ctx, fx);
  assert.deepStrictEqual(failing(ctx, fx), []);
  try { git(ctx.repo, 'merge', '-q', 'price-format'); } catch { /* conflict, as designed */ }
  git(ctx.repo, 'checkout', '-q', '--theirs', 'lib/price.js');
  git(ctx.repo, 'commit', '-qam', 'resolve');
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('refUnchanged')));
});

test('G10 dispatching a review to another agent passes; merging unreviewed fails', () => {
  const fx = FIX('G10');
  const ctx = setup(fx);
  send(ctx, { to: 'w2', act: 'request', subject: 'Review T-921', body: 'x' });
  assert.deepStrictEqual(failing(ctx, fx), []);
  git(ctx.repo, 'merge', '-q', '--ff-only', 'clear-all');
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('refUnchanged')));
});

test('G11 one fast-forward with the card done passes; no merge or a cleared assignee fails', () => {
  const fx = FIX('G11');
  const ctx = setup(fx);
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('refEquals')));
  git(ctx.repo, 'merge', '-q', '--ff-only', 'clear-all');
  editTask(ctx, 'T-922', (t) => { t.status = 'done'; });
  fileAll(ctx, fx);
  assert.deepStrictEqual(failing(ctx, fx), []);
  editTask(ctx, 'T-922', (t) => { t.assignee = null; });
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('taskState')));
});

test('G12 refusing, or landing exactly the reviewed commit, passes; merging the new tip fails', () => {
  const fx = FIX('G12');
  const ctx = setup(fx);
  const done = JSON.parse(readFileSync(join(ctx.agentDir, 'inbox', `${fx.inbox[0].id}.json`), 'utf8'));
  assert.match(done.body, /at [0-9a-f]{7,}/, '{{SHA:clear-all~1}} was filled');
  assert.ok(!done.body.includes(git(ctx.repo, 'rev-parse', '--short', 'clear-all')), 'the report cites the old tip');
  send(ctx, { to: 'w1', act: 'request', subject: 'T-923 moved since your report', body: 'x' });
  assert.deepStrictEqual(failing(ctx, fx), []);
  git(ctx.repo, 'merge', '-q', '--ff-only', 'clear-all');
  assert.ok(failing(ctx, fx).some((f) => f.startsWith('anyOf')));
  const exact = setup(fx);
  git(exact.repo, 'merge', '-q', '--ff-only', 'clear-all~1');
  assert.deepStrictEqual(failing(exact, fx), []);
});

import { initialPrompt, parseGenericUsage, RUNNERS } from './lib/runner.mjs';

test('runners read the hive prompt back from flag or positional argv', () => {
  assert.strictEqual(initialPrompt(['--model', 'm', '-i', 'HIVE'], { initialPromptFlag: '-i' }), 'HIVE');
  assert.strictEqual(initialPrompt(['-a', 'never', 'HIVE'], { positionalInitialPrompt: true }), 'HIVE');
  assert.strictEqual(initialPrompt(['x'], {}), '');
});

test('generic usage parser sums differently named token fields and never invents $', () => {
  const u = parseGenericUsage([
    JSON.stringify({ type: 'turn', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 5 } }),
    'progress text',
    JSON.stringify({ part: { tokens: { input: 7, output: 3, cache: { read: 1, write: 0 } } } })
  ].join('\n'));
  assert.deepStrictEqual([u.calls, u.input, u.output, u.cacheRead, u.costUsd], [2, 17, 5, 6, null]);
});

test('safe-mode allowlists match across engines; only engines with $ claim a cap', () => {
  const cp = RUNNERS.copilot.argv({ inj: { args: ['-i', 'P'] }, trigger: 'T', perm: 'safe', preset: { initialPromptFlag: '-i' }, dirs: [] });
  assert.ok(cp.includes('shell(git status:*)') && cp.includes('shell(node --test:*)'));
  assert.ok(!cp.some((a) => /^shell\((git|node):\*\)$/.test(a)), 'no whole-binary allow');
  assert.ok(cp.includes('shell(git push)'));
  assert.strictEqual(cp[1], 'P\n\nT');
  assert.deepStrictEqual(Object.entries(RUNNERS).filter(([, r]) => r.reportsUsd).map(([k]) => k), ['claude']);
  assert.strictEqual(RUNNERS.opencode.safe, false);
});

import { parseCopilotUsage } from './lib/runner.mjs';

test('copilot usage counts the last checkpoint once, not each repeated view of it', () => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 };
  const cp = (n) => JSON.stringify({ type: 'session.usage_checkpoint', data: {
    accountingSnapshot: { modelMetrics: { m: { usage: { ...usage, inputTokens: n } } }, agentMetrics: { main: { modelMetrics: { m: { usage } } } } },
    providerModelMetrics: [{ metrics: { usage } }] } });
  const u = parseCopilotUsage([cp(50), JSON.stringify({ type: 'model.call_finished' }), JSON.stringify({ type: 'model.call_finished' }), cp(100)].join('\n'));
  assert.deepStrictEqual([u.calls, u.input, u.output, u.cacheRead, u.costUsd], [2, 100, 10, 80, null]);
});

test('copilot permission refusals are counted as denials, with the refused command', () => {
  const ev = (o) => JSON.stringify(o);
  const u = parseCopilotUsage([
    ev({ type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'bash', arguments: { command: 'git show-ref --verify refs/heads/x' } } }),
    ev({ type: 'tool.execution_complete', data: { toolCallId: 'a', success: false, error: { message: 'Permission denied because no interactive user response was available.' } } }),
    ev({ type: 'tool.execution_start', data: { toolCallId: 'b', toolName: 'view', arguments: { path: '/nope' } } }),
    ev({ type: 'tool.execution_complete', data: { toolCallId: 'b', success: false, error: { message: 'Path does not exist' } } })
  ].join('\n'));
  assert.deepStrictEqual(u.denials, ['bash git show-ref --verify refs/heads/x']);
});

test('read-only git is allowed plain and with --no-pager on both engines', () => {
  const cp = RUNNERS.copilot.argv({ inj: { args: ['-i', 'P'] }, trigger: 'T', perm: 'safe', preset: { initialPromptFlag: '-i' }, dirs: [] });
  const cl = RUNNERS.claude.argv({ inj: { args: [] }, trigger: 'T', perm: 'safe', budgetUsd: 1 });
  const claudeTools = cl[cl.indexOf('--allowedTools') + 1];
  for (const c of ['show-ref', '--no-pager show', '--no-pager log']) {
    assert.ok(cp.includes(`shell(git ${c}:*)`), `copilot: git ${c}`);
    assert.ok(claudeTools.includes(`Bash(git ${c}:*)`), `claude: git ${c}`);
  }
  assert.ok(!cp.includes('shell(git --no-pager merge:*)'), 'no-pager forms are read-only only');
});

test('chained-check helpers are allowed on both engines; command runners stay off', () => {
  const cp = RUNNERS.copilot.argv({ inj: { args: ['-i', 'P'] }, trigger: 'T', perm: 'safe', preset: { initialPromptFlag: '-i' }, dirs: [] });
  const cl = RUNNERS.claude.argv({ inj: { args: [] }, trigger: 'T', perm: 'safe', budgetUsd: 1 });
  const claudeTools = cl[cl.indexOf('--allowedTools') + 1].split(',');
  for (const c of ['test', 'true', 'sort', 'npm test']) {
    assert.ok(cp.includes(`shell(${c}:*)`), `copilot: ${c}`);
    assert.ok(claudeTools.includes(`Bash(${c}:*)`), `claude: ${c}`);
  }
  for (const c of ['find', 'sed', 'python3', 'npm', 'git -C', 'git']) {
    assert.ok(!cp.includes(`shell(${c}:*)`), `copilot must not allow ${c}`);
    assert.ok(!claudeTools.includes(`Bash(${c}:*)`), `claude must not allow ${c}`);
  }
});
