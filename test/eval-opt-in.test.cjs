// The hive eval (eval/) spends real money, so it must only run when asked for:
// `npm run eval` or `npm run build:eval`. Nothing in the normal build, test or
// release path may reach it, and its own self-test must stay out of test globs.
const test = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join, relative } = require('node:path');

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const OPT_IN = new Set(['eval', 'build:eval']);
const mentionsEval = (s) => /\beval\//.test(s) || /\brun (build:)?eval\b/.test(s);

/** Scripts npm runs for `name`, following `npm run x` and pre/post hooks. */
function reachable(name, seen = new Set()) {
  for (const n of [`pre${name}`, name, `post${name}`]) {
    if (seen.has(n) || !pkg.scripts[n]) continue;
    seen.add(n);
    for (const m of pkg.scripts[n].matchAll(/npm run (?:-s )?([\w:.-]+)/g)) reachable(m[1], seen);
  }
  return seen;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}

test('eval is reachable only from its opt-in scripts', () => {
  assert.ok(pkg.scripts.eval, 'npm run eval exists');
  for (const entry of Object.keys(pkg.scripts).filter((s) => !OPT_IN.has(s))) {
    for (const s of reachable(entry)) {
      assert.ok(OPT_IN.has(s) || !mentionsEval(pkg.scripts[s]), `npm run ${entry} reaches the eval via "${s}"`);
    }
  }
  for (const s of ['build', 'test', 'test:focused', 'dist', 'dist:mac', 'dist:win', 'dist:linux', 'postinstall']) {
    for (const r of reachable(s)) assert.ok(!OPT_IN.has(r), `npm run ${s} reaches ${r}`);
  }
});

test('CI and release workflows never run the eval', () => {
  const dir = join(ROOT, '.github', 'workflows');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const yml = readFileSync(join(dir, f), 'utf8');
    assert.ok(!mentionsEval(yml), `${f} mentions the eval`);
  }
});

test('no eval file matches the normal or default node --test globs', () => {
  // test:focused globs test/*.test.cjs; bare `node --test` uses node's default patterns.
  const defaults = [/\.test\.[cm]?js$/, /-test\.[cm]?js$/, /_test\.[cm]?js$/, /(^|\/)test-[^/]*\.[cm]?js$/, /(^|\/)test\.[cm]?js$/, /(^|\/)test\//];
  for (const f of walk(join(ROOT, 'eval')).map((p) => relative(ROOT, p))) {
    assert.ok(!defaults.some((re) => re.test(f)), `${f} would be picked up by node --test`);
  }
});
