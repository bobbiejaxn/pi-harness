/**
 * Child Domain Guard — structural enforcement of domain restrictions inside child processes.
 *
 * This extension is loaded into every spawned subagent via `-e child-domain-guard.ts`
 * **only when domain rules are configured** (i.e. when `AGENT_DOMAIN_RULES` is set).
 *
 * It reads three env vars injected by the parent:
 * - `AGENT_DOMAIN_RULES` — JSON array of `{ path, read, upsert, delete }` rules
 * - `AGENT_EXPERTISE` — JSON array of `{ absPath, updatable, maxLines }` overrides
 * - `AGENT_ALLOWED_TOOLS` — JSON array of allowed tool names (empty = all allowed)
 *
 * ## How it works
 *
 * Hooks into `pi.on("tool_call")` and blocks any tool call that violates the rules:
 * - Read tools (read, grep, find, ls, glob): blocked if path outside allowed domains
 * - Write tools (write, edit): blocked if path not upsert-allowed
 * - Bash: heuristic analysis for write/delete patterns
 *
 * Also hooks `pi.on("tool_result")` to enforce line limits on expertise files.
 *
 * ## Evaluation order (first match wins)
 *
 * 1. **Tool allowlist** — if `AGENT_ALLOWED_TOOLS` is set and tool is not in it → block
 * 2. **Expertise override** — exact file match overrides domain rules
 * 3. **Domain rules** — directory-level access control
 * 4. **No matching rule** → deny (closed-door policy)
 *
 * ## Exit behavior
 *
 * If no env vars are set, this extension is a no-op — it returns immediately from
 * the factory function without registering any hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

interface DomainRule {
	path: string;
	read: boolean;
	upsert: boolean;
	delete: boolean;
}

interface ExpertiseEntry {
	absPath: string;
	updatable: boolean;
	maxLines?: number;
}

// ── Bash heuristic patterns ─────────────────────────────────────────────────

const BASH_WRITE_PATTERNS = [
	/>(?!&)/,
	/\btee\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\btouch\b/,
	/\bchmod\b/, /\bchown\b/,
	/\bnpm\s+install/, /\bbun\s+(install|add)/,
	/\bgit\s+(commit|push|merge|rebase|reset|checkout\s+-)/,
	/\bsed\s+-i/, /\bpatch\b/,
	/\bdd\b.*\bof=/, /\bcurl\b.*\s-o\s/i, /\bwget\b.*\s-O\s/,
];

const BASH_DELETE_PATTERNS = [
	/\brm\s/, /\brmdir\b/, /\bunlink\b/, /\bgit\s+clean/,
];

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const rulesJson = process.env.AGENT_DOMAIN_RULES;
	if (!rulesJson) return; // No rules = no enforcement

	let rules: DomainRule[];
	try { rules = JSON.parse(rulesJson); } catch { return; }
	if (!rules || !Array.isArray(rules) || rules.length === 0) return;

	const projectRoot = process.env.AGENT_PROJECT_ROOT || process.cwd();

	// Parse expertise entries
	let expertise: ExpertiseEntry[] = [];
	const expJson = process.env.AGENT_EXPERTISE;
	if (expJson) { try { expertise = JSON.parse(expJson); } catch {} }

	// Parse allowed tools (empty = all allowed for backward compat)
	let allowedTools: string[] = [];
	const toolsJson = process.env.AGENT_ALLOWED_TOOLS;
	if (toolsJson) { try { allowedTools = JSON.parse(toolsJson); } catch {} }

	// ── Helpers ──────────────────────────────────────────────────────────

	function normalize(filePath: string): string {
		let rel = filePath;
		if (rel.startsWith(projectRoot)) {
			rel = rel.slice(projectRoot.length).replace(/^\//, "");
		}
		if (rel.startsWith("./")) rel = rel.slice(2);
		return rel || ".";
	}

	function checkExpertise(filePath: string, operation: "read" | "upsert"): boolean | null {
		if (expertise.length === 0) return null;
		const abs = filePath.startsWith("/") ? filePath : (projectRoot + "/" + normalize(filePath));
		for (const exp of expertise) {
			if (abs === exp.absPath) {
				if (operation === "read") return true;
				if (operation === "upsert") return exp.updatable;
			}
		}
		return null;
	}

	function isAllowed(filePath: string, operation: "read" | "upsert" | "delete"): boolean {
		if (operation !== "delete") {
			const expResult = checkExpertise(filePath, operation);
			if (expResult !== null) return expResult;
		}

		const rel = normalize(filePath);
		for (const rule of rules) {
			if (rule.path === ".") return rule[operation] === true;
			const rulePath = rule.path.replace(/\/$/, "");
			if (rel === rulePath || rel.startsWith(rulePath + "/") || rel.startsWith(rule.path)) {
				return rule[operation] === true;
			}
		}
		return false;
	}

	// Pre-compute aggregate permissions for bash heuristics
	const anyUpsert = rules.some(r => r.upsert) || expertise.some(e => e.updatable);
	const anyDelete = rules.some(r => r.delete);

	// ── tool_call hook ──────────────────────────────────────────────────

	pi.on("tool_call", async (event) => {
		const toolName = event.toolName;
		const input = event.input as Record<string, any>;

		// Tool allowlist — block anything not listed
		if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
			return { block: true, reason: `Tool not allowed: '${toolName}'. Permitted: ${allowedTools.join(", ")}` };
		}

		// Read-only tools
		if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls" || toolName === "glob") {
			const path = input.path || input.file_path || ".";
			if (!isAllowed(path, "read")) {
				return { block: true, reason: `Domain: read denied for '${normalize(path)}'` };
			}
			return undefined;
		}

		// Write tools
		if (toolName === "write" || toolName === "edit") {
			const path = input.path || input.file_path || "";
			if (!path) return undefined;
			if (!isAllowed(path, "upsert")) {
				return { block: true, reason: `Domain: write denied for '${normalize(path)}'` };
			}
			return undefined;
		}

		// Bash — heuristic analysis
		if (toolName === "bash") {
			const command = (input.command || "") as string;

			if (!anyDelete && BASH_DELETE_PATTERNS.some(p => p.test(command))) {
				return { block: true, reason: `Domain: delete operations not permitted — ${command.slice(0, 80)}` };
			}

			if (!anyUpsert && BASH_WRITE_PATTERNS.some(p => p.test(command))) {
				return { block: true, reason: `Domain: write operations not permitted — ${command.slice(0, 80)}` };
			}

			return undefined;
		}

		return undefined;
	});

	// ── Line limit enforcement (post-write) ─────────────────────────────

	pi.on("tool_result", async (event) => {
		const toolName = event.toolName;
		if (toolName !== "write" && toolName !== "edit") return undefined;

		const input = event.input as Record<string, any>;
		const path = input.path || input.file_path || "";
		if (!path) return undefined;

		const abs = path.startsWith("/") ? path : (projectRoot + "/" + normalize(path));
		const match = expertise.find(e => e.absPath === abs);
		if (!match || !match.maxLines) return undefined;

		try {
			const { readFileSync } = require("node:fs");
			const content = readFileSync(abs, "utf-8");
			const lineCount = content.split("\n").length;
			if (lineCount > match.maxLines) {
				const warning = `\n\n⚠️ EXPERTISE LINE LIMIT EXCEEDED: ${lineCount}/${match.maxLines} lines. Trim this file immediately before continuing.`;
				const currentResult = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
				return { result: currentResult + warning };
			}
		} catch {}

		return undefined;
	});
}
