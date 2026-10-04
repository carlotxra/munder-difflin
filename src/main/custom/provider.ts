/**
 * Which agents run Claude (T-040). Some levers ride Claude-shaped channels:
 * hook additionalContext reaching the model, a Stop hook at every turn end.
 * They apply only to Claude agents; every other provider keeps upstream's path.
 */
import { isClaudeProvider, type AgentProvider } from '../../shared/agentProvider';

let providerOf: (agentId: string) => AgentProvider | null | undefined = () => null;

/** Installed from install.ts: the agent's registry provider, undefined when
 *  the agent has none recorded (upstream launches that as claude), null when
 *  the agent is unknown. */
export function setProviderSource(f: (agentId: string) => AgentProvider | null | undefined): void {
  providerOf = f;
}

/** True only for a known agent on the claude provider (unset = claude, as at launch). */
export function isClaudeAgent(agentId: string): boolean {
  const p = providerOf(agentId);
  return p !== null && isClaudeProvider(p ?? 'claude');
}
