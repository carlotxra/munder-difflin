'use strict';

/**
 * T-054: the `hive` command line (src/main/custom/hiveCli*.ts), installed by a
 * real god spawn with prompt V2 + hiveCli on, then run as its own process the
 * way god runs it. Every command: one success and its refusals.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const orch = loadTs('src/main/custom/orchestrator.ts');
const { ASK_FIRST_CLAUSE } = loadTs('src/main/askFirst.ts');
const { resolveOrchestratorLevers } = loadTs('src/shared/custom/orchestratorLevers.ts');

const ON = { orchestrator: { godPromptV2: true, hiveCli: true, integrationBranch: 'stable' } };

async function floor(t, config = ON, { maySpawn = false } = {}) {
  orch.setOrchestratorLeversSource(() => config);
  t.after(() => orch.setOrchestratorLeversSource(null));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.setOrchestratorMaySpawn(maySpawn);
  await hive.ensureAgent({ id: 'w1', name: 'Kevin', provider: 'claude', cwd: home, role: 'developer' });
  await hive.ensureAgent({ id: 'w2', name: 'Dwight', provider: 'claude', cwd: home, role: 'reviewer' });
  const inj = await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  const root = hive.root();
  const cli = path.join(root, 'bin', 'hive-cli.cjs');
  const run = (args, agent = 'god') => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, AGENT_ID: agent } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const tasks = () => JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  const card = (id) => tasks().find((x) => x.id === id);
  const outbox = () => { const d = path.join(root, 'agents', 'god', 'outbox'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : []; };
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'T-1', title: 'Clear button', status: 'todo', priority: 'med', assignee: null, deps: [] }] }));
  return { home, hive, root, cli, run, card, outbox, prompt };
}

test('lever: hiveCli is off by default', () => {
  assert.equal(resolveOrchestratorLevers({}).hiveCli, false);
});

test('install: god spawn writes the script and settings; V2 prompt advertises it; off = neither', async (t) => {
  const { root, cli, prompt } = await floor(t);
  assert.ok(fs.existsSync(cli));
  const s = JSON.parse(fs.readFileSync(path.join(root, 'bin', 'hive-cli.json'), 'utf8'));
  assert.equal(s.godId, 'god');
  assert.equal(s.askFirstClause, ASK_FIRST_CLAUSE);
  assert.match(prompt, /## Commands/);
  assert.ok(prompt.includes(`${path.join(root, 'bin', 'hive-node')} ${cli} <command>`), 'the exact command to run');
  assert.doesNotMatch(prompt, /`spawn --objective/, 'spawn only listed when spawning is on');
  const off = await floor(t, { orchestrator: { godPromptV2: true } });
  assert.ok(!fs.existsSync(off.cli));
  assert.doesNotMatch(off.prompt, /## Commands/);
});

test('help and unknown commands', async (t) => {
  const { run } = await floor(t);
  assert.match(run(['help']).out, /dispatch --to <agent>/);
  const r = run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command/);
});

test('dispatch: contract + done clause + ASK FIRST, card doing with assignee; refusals', async (t) => {
  const { run, card, outbox } = await floor(t);
  const ok = run(['dispatch', '--to', 'w1', '--task', 'T-1', '--objective', 'Add a clear button', '--output', 'a branch', '--boundaries', 'index.html and app.js only']);
  assert.equal(ok.code, 0, ok.err);
  const [m] = outbox();
  assert.equal(m.to, 'w1');
  assert.equal(m.act, 'request');
  assert.match(m.body, /OBJECTIVE: Add a clear button\nOUTPUT: a branch\nTOOLS: .+\nBOUNDARIES: index.html and app.js only Bring your branch up to date with `stable`/);
  assert.ok(m.body.includes(ASK_FIRST_CLAUSE));
  assert.deepEqual([card('T-1').status, card('T-1').assignee], ['doing', 'w1']);
  assert.match(run(['dispatch', '--to', 'nobody', '--task', 'T-1', '--objective', 'x', '--output', 'y', '--boundaries', 'z']).err, /no live agent "nobody"/);
  assert.match(run(['dispatch', '--to', 'w1', '--task', 'T-1', '--output', 'y', '--boundaries', 'z']).err, /missing --objective/);
  assert.match(run(['dispatch', '--to', 'w1', '--task', 'T-9', '--objective', 'x', '--output', 'y', '--boundaries', 'z']).err, /add --title/);
  assert.match(run(['dispatch', '--to', 'w2', '--task', 'T-1', '--objective', 'x', '--output', 'y', '--boundaries', 'z'], 'w1').err, /only the orchestrator/);
});

test('ask: card-shaped asks land in humanQA and block the card; reports are refused', async (t) => {
  const { run, card } = await floor(t);
  const good = '**Pick the payment provider for T-1.**\n\n- Stripe\n- PayPal';
  assert.equal(run(['ask', '--task', 'T-1', '--q', good]).code, 0);
  assert.equal(card('T-1').humanQA[0].q, good);
  assert.equal(card('T-1').status, 'blocked');
  const bad = run(['ask', '--task', 'T-1', '--q', 'I looked into it for an hour. '.repeat(30)]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /under 700/);
  assert.match(bad.err, /\*\*bold\*\*/);
  assert.match(bad.err, /own "-" or "1\." line/);
  assert.equal(card('T-1').humanQA.length, 1);
});

test('task: add, status and done never clear the assignee', async (t) => {
  const { run, card } = await floor(t);
  run(['dispatch', '--to', 'w1', '--task', 'T-1', '--objective', 'x', '--output', 'y', '--boundaries', 'z']);
  assert.equal(run(['task', 'status', 'T-1', 'blocked']).code, 0);
  assert.equal(run(['task', 'done', 'T-1']).code, 0);
  assert.deepEqual([card('T-1').status, card('T-1').assignee], ['done', 'w1']);
  assert.equal(run(['task', 'add', '--id', 'T-2', '--title', 'Docs']).code, 0);
  assert.equal(card('T-2').status, 'todo');
  assert.match(run(['task', 'add', '--id', 'T-2', '--title', 'again']).err, /already exists/);
  assert.match(run(['task', 'status', 'T-1', 'finished']).err, /status must be/);
});

test('review: never to the author; records the reviewer', async (t) => {
  const { run, card } = await floor(t);
  run(['dispatch', '--to', 'w1', '--task', 'T-1', '--objective', 'x', '--output', 'y', '--boundaries', 'z']);
  assert.match(run(['review', '--task', 'T-1', '--to', 'w1', '--branch', 'b', '--sha', 'abc']).err, /must be a different agent/);
  assert.equal(run(['review', '--task', 'T-1', '--to', 'w2', '--branch', 'b', '--sha', 'abc']).code, 0);
  assert.equal(card('T-1').reviewer, 'w2');
});

// — merge, against a real repo —

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'stable');
  g('config', 'user.email', 'e@x.invalid'); g('config', 'user.name', 'e'); g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'app.js'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'init');
  g('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'app.js'), 'b\n'); fs.writeFileSync(path.join(dir, 'index.html'), '<b>\n');
  g('add', '-A'); g('commit', '-qm', 'feature');
  g('checkout', '-q', 'stable');
  return { dir, g, sha: g('rev-parse', 'feature') };
}

test('merge: refuses without review, without the human, when moved or not fast-forward; lands otherwise', async (t) => {
  const { run, card } = await floor(t);
  const r = repo(t);
  run(['dispatch', '--to', 'w1', '--task', 'T-1', '--objective', 'x', '--output', 'y', '--boundaries', 'z']);
  run(['review', '--task', 'T-1', '--to', 'w2', '--branch', 'feature', '--sha', r.sha]);
  const base = ['merge', '--task', 'T-1', '--repo', r.dir, '--branch', 'feature', '--sha', r.sha];
  assert.match(run(base).err, /needs a review by a different agent/);
  assert.match(run([...base, '--reviewed-by', 'w1']).err, /must not be the author/);
  assert.match(run([...base, '--reviewed-by', 'w2']).err, /needs the human's yes/);
  assert.match(run(['merge', '--task', 'T-1', '--repo', r.dir, '--branch', 'feature', '--sha', 'deadbeef']).err, /not a commit/);
  const ok = run([...base, '--reviewed-by', 'w2', '--human', 'msg hum-1: OK merge T-1']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(r.g('rev-parse', 'stable'), r.sha);
  assert.equal(card('T-1').status, 'done');
  assert.equal(card('T-1').assignee, 'w1');
  assert.equal(card('T-1').merged.human, 'msg hum-1: OK merge T-1');
  assert.match(ok.out, /Not pushed/);
});

test('merge: moved branch and conflicting branch go back to the author; fetch path when not checked out', async (t) => {
  const cfg = { orchestrator: { godPromptV2: true, hiveCli: true, integrationBranch: 'stable', reviewPolicy: 'tests-only' } };
  const { run } = await floor(t, cfg);
  const r = repo(t);
  run(['dispatch', '--to', 'w1', '--task', 'T-1', '--objective', 'x', '--output', 'y', '--boundaries', 'z']);
  const reported = r.sha;
  r.g('checkout', '-q', 'feature'); fs.writeFileSync(path.join(r.dir, 'notes.md'), 'n\n'); r.g('add', '-A'); r.g('commit', '-qm', 'wip');
  const moved = run(['merge', '--task', 'T-1', '--repo', r.dir, '--branch', 'feature', '--sha', reported, '--human', 'yes']);
  assert.match(moved.err, /has moved since the report.*send it back to w1/);
  r.g('checkout', '-q', 'stable'); fs.writeFileSync(path.join(r.dir, 'app.js'), 'c\n'); r.g('commit', '-qam', 'stable moved');
  const tip = r.g('rev-parse', 'feature');
  assert.match(run(['merge', '--task', 'T-1', '--repo', r.dir, '--branch', 'feature', '--sha', tip, '--human', 'yes']).err, /cannot fast-forward stable; send it back to w1/);
  // A clean fast-forward while another branch is checked out uses `git fetch . <sha>:stable`.
  const r2 = repo(t);
  r2.g('checkout', '-q', 'feature');
  const ok = run(['merge', '--task', 'T-1', '--repo', r2.dir, '--branch', 'feature', '--sha', r2.sha, '--human', 'yes']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(r2.g('rev-parse', 'stable'), r2.sha);
});

test('spawn: refused when off; shows the roster first; files a request with --none-fit', async (t) => {
  const off = await floor(t);
  assert.match(off.run(['spawn', '--objective', 'x', '--cwd', off.home]).err, /spawning is switched off/);
  const on = await floor(t, ON, { maySpawn: true });
  assert.match(on.prompt, /`spawn --objective/);
  const first = on.run(['spawn', '--objective', 'Playwright smoke test', '--cwd', on.home]);
  assert.match(first.err, /reuse an existing agent first.*w1 \(developer\).*--none-fit/);
  assert.equal(on.run(['spawn', '--objective', 'Playwright smoke test', '--cwd', on.home, '--none-fit', '--name', 'QA']).code, 0);
  const reqs = fs.readdirSync(path.join(on.root, 'spawn-requests')).filter((f) => f.endsWith('.json'));
  assert.equal(reqs.length, 1);
  const body = JSON.parse(fs.readFileSync(path.join(on.root, 'spawn-requests', reqs[0]), 'utf8'));
  assert.deepEqual([body.objective, body.cwd, body.name], ['Playwright smoke test', on.home, 'QA']);
});

test('roster: one line per live agent with open cards', async (t) => {
  const { run } = await floor(t);
  run(['dispatch', '--to', 'w1', '--task', 'T-1', '--objective', 'x', '--output', 'y', '--boundaries', 'z']);
  const out = run(['roster']).out;
  assert.match(out, /^w1 \| Kevin \| developer \| .* \| T-1 doing$/m);
  assert.match(out, /^god \| Michael \| orchestrator/m);
});
