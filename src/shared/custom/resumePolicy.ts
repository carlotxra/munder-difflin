/**
 * When a restarted Claude agent should resume its old session and when it should
 * start fresh with a handoff note instead (T-035 / J2).
 *
 * Measured in T-033: resuming a session re-writes its WHOLE context into the
 * prompt cache (the system prompt is re-rendered and old thinking blocks are
 * dropped, so the cached prefix no longer matches). For god that cost up to 252k
 * tokens × $8/MTok ≈ $2 per restart, 31 restarts in 8 days. A fresh session only
 * writes the static prefix (~25–47k). Past a size threshold, and on any model
 * change (a model switch mid-session invalidates the cache too), starting fresh
 * is cheaper. An explicit resume (a session id typed by the user, or a caller
 * that requires the resume) always wins.
 */

/** Default threshold: resume sessions up to this context size, start fresh above. */
export const DEFAULT_RESUME_MAX_CONTEXT_TOKENS = 100_000;

export interface TranscriptStats {
  /** Context size of the last API call: input + cache read + cache write. */
  lastContextTokens: number;
  /** Model id of the last API call (e.g. `claude-opus-5-5`). */
  lastModel?: string;
  /** Text of the last assistant reply, for the handoff note. */
  lastAssistantText?: string;
  /** The last prompt the agent was given (string user turn), for the handoff note. */
  lastUserPrompt?: string;
}

/** Scan a Claude Code transcript (.jsonl text) for the last call's size and model.
 *  Undefined when it holds no assistant call with usage (nothing to judge by). */
export function transcriptStats(jsonl: string): TranscriptStats | undefined {
  let stats: TranscriptStats | undefined;
  let lastUserPrompt: string | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === 'user' && !d.isMeta && typeof d.message?.content === 'string') {
      lastUserPrompt = d.message.content;
      continue;
    }
    if (d?.type !== 'assistant') continue;
    const u = d.message?.usage;
    const model: string | undefined = d.message?.model;
    if (!u || (model && model.startsWith('<'))) continue; // `<synthetic>` entries carry no real call
    const text = Array.isArray(d.message?.content)
      ? d.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim()
      : '';
    stats = {
      lastContextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      lastModel: model ?? stats?.lastModel,
      lastAssistantText: text || stats?.lastAssistantText
    };
  }
  if (stats && lastUserPrompt) stats.lastUserPrompt = lastUserPrompt;
  return stats;
}

export type ResumeDecision =
  | { resume: true; reason: 'explicit' | 'no-stats' | 'within-limits' }
  | { resume: false; reason: 'context' | 'model' };

export interface ResumeInput {
  /** The user typed this session id, or the caller requires a resume. */
  explicit: boolean;
  stats?: TranscriptStats;
  /** The `--model` the agent is about to launch with, if any. */
  launchModel?: string;
  /** 0 or negative = no size limit. */
  maxContextTokens: number;
}

/** A full model id (`claude-…`) can be compared; an alias (`opus`) cannot, so it
 *  never counts as a switch. */
function isModelSwitch(lastModel: string | undefined, launchModel: string | undefined): boolean {
  if (!lastModel || !launchModel || !launchModel.startsWith('claude-')) return false;
  return lastModel !== launchModel;
}

export function decideResume(input: ResumeInput): ResumeDecision {
  if (input.explicit) return { resume: true, reason: 'explicit' };
  const s = input.stats;
  if (!s) return { resume: true, reason: 'no-stats' };
  if (isModelSwitch(s.lastModel, input.launchModel)) return { resume: false, reason: 'model' };
  if (input.maxContextTokens > 0 && s.lastContextTokens > input.maxContextTokens) return { resume: false, reason: 'context' };
  return { resume: true, reason: 'within-limits' };
}

const clip = (s: string | undefined, n: number): string =>
  !s ? '(none)' : (s.length > n ? `${s.slice(0, n)}…` : s);

/** Body of the inbox note a fresh-started agent finds, so it picks up where its
 *  old session stopped. Kept short: memory.md and the inbox hold the durable state. */
export function handoffBody(sessionId: string, decision: ResumeDecision, stats: TranscriptStats | undefined, launchModel?: string): string {
  const why = decision.reason === 'model'
    ? `the model changed (${stats?.lastModel ?? '?'} → ${launchModel ?? '?'})`
    : `its context had grown to ${stats?.lastContextTokens ?? '?'} tokens`;
  return [
    `Your app restarted and this is a FRESH session instead of a resume of ${sessionId}, because ${why}; resuming would have re-written that whole context into the cache.`,
    'Pick up from your memory.md and your inbox as usual. Context from the old session:',
    `- Last prompt you were given: ${clip(stats?.lastUserPrompt, 600)}`,
    `- Your last reply: ${clip(stats?.lastAssistantText, 1200)}`,
    `- The full old transcript is session ${sessionId} if you need detail.`,
    'No reply needed.'
  ].join('\n');
}
