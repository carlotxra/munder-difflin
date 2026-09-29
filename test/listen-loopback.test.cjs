/**
 * The Slack and webhook listeners bind 127.0.0.1, never all interfaces. The
 * tunnel client dials the port locally, so the tunnel path is unaffected, but
 * nothing else on the LAN can reach the handler directly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

async function boundAddress(server) {
  // listen() is the private bind step start() runs before opening the tunnel.
  await server.listen();
  try {
    return server.server.address();
  } finally {
    server.stop();
  }
}

test('webhook server listens on 127.0.0.1 only', async () => {
  const { WebhookServer, LISTEN_HOST } = loadTs('src/main/webhook.ts');
  assert.equal(LISTEN_HOST, '127.0.0.1');
  const srv = new WebhookServer({ port: 0, endpoints: [], onMessage: () => null, lookupStatus: () => null });
  const addr = await boundAddress(srv);
  assert.equal(addr.address, '127.0.0.1');
});

test('slack server listens on 127.0.0.1 only', async () => {
  const { SlackWebhookServer, LISTEN_HOST } = loadTs('src/main/slack.ts');
  assert.equal(LISTEN_HOST, '127.0.0.1');
  const srv = new SlackWebhookServer({ port: 0, signingSecret: 'x', onMessage: () => {} });
  const addr = await boundAddress(srv);
  assert.equal(addr.address, '127.0.0.1');
});
