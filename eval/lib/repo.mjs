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
  if (spec.branch) git(dir, 'checkout', '-q', '-b', spec.branch);
  for (const [p, body] of Object.entries(spec.wip ?? {})) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return { head: git(dir, 'rev-parse', 'HEAD'), stable: git(dir, 'rev-parse', 'stable') };
}

export { git };
