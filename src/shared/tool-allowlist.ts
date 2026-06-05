/**
 * Tool Allowlist — Permissive tool restriction for subagents.
 *
 * Ported from pi_launchpad's domain-enforcer.ts tool checking logic.
 *
 * Philosophy: **allow by default**. Only restrict tools when explicitly
 * configured. An empty or undefined allowlist means ALL tools are permitted.
 *
 * This is the permissive approach — the parent *opts into* restrictions
 * by setting `allowedTools` on the agent config or via the
 * `AGENT_ALLOWED_TOOLS` env var.
 *
 * Tools that are ALWAYS allowed (cannot be blocked):
 *   - read, grep, find, ls, glob — observation tools
 *   - subagent — delegation tools (would break subagent nesting otherwise)
 *
 * Tools that CAN be blocked:
 *   - write, edit, bash — mutation tools
 *   - Any custom tools registered by extensions
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolAllowlistConfig {
	/**
	 * Tools the agent is explicitly allowed to use.
	 * Empty or undefined = all tools allowed (permissive default).
	 */
	allowedTools?: string[];
}

/** Resolved allowlist state. `active: false` means permissive (all tools allowed). */
export interface ResolvedToolAllowlist {
	/** Whether the allowlist is active (has entries). When false, all tools pass. */
	active: boolean;
	/** Set of allowed tool names. */
	tools: Set<string>;
}

// ── Always-allowed tools (cannot be blocked) ─────────────────────────────────

const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"glob",
	"subagent",
]);

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve tool allowlist from config and env.
 *
 * Env var `AGENT_ALLOWED_TOOLS` takes precedence over config.
 * JSON array format: `["read","write","bash"]`
 *
 * Permissive: if neither config nor env specifies tools, ALL tools are allowed.
 */
/**
 * Resolve tool allowlist from config and env.
 * Env `AGENT_ALLOWED_TOOLS` (JSON array) takes precedence over config.
 * Returns `{ active: false }` (permissive) if neither specifies tools.
 */
export function resolveToolAllowlist(
	config?: ToolAllowlistConfig,
	env?: NodeJS.ProcessEnv,
): ResolvedToolAllowlist {
	// Check env first
	const envJson = env?.AGENT_ALLOWED_TOOLS;
	if (envJson) {
		try {
			const parsed = JSON.parse(envJson);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return { active: true, tools: new Set(parsed as string[]) };
			}
		} catch {
			// Invalid JSON — ignore, fall through
		}
	}

	// Then config
	if (config?.allowedTools && config.allowedTools.length > 0) {
		return { active: true, tools: new Set(config.allowedTools) };
	}

	// Permissive default — no restrictions
	return { active: false, tools: new Set() };
}

// ── Check ────────────────────────────────────────────────────────────────────

/**
 * Check if a tool is allowed.
 *
 * Always-allowed tools (read, grep, find, ls, glob, subagent) pass through
 * regardless of the allowlist.
 *
 * If the allowlist is not active (permissive default), everything is allowed.
 */
/**
 * Check if a tool is allowed by the allowlist.
 * Always-allowed tools (read, grep, find, ls, glob, subagent) pass regardless.
 * When allowlist is inactive (permissive), everything is allowed.
 * @returns `{ allowed: true }` or `{ allowed: false, reason }` with human-readable block message.
 */
export function isToolAllowed(
	toolName: string,
	allowlist: ResolvedToolAllowlist,
): { allowed: true } | { allowed: false; reason: string } {
	// Always-allowed tools bypass the check
	if (ALWAYS_ALLOWED.has(toolName)) {
		return { allowed: true };
	}

	// Permissive default — no restrictions active
	if (!allowlist.active) {
		return { allowed: true };
	}

	// Check the explicit allowlist
	if (allowlist.tools.has(toolName)) {
		return { allowed: true };
	}

	return {
		allowed: false,
		reason: `Tool '${toolName}' not in allowlist. Permitted tools: ${[...allowlist.tools].join(", ")}`,
	};
}

/**
 * Get the list of always-allowed tools (for documentation/debugging).
 */
export function getAlwaysAllowedTools(): ReadonlySet<string> {
	return ALWAYS_ALLOWED;
}
