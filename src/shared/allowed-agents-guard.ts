/**
 * Allowed-agents guard for subagent runs.
 *
 * Restricts which agents a parent can spawn, preventing unauthorized
 * delegation chains. Ported from ivi's agent enforcement system.
 *
 * ## How it works
 *
 * The guard reads the parent agent's frontmatter `agents` field:
 *
 * ```yaml
 * ---
 * name: orchestrator
 * agents: [worker, scout, researcher]
 * ---
 * ```
 *
 * When present, only listed agents can be spawned as children.
 * When absent (or empty), all discovered agents are allowed.
 *
 * ## Enforcement flow
 *
 * 1. `checkAllowedAgent()` reads the parent's `agents` frontmatter
 * 2. If the child is not in the list, returns `{ allowed: false, reason }`
 * 3. Top-level calls (no parent) always pass
 * 4. Parents without an `agents` field allow all children
 */

import type { AgentConfig } from "../agents/agents.ts";

/** Result of an allowed-agents check. */
export interface AgentsGuardResult {
	/** Whether the spawn is permitted. */
	allowed: boolean;
	/** Human-readable reason if blocked. */
	reason?: string;
}

/**
 * Check if a parent agent is allowed to spawn a specific child agent.
 *
 * Resolution order:
 * 1. No parent (top-level) → always allowed
 * 2. Parent not found in discovered agents → allowed (can't enforce)
 * 3. Parent has no `agents` field → allowed (no restriction)
 * 4. Child is in parent's `agents` list → allowed
 * 5. Otherwise → blocked with reason
 *
 * @param parentAgentName - Name of the parent agent (undefined if top-level)
 * @param childAgentName - Name of the agent being spawned
 * @param allAgents - All discovered agent configs
 */
export function checkAllowedAgent(
	parentAgentName: string | undefined,
	childAgentName: string,
	allAgents: AgentConfig[],
): AgentsGuardResult {
	if (!parentAgentName) {
		return { allowed: true };
	}

	const parentConfig = allAgents.find((a) => a.name === parentAgentName);
	if (!parentConfig) {
		return { allowed: true };
	}

	const allowedAgents = (parentConfig as AgentConfig & { agents?: string[] }).agents;
	if (!allowedAgents || !Array.isArray(allowedAgents) || allowedAgents.length === 0) {
		return { allowed: true };
	}

	if (allowedAgents.includes(childAgentName)) {
		return { allowed: true };
	}

	return {
		allowed: false,
		reason: `Agent "${parentAgentName}" can only spawn: ${allowedAgents.join(", ")}. "${childAgentName}" is not allowed.`,
	};
}

/**
 * Resolve the parent agent name from environment.
 * Reads `PI_TRACE_AGENT_NAME` set by the trace propagation system.
 */
export function resolveParentAgentName(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.PI_TRACE_AGENT_NAME;
}
