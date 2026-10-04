/**
 * Main-process side of the T-043 submit (T-047): the worker-wake watchdog's
 * nudge goes through the same typeAndSubmit as the renderer, so a lost Enter
 * can't glue it to the next submission either. There's no pty data listener
 * here; the echo wait polls PtyManager.lastOutputAt instead.
 *
 * Seam: nudgeWorker in src/main/index.ts.
 */
import type { AgentProvider } from '../../shared/agentProvider';
import { typeAndSubmit } from '../../shared/custom/ptySubmit';

export interface PtyWriter {
  write(id: string, data: string): { ok: boolean; error?: string };
  lastOutputAt(id: string): number | undefined;
}

const POLL_MS = 20;

export function submitLine(
  pty: PtyWriter,
  ptyId: string,
  text: string,
  provider: AgentProvider,
  settleMs = 0
): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return typeAndSubmit({
    write: async (data) => pty.write(ptyId, data),
    waitForOutput: async (timeoutMs) => {
      const mark = Date.now();
      while (Date.now() - mark < timeoutMs) {
        const at = pty.lastOutputAt(ptyId);
        if (at === undefined) return false; // pty gone; the next write reports it
        if (at >= mark) return true;
        await sleep(POLL_MS);
      }
      return false;
    },
    sleep
  }, text, provider, settleMs);
}
