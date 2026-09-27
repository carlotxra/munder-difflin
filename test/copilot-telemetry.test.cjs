'use strict';
/**
 * Copilot telemetry (FR8): the collector turns Copilot CLI trace spans into a
 * usage sample carrying Copilot's own billing counters (no invented dollars),
 * and the breaker keeps Copilot out of the $-cap while capping its requests.
 * The span shapes below are trimmed from a real Copilot CLI 1.0.88 export.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { CircuitBreaker } = loadTs('src/main/breaker.ts');

const SID = '86c555bd-6305-4c0e-831c-8fe982ae3534';
const kv = (key, v) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });

function chatSpan(extra = []) {
  return {
    name: 'chat auto',
    startTimeUnixNano: '1000000000',
    endTimeUnixNano: '14000000000',
    status: { code: 0 },
    attributes: [
      kv('gen_ai.operation.name', 'chat'), kv('gen_ai.provider.name', 'github'),
      kv('gen_ai.request.model', 'auto'), kv('gen_ai.response.model', 'gpt-6-luna'),
      kv('gen_ai.conversation.id', SID),
      kv('gen_ai.usage.input_tokens', 11905), kv('gen_ai.usage.output_tokens', 5),
      kv('gen_ai.usage.cache_write.input_tokens', 11902),
      { key: 'github.copilot.cost', value: { doubleValue: 1 } },
      kv('github.copilot.nano_aiu', 149055000),
      kv('enduser.pseudo.id', '17ee1bac4aa6e33b8bec46cc3dc3c1c8'),
      ...extra
    ]
  };
}

function traceBatch(agentId, spans) {
  return {
    resourceSpans: [{
      resource: { attributes: [kv('agent.id', agentId), kv('service.name', 'github-copilot')] },
      scopeSpans: [{ scope: { name: 'github.copilot' }, spans }]
    }]
  };
}

const invokeAgentSpan = {
  name: 'invoke_agent',
  attributes: [
    kv('gen_ai.operation.name', 'invoke_agent'), kv('gen_ai.provider.name', 'github'),
    kv('gen_ai.conversation.id', SID), kv('gen_ai.usage.input_tokens', 11905),
    kv('gen_ai.usage.output_tokens', 5), { key: 'github.copilot.cost', value: { doubleValue: 1 } },
    kv('github.copilot.nano_aiu', 149055000)
  ]
};

const toolSpan = {
  name: 'execute_tool bash',
  startTimeUnixNano: '2000000000',
  endTimeUnixNano: '2250000000',
  status: { code: 0 },
  attributes: [
    kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.provider.name', 'github'),
    kv('gen_ai.conversation.id', SID), kv('gen_ai.tool.name', 'bash')
  ]
};

async function collector(t) {
  const c = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
  await c.start();
  t.after(() => c.stop());
  return c;
}

async function post(c, route, body) {
  const res = await fetch(`${c.endpoint()}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal(res.status, 200);
  await res.text();
}

test('Copilot chat spans become usage with Copilot billing, not dollars', async (t) => {
  const c = await collector(t);
  await post(c, '/v1/traces', traceBatch('cop-1', [chatSpan(), invokeAgentSpan, toolSpan]));
  const s = c.getAgentUsage('cop-1');
  assert.equal(s.sessionId, SID, 'keyed by gen_ai.conversation.id (the --resume id)');
  assert.equal(s.model, 'gpt-6-luna');
  assert.equal(s.output, 5);
  assert.equal(s.cacheCreation, 11902);
  assert.equal(s.input, 3, 'fresh input = input_tokens minus the cached parts');
  assert.equal(s.usd, 0);
  assert.equal(s.copilot.requests, 1, 'invoke_agent repeats the totals and is not counted again');
  assert.ok(Math.abs(s.copilot.aiCredits - 0.149055) < 1e-9);
  assert.equal(JSON.stringify(s).includes('17ee1bac'), false, 'user hash never leaves the collector');
});

test('Copilot requests accumulate across chat spans and sessions', async (t) => {
  const c = await collector(t);
  await post(c, '/v1/traces', traceBatch('cop-1', [chatSpan()]));
  await post(c, '/v1/traces', traceBatch('cop-1', [chatSpan()]));
  const other = chatSpan();
  other.attributes = other.attributes.map((a) => a.key === 'gen_ai.conversation.id' ? kv(a.key, 'second') : a);
  await post(c, '/v1/traces', traceBatch('cop-1', [other]));
  const s = c.getAgentUsage('cop-1');
  assert.equal(s.copilot.requests, 3);
  assert.equal(s.output, 15);
  c.forgetAgent('cop-1');
  assert.equal(c.getAgentUsage('cop-1'), null);
});

test('execute_tool spans feed the tool waterfall; failures are marked', async (t) => {
  const c = await collector(t);
  const failed = { ...toolSpan, status: { code: 2 }, attributes: [...toolSpan.attributes.slice(0, 3), kv('gen_ai.tool.name', 'edit'), kv('error.type', 'ToolError')] };
  await post(c, '/v1/traces', traceBatch('cop-1', [toolSpan, failed]));
  const spans = c.getSpans('cop-1');
  assert.equal(spans.length, 2);
  assert.deepEqual([spans[0].tool, spans[0].success, spans[0].durationMs], ['bash', true, 250]);
  assert.deepEqual([spans[1].tool, spans[1].success, spans[1].error], ['edit', false, 'ToolError']);
});

test('a failed Copilot chat span feeds the breaker error-storm input', async (t) => {
  const c = await collector(t);
  const errs = [];
  c.onApiError((id) => errs.push(id));
  const bad = chatSpan([kv('error.type', 'rate_limited')]);
  bad.status = { code: 2 };
  await post(c, '/v1/traces', traceBatch('cop-1', [bad]));
  assert.deepEqual(errs, ['cop-1']);
});

test('non-Copilot spans and Copilot histogram metrics are ignored', async (t) => {
  const c = await collector(t);
  const foreign = chatSpan();
  foreign.attributes = foreign.attributes.map((a) => a.key === 'gen_ai.provider.name' ? kv(a.key, 'openai') : a);
  await post(c, '/v1/traces', traceBatch('cop-1', [foreign]));
  // Copilot's metrics: cumulative histograms, no session id → cannot be attributed.
  await post(c, '/v1/metrics', {
    resourceMetrics: [{
      resource: { attributes: [kv('agent.id', 'cop-1')] },
      scopeMetrics: [{ metrics: [{ name: 'gen_ai.client.token.usage', histogram: { aggregationTemporality: 2, dataPoints: [{ sum: 5, count: 1, attributes: [kv('gen_ai.token.type', 'output')] }] } }] }]
    }]
  });
  assert.equal(c.getAgentUsage('cop-1'), null);
});

const copilotSample = (agentId, requests, tokens) => ({
  agentId, sessionId: 's-' + agentId, ts: 1, input: tokens, output: 0, cacheRead: 0, cacheCreation: 0,
  model: 'gpt-6-luna', usd: 0, copilot: { requests, aiCredits: requests * 0.15 }
});
const claudeSample = (agentId, usd, tokens) => ({
  agentId, sessionId: 's-' + agentId, ts: 1, input: tokens, output: 0, cacheRead: 0, cacheCreation: 0,
  model: 'claude-sonnet-5', usd
});
const input = (sample) => ({ agentId: sample.agentId, sample, progressing: true });

test('breaker: Copilot is never blamed for the $-cap', () => {
  const b = new CircuitBreaker(() => ({ costCapUsd: 1 }));
  const d = b.tick([input(copilotSample('cop', 500, 10)), input(claudeSample('cla', 0.5, 10))], 1000);
  assert.deepEqual(d.map((x) => x.state.level), ['healthy', 'healthy'], 'floor $ total is 0.5, under the cap');
  const over = new CircuitBreaker(() => ({ costCapUsd: 0.1 }));
  const d2 = over.tick([input(copilotSample('cop', 500, 10)), input(claudeSample('cla', 0.5, 10))], 1000);
  assert.equal(d2[0].state.level, 'healthy', 'Copilot is not the $ top spender');
  assert.equal(d2[1].state.level, 'steering');
});

test('breaker: copilotRequestCap trips the biggest Copilot user only', () => {
  const b = new CircuitBreaker(() => ({ copilotRequestCap: 10 }));
  const d = b.tick([
    input(copilotSample('cop-a', 4, 10)), input(copilotSample('cop-b', 8, 10)), input(claudeSample('cla', 99, 10))
  ], 1000);
  assert.deepEqual(d.map((x) => x.state.level), ['healthy', 'steering', 'healthy']);
  assert.match(d[1].state.reason, /Copilot request cap: floor total over 10 requests \(top user 8\)/);
});

test('breaker: Copilot tokens still count toward the token budget', () => {
  const b = new CircuitBreaker(() => ({ costCapTokens: 100 }));
  const d = b.tick([input(copilotSample('cop', 1, 90)), input(claudeSample('cla', 0, 20))], 1000);
  assert.equal(d[0].state.level, 'steering');
  assert.match(d[0].state.reason, /token cap/);
});
