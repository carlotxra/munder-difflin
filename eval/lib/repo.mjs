// A tiny fixed git repo the fixture agent works in. Small on purpose: the eval
// measures protocol behaviour and prompt cost, not how long an agent spends
// reading a large codebase.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const FILES = {
  'README.md': '# shoplist\n\nA tiny shopping-list page used by the hive eval.\n',
  'package.json': JSON.stringify({ name: 'shoplist', version: '1.0.0', scripts: { test: 'node --test test/' } }, null, 2) + '\n',
  'index.html': '<!doctype html>\n<html><body>\n  <ul id="list"></ul>\n  <input id="item"><button id="add">Add</button>\n  <script src="app.js"></script>\n</body></html>\n',
  'app.js': "const list = [];\nfunction addItem(name) { list.push(name); render(); }\nfunction clearList() { list.length = 0; render(); }\nfunction render() {\n  const ul = document.getElementById('list');\n  ul.innerHTML = list.map((x) => `<li>${x}</li>`).join('');\n}\ndocument.getElementById('add').onclick = () => addItem(document.getElementById('item').value);\n",
  'lib/price.js': "function total(items) { return items.reduce((s, i) => s + i.price * i.qty, 0); }\nmodule.exports = { total };\n",
  'test/price.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../lib/price.js');\ntest('total', () => assert.strictEqual(total([{ price: 2, qty: 3 }]), 6));\n",
  'config.json': JSON.stringify({ timeout: 30, currency: 'EUR' }, null, 2) + '\n',
  'scripts/read-config.js': "// Read by customers' own automation; the key names are part of the public contract.\nconst cfg = require('../config.json');\nconsole.log(cfg.timeout, cfg.currency);\n"
};

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function makeRepo(dir, spec = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [p, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git(dir, 'init', '-q', '-b', 'stable');
  git(dir, 'config', 'user.email', 'eval@example.invalid');
  git(dir, 'config', 'user.name', 'eval');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  // T-050: commits on named branches (in order), so god fixtures can start from a
  // worker branch that is ready, conflicting or moved since its done report.
  // `{ branch, from?, files, message }`: `from` defaults to `stable`; a branch that
  // already exists gets the commit on top. Ends back on `stable`.
  for (const c of spec.commits ?? []) {
    const exists = (() => { try { git(dir, 'rev-parse', '--verify', '-q', c.branch); return true; } catch { return false; } })();
    git(dir, 'checkout', '-q', ...(exists ? [c.branch] : ['-b', c.branch, c.from ?? 'stable']));
    for (const [p, body] of Object.entries(c.files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', c.message ?? `${c.branch}: change`);
  }
  if (spec.commits?.length) git(dir, 'checkout', '-q', 'stable');
  if (spec.branch) git(dir, 'checkout', '-q', '-b', spec.branch);
  for (const [p, body] of Object.entries(spec.wip ?? {})) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return { head: git(dir, 'rev-parse', 'HEAD'), stable: git(dir, 'rev-parse', 'stable') };
}

/** T-050: replace `{{SHA:<rev>}}` in every string of `x` with that rev's short SHA in
 *  `dir` (e.g. `{{SHA:feature}}`, `{{SHA:feature~1}}`), for done reports that cite a
 *  commit made by makeRepo. */
export function fillShas(x, dir) {
  if (typeof x === 'string') return x.replace(/\{\{SHA:([^}]+)\}\}/g, (_, rev) => git(dir, 'rev-parse', '--short', rev));
  if (Array.isArray(x)) return x.map((v) => fillShas(v, dir));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillShas(v, dir)]));
  return x;
}

export { git };
