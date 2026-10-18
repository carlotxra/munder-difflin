#!/usr/bin/env node
// Hive protocol eval: runs fixtures (S* worker/protocol, G* god/orchestrator)
// headless against a throwaway hive and prints pass rate, tokens and $ per
// fixture, per engine. See eval/README.md.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { buildHarness, closingTimeText, provision, leverCheck } from './lib/build.mjs';
import { makeRepo, fillShas } from './lib/repo.mjs';
import { runChecks, snapshot } from './lib/checks.mjs';
import { RUNNERS, initialPrompt } from './lib/runner.mjs';

const { values: o } = parseArgs({ options: {
  build: { type: 'string' },            // a checkout directory or a git ref/branch
  ref: { type: 'string' },              // git ref to take src/ from (default: working tree)
  src: { type: 'string' },              // or a checkout directory
  runs: { type: 'string', default: '1' },
  only: { type: 'string' },             // e.g. S1,S7,G1
  provider: { type: 'string', default: 'claude' }, // T-050: engine for the agent under test
  model: { type: 'string' },
  matrix: { type: 'string' },           // T-050: JSON file, [{provider, model?}], one arm each
  'accept-uncapped': { type: 'boolean', default: false }, // T-050: allow engines --max-usd cannot cap
  'max-usd': { type: 'string' },                  // total $ cap; no new run starts once reached
  budget: { type: 'string', default: '8' },       // old name for --max-usd
  'run-budget': { type: 'string', default: '1.5' }, // $ cap per headless run
  timeout: { type: 'string', default: '600' },    // seconds per run
  claude: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean', default: false }, // set up + check, no model call
  keep: { type: 'boolean', default: false },      // keep run dirs (default keeps only logs)
  levers: { type: 'string', default: 'on' },      // cost levers: on = fork defaults, off = upstream, or a JSON config file
  orchestrator: { type: 'string', default: 'on' }, // T-052: on = fork defaults, off = upstream, or a JSON file of config.orchestrator keys
  perm: { type: 'string', default: 'safe' }       // safe = tool + env allowlist; live = harness's bypassPermissions (human opt-in)
} });

// --build takes either a directory or a ref; --max-usd wins over --budget.
if (o.build) { if (existsSync(o.build)) o.src = o.build; else o.ref = o.build; }
const MAX_USD = Number(o['max-usd'] ?? o.budget);
if (!['safe', 'live'].includes(o.perm)) { console.error('--perm must be safe or live'); process.exit(2); }

// One arm per engine/model pair: --matrix, or the single --provider/--model.
const ARMS = (o.matrix ? JSON.parse(readFileSync(o.matrix, 'utf8')) : [{ provider: o.provider, model: o.model }])
  .map((a) => ({ provider: a.provider ?? 'claude', model: a.model ?? null, orchestrator: a.orchestrator ?? null }));
for (const a of ARMS) {
  const r = RUNNERS[a.provider];
  if (!r) { console.error(`unknown or unverified provider "${a.provider}" (have: ${Object.keys(RUNNERS).join(', ')})`); process.exit(2); }
  // --perm safe needs a tool allowlist the engine itself enforces.
  if (o.perm === 'safe' && !r.safe) { console.error(`${a.provider} has no enforceable safe mode; rerun with --perm live (human opt-in)`); process.exit(2); }
  // --max-usd only caps engines that report $. Spending on any other engine must be explicit.
  if (!r.reportsUsd && !o['dry-run'] && !o['accept-uncapped']) {
    console.error(`${a.provider} reports no $ cost, so --max-usd cannot cap it (it bills its own units, e.g. premium requests). Rerun with --accept-uncapped to accept that.`);
    process.exit(2);
  }
}
// An arm may set its own orchestrator levers (e.g. { "godPromptV2": true }) for a
// side-by-side A/B in one table; the label shows which keys it set.
const armLabel = (a) => `${a.provider}${a.model ? `:${a.model}` : ''}${a.orchestrator ? ` ${Object.entries(a.orchestrator).map(([k, v]) => `${k}=${v}`).join(',')}` : ''}`;

// Child env for --perm safe: an allowlist, never the parent's whole environment.
// Each engine adds the keys its own login needs (runner.envKeep).
const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_\w+)$/;
const childEnv = (extra, keep) => {
  const base = o.perm === 'live' ? { ...process.env } : Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_KEEP.test(k) || keep?.test(k)));
  for (const k of Object.keys(base)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete base[k];
  return { ...base, ...extra };
};

const LEVERS = o.levers === 'off' ? null : o.levers === 'on' ? {} : JSON.parse(readFileSync(o.levers, 'utf8'));
const ORCH = o.orchestrator === 'off' ? null : o.orchestrator === 'on' ? {} : JSON.parse(readFileSync(o.orchestrator, 'utf8'));
const orchFor = (arm) => (arm.orchestrator ? { ...(ORCH ?? {}), ...arm.orchestrator } : ORCH);

const FIX_DIR = new URL('./fixtures/', import.meta.url).pathname;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(o.out ?? join(process.env.TMPDIR ?? tmpdir(), 'md-eval', `${o.ref ?? 'worktree'}-${stamp}`.replace(/[^\w.-]/g, '_')));
mkdirSync(OUT, { recursive: true });

const mod = buildHarness({ ref: o.ref, src: o.src, out: join(OUT, 'build') });
const LC = leverCheck(mod, LEVERS);
if (LC.errs.length) {
  console.error(`\nEVAL ABORTED: this build would not run as the app runs it.\n  - ${LC.errs.join('\n  - ')}\n`);
  process.exit(3);
}
const subs = {
  '{{ASK_FIRST_CLAUSE}}': mod.ASK_FIRST_CLAUSE,
  '{{CLOSING_TEXT}}': closingTimeText(mod.srcRoot)
};
const fill = (s, extra) => Object.entries({ ...subs, ...extra }).reduce((t, [k, v]) => t.split(k).join(v), s);
// Substitute run-time text into every string of a fixture (messages and checks).
const deepFill = (x, extra = {}) => typeof x === 'string' ? fill(x, extra)
  : Array.isArray(x) ? x.map((v) => deepFill(v, extra))
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepFill(v, extra)])) : x;

// S* (worker/protocol) then G* (god), each in numeric order.
const fixKey = (id) => [id[0] === 'S' ? 0 : 1, Number(id.slice(1))];
const ids = (o.only ? o.only.split(',') : readdirSync(FIX_DIR).filter((f) => /^[SG]\d+\.json$/.test(f)).map((f) => f.slice(0, -5)))
  .sort((a, b) => { const [x, y] = [fixKey(a), fixKey(b)]; return x[0] - y[0] || x[1] - y[1]; });
const runs = Number(o.runs);
let spent = 0;

// Estimate before spending anything: per-fixture $ from eval/estimates.json (each
// real run writes fresh medians to <out>/estimates.json to copy over it), else a
// flat guess. The ceiling is every run hitting its own --run-budget cap. Only
// engines that report $ count; the others were accepted as uncapped above.
const EST = (() => { try { return JSON.parse(readFileSync(new URL('./estimates.json', import.meta.url), 'utf8')); } catch { return {}; } })();
const usdArms = ARMS.filter((a) => RUNNERS[a.provider].reportsUsd).length;
const estimate = usdArms * ids.reduce((s, id) => s + runs * (EST[id] ?? EST.default ?? 0.5), 0);
const ceiling = usdArms * ids.length * runs * Number(o['run-budget']);
console.log(`perm mode: ${o.perm}  levers (${o.levers}): ${LC.summary}${mod.trimPrefixArgs ? '  +trimPrefixArgs' : ''}`);
const orchSummary = !mod.setOrchestratorLeversSource ? 'none in this ref' : ORCH === null ? 'off (upstream)' : JSON.stringify(ORCH) === '{}' ? 'fork defaults' : JSON.stringify(ORCH);
console.log(`orchestrator (${o.orchestrator}): ${orchSummary}`);
console.log(`engines: ${ARMS.map(armLabel).join(', ')}`);
console.log(`eval: ${ids.length} fixtures x ${runs} runs x ${ARMS.length} engines = ${ids.length * runs * ARMS.length} headless runs`);
console.log(`estimated cost $${estimate.toFixed(2)} (ceiling $${ceiling.toFixed(2)}), --max-usd $${MAX_USD.toFixed(2)}${o['dry-run'] ? ' — dry run, nothing will be spent' : ''}`);
const uncapped = ARMS.filter((a) => !RUNNERS[a.provider].reportsUsd);
if (uncapped.length) console.log(`uncapped (no $ figure; billed in the engine's own units): ${uncapped.map(armLabel).join(', ')} — ${ids.length * runs} runs each`);
if (!o['dry-run'] && estimate > MAX_USD) {
  console.error(`aborting: the estimate is over --max-usd. Lower --runs/--only or raise --max-usd.`);
  process.exit(2);
}
const results = [];

function writeMsgs(dir, msgs = []) {
  mkdirSync(dir, { recursive: true });
  for (const m of msgs) writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m, null, 2));
}

function runCli(bin, argv, env, cwd, logFile) {
  return new Promise((done) => {
    const child = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill('SIGTERM'), Number(o.timeout) * 1000);
    child.on('error', (e) => { err += String(e); });
    child.on('close', (code) => {
      clearTimeout(t);
      writeFileSync(logFile, out);
      if (err) writeFileSync(logFile.replace(/\.jsonl$/, '.stderr.txt'), err);
      done({ code, out });
    });
  });
}

async function runOne(id, n, arm, ai) {
  const runner = RUNNERS[arm.provider];
  const dir = join(OUT, ARMS.length > 1 ? `${id}-${n}-a${ai}` : `${id}-${n}`);
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  let fx = deepFill(JSON.parse(readFileSync(join(FIX_DIR, `${id}.json`), 'utf8')), { '{{REPO}}': repo });
  makeRepo(repo, fx.repo);
  fx = fillShas(fx, repo);
  const agents = [fx.agent, ...(fx.extraAgents ?? [])].map((a) => ({ ...a, cwd: repo }));
  const { root, inj } = await provision(mod, home, agents, { levers: LEVERS, orchestrator: orchFor(arm), provider: arm.provider, maySpawn: !!fx.hive?.maySpawn });
  const agentDir = join(root, 'agents', fx.agent.id);

  writeFileSync(join(agentDir, 'memory.md'), fx.memory ?? '');
  writeMsgs(join(agentDir, 'inbox'), fx.inbox);
  writeMsgs(join(agentDir, 'inbox', '.done'), fx.done);
  if (fx.tasks) writeFileSync(join(root, 'tasks.json'), JSON.stringify(fx.tasks, null, 2));
  if (fx.fleet) writeFileSync(join(root, 'fleet.json'), JSON.stringify(fx.fleet, null, 2));

  const me = inj[fx.agent.id];
  const preset = mod.providerPreset(arm.provider);
  const prompt = arm.provider === 'claude'
    ? me.args[me.args.indexOf('--append-system-prompt') + 1] ?? ''
    : initialPrompt(me.args, preset);
  if (fx.agent.isGod === false && !prompt.includes(mod.ASK_FIRST_CLAUSE)) console.warn(`[${id}] warning: worker prompt lacks the ASK FIRST clause`);
  if (!prompt) console.warn(`[${id}] warning: no hive prompt found in the ${arm.provider} launch argv`);
  const trigger = (mod.nudgeText ?? mod.inboxNudgeText)(fx.nudgeIds ?? (fx.inbox ?? []).map((m) => m.id));
  const ctx = { dir, repo, root, agentDir };
  ctx.before = snapshot(ctx);

  const remaining = MAX_USD - spent;
  const bin = runner.bin(o);
  const argv = runner.argv({
    inj: me, trigger, perm: o.perm, model: arm.model, preset, repo, dirs: [agentDir, root],
    budgetUsd: Math.min(Number(o['run-budget']), remaining)
  });
  writeFileSync(join(dir, 'argv.json'), JSON.stringify({ provider: arm.provider, bin, argv, env: me.env }, null, 2));

  let usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: runner.reportsUsd ? 0 : null, turns: 0, error: null, denials: [] };
  if (!o['dry-run']) {
    const env = childEnv(me.env, runner.envKeep);
    const r = await runCli(bin, argv, env, repo, join(dir, 'stream.jsonl'));
    usage = runner.parse(r.out);
    if (r.code !== 0 && !usage.error) usage.error = `exit ${r.code}`;
  }
  ctx.usage = usage;
  spent += usage.costUsd ?? 0;
  const checks = runChecks(ctx, fx.checks);
  const pass = checks.every((c) => c.ok || c.optional);
  if (!o.keep && !o['dry-run']) for (const p of ['repo', 'home']) rmSync(join(dir, p), { recursive: true, force: true });
  return { id, n, arm: armLabel(arm), title: fx.title, pass, checks, usage };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const usd = (v) => (v === null ? 'n/a' : v.toFixed(3));

for (const [ai, arm] of ARMS.entries()) {
  for (const id of ids) {
    for (let n = 1; n <= runs; n++) {
      if (!o['dry-run'] && RUNNERS[arm.provider].reportsUsd && spent >= MAX_USD) { console.log(`--max-usd $${MAX_USD} reached, skipping ${armLabel(arm)} ${id}#${n}`); continue; }
      const r = await runOne(id, n, arm, ai);
      results.push(r);
      const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.type}${c.optional ? '?' : ''}: ${c.detail}`);
      console.log(`${ARMS.length > 1 ? `[${r.arm}] ` : ''}${id}#${n} ${r.pass ? 'PASS' : 'FAIL'}  $${usd(r.usage.costUsd)}  ${r.usage.calls} calls${r.usage.error ? `  [${r.usage.error}]` : ''}${r.usage.denials.length ? `\n    denied ${r.usage.denials.join('; denied ')}` : ''}${failed.length ? `\n    ${failed.join('\n    ')}` : ''}`);
    }
  }
}

const rows = ARMS.flatMap((arm) => ids.map((id) => {
  const rs = results.filter((r) => r.id === id && r.arm === armLabel(arm));
  if (!rs.length) return null;
  const tok = rs.map((r) => r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite);
  const costs = rs.map((r) => r.usage.costUsd);
  const hasUsd = costs.every((c) => c !== null);
  return {
    arm: armLabel(arm), id, title: rs[0].title, pass: `${rs.filter((r) => r.pass).length}/${rs.length}`,
    tokens: median(tok), output: median(rs.map((r) => r.usage.output)), calls: median(rs.map((r) => r.usage.calls)),
    usd: hasUsd ? median(costs) : null, denied: [...new Set(rs.flatMap((r) => r.usage.denials.map((d) => d.split(' ')[0])))].join(', ') || '-',
    totalUsd: hasUsd ? costs.reduce((s, c) => s + c, 0) : null
  };
}).filter(Boolean));

const table = [
  `ref: ${o.ref ?? o.src ?? 'working tree'}  perm: ${o.perm}  runs: ${runs}  engines: ${ARMS.map(armLabel).join(', ')}  total: $${spent.toFixed(2)}`,
  `levers (${o.levers}): ${LC.summary}${mod.trimPrefixArgs ? '  +trimPrefixArgs' : ''}`,
  `orchestrator (${o.orchestrator}): ${orchSummary}`,
  '',
  '| Engine | Fixture | Scenario | Pass | Median tokens | Median output | Median calls | Median $ | Total $ | Denied |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.arm} | ${r.id} | ${r.title} | ${r.pass} | ${r.tokens.toLocaleString('en')} | ${r.output.toLocaleString('en')} | ${r.calls} | ${usd(r.usd)} | ${usd(r.totalUsd)} | ${r.denied} |`)
].join('\n');
console.log('\n' + table + `\n\nruns kept in ${OUT}`);
if (!o['dry-run'] && spent > MAX_USD) console.log(`note: spent $${spent.toFixed(2)}, over --max-usd by the last run's overshoot`);
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ ref: o.ref ?? null, runs, arms: ARMS, spent, rows, results }, null, 2));
// Fresh $ medians for eval/estimates.json: Claude-arm rows only (the only $ figures).
const est = rows.filter((r) => r.usd !== null && r.arm.startsWith('claude'));
if (!o['dry-run'] && est.length) writeFileSync(join(OUT, 'estimates.json'), JSON.stringify({ default: 0.5, ...Object.fromEntries(est.map((r) => [r.id, Number(r.usd.toFixed(3))])) }, null, 2) + '\n');
writeFileSync(join(OUT, 'table.md'), table + '\n');
