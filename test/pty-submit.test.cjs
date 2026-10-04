'use strict';

// T-043: a lost Enter must not glue the next submission onto the same line.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { typeAndSubmit, clearInputSequence, submitPayload } = loadTs('src/shared/custom/ptySubmit.ts');

/** A fake line-editor TUI: keeps an input line, honours Ctrl+U, submits on
 *  "\r" unless told to drop the next Enter. Records what it echoes. */
function fakeTui({ dropEnters = 0, echoes = true } = {}) {
  const log = [];
  const submitted = [];
  let line = '';
  let listener = null;
  const io = {
    async write(data) {
      log.push(data);
      if (data === '\x15') line = '';
      else if (data === '\r') {
        if (dropEnters > 0) dropEnters -= 1;
        else { submitted.push(line); line = ''; }
      } else {
        line += data;
        if (echoes && listener) setImmediate(() => listener && listener());
      }
      return { ok: true };
    },
    waitForOutput(timeoutMs) {
      return new Promise((resolve) => {
        const t = setTimeout(() => { listener = null; resolve(false); }, timeoutMs);
        listener = () => { clearTimeout(t); listener = null; resolve(true); };
      });
    },
    sleep: async () => {}
  };
  return { io, log, submitted };
}

test('a lost Enter no longer glues /remote-control onto the next prompt', async () => {
  const tui = fakeTui({ dropEnters: 1 });
  await typeAndSubmit(tui.io, '/remote-control Michael', 'claude', 0);
  await typeAndSubmit(tui.io, "You're online as Michael", 'claude', 0);
  assert.deepEqual(tui.submitted, ["You're online as Michael"]);
});

test('without a lost Enter both lines submit separately, in order', async () => {
  const tui = fakeTui();
  await typeAndSubmit(tui.io, '/remote-control Michael', 'codex', 0);
  await typeAndSubmit(tui.io, 'next', 'codex', 0);
  assert.deepEqual(tui.submitted, ['/remote-control Michael', 'next']);
  assert.deepEqual(tui.log, ['\x15', '/remote-control Michael', '\r', '\x15', 'next', '\r']);
});

test('Enter waits for the echo, and still goes when the TUI never echoes', async () => {
  const order = [];
  let release;
  const io = {
    async write(d) { order.push(d); return { ok: true }; },
    waitForOutput() { return new Promise((r) => { release = () => { order.push('echo'); r(true); }; }); },
    sleep: async () => {}
  };
  const p = typeAndSubmit(io, 'hi', 'claude', 0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['\x15', 'hi'], 'no Enter before the echo');
  release();
  await p;
  assert.deepEqual(order, ['\x15', 'hi', 'echo', '\r']);

  const silent = fakeTui({ echoes: false });
  silent.io.waitForOutput = async () => false; // the timeout path
  await typeAndSubmit(silent.io, 'hi', 'claude', 0);
  assert.deepEqual(silent.submitted, ['hi']);
});

test('a failed write rejects and sends no Enter', async () => {
  const writes = [];
  const io = {
    async write(d) { writes.push(d); return d === 'x' ? { ok: false, error: 'no pty: god' } : { ok: true }; },
    waitForOutput: async () => true,
    sleep: async () => {}
  };
  await assert.rejects(typeAndSubmit(io, 'x', 'claude', 0), /no pty: god/);
  assert.equal(writes.includes('\r'), false);
});

test('Enter is sent exactly once (a second could answer a permission prompt)', async () => {
  const tui = fakeTui({ dropEnters: 1 });
  await typeAndSubmit(tui.io, 'hello', 'claude', 0);
  assert.equal(tui.log.filter((d) => d === '\r').length, 1);
});

test('clear sequence: Ctrl+U for line editors, none for agy or a custom command', () => {
  for (const p of ['claude', 'codex', 'copilot', 'qwen', 'grok', 'gemini', 'kimi', 'opencode', 'crush', 'pi', 'cursor']) {
    assert.equal(clearInputSequence(p), '\x15', p);
  }
  assert.equal(clearInputSequence('antigravity'), null);
  assert.equal(clearInputSequence('custom'), null);
  const agy = fakeTui();
  return typeAndSubmit(agy.io, 'hi', 'antigravity', 0).then(() => {
    assert.deepEqual(agy.log, ['hi', '\r']);
  });
});

test('bracketed paste only wraps multi-line text', () => {
  assert.equal(submitPayload('/remote-control Michael'), '/remote-control Michael');
  assert.equal(submitPayload('a\nb'), '\x1b[200~a\nb\x1b[201~');
});
