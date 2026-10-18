/**
 * Main-process access to the orchestrator levers
 * (src/shared/custom/orchestratorLevers.ts). Until install.ts sets a source,
 * every lever reads OFF, so a bare HiveManager behaves exactly like upstream.
 */
import { ORCHESTRATOR_LEVERS_OFF, resolveOrchestratorLevers, type OrchestratorLevers } from '../../shared/custom/orchestratorLevers';

let source: (() => unknown) | null = null;

/** Install the config reader (install.ts, once at startup). Tests pass a literal. */
export function setOrchestratorLeversSource(read: (() => unknown) | null): void {
  source = read;
}

/** The current levers, read live. Prompts read them once per spawn, so a change
 *  reaches agents spawned after it (the prompt-cache rule in hive.ts). */
export function orchestratorLevers(): OrchestratorLevers {
  if (!source) return ORCHESTRATOR_LEVERS_OFF;
  try { return resolveOrchestratorLevers(source()); } catch { return ORCHESTRATOR_LEVERS_OFF; }
}
