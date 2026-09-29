'use strict';

/**
 * Config secrets (Slack token + signing secret, Groq key, webhook secret) live
 * in the encrypted secret store, not config.json. An older plaintext config is
 * migrated once: the value moves to the store and leaves the file, which is
 * written 0600.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// Throwaway userData + a reversible fake safeStorage, so the real app config
// is never touched.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-secrets-'));
const PREFIX = 'enc:';
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(PREFIX + Buffer.from(s).toString('hex')),
      decryptString: (b) => Buffer.from(b.toString().slice(PREFIX.length), 'hex').toString()
    }
  }
};

const configFile = path.join(userData, 'config.json');
const storeFile = path.join(userData, 'integration-secrets.json');
const onDisk = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const mode = (p) => fs.statSync(p).mode & 0o777;

// Seed an OLD-style config: plaintext secrets, world-readable.
fs.writeFileSync(configFile, JSON.stringify({
  triggersMigratedV1: true,
  slackBotToken: 'xoxb-old-token',
  slackSigningSecret: 'old-signing',
  groqApiKey: 'gsk_old',
  webhookSecret: 'old-webhook',
  orchestratorMaySpawn: true
}), { mode: 0o644 });
fs.chmodSync(configFile, 0o644);

const { readConfig, writeConfig, resetConfig, CONFIG_SECRET_KEYS } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('first read migrates plaintext secrets into the store and off config.json', () => {
  const cfg = readConfig();
  assert.equal(cfg.slackBotToken, 'xoxb-old-token');
  assert.equal(cfg.slackSigningSecret, 'old-signing');
  assert.equal(cfg.groqApiKey, 'gsk_old');
  assert.equal(cfg.webhookSecret, 'old-webhook');
  assert.equal(cfg.orchestratorMaySpawn, true, 'other settings survive');

  const file = onDisk();
  for (const key of CONFIG_SECRET_KEYS) assert.ok(!(key in file), `${key} must leave config.json`);
  const raw = fs.readFileSync(configFile, 'utf8');
  for (const v of ['xoxb-old-token', 'old-signing', 'gsk_old', 'old-webhook']) {
    assert.ok(!raw.includes(v), `plaintext ${v} must be gone from config.json`);
  }
  const store = fs.readFileSync(storeFile, 'utf8');
  assert.ok(!store.includes('xoxb-old-token'), 'the store holds ciphertext, not plaintext');
  assert.ok(JSON.parse(store)['config:slackBotToken'], 'the store holds the moved value');
});

test('config.json and the store are 0600', () => {
  assert.equal(mode(configFile), 0o600);
  assert.equal(mode(storeFile), 0o600);
});

test('writing a secret stores it encrypted; clearing it removes it', () => {
  writeConfig({ groqApiKey: 'gsk_new' });
  assert.equal(readConfig().groqApiKey, 'gsk_new');
  assert.ok(!('groqApiKey' in onDisk()));
  assert.ok(!fs.readFileSync(storeFile, 'utf8').includes('gsk_new'));

  writeConfig({ groqApiKey: undefined });
  assert.equal(readConfig().groqApiKey, undefined);
  assert.ok(!('config:groqApiKey' in JSON.parse(fs.readFileSync(storeFile, 'utf8'))));
});

test('an unrelated write keeps the stored secrets', () => {
  writeConfig({ orchestratorMaySpawn: false });
  const cfg = readConfig();
  assert.equal(cfg.slackBotToken, 'xoxb-old-token');
  assert.equal(cfg.webhookSecret, 'old-webhook');
  assert.equal(mode(configFile), 0o600);
});

test('reset clears the stored secrets too', () => {
  resetConfig();
  const cfg = readConfig();
  for (const key of CONFIG_SECRET_KEYS) assert.equal(cfg[key], undefined, key);
});
