#!/usr/bin/env node
// Hive protocol eval: runs fixtures S1-S8 headless against a throwaway hive and
// prints pass rate, tokens and $ per fixture. See eval/README.md.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { buildHarness, closingTimeText, provision } from './lib/build.mjs';
import { makeRepo } from './lib/repo.mjs';
import { runChecks, snapshot } from './lib/checks.mjs';
import { parseStream } from './lib/usage.mjs';

const { values: o } = parseArgs({ options: {
  ref: { type: 'string' },              // git ref to take src/ from (default: working tree)
  src: { type: 'string' },              // or a checkout directory
  runs: { type: 'string', default: '1' },
  only: { type: 'string' },             // e.g. S1,S7
  model: { type: 'string' },
  budget: { type: 'string', default: '8' },       // total $ cap for the whole invocation
  'run-budget': { type: 'string', default: '1.5' }, // $ cap per headless run
  timeout: { type: 'string', default: '600' },    // seconds per run
  claude: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean', default: false }, // set up + check, no model call
  keep: { type: 'boolean', default: false }       // keep run dirs (default keeps only logs)
} });

const FIX_DIR = new URL('./fixtures/', import.meta.url).pathname;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(o.out ?? join(process.env.TMPDIR ?? tmpdir(), 'md-eval', `${o.ref ?? 'worktree'}-${stamp}`.replace(/[^\w.-]/g, '_')));
const CLAUDE = o.claude ?? [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(existsSync) ?? 'claude';
mkdirSync(OUT, { recursive: true });

const mod = buildHarness({ ref: o.ref, src: o.src, out: join(OUT, 'build') });
const subs = {
  '{{ASK_FIRST_CLAUSE}}': mod.ASK_FIRST_CLAUSE,
  '{{CLOSING_TEXT}}': closingTimeText(mod.srcRoot)
};
const fill = (s, extra) => Object.entries({ ...subs, ...extra }).reduce((t, [k, v]) => t.split(k).join(v), s);
// Substitute run-time text into every string of a fixture (messages and checks).
const deepFill = (x, extra = {}) => typeof x === 'string' ? fill(x, extra)
  : Array.isArray(x) ? x.map((v) => deepFill(v, extra))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepFill(v, extra)])) : x;

const ids = (o.only ? o.only.split(',') : readdirSync(FIX_DIR).filter((f) => /^S\d+\.json$/.test(f)).map((f) => f.slice(0, -5)))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const runs = Number(o.runs);
let spent = 0;
const results = [];

function writeMsgs(dir, msgs = []) {
  mkdirSync(dir, { recursive: true });
  for (const m of msgs) writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m, null, 2));
}

function runClaude(argv, env, cwd, logFile) {
  return new Promise((done) => {
    const child = spawn(CLAUDE, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill('SIGTERM'), Number(o.timeout) * 1000);
    child.on('close', (code) => {
      clearTimeout(t);
      writeFileSync(logFile, out);
      if (err) writeFileSync(logFile.replace(/\.jsonl$/, '.stderr.txt'), err);
      done({ code, out });
    });
  });
}

async function runOne(id, n) {
  const dir = join(OUT, `${id}-${n}`);
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const fx = deepFill(JSON.parse(readFileSync(join(FIX_DIR, `${id}.json`), 'utf8')), { '{{REPO}}': repo });
  makeRepo(repo, fx.repo);
  const agents = [fx.agent, ...(fx.extraAgents ?? [])].map((a) => ({ ...a, cwd: repo }));
  const { root, inj } = await provision(mod, home, agents);
  const agentDir = join(root, 'agents', fx.agent.id);

  writeFileSync(join(agentDir, 'memory.md'), fx.memory ?? '');
  writeMsgs(join(agentDir, 'inbox'), fx.inbox);
  writeMsgs(join(agentDir, 'inbox', '.done'), fx.done);
  if (fx.tasks) writeFileSync(join(root, 'tasks.json'), JSON.stringify(fx.tasks, null, 2));
  if (fx.fleet) writeFileSync(join(root, 'fleet.json'), JSON.stringify(fx.fleet, null, 2));

  const prompt = inj[fx.agent.id].args[inj[fx.agent.id].args.indexOf('--append-system-prompt') + 1] ?? '';
  if (fx.agent.isGod === false && !prompt.includes(mod.ASK_FIRST_CLAUSE)) console.warn(`[${id}] warning: worker prompt lacks the ASK FIRST clause`);
  const trigger = mod.inboxNudgeText(fx.nudgeIds ?? (fx.inbox ?? []).map((m) => m.id));
  const ctx = { dir, repo, root, agentDir };
  ctx.before = snapshot(ctx);

  const remaining = Number(o.budget) - spent;
  const argv = ['-p', trigger, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--permission-mode', 'bypassPermissions', '--max-budget-usd', String(Math.min(Number(o['run-budget']), remaining).toFixed(2)),
    ...(o.model ? ['--model', o.model] : []), ...inj[fx.agent.id].args];
  writeFileSync(join(dir, 'argv.json'), JSON.stringify({ claude: CLAUDE, argv, env: inj[fx.agent.id].env }, null, 2));

  let usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0, error: null };
  if (!o['dry-run']) {
    const env = { ...process.env, ...inj[fx.agent.id].env };
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
    const r = await runClaude(argv, env, repo, join(dir, 'stream.jsonl'));
    usage = parseStream(r.out);
    if (r.code !== 0 && !usage.error) usage.error = `exit ${r.code}`;
  }
  ctx.usage = usage;
  spent += usage.costUsd;
  const checks = runChecks(ctx, fx.checks);
  const pass = checks.every((c) => c.ok || c.optional);
  if (!o.keep && !o['dry-run']) for (const p of ['repo', 'home']) rmSync(join(dir, p), { recursive: true, force: true });
  return { id, n, title: fx.title, pass, checks, usage };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

for (const id of ids) {
  for (let n = 1; n <= runs; n++) {
    if (!o['dry-run'] && spent >= Number(o.budget)) { console.log(`budget $${o.budget} reached, skipping ${id}#${n}`); continue; }
    const r = await runOne(id, n);
    results.push(r);
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.type}${c.optional ? '?' : ''}: ${c.detail}`);
    console.log(`${id}#${n} ${r.pass ? 'PASS' : 'FAIL'}  $${r.usage.costUsd.toFixed(3)}  ${r.usage.calls} calls${r.usage.error ? `  [${r.usage.error}]` : ''}${failed.length ? `\n    ${failed.join('\n    ')}` : ''}`);
  }
}

const rows = ids.map((id) => {
  const rs = results.filter((r) => r.id === id);
  if (!rs.length) return null;
  const tok = rs.map((r) => r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite);
  return {
    id, title: rs[0].title, pass: `${rs.filter((r) => r.pass).length}/${rs.length}`,
    tokens: median(tok), output: median(rs.map((r) => r.usage.output)), calls: median(rs.map((r) => r.usage.calls)),
    usd: median(rs.map((r) => r.usage.costUsd)), totalUsd: rs.reduce((s, r) => s + r.usage.costUsd, 0)
  };
}).filter(Boolean);

const table = [
  `ref: ${o.ref ?? 'working tree'}  runs: ${runs}  model: ${o.model ?? 'CLI default'}  total: $${spent.toFixed(2)}`,
  '',
  '| Fixture | Scenario | Pass | Median tokens | Median output | Median calls | Median $ | Total $ |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.id} | ${r.title} | ${r.pass} | ${r.tokens.toLocaleString('en')} | ${r.output.toLocaleString('en')} | ${r.calls} | ${r.usd.toFixed(3)} | ${r.totalUsd.toFixed(3)} |`)
].join('\n');
console.log('\n' + table + `\n\nruns kept in ${OUT}`);
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ ref: o.ref ?? null, runs, model: o.model ?? null, spent, rows, results }, null, 2));
writeFileSync(join(OUT, 'table.md'), table + '\n');
