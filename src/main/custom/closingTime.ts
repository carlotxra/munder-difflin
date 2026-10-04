/**
 * Harness-side closing time (T-034, J5 + F18; god049 decision A + single
 * delivery). Lever: costLevers.harnessClosingTime. Off = upstream exactly.
 *
 * Upstream mails god a brief, god broadcasts to every worker, and every worker
 * also gets a steer: an idle worker spends a turn to say "nothing to save", and
 * a busy one hears it twice. Here the harness does the fan-out itself:
 *
 *  - STRICTLY IDLE workers (no PTY output for 12s+, last hook not a PreToolUse,
 *    empty inbox AND outbox, clean git worktree) are parked by the harness: a
 *    dated line goes into their memory.md and the harness records their
 *    CLOSING-TIME-ACK. They take no turn.
 *  - Every other worker gets exactly ONE delivery of the short brief: a busy
 *    one a steer (reaches it at its next hook boundary, the graceful
 *    interrupt), an idle-but-not-clean one an inbox message. A steer still
 *    unconsumed once its worker goes idle is withdrawn and replaced by the inbox
 *    message, so it is never lost and never doubled. Each must ACK itself.
 *  - god is told who was parked and who was briefed, must NOT broadcast, and
 *    is woken once when the last ACK is in. (Worker ACKs are mechanical mail
 *    under digestWakes, so they don't wake god one by one.)
 *  - ACK verification is unchanged: ClosingTimeController still refuses a
 *    CLOSING-TIME-COMPLETE while any live worker lacks an ACK.
 *  - On cancel, the harness tells the briefed workers itself; nobody broadcasts.
 *
 * Seams: start() and cancel() in closingTime.ts, and the hook observer in index.ts.
 */
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HiveManager } from '../hive';
import type { ControlRegistry } from '../control';
import { costLevers } from './levers';

/** No PTY output for this long = idle (the worker-wake watchdog's threshold). */
export const CLOSING_IDLE_MS = 12_000;
const POLL_MS = 5_000;

/** F18: the one delivery a worker gets. Same steps, same exact ACK subject. */
export const WORKER_BRIEF =
  'CLOSING TIME: finish your current step and start no new work. Park or commit your work-in-progress, append your current state and concrete next steps to your memory.md, then reply to god with a message whose subject is exactly "CLOSING-TIME-ACK".';

/** Upstream's god steer, unchanged. */
const GOD_STEER =
  'CLOSING TIME was pressed by the human: pause your current work at the next sensible point and drain your inbox NOW — a shutdown brief is waiting there. Coordinate the floor shutdown before anything else.';

// — live facts, installed from index.ts —
let lastOutputAt: (agentId: string) => number = () => 0;
const lastHook = new Map<string, string>();
export function setClosingFacts(f: { lastOutputAt: (agentId: string) => number }): void {
  lastOutputAt = f.lastOutputAt;
}
/** Hook observer: remembers each agent's last hook event (mid-tool detection). */
export function noteHookForClosing(agentId: string | undefined, event: string | undefined): void {
  if (agentId && event) lastHook.set(agentId, event);
}

export interface WorkerFacts {
  outputQuietMs: number;
  midTool: boolean;
  inbox: number;
  outbox: number;
  clean: boolean;
}

/** god049 "strict idle". Any doubt (never produced output, not a git repo) is not idle. */
export function isStrictlyIdle(f: WorkerFacts): boolean {
  return f.outputQuietMs >= CLOSING_IDLE_MS && !f.midTool && f.inbox === 0 && f.outbox === 0 && f.clean;
}

function gitClean(dir: string | undefined): boolean {
  if (!dir || !existsSync(dir)) return false;
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout.trim() === '';
}

function outboxCount(root: string, id: string): number {
  try { return readdirSync(join(root, 'agents', id, 'outbox')).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

function factsFor(hive: HiveManager, id: string, now: number): WorkerFacts {
  const out = lastOutputAt(id);
  return {
    outputQuietMs: out > 0 ? now - out : 0,
    midTool: lastHook.get(id) === 'PreToolUse',
    inbox: hive.inbox(id).length,
    outbox: outboxCount(hive.root()!, id),
    clean: gitClean(hive.registry().agents[id]?.cwd)
  };
}

export interface ClosingRun {
  hive: HiveManager;
  control?: ControlRegistry;
  godId: string;
  workers: Set<string>;
  acked: Set<string>;
  isActive: () => boolean;
  /** Re-render the controller's progress after the harness records ACKs. */
  progress: () => void;
}

/** Workers briefed in the current run, and how each was reached. */
let briefed = new Map<string, { via: 'steer' | 'inbox'; pendingAfter: number }>();
let timer: ReturnType<typeof setInterval> | null = null;
let allAckedSent = false;

const label = (hive: HiveManager, id: string): string => `${hive.registry().agents[id]?.name ?? id} (${id})`;

function inboxBrief(run: ClosingRun, id: string): void {
  run.hive.send({ to: id, act: 'request', subject: 'CLOSING TIME', body: WORKER_BRIEF }, 'harness');
}

/**
 * Seam for ClosingTimeController.start(), called once the worker set is known.
 * Returns false (lever off) to let upstream's kickoff run unchanged.
 */
export function customClosingStart(run: ClosingRun, now = Date.now()): boolean {
  if (!costLevers().harnessClosingTime) return false;
  stopTimer();
  briefed = new Map();
  allAckedSent = false;
  const root = run.hive.root();
  const parked: string[] = [];
  const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ');

  for (const id of run.workers) {
    const f = factsFor(run.hive, id, now);
    if (root && isStrictlyIdle(f)) {
      try {
        appendFileSync(join(root, 'agents', id, 'memory.md'),
          `\n- ${stamp}Z closing time: idle with a clean worktree and no pending mail, so the harness parked it. No WIP to save; resume from the notes above.\n`, 'utf8');
      } catch { /* an unwritable memory is not idle-safe: brief it instead */
        inboxBrief(run, id); briefed.set(id, { via: 'inbox', pendingAfter: 0 }); continue;
      }
      run.acked.add(id);
      parked.push(id);
      run.hive.send({ to: run.godId, act: 'inform', subject: 'CLOSING-TIME-ACK',
        body: `${label(run.hive, id)} parked by the harness: idle, clean worktree, no pending mail. Its memory.md has the closing line.` }, 'harness');
    } else if (f.outputQuietMs < CLOSING_IDLE_MS || f.midTool) {
      run.control?.steer(id, WORKER_BRIEF);
      briefed.set(id, { via: 'steer', pendingAfter: run.control?.snapshot(id).pendingSteers ?? 0 });
    } else {
      inboxBrief(run, id);
      briefed.set(id, { via: 'inbox', pendingAfter: 0 });
    }
  }

  const names = (ids: string[]): string => ids.map((id) => label(run.hive, id)).join(', ') || '(none)';
  const waiting = [...briefed.keys()];
  run.hive.send({
    to: 'god',
    act: 'request',
    subject: 'CLOSING TIME — run the shutdown protocol now',
    body: [
      'The human pressed "closing time": the harness closes as soon as you confirm the floor is safe. The harness has already reached every worker, so do NOT broadcast closing time:',
      `- Parked by the harness (idle, clean, ACK recorded): ${names(parked)}.`,
      `- Told to park WIP, save memory and ACK you (one delivery each): ${names(waiting)}.`,
      '',
      waiting.length
        ? '1. WAIT for their CLOSING-TIME-ACKs; the harness wakes you once when the last one is in. Nudge a straggler once if needed.'
        : '1. Nothing to wait for.',
      '2. Save your own state: update board.md and append your shift summary to your memory.md.',
      '3. CONCLUDE by sending a message with "to":"human" and the subject exactly "CLOSING-TIME-COMPLETE" — the harness watches for it and closes the app. Do not send it before every worker has acked: the harness independently verifies the ACKs and will reject a premature conclusion.',
      '',
      'This is a shutdown: do not start new work and do not accept new tasks.'
    ].join('\n')
  }, 'human');
  run.control?.steer(run.godId, GOD_STEER);
  run.progress();

  timer = setInterval(() => poll(run), POLL_MS);
  timer.unref?.();
  return true;
}

/** Withdraw an unconsumed steer from a worker that went idle (inbox brief
 *  instead), and wake god once when every worker has acked. */
export function poll(run: ClosingRun, now = Date.now()): void {
  if (!run.isActive()) { stopTimer(); return; }
  for (const [id, b] of briefed) {
    if (b.via !== 'steer' || run.acked.has(id) || !run.control) continue;
    const pending = run.control.snapshot(id).pendingSteers;
    const quiet = now - lastOutputAt(id);
    if (pending > 0 && pending === b.pendingAfter && quiet >= CLOSING_IDLE_MS && lastHook.get(id) !== 'PreToolUse') {
      run.control.clearSteers(id);
      inboxBrief(run, id);
      briefed.set(id, { via: 'inbox', pendingAfter: 0 });
    } else if (pending < b.pendingAfter) {
      briefed.set(id, { via: 'steer', pendingAfter: -1 }); // consumed: delivered
    }
  }
  if (!allAckedSent && run.workers.size > 0 && [...run.workers].every((id) => run.acked.has(id))) {
    allAckedSent = true;
    run.hive.send({ to: run.godId, act: 'request', subject: 'CLOSING TIME — every worker has acked',
      body: 'Every worker has sent (or the harness recorded) its CLOSING-TIME-ACK. Save your own state, then send CLOSING-TIME-COMPLETE to "human".' }, 'harness');
  }
}

/**
 * Seam for ClosingTimeController.cancel(): the harness tells the briefed workers
 * itself and tells god nobody needs a broadcast. Returns false (lever off) to
 * let upstream's cancel notice go to god unchanged.
 */
export function customClosingCancel(hive: HiveManager): boolean {
  if (!costLevers().harnessClosingTime || timer === null) return false;
  stopTimer();
  for (const id of briefed.keys()) {
    hive.send({ to: id, act: 'inform', subject: 'CLOSING TIME CANCELLED',
      body: 'The human cancelled the shutdown: resume normal work. Anything you already saved is fine.' }, 'harness');
  }
  hive.send({ to: 'god', act: 'inform', subject: 'CLOSING TIME CANCELLED',
    body: 'The human cancelled the shutdown — resume normal operation. The harness has already told the workers it briefed, so do not broadcast. Any memory saves already done are a bonus, not a problem.' }, 'human');
  briefed = new Map();
  return true;
}

function stopTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Test hook. */
export function resetClosingState(): void {
  stopTimer(); briefed = new Map(); allAckedSent = false; lastHook.clear(); lastOutputAt = () => 0;
}
