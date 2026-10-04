/**
 * Typing a line into an agent TUI and submitting it (T-043).
 *
 * The boot bug: god's `/remote-control <name>` was typed, its Enter was lost,
 * and the orientation prompt was then typed onto the SAME input line, so one
 * Enter submitted "/remote-control MichaelYou're online as Michael…". The
 * per-pty serialization in useHive only stops two writers interleaving; it
 * can't help when the TUI drops a keystroke.
 *
 * Two guards, both provider-neutral:
 *  1. Clear the input line before typing (Ctrl+U, "kill to line start"), for
 *     the providers verified to honour it (see clearInputSequence). A line
 *     whose Enter was lost is discarded instead of becoming the prefix of the
 *     next submission.
 *  2. Don't send Enter until the TUI has echoed the text (any pty output after
 *     the write, bounded by a timeout), so Enter can't race ahead of a TUI that
 *     is still processing the keystrokes.
 *
 * Enter is never re-sent blindly: if the first one did land, a second could
 * answer a permission prompt the submission just opened.
 *
 * Seams: submitToPty in src/renderer/src/hooks/useHive.ts; nudgeWorker in
 * src/main/index.ts via src/main/custom/ptySubmit.ts (T-047).
 */
import type { AgentProvider } from '../agentProvider';

/** Providers whose input box is verified to treat Ctrl+U as "kill to line
 *  start" (T-047, from the T-046 audit): Claude Code; kimi (prompt_toolkit);
 *  crush (bubbles textarea). Ink-style or homegrown inputs (copilot, grok,
 *  cursor, pi, opencode) may type a literal "u", so everyone not listed gets no
 *  clear (only the echo wait). To add one, check it in a PTY: type "ab", send
 *  Ctrl+U, type "c", Enter; the submitted text must be "c". codex, gemini and
 *  qwen are likely line editors but are not verified yet. */
const CLEARS_WITH_CTRL_U: ReadonlySet<string> = new Set(['claude', 'kimi', 'crush']);

export function clearInputSequence(provider: AgentProvider): string | null {
  return CLEARS_WITH_CTRL_U.has(provider) ? '\x15' : null;
}

export interface PtySubmitIo {
  write(data: string): Promise<{ ok: boolean; error?: string } | undefined>;
  /** Resolves true once the pty emits any output after this call, or false at
   *  the timeout. Must start listening synchronously, before it returns. */
  waitForOutput(timeoutMs: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export const CLEAR_SETTLE_MS = 80;
export const ECHO_TIMEOUT_MS = 1000;
export const ENTER_GAP_MS = 140;

/** Bracketed paste only for multi-line text (#24); single lines go raw, since
 *  agy treats the markers as literal input. */
export function submitPayload(text: string): string {
  return text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
}

/** Clear the line, type `text`, wait for the echo, press Enter, settle. Rejects
 *  on a failed write. writePty never rejects for a dead pty, it resolves
 *  { ok:false } (#36), so every write is checked. */
export async function typeAndSubmit(
  io: PtySubmitIo,
  text: string,
  provider: AgentProvider,
  settleMs: number
): Promise<void> {
  const write = async (data: string): Promise<void> => {
    const res = await io.write(data);
    if (!res?.ok) throw new Error(res?.error ?? 'pty write failed');
  };
  const clear = clearInputSequence(provider);
  if (clear) {
    await write(clear);
    await io.sleep(CLEAR_SETTLE_MS);
  }
  const echoed = io.waitForOutput(ECHO_TIMEOUT_MS);
  await write(submitPayload(text));
  await echoed;
  await io.sleep(ENTER_GAP_MS);
  await write('\r');
  await io.sleep(settleMs);
}
