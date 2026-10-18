/**
 * Native instruction channel (T-051). Plan: docs/plans/orchestrator-alignment.md, Phase 1.
 *
 * A non-Claude engine has no `--append-system-prompt`, so upstream sends the
 * whole hive prompt as the session's FIRST USER MESSAGE. That carries less
 * weight than standing instructions and is the first thing lost when the
 * session compacts. Most engines can load an instructions file from their
 * config home, and the harness already gives each agent an isolated one. This
 * writes the hive prompt there and returns a short kick for the first message
 * instead. On any failure it returns the full prompt: upstream behaviour.
 *
 * Engines are enabled by `orchestrator.nativeInstructions` (provider ids).
 * Each writer below says how it was checked. Only the per-agent home is ever
 * written; a symlinked target is never written through (it could be a file in
 * the user's own config).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { orchestratorLevers } from './orchestrator';

interface AgentLike {
  id: string;
  name: string;
  provider?: string;
  isGod?: boolean;
}

const MARK = '<!-- munder-hive (auto-generated; do not edit) -->';

/** The first message when the prompt went into the instructions file. Names the
 *  file, so an engine that did not load it can still read it. */
export function instructionKick(meta: AgentLike, file: string): string {
  return [
    `You are "${meta.name}" (${meta.id}), ${meta.isGod ? 'the orchestrator of' : 'an agent in'} a hive of AI agents.`,
    `Your full hive instructions are loaded as your standing instructions, from ${file}. Follow them for the whole session. If you cannot see them, read that file now.`,
    'Start with the first step they give you: read your memory.md and every file in your inbox.'
  ].join('\n');
}

/** Refuse to write through a symlink; create parent dirs. */
function safeWrite(file: string, text: string): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${file}`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

type Writer = (prompt: string, env: Record<string, string>) => string | null;

/** One writer per engine: write the prompt, return the file the engine loads
 *  (named in the kick), or null when the engine's home is not set up. */
export const WRITERS: Record<string, Writer> = {
  // Checked on Copilot CLI 1.0.98: `copilot instruction list` with COPILOT_HOME
  // set lists "Home copilot-instructions.md" from that dir. installCopilotHooks
  // already writes the prompt there (the user's own file first); this only
  // confirms it landed, so Copilot stops getting the prompt twice.
  copilot(prompt, env) {
    const file = env.COPILOT_HOME && join(env.COPILOT_HOME, 'copilot-instructions.md');
    if (!file || !existsSync(file)) return null;
    return readFileSync(file, 'utf8').includes(prompt) ? file : null;
  },
  // Checked on OpenCode 1.19.3: with OPENCODE_CONFIG_DIR set, `opencode debug
  // config` resolves an `instructions` entry from that dir's opencode.json.
  // installOpenCodePlugin may already have written opencode.json (theme): merge.
  opencode(prompt, env) {
    const dir = env.OPENCODE_CONFIG_DIR;
    if (!dir) return null;
    const file = join(dir, 'hive-instructions.md');
    safeWrite(file, `${MARK}\n${prompt}\n`);
    const cfgFile = join(dir, 'opencode.json');
    let cfg: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
    if (existsSync(cfgFile)) cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    const list = Array.isArray(cfg.instructions) ? (cfg.instructions as unknown[]).filter((x) => x !== file) : [];
    cfg.instructions = [...list, file];
    safeWrite(cfgFile, JSON.stringify(cfg, null, 2));
    return file;
  },
  // Codex documents a global AGENTS.md in CODEX_HOME. NOT checked on this machine
  // (its install is broken), so it is not in the default list: add "codex" to
  // orchestrator.nativeInstructions once `codex` shows it loaded. The user's own
  // ~/.codex/AGENTS.md (or $CODEX_HOME's) is kept at the top, as for Copilot.
  codex(prompt, env) {
    const dir = env.CODEX_HOME;
    if (!dir) return null;
    const userFile = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'AGENTS.md');
    const own = userFile !== join(dir, 'AGENTS.md') && existsSync(userFile) ? readFileSync(userFile, 'utf8').trimEnd() + '\n\n' : '';
    const file = join(dir, 'AGENTS.md');
    safeWrite(file, `${own}${MARK}\n${prompt}\n`);
    return file;
  }
};

/** The text for the engine's first message: a kick when the prompt went into
 *  the engine's instructions file, else the full prompt (upstream). */
export function nativeInstructions(meta: AgentLike, env: Record<string, string>, prompt: string): string {
  const provider = meta.provider ?? '';
  const write = WRITERS[provider];
  if (!write || !prompt || !orchestratorLevers().nativeInstructions.includes(provider)) return prompt;
  try {
    const file = write(prompt, env);
    return file ? instructionKick(meta, file) : prompt;
  } catch (e) {
    console.error(`[hive] native instructions for ${meta.id} (${provider}) failed, sending the prompt as the first message:`, e);
    return prompt;
  }
}
