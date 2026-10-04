/**
 * Which cards the ASK ME surfaces show: the tab, the kanban "needs you" badge
 * and the office floor's ASK ME board all use the predicate below, so they
 * can never disagree.
 *
 * Kept free of every import (no React, no store), like askMeOrder.ts, so it is
 * unit-testable and the office floor can apply it to the raw ledger.
 *
 * Visibility used to require `status: "blocked"`. In practice god recorded asks
 * on cards it left at "doing", so they never reached the board. An open
 * question on any card that is not done now shows; "blocked" is still the
 * recommended status when work cannot proceed, but it no longer gates
 * visibility.
 */

/** Structural shape of one humanQA entry. Loose on purpose: the god writes
 *  tasks.json by hand, and the office floor reads it unparsed. */
export interface HumanQALike {
  q?: unknown;
  a?: unknown;
  dismissedAt?: unknown;
}

export interface TaskLike<E extends HumanQALike = HumanQALike> {
  status?: unknown;
  humanQA?: E[];
}

/** The card's currently open question for the human, if any. An entry the human
 *  dismissed (dismissedAt) counts as resolved, same as an answered one. */
export function openQuestion<E extends HumanQALike>(t: TaskLike<E>): E | undefined {
  if (!Array.isArray(t.humanQA)) return undefined;
  for (let i = t.humanQA.length - 1; i >= 0; i--) {
    const e = t.humanQA[i];
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

/** Waiting on the human = an open question on a card that is not done. */
export function waitsOnHuman(t: TaskLike): boolean {
  return !!t && t.status !== 'done' && !!openQuestion(t);
}

/** How many cards wait on the human. Tolerates a malformed ledger. */
export function countWaitingOnHuman(tasks: unknown): number {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t) => !!t && typeof t === 'object' && waitsOnHuman(t as TaskLike)).length;
}
