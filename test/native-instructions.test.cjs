'use strict';

/**
 * T-051: the hive prompt goes into each engine's own instructions file in the
 * agent's per-agent home (src/main/custom/instructionChannel.ts), and the first
 * message becomes a short kick. Off, or on any failure: upstream (the whole
 * prompt as the first message).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const orch = loadTs('src/main/custom/orchestrator.ts');
const { nativeInstructions, instructionKick } = loadTs('src/main/custom/instructionChannel.ts');
const { resolveOrchestratorLevers, ORCHESTRATOR_LEVERS_OFF } = loadTs('src/shared/custom/orchestratorLevers.ts');

const ROOT = path.join(__dirname, '..');
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** Spawn one agent under a config (null = no source) and return its injection. */
async function spawn(t, meta, config, opts = {}) {
  orch.setOrchestratorLeversSource(config === null ? null : () => config);
  t.after(() => orch.setOrchestratorLeversSource(null));
  const home = tmp(t, 'md-native-');
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ ...meta, cwd: home }, opts);
  return { inj, home, hive };
}
const after = (args, flag) => args[args.lastIndexOf(flag) + 1];
const W = (provider) => ({ id: 'w1', name: 'Kevin', provider });

test('lever: default engines are the ones checked here; junk ignored; off before install', () => {
  assert.deepEqual(resolveOrchestratorLevers({}).nativeInstructions, ['copilot', 'opencode']);
  assert.deepEqual(resolveOrchestratorLevers({ orchestrator: { nativeInstructions: ['codex', 'Bad Id', 7, 'opencode'] } }).nativeInstructions, ['codex', 'opencode']);
  assert.deepEqual(ORCHESTRATOR_LEVERS_OFF.nativeInstructions, []);
});

test('no source installed: copilot and opencode get the whole prompt as the first message (upstream)', async (t) => {
  const cp = await spawn(t, W('copilot'), null);
  assert.ok(after(cp.inj.args, '-i').includes('HIVE PROTOCOL'));
  const oc = await spawn(t, W('opencode'), null);
  assert.ok(after(oc.inj.args, '--prompt').includes('HIVE PROTOCOL'));
  assert.ok(!fs.existsSync(path.join(oc.inj.env.OPENCODE_CONFIG_DIR, 'hive-instructions.md')));
});

test('copilot: kick as the first message; the prompt stays in copilot-instructions.md', async (t) => {
  const { inj } = await spawn(t, W('copilot'), {});
  const kick = after(inj.args, '-i');
  const file = path.join(inj.env.COPILOT_HOME, 'copilot-instructions.md');
  assert.equal(kick, instructionKick(W('copilot'), file));
  assert.ok(!kick.includes('HIVE PROTOCOL'), 'the prompt is no longer sent twice');
  assert.ok(fs.readFileSync(file, 'utf8').includes('HIVE PROTOCOL'));
});

test('opencode: prompt in hive-instructions.md, listed in opencode.json next to the theme; respawn does not duplicate', async (t) => {
  const { inj, hive } = await spawn(t, W('opencode'), {}, { theme: 'dark' });
  const dir = inj.env.OPENCODE_CONFIG_DIR;
  const file = path.join(dir, 'hive-instructions.md');
  assert.equal(after(inj.args, '--prompt'), instructionKick(W('opencode'), file));
  assert.ok(fs.readFileSync(file, 'utf8').includes('HIVE PROTOCOL'));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
  assert.equal(cfg.theme, 'system', 'upstream theme kept');
  assert.deepEqual(cfg.instructions, [file]);
  await hive.ensureAgent({ ...W('opencode'), cwd: path.dirname(dir) }, { theme: 'dark' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).instructions, [file]);
});

test('god gets an orchestrator kick', async (t) => {
  const { inj } = await spawn(t, { id: 'god', name: 'Michael', provider: 'copilot', isGod: true }, {});
  assert.match(after(inj.args, '-i'), /^You are "Michael" \(god\), the orchestrator of a hive/);
});

test('codex: off by default (not checked here); when listed, AGENTS.md in CODEX_HOME keeps the user\'s own text first', async (t) => {
  const userCodex = tmp(t, 'md-usercodex-');
  fs.writeFileSync(path.join(userCodex, 'AGENTS.md'), 'USER GLOBAL GUIDANCE\n');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = userCodex;
  t.after(() => { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; });
  const off = await spawn(t, W('codex'), {});
  assert.ok(off.inj.args[off.inj.args.length - 1].includes('HIVE PROTOCOL'));
  const on = await spawn(t, W('codex'), { orchestrator: { nativeInstructions: ['codex'] } });
  const file = path.join(on.inj.env.CODEX_HOME, 'AGENTS.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('USER GLOBAL GUIDANCE') && text.includes('HIVE PROTOCOL'));
  assert.equal(on.inj.args[on.inj.args.length - 1], instructionKick(W('codex'), file));
  assert.equal(fs.readFileSync(path.join(userCodex, 'AGENTS.md'), 'utf8'), 'USER GLOBAL GUIDANCE\n', 'user file untouched');
});

test('never writes through a symlink: falls back to the whole prompt, target untouched', (t) => {
  orch.setOrchestratorLeversSource(() => ({}));
  t.after(() => orch.setOrchestratorLeversSource(null));
  const d = tmp(t, 'md-symlink-');
  const target = path.join(d, 'users-own.md');
  fs.writeFileSync(target, 'MINE\n');
  fs.mkdirSync(path.join(d, 'cfg'));
  fs.symlinkSync(target, path.join(d, 'cfg', 'hive-instructions.md'));
  const out = nativeInstructions(W('opencode'), { OPENCODE_CONFIG_DIR: path.join(d, 'cfg') }, 'THE PROMPT');
  assert.equal(out, 'THE PROMPT');
  assert.equal(fs.readFileSync(target, 'utf8'), 'MINE\n');
});

test('engine home missing or engine unknown: whole prompt', (t) => {
  orch.setOrchestratorLeversSource(() => ({ orchestrator: { nativeInstructions: ['copilot', 'opencode', 'crush'] } }));
  t.after(() => orch.setOrchestratorLeversSource(null));
  assert.equal(nativeInstructions(W('copilot'), {}, 'P'), 'P');
  assert.equal(nativeInstructions(W('opencode'), {}, 'P'), 'P');
  assert.equal(nativeInstructions(W('crush'), {}, 'P'), 'P');
});

test('claude agents are unaffected', async (t) => {
  const a = await spawn(t, W('claude'), {});
  const b = await spawn(t, W('claude'), null);
  const sys = (inj, home) => after(inj.args, '--append-system-prompt').split(home).join('<HOME>');
  assert.equal(sys(a.inj, a.home), sys(b.inj, b.home));
});

test('seam: two marked lines in the non-Claude launch path, after the bridges, before the prompt is used', () => {
  const hive = fs.readFileSync(path.join(ROOT, 'src/main/hive.ts'), 'utf8');
  const lines = hive.split('\n').filter((l) => l.includes('// fork: T-051'));
  assert.equal(lines.length, 3, 'import, let, reassignment');
  const at = (s) => { const i = hive.indexOf(s); assert.ok(i >= 0, `anchor gone: ${s}`); return i; };
  const seam = at('prompt = nativeInstructions(meta, env, prompt); // fork: T-051');
  assert.ok(at('this.installCopilotHooks(dir, meta.id, prompt)') < seam, 'Copilot install still gets the whole prompt');
  assert.ok(seam < at("if (preset.seedDelivery === 'type-into-tui') return"), 'before the prompt is put on argv');
  assert.ok(seam < at('if (flag) return { args: [...preArgs, flag, prompt]'));
});
