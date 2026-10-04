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
 *
 * Configurable (T-038), all in `<userData>/config.json` → `costLevers`:
 *  - `trimPrefix` (default true): master switch; false = upstream, nothing trimmed.
 *  - `strictMcp` (default true): pass `--strict-mcp-config`.
 *  - `leanDisabledPlugins` (default DEFAULT_LEAN_DISABLED_PLUGINS): plugin names
 *    to switch off; `[]` = no plugin trim. superpowers is kept by default (the
 *    human wants its TDD/debugging/verification guidance). Probe with the
 *    default: 27,314 → 23,772 tokens (-13%); trimming superpowers too gave
 *    23,059 (it adds 15 skills, ≈713 tokens).
 * Read live: a change applies to the next agent spawn.
 */

/** Default for `costLevers.leanDisabledPlugins`: plugins with skills/agents/
 *  commands no hive agent has used, matched by name, any marketplace.
 *  superpowers is NOT in the default (T-038, the human's call): its TDD,
 *  debugging and verification guidance is wanted even though no hive transcript
 *  invoked one of its skills. */
export const DEFAULT_LEAN_DISABLED_PLUGINS: readonly string[] = Object.freeze([
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
export function leanPluginOverrides(
  userEnabledPlugins: Record<string, unknown> | undefined,
  disabled: readonly string[] = DEFAULT_LEAN_DISABLED_PLUGINS
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, on] of Object.entries(userEnabledPlugins ?? {})) {
    if (on === true && disabled.includes(pluginName(key))) out[key] = false;
  }
  return out;
}

/** Add `--strict-mcp-config` unless the caller already passes MCP config of its own. */
export function withLeanArgs(args: string[]): string[] {
  if (args.includes('--strict-mcp-config') || args.includes('--mcp-config')) return args;
  return [...args, '--strict-mcp-config'];
}
