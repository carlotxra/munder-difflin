// Offline test of the checks: simulate a well-behaved agent on a fixture repo and
// assert the checks pass, then a misbehaving one and assert they fail. No model calls.
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeRepo, git } from './lib/repo.mjs';
import { runChecks, snapshot } from './lib/checks.mjs';

const FIX = (id) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.json`, import.meta.url), 'utf8'));

function setup(fx) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'evtest-'));
  const repo = join(dir, 'repo');
  const root = join(dir, 'hive');
  const agentDir = join(root, 'agents', fx.agent.id);
  makeRepo(repo, fx.repo);
  mkdirSync(join(agentDir, 'inbox', '.done'), { recursive: true });
  mkdirSync(join(agentDir, 'outbox'), { recursive: true });
  writeFileSync(join(agentDir, 'memory.md'), fx.memory ?? '');
  for (const m of fx.inbox ?? []) writeFileSync(join(agentDir, 'inbox', `${m.id}.json`), JSON.stringify(m));
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

test('S7 doing nothing passes; replying or too many calls fails', () => {
  const fx = FIX('S7');
  const ctx = setup(fx);
  assert.deepStrictEqual(failing(ctx, fx), []);
  ctx.usage.calls = 5;
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
