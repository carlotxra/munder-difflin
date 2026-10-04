'use strict';
/**
 * T-028: the hook socket path must fit in a Unix socket address.
 *
 * A hive under a deep root (105 bytes on a Dropbox CloudStorage path) made
 * libuv truncate `hooks.sock` to `hooks.soc`. The stale-file check looked at the
 * full name, listen() bound the truncated one, and a leftover `hooks.soc` made
 * every bind fail with EADDRINUSE, so no hook event ever reached the app and
 * every status chip stayed idle.
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

const { SOCK_PATH_MAX, shortSockPath } = loadTs('src/main/sockPath.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const posixOnly = { skip: process.platform === 'win32' ? 'named pipes have no socket file' : false };
const bytes = (s) => Buffer.byteLength(s);

/** A hive root deep enough that `<root>/hooks.sock` cannot be a socket address. */
function deepRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-'));
  let root = base;
  while (bytes(path.join(root, 'hooks.sock')) <= SOCK_PATH_MAX + 4) root = path.join(root, 'CloudStorage-Dropbox');
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return root;
}

test('a short path is kept as is', () => {
  assert.equal(shortSockPath('/tmp/hive/hooks.sock', 'abc123def456'), '/tmp/hive/hooks.sock');
});

test('a long path falls back to a private per-user directory', posixOnly, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdb-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const long = '/' + 'x'.repeat(120) + '/hooks.sock';
  const p = shortSockPath(long, 'abc123def456', [base]);
  const dir = path.join(base, `munder-difflin-${process.getuid()}`);
  assert.equal(p, path.join(dir, 'hooks-abc123def456.sock'));
  assert.ok(bytes(p) <= SOCK_PATH_MAX);
  const st = fs.lstatSync(dir);
  assert.ok(st.isDirectory());
  assert.equal(st.mode & 0o777, 0o700, 'only this user can reach the socket');
  // A base too deep to fit is skipped; with nothing usable the path is
  // returned unchanged so bind() refuses it instead of truncating.
  assert.equal(shortSockPath(long, 'abc123def456', ['/' + 'y'.repeat(120)]), long);
});

test('a symlinked or loosened socket directory is not trusted', posixOnly, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdb-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const long = '/' + 'x'.repeat(120) + '/hooks.sock';
  const dir = path.join(base, `munder-difflin-${process.getuid()}`);
  // A symlink planted at the directory name (the squatting shape) is refused.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mdt-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.symlinkSync(target, dir);
  assert.equal(shortSockPath(long, 'abc123def456', [base]), long);
  // Our own directory with loose permissions is tightened back to 0700.
  fs.unlinkSync(dir);
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  shortSockPath(long, 'abc123def456', [base]);
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
});

test('sockPath() stays within the limit for a long root, stable and per root', posixOnly, (t) => {
  const root = deepRoot(t);
  const hive = new HiveManager(() => root);
  const sock = hive.sockPath();
  assert.ok(bytes(path.join(hive.root(), 'hooks.sock')) > SOCK_PATH_MAX, 'the fixture really is too deep');
  assert.ok(bytes(sock) <= SOCK_PATH_MAX, `${bytes(sock)} bytes: ${sock}`);
  assert.equal(hive.sockPath(), sock, 'server and shims read the same value');
  const other = new HiveManager(() => path.join(root, 'second-hive-with-another-root'));
  assert.notEqual(other.sockPath(), sock, 'two hives never share a socket');
  // A shallow root keeps the socket next to the hive, as before.
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-'));
  t.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
  const near = new HiveManager(() => shallow);
  assert.equal(near.sockPath(), path.join(near.root(), 'hooks.sock'));
});

test('bind() refuses a path libuv would truncate instead of binding another file', posixOnly, async (t) => {
  const root = deepRoot(t);
  const logs = [];
  const hive = { sockPath: () => path.join(root, 'hooks.sock'), appendLog: (e) => logs.push(e) };
  const a = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, undefined);
  t.after(() => a.stop());
  const h = await a.ensureListening();
  assert.equal(h.listening, false);
  assert.equal(h.lastError, 'ENAMETOOLONG', JSON.stringify(h));
  assert.equal(logs[0].code, 'ENAMETOOLONG');
  assert.equal(fs.readdirSync(root).length, 0, 'no truncated socket file is created');
});

test('a stale socket file at the bound path is cleared and the bind succeeds', posixOnly, async (t) => {
  const root = deepRoot(t);
  const hive = new HiveManager(() => root);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: root });
  const sock = hive.sockPath();
  t.after(() => fs.rmSync(sock, { force: true }));
  // Leave a dead socket file behind, as a crashed run does (exit without close()).
  const r = spawnSync(process.execPath, ['-e',
    `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok(fs.existsSync(sock), 'the stale socket file is there');
  const a = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, undefined);
  t.after(() => a.stop());
  const h = await a.ensureListening();
  assert.equal(h.listening, true, JSON.stringify(h));
  assert.equal(h.path, sock);
});
