/**
 * T-035 levers on the Claude spawn path, kept out of index.ts so upstream merges
 * only meet two one-line seams there (see CUSTOMIZATIONS.md).
 *
 * J4 trimPrefix: `--strict-mcp-config` + unused plugins off in the per-session
 *   settings file the hive already wrote (shared/custom/leanContext.ts).
 * J2 freshStartOnResume: skip `--resume` for a big session or a model switch and
 *   leave the agent a handoff note in its inbox instead (shared/custom/resumePolicy.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { costLevers } from './levers';
import { projectDir } from '../transcript';
import { leanPluginOverrides, withLeanArgs } from '../../shared/custom/leanContext';
import {
  DEFAULT_RESUME_MAX_CONTEXT_TOKENS, decideResume, handoffBody, transcriptStats, type ResumeDecision
} from '../../shared/custom/resumePolicy';

const readJson = (p: string): any => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; }
};

/** The user's own enabledPlugins (~/.claude/settings.json). Overridable for tests. */
let userSettingsPath = (): string => join(homedir(), '.claude', 'settings.json');
export function setUserSettingsPathForTest(fn: () => string): void { userSettingsPath = fn; }

/** J4 seam: returns the args to spawn with. Off → args unchanged. */
export function trimPrefixArgs(args: string[]): string[] {
  if (!costLevers().trimPrefix) return args;
  const i = args.indexOf('--settings');
  const settingsFile = i >= 0 ? args[i + 1] : undefined;
  if (settingsFile && existsSync(settingsFile)) {
    const overrides = leanPluginOverrides(readJson(userSettingsPath())?.enabledPlugins);
    const settings = readJson(settingsFile);
    if (settings && Object.keys(overrides).length) {
      settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), ...overrides };
      try { writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch { /* spawn anyway */ }
    }
  }
  return withLeanArgs(args);
}

export interface ResumeGateInput {
  agentId: string;
  sessionId: string;
  /** The agent's cwd; the transcript was already seeded into its project dir. */
  cwd: string;
  /** A session id typed by the user, or a caller that requires the resume. */
  explicit: boolean;
  args: string[];
  /** Deliver the handoff note (hive.send). */
  send: (msg: { to: string; act: 'inform'; subject: string; body: string; requires_reply: false }) => unknown;
  maxContextTokens?: number;
}

/** J2 seam: true = attach `--resume` as before; false = start fresh (handoff sent). */
export function keepResume(input: ResumeGateInput): boolean {
  if (!costLevers().freshStartOnResume) return true;
  let decision: ResumeDecision;
  let stats;
  try {
    const transcript = join(projectDir(input.cwd), `${input.sessionId}.jsonl`);
    stats = existsSync(transcript) ? transcriptStats(readFileSync(transcript, 'utf8')) : undefined;
    const m = input.args.indexOf('--model');
    decision = decideResume({
      explicit: input.explicit,
      stats,
      launchModel: m >= 0 ? input.args[m + 1] : undefined,
      maxContextTokens: input.maxContextTokens ?? DEFAULT_RESUME_MAX_CONTEXT_TOKENS
    });
  } catch {
    return true; // never block a spawn on the policy
  }
  if (decision.resume) return true;
  const m = input.args.indexOf('--model');
  try {
    input.send({
      to: input.agentId,
      act: 'inform',
      subject: 'Fresh session after restart (handoff)',
      body: handoffBody(input.sessionId, decision, stats, m >= 0 ? input.args[m + 1] : undefined),
      requires_reply: false
    });
  } catch { /* the fresh start still stands; memory.md holds the durable state */ }
  console.log(`[resume] ${input.agentId}: fresh start instead of --resume ${input.sessionId} (${decision.reason})`);
  return false;
}
