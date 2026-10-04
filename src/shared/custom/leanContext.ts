/**
 * Trim the static prefix every hive Claude agent pays on every call (T-035 / J4).
 *
 * Evidence (T-033, all 25 hive transcripts, 2026-09-26 → 10-04): 1,531 Bash
 * calls, 6 Skill calls (lavish ×5, claude-api ×1, neither from a plugin below),
 * 11 subagent calls (general-purpose only), ZERO calls to any MCP tool. Probe
 * on CLI 2.1.289 (`claude -p`, same settings as a hive agent): 27.3k tokens
 * baseline → 25.2k with `--strict-mcp-config` (drops 36 claude.ai connectors and
 * the context7 plugin server) → 23.1k with the plugins below switched off
 * (54 → 36 skills, 10 → 5 agent types). The hive's own default MCP servers live
 * in the per-session settings.json, which this CLI does not load as MCP config
 * (the probe's init listed none of them), so strict mode changes nothing there.
 *
 * Kept on purpose: LSP plugins (edit diagnostics), security-guidance (a hook
 * that guards edits, no listing cost), user skills (lavish is used) and the
 * bundled skills (claude-api is used).
 */

/** Plugins with skills/agents/commands no hive agent has used. Matched by name,
 *  any marketplace. */
export const LEAN_DISABLED_PLUGINS: readonly string[] = Object.freeze([
  'superpowers',
  'code-review',
  'feature-dev',
  'code-simplifier',
  'claude-md-management',
  'commit-commands',
  'claude-code-setup',
  'hookify',
  'context7'
]);

const pluginName = (key: string): string => key.split('@')[0];

/** Per-session `enabledPlugins` overrides: switch off the listed plugins the user
 *  has enabled (keeping the user's own marketplace key). Empty when none apply. */
export function leanPluginOverrides(userEnabledPlugins: Record<string, unknown> | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, on] of Object.entries(userEnabledPlugins ?? {})) {
    if (on === true && LEAN_DISABLED_PLUGINS.includes(pluginName(key))) out[key] = false;
  }
  return out;
}

/** Add `--strict-mcp-config` unless the caller already passes MCP config of its own. */
export function withLeanArgs(args: string[]): string[] {
  if (args.includes('--strict-mcp-config') || args.includes('--mcp-config')) return args;
  return [...args, '--strict-mcp-config'];
}
