'use strict';
/**
 * The copilot bridge: ensureAgent points COPILOT_HOME at a per-agent dir holding
 * our hooks/munder-hive.json + copilot-instructions.md, regenerates it
 * identically on respawn, and never writes to the user's ~/.copilot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, COPILOT_HOOK_EVENTS } = loadTs('src/main/hive.ts');

function snapshot(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    if (e.isFile()) out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

async function spawnCopilot(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-copilot-config-'));
  const prevHome = process.env.HOME;
  const userCopilot = path.join(home, '.copilot');
  fs.mkdirSync(path.join(userCopilot, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(userCopilot, 'config.json'), '// jsonc\n{ "lastLoggedInUser": {"login":"me"} }\n');
  fs.writeFileSync(path.join(userCopilot, 'mcp-config.json'), '{"mcpServers":{}}');
  fs.writeFileSync(path.join(userCopilot, 'copilot-instructions.md'), 'USER-OWN-INSTRUCTIONS');
  fs.writeFileSync(path.join(userCopilot, 'hooks', 'mine.json'), '{"version":1,"hooks":{}}');
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prevHome; fs.rmSync(home, { recursive: true, force: true }); });
  const before = snapshot(userCopilot);
  const hive = new HiveManager(() => home);
  const meta = { id: 'cop-1', name: 'Copilot Worker', provider: 'copilot', cwd: home };
  const injection = await hive.ensureAgent(meta);
  return { home, hive, meta, injection, userCopilot, before };
}

test('copilot worker gets an isolated COPILOT_HOME with a complete hook file', async (t) => {
  const { home, injection } = await spawnCopilot(t);
  const agentHome = path.join(home, 'hive', 'agents', 'cop-1', '.copilot');
  assert.equal(injection.env.COPILOT_HOME, agentHome);
  const cfg = JSON.parse(fs.readFileSync(path.join(agentHome, 'hooks', 'munder-hive.json'), 'utf8'));
  assert.equal(cfg.version, 1);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), [...COPILOT_HOOK_EVENTS].sort());
  for (const ev of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const [h] = cfg.hooks[ev];
    assert.equal(h.type, 'command');
    assert.equal(h.timeoutSec, 30);
    const cmd = h.bash ?? h.powershell;
    assert.match(cmd, /cth-hook\.cjs/);
    assert.match(cmd, /--flat$/);
  }
  const instr = fs.readFileSync(path.join(agentHome, 'copilot-instructions.md'), 'utf8');
  assert.match(instr, /^USER-OWN-INSTRUCTIONS/);
  assert.match(instr, /munder-hive/);
  assert.match(instr, /cop-1/);
  assert.equal(injection.args.includes('-i'), true, 'protocol seed rides in via -i');
});

test('no OTel env is injected while the collector is off', async (t) => {
  const { injection } = await spawnCopilot(t);
  for (const k of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'COPILOT_OTEL_ENABLED', 'OTEL_RESOURCE_ATTRIBUTES']) {
    assert.equal(injection.env[k], undefined, k);
  }
});

test('with the collector up, Copilot exports OTLP/HTTP JSON to it, tagged with the agent', async (t) => {
  const { hive, meta } = await spawnCopilot(t);
  hive.setOtelEndpoint('http://127.0.0.1:43210');
  const { env } = await hive.ensureAgent({ ...meta, name: 'Pam, Copilot' });
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:43210');
  assert.equal(env.COPILOT_OTEL_ENABLED, 'true');
  assert.equal(env.COPILOT_OTEL_EXPORTER_TYPE, 'otlp-http');
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  // Percent-encoded so the comma in the name cannot split the attribute list.
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, 'agent.id=cop-1,agent.name=Pam%2C%20Copilot');
  assert.ok(env.COPILOT_HOME, 'hook bridge still installed alongside telemetry');
});

test('respawn is idempotent and the user ~/.copilot is untouched', async (t) => {
  const { home, hive, meta, userCopilot, before } = await spawnCopilot(t);
  const agentHome = path.join(home, 'hive', 'agents', 'cop-1', '.copilot');
  const first = snapshot(agentHome);
  await hive.ensureAgent(meta);
  assert.deepEqual(snapshot(agentHome), first);
  assert.deepEqual(snapshot(userCopilot), before);
  assert.equal(fs.lstatSync(path.join(agentHome, 'config.json')).isSymbolicLink(), false,
    'config.json is copied (Copilot writes it back), never linked');
});

test('cth-hook --flat lifts Claude-nested decisions to Copilot top-level keys', async (t) => {
  const { home } = await spawnCopilot(t);
  const shim = path.join(home, 'hive', 'bin', 'cth-hook.cjs');
  // Stand in for HookServer: a one-shot socket that answers with a nested deny.
  const net = require('node:net');
  const sock = process.platform === 'win32'
    ? `\\\\.\\pipe\\md-cop-${process.pid}` : path.join(home, 'h.sock');
  const reply = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'paused' } };
  const srv = net.createServer((c) => c.on('data', () => c.end(JSON.stringify(reply))));
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  const { spawn } = require('node:child_process');
  const out = await new Promise((resolve) => {
    const cp = spawn(process.execPath, [shim, '--flat'], { env: { ...process.env, HIVE_SOCK: sock, AGENT_ID: 'cop-1' } });
    let buf = ''; cp.stdout.on('data', (d) => { buf += d; });
    cp.on('close', () => resolve(buf));
    cp.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's' }));
  });
  const o = JSON.parse(out);
  assert.equal(o.permissionDecision, 'deny');
  assert.equal(o.permissionDecisionReason, 'paused');
});
