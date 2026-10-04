// Usage from a `claude -p --output-format stream-json --verbose` transcript.
// Tokens are summed per API call (one assistant message id = one call; a call
// that emits several content blocks repeats its usage, so count each id once).
// Permission denials come from `result.permission_denials`. Dollars come from the CLI's own `result.total_cost_usd`.
export function parseStream(text) {
  const u = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0, error: null, denials: [] };
  const seen = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'assistant' && ev.message?.usage) {
      // Keep the last usage seen for an id: output_tokens grows as blocks stream.
      seen.set(ev.message.id ?? `anon-${seen.size}`, ev.message.usage);
    } else if (ev.type === 'result') {
      u.costUsd = ev.total_cost_usd ?? 0;
      u.turns = ev.num_turns ?? 0;
      // Tools the permission layer refused (--perm safe): name + a short hint of the input.
      for (const d of ev.permission_denials ?? []) {
        const hint = d.tool_input?.command ?? d.tool_input?.file_path ?? '';
        u.denials.push(`${d.tool_name}${hint ? ` ${String(hint).slice(0, 60)}` : ''}`);
      }
      if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) u.error = ev.subtype ?? 'error';
    }
  }
  for (const x of seen.values()) {
    u.calls++;
    u.input += x.input_tokens ?? 0;
    u.output += x.output_tokens ?? 0;
    u.cacheRead += x.cache_read_input_tokens ?? 0;
    u.cacheWrite += x.cache_creation_input_tokens ?? 0;
  }
  return u;
}
