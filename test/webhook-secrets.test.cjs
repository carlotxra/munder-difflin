'use strict';

/**
 * webhookTriggers[].secret lives in the encrypted secret store, one entry per
 * trigger id; config.json keeps `secret: ''`. An older plaintext config is
 * migrated once on read, and a deleted trigger takes its secret with it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-webhook-secrets-'));
const PREFIX = 'enc:';
let encryption = true;
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryption,
      encryptString: (s) => Buffer.from(PREFIX + Buffer.from(s).toString('hex')),
      decryptString: (b) => Buffer.from(b.toString().slice(PREFIX.length), 'hex').toString()
    }
  }
};

const configFile = path.join(userData, 'config.json');
const storeFile = path.join(userData, 'integration-secrets.json');
const onDisk = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const store = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
const hook = (id, secret) => ({ id, name: id, secret, enabled: true, mode: 'route', schema: '{}', createdAt: 1 });

fs.writeFileSync(configFile, JSON.stringify({
  triggersMigratedV1: true,
  webhookTriggers: [hook('a', 'plain-a'), hook('b', 'plain-b')]
}), { mode: 0o644 });

const { readConfig, writeConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('first read moves every webhook secret into the store and off config.json', () => {
  const cfg = readConfig();
  assert.deepEqual(cfg.webhookTriggers.map((t) => t.secret), ['plain-a', 'plain-b']);
  const raw = fs.readFileSync(configFile, 'utf8');
  assert.ok(!raw.includes('plain-a') && !raw.includes('plain-b'), 'plaintext gone from config.json');
  assert.deepEqual(onDisk().webhookTriggers.map((t) => t.secret), ['', '']);
  assert.ok(store()['config:webhookTrigger:a'], 'the store holds trigger a');
  assert.ok(!fs.readFileSync(storeFile, 'utf8').includes('plain-a'), 'the store holds ciphertext');
});

test('editing a secret re-encrypts it; deleting a trigger drops its secret', () => {
  writeConfig({ webhookTriggers: [hook('a', 'new-a')] });
  assert.equal(readConfig().webhookTriggers[0].secret, 'new-a');
  assert.ok(!fs.readFileSync(configFile, 'utf8').includes('new-a'));
  assert.ok(!('config:webhookTrigger:b' in store()), 'deleted trigger b took its secret');
});

test('an unrelated write keeps the stored webhook secrets', () => {
  writeConfig({ orchestratorMaySpawn: false });
  assert.equal(readConfig().webhookTriggers[0].secret, 'new-a');
});

test('without OS encryption the secret stays inline rather than being lost', () => {
  encryption = false;
  try {
    writeConfig({ webhookTriggers: [hook('c', 'plain-c')] });
    assert.equal(onDisk().webhookTriggers[0].secret, 'plain-c');
    assert.equal(readConfig().webhookTriggers[0].secret, 'plain-c');
  } finally {
    encryption = true;
  }
  // The next read with encryption back migrates it.
  assert.equal(readConfig().webhookTriggers[0].secret, 'plain-c');
  assert.equal(onDisk().webhookTriggers[0].secret, '');
});
