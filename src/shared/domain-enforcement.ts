/**
 * Domain Enforcement — per-agent file path restrictions.
 *
 * Ported from pi_launchpad's domain-enforcer.ts and modules/domain.ts.
 *
 * When a subagent is spawned with `domainRules` in its config, the parent
 * injects `AGENT_DOMAIN_RULES` (and optionally `AGENT_EXPERTISE`,
 * `AGENT_ALLOWED_TOOLS`) into the child's environment. This module provides:
 *
 *   1. Types for domain rules and expertise entries
 *   2. `isDomainAllowed()` — check if a path is permitted
 *   3. `checkExpertise()` — exact file overrides
 *   4. `buildDomainBlock()` — generate a markdown description for system prompts
 *   5. Bash heuristic patterns for write/delete detection
 *   6. `buildDomainEnv()` — serialize rules into env vars for child spawn
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DomainRule {
	/** Directory or file path relative to project root. "." = project root. */
	path: string;
	/** Allow read operations (read, grep, find, ls, glob). */
	read: boolean;
	/** Allow write/edit operations. */
	upsert: boolean;
	/** Allow delete operations. */
	delete: boolean;
}

export interface ExpertiseEntry {
	/** Absolute path to a specific file this agent has expertise in. */
	absPath: string;
	/** Whether the agent can write to this file. */
	updatable: boolean;
	/** Optional max line count for the file. */
	maxLines?: number;
}

export interface ToolAllowlistConfig {
	/**
	 * List of tool names the agent is allowed to use.
	 * Empty array = all tools allowed (permissive default).
	 * This is the "block list" approach — anything NOT listed is denied.
	 */
	allowedTools?: string[];
}

// ── Bash Heuristic Patterns ─────────────────────────────────────────────────

/** Patterns that indicate a bash command performs write/create operations */
export const BASH_WRITE_PATTERNS: RegExp[] = [
	/>(?!&)/,                                                      // Output redirect (> or >>) but not 2>&1
	/\btee\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\btouch\b/,
	/\bchmod\b/, /\bchown\b/,
	/\bnpm\s+install/, /\bbun\s+(install|add)/,
	/\bgit\s+(commit|push|merge|rebase|reset|checkout\s+-)/,
	/\bsed\s+-i/, /\bpatch\b/,
	/\bdd\b.*\bof=/, /\bcurl\b.*\s-o\s/i, /\bwget\b.*\s-O\s/,
];

/** Patterns that indicate a bash command performs delete operations */
export const BASH_DELETE_PATTERNS: RegExp[] = [
	/\brm\s/, /\brmdir\b/, /\bunlink\b/, /\bgit\s+clean/,
];

// ── Path Normalization ──────────────────────────────────────────────────────

/**
 * Normalize a file path to a relative path from project root.
 */
export function normalizePath(filePath: string, projectRoot: string): string {
	let rel = filePath;
	if (rel.startsWith(projectRoot)) {
		rel = rel.slice(projectRoot.length).replace(/^\//, "");
	}
	if (rel.startsWith("./")) rel = rel.slice(2);
	return rel || ".";
}

// ── Expertise Check ─────────────────────────────────────────────────────────

/**
 * Check expertise first — exact file match overrides domain.
 * Returns true (allow), false (deny), or null (no match, fall through to domain).
 */
export function checkExpertise(
	filePath: string,
	operation: "read" | "upsert",
	expertise: ExpertiseEntry[],
	projectRoot: string,
): boolean | null {
	if (!expertise || expertise.length === 0) return null;
	const abs = filePath.startsWith("/")
		? filePath
		: projectRoot + "/" + normalizePath(filePath, projectRoot);
	for (const exp of expertise) {
		if (abs === exp.absPath) {
			if (operation === "read") return true;
			if (operation === "upsert") return exp.updatable;
		}
	}
	return null;
}

// ── Domain Check ────────────────────────────────────────────────────────────

/**
 * Check if a file path is allowed under domain rules for a given operation.
 *
 * Evaluation order (first match wins):
 *   1. Expertise file paths — exact file match overrides domain
 *   2. Domain rules — directory-level access control
 *   3. No matching rule = deny
 *
 * Empty/undefined domain = all access allowed (permissive default).
 */
export function isDomainAllowed(
	filePath: string,
	operation: "read" | "upsert" | "delete",
	domain: DomainRule[],
	projectRoot: string,
	expertise?: ExpertiseEntry[],
): boolean {
	// No rules = permissive (all access)
	if (!domain || domain.length === 0) return true;

	// 1. Check expertise override (read/upsert only)
	if (operation !== "delete" && expertise && expertise.length > 0) {
		const expResult = checkExpertise(filePath, operation, expertise, projectRoot);
		if (expResult !== null) return expResult;
	}

	// 2. Domain rules
	const rel = normalizePath(filePath, projectRoot);
	for (const rule of domain) {
		if (rule.path === ".") return rule[operation] === true;
		const rulePath = rule.path.replace(/\/$/, "");
		if (rel === rulePath || rel.startsWith(rulePath + "/") || rel.startsWith(rule.path)) {
			return rule[operation] === true;
		}
	}
	return false; // No matching rule = deny
}

// ── Tool Allowlist Check ────────────────────────────────────────────────────

/**
 * Check if a tool is allowed by the allowlist.
 * Permissive: if allowlist is empty/undefined, ALL tools are allowed.
 */
export function isToolAllowed(toolName: string, allowedTools?: string[]): boolean {
	if (!allowedTools || allowedTools.length === 0) return true;
	return allowedTools.includes(toolName);
}

// ── Domain Block Builder (for system prompts) ──────────────────────────────

/**
 * Build a domain restrictions block for injection into system prompts.
 */
export function buildDomainBlock(domain: DomainRule[], projectRoot: string): string {
	if (!domain || domain.length === 0) return "";

	const lines: string[] = [
		"**You are restricted to the following areas of the codebase.** Do NOT access files outside these paths.\n",
	];

	for (const rule of domain) {
		const perms: string[] = [];
		if (rule.read) perms.push("read");
		if (rule.upsert) perms.push("write/edit");
		if (rule.delete) perms.push("delete");
		const permStr = perms.length > 0 ? perms.join(", ") : "no access";
		const absPath = rule.path === "." ? projectRoot : projectRoot + "/" + rule.path;
		lines.push(`- \`${absPath}\` — ${permStr}`);
	}

	lines.push("\nIf a file is not under one of these paths, do not read, write, or reference it.");
	return lines.join("\n");
}

// ── Aggregate Permission Check ─────────────────────────────────────────────

/**
 * Pre-compute aggregate permissions from domain rules + expertise.
 * Useful for bash heuristic checks.
 */
export function aggregatePermissions(
	domain: DomainRule[],
	expertise?: ExpertiseEntry[],
): { anyUpsert: boolean; anyDelete: boolean } {
	const anyUpsert = domain.some(r => r.upsert) || (expertise?.some(e => e.updatable) ?? false);
	const anyDelete = domain.some(r => r.delete);
	return { anyUpsert, anyDelete };
}

// ── Env Serialization ───────────────────────────────────────────────────────

/**
 * Build env vars for domain enforcement in child processes.
 * Returns an object to merge into spawn env.
 */
export function buildDomainEnv(
	domain: DomainRule[],
	expertise: ExpertiseEntry[],
	allowedTools: string[],
	projectRoot: string,
): Record<string, string> {
	const env: Record<string, string> = {
		AGENT_PROJECT_ROOT: projectRoot,
	};
	if (domain.length > 0) {
		env.AGENT_DOMAIN_RULES = JSON.stringify(domain);
	}
	if (expertise.length > 0) {
		env.AGENT_EXPERTISE = JSON.stringify(expertise);
	}
	if (allowedTools.length > 0) {
		env.AGENT_ALLOWED_TOOLS = JSON.stringify(allowedTools);
	}
	return env;
}
