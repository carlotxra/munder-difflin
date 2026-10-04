/**
 * Clone agent (T-029): the rules for turning an existing agent into the
 * pre-filled Add Agent form, kept import-free so main, the renderer and the
 * tests share one definition.
 *
 * Approved design (.lavish/clone-agent-mockups.html):
 *   - copied:     character, provider, model, command (minus session flags),
 *                 role, capabilities, description, goal, cwd, token cap
 *   - changed:    name (next free "<src> N"), id (new), accent (next unused)
 *   - check:      git isolation (locked on when the source has a worktree),
 *                 project folder when the source's folder is missing
 *   - not copied: inbox/outbox, session id, status, note, hold, tasks
 *   - memory.md:  optional one-time snapshot, OFF by default
 *   - god and the prep assistant cannot be cloned
 */

/** What a clone needs to know about its source. Structural, so the renderer's
 *  Agent and an archived record both fit. */
export interface CloneSource {
  id: string;
  name: string;
  character: string;
  accent: string;
  description?: string;
  goal?: string;
  cwd: string;
  command?: string;
  provider?: string;
  model?: string;
  worktreePath?: string;
  isGod?: boolean;
  isAssistant?: boolean;
  archived?: boolean;
  /** Registry-only fields, when known. */
  role?: string;
  capabilities?: string[];
  /** False when the registry recorded the folder as missing or unusable. */
  cwdValid?: boolean;
}

export type CloneTag = 'copied' | 'changed' | 'check' | 'notCopied';

export interface CloneDraft {
  name: string;
  character: string;
  accent: string;
  cwd: string;
  /** Git isolation for the clone. */
  isolate: boolean;
  /** True when the source works in its own worktree: the clone must get a NEW
   *  one, and the checkbox is locked on. */
  isolateLocked: boolean;
  provider?: string;
  model?: string;
  command: string;
  description: string;
  goal: string;
  role?: string;
  capabilities?: string[];
  tokenCap?: number;
  /** The source's folder is gone: hiring is blocked until a folder is picked. */
  cwdMissing: boolean;
  copyMemory: boolean;
  startNow: boolean;
  tellGod: boolean;
  tags: Record<string, CloneTag>;
}

export type CloneBlock = 'god' | 'assistant';

/** Whether an agent may be cloned. One orchestrator per floor; the prep
 *  assistant is a singleton too. */
export function cloneBlock(src: Pick<CloneSource, 'isGod' | 'isAssistant'>): CloneBlock | null {
  if (src.isGod) return 'god';
  if (src.isAssistant) return 'assistant';
  return null;
}

/** Flags that bind a CLI to one specific session. A clone starts fresh, and
 *  resuming the source's session would fork the same conversation. */
const SESSION_FLAGS_WITH_VALUE = ['--resume', '--session-id', '--conversation'];
const SESSION_FLAGS_BARE = ['--continue', '--fork-session'];

/** Split a command line on whitespace, keeping quoted runs together. */
function splitArgs(command: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[0]);
  return out;
}

/** The command with every session-bound flag (and its value) removed. */
export function stripSessionFlags(command: string): string {
  const args = splitArgs(command.trim());
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SESSION_FLAGS_BARE.includes(a)) continue;
    if (SESSION_FLAGS_WITH_VALUE.some((f) => a.startsWith(`${f}=`))) continue;
    if (SESSION_FLAGS_WITH_VALUE.includes(a)) {
      // Skip the value too, unless the flag was used bare (next arg is a flag).
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    kept.push(a);
  }
  return kept.join(' ');
}

const norm = (s: string): string => s.trim().toLowerCase();

/** True when `name` matches an ACTIVE agent's name (case-insensitive).
 *  Archived names may be reused, as Add Agent already allows. */
export function nameClash(name: string, activeNames: string[]): boolean {
  const n = norm(name);
  return !!n && activeNames.some((a) => norm(a) === n);
}

/** "Jim" → "Jim 2", "Jim 2" → "Jim 3": the first free "<base> N". */
export function suggestCloneName(srcName: string, activeNames: string[]): string {
  const m = /^(.*?)\s+(\d+)$/.exec(srcName.trim());
  const base = (m ? m[1] : srcName).trim() || 'Agent';
  for (let n = m ? Number(m[2]) + 1 : 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!nameClash(candidate, activeNames)) return candidate;
  }
  return `${base} ${Date.now().toString(36)}`;
}

/** The first accent no active agent uses, after the source's own; the
 *  source's accent when every one is taken. */
export function nextAccent(srcAccent: string, usedAccents: string[], accents: string[]): string {
  const start = Math.max(0, accents.indexOf(srcAccent));
  for (let i = 1; i <= accents.length; i++) {
    const a = accents[(start + i) % accents.length];
    if (!usedAccents.includes(a)) return a;
  }
  return srcAccent;
}

export interface CloneContext {
  /** Names of agents currently on the floor (not archived). */
  activeNames: string[];
  /** Accents of agents currently on the floor. */
  usedAccents: string[];
  /** Every accent the app offers, in picker order. */
  accents: string[];
  /** The source's per-agent token cap, if any (config.agentTokenCaps). */
  tokenCap?: number;
}

/** Build the pre-filled form for cloning `src`. */
export function buildCloneDraft(src: CloneSource, ctx: CloneContext): CloneDraft {
  const isolateLocked = !!src.worktreePath;
  const cwdMissing = src.cwdValid === false || !src.cwd;
  return {
    name: suggestCloneName(src.name, ctx.activeNames),
    character: src.character,
    accent: nextAccent(src.accent, ctx.usedAccents, ctx.accents),
    cwd: cwdMissing ? '' : src.cwd,
    isolate: isolateLocked,
    isolateLocked,
    provider: src.provider,
    model: src.model,
    command: stripSessionFlags(src.command ?? ''),
    description: src.description ?? '',
    goal: src.goal ?? '',
    role: src.role,
    capabilities: src.capabilities ? [...src.capabilities] : undefined,
    tokenCap: ctx.tokenCap,
    cwdMissing,
    copyMemory: false,
    startNow: true,
    tellGod: true,
    tags: {
      name: 'changed',
      character: 'copied',
      color: 'changed',
      project: cwdMissing ? 'check' : 'copied',
      isolation: isolateLocked ? 'check' : 'copied',
      resumeSession: 'notCopied',
      provider: 'copied',
      model: 'copied',
      command: (src.command ?? '').trim() !== stripSessionFlags(src.command ?? '') ? 'changed' : 'copied',
      tokenCap: 'copied',
      description: 'copied',
      goal: 'copied'
    }
  };
}

/** memory.md for a clone that opted in: the source's memory under a header
 *  whose first line names where it came from. */
export function memorySnapshot(srcMemory: string, srcName: string, date: string): string {
  return `Cloned from ${srcName} on ${date}\n\n${srcMemory.replace(/^﻿/, '')}`;
}

/** The inform message god gets when a clone joins. */
export function cloneInformBody(newName: string, srcName: string): string {
  return `${newName} (clone of ${srcName}) joined: same role and capabilities.`;
}
