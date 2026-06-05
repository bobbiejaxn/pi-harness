/**
 * Tiered conflict resolution for merging worktree branches.
 *
 * Ported from ivi's merge-resolver.ts and Overstory's 4-tier strategy,
 * adapted for pi-harness. Works with the existing worktree.ts module.
 *
 * ## Resolution tiers (attempted in order)
 *
 * | Tier | Name | Strategy | When enabled |
 * |------|------|----------|-------------|
 * | 1 | Clean merge | `git merge --no-edit` | Always |
 * | 2 | Auto-resolve | Parse conflict markers, keep incoming (agent) | Always |
 * | 3 | AI-resolve | Spawn LLM subprocess to resolve conflicts | Opt-in |
 * | 4 | Re-imagine | Abort, reimplement changes from scratch via LLM | Opt-in |
 *
 * Tiers 3 and 4 are disabled by default. Enable via `MergeResolverOptions`.
 *
 * ## Usage
 *
 * ```ts
 * import { resolveMerge } from "./merge-resolver.ts";
 *
 * const result = await resolveMerge(repoRoot, branchName, "main", modifiedFiles, {
 *   aiResolveEnabled: true,
 *   aiModel: "zai/glm-5",  // override, defaults to PI_MODEL env var
 * });
 *
 * if (result.success) {
 *   console.log(`Merged via ${result.tier}`);
 * } else {
 *   console.error(`Failed at ${result.tier}: ${result.errorMessage}`);
 *   // result.conflictFiles contains unresolvable paths
 * }
 * ```
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

/** The resolution tier that succeeded (or was last attempted). */
export type ResolutionTier = "clean-merge" | "auto-resolve" | "ai-resolve" | "reimagine";

/** Result of a merge resolution attempt. */
export interface MergeResolutionResult {
	/** Whether the merge succeeded. */
	success: boolean;
	/** The highest tier attempted. */
	tier: ResolutionTier;
	/** Files that still have conflicts (empty if success). */
	conflictFiles: string[];
	/** Non-fatal warnings collected during resolution. */
	warnings: string[];
	/** Error message if the merge failed. null if success. */
	errorMessage: string | null;
}

/** Configuration for the merge resolver. */
export interface MergeResolverOptions {
	/** Enable tier 3 (AI-assisted resolution). Default: false. */
	aiResolveEnabled?: boolean;
	/** Enable tier 4 (full reimagine). Default: false. */
	reimagineEnabled?: boolean;
	/** Model to use for AI resolve. Default: uses parent session model, falls back to "zai/glm-5". */
	aiModel?: string;
	/** Directory prefixes to auto-commit before merging. Default: [".pi/"]. */
	statePrefixes?: string[];
	/** Maximum time in ms for AI resolution per file. Default: 60000. */
	aiTimeoutMs?: number;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function runGit(repoRoot: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execSync(`git ${args.join(" ")}`, {
			cwd: repoRoot,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout: stdout ?? "", stderr: "", exitCode: 0 };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exitCode: err.status ?? 1,
		};
	}
}

// ── Conflict parsing helpers ─────────────────────────────────────────────────

/**
 * Parse conflict markers and keep only the incoming (agent) side.
 * Returns resolved content, or null if no conflict markers found.
 *
 * @param content - File content with potential conflict markers
 * @returns Resolved content with only incoming changes, or null
 */
export function resolveConflictsKeepIncoming(content: string): string | null {
	const conflictPattern = /^<{7} .+\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} .+\n?/gm;
	if (!conflictPattern.test(content)) return null;
	conflictPattern.lastIndex = 0;
	return content.replace(conflictPattern, (_match, _canonical: string, incoming: string) => incoming);
}

/**
 * Parse conflict markers and keep ALL lines from both sides (union merge).
 * Useful when both sides add different lines to the same section.
 *
 * @param content - File content with potential conflict markers
 * @returns Resolved content with both sides merged, or null
 */
export function resolveConflictsUnion(content: string): string | null {
	const conflictPattern = /^<{7} .+\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} .+\n?/gm;
	if (!conflictPattern.test(content)) return null;
	conflictPattern.lastIndex = 0;
	return content.replace(conflictPattern, (_match, canonical: string, incoming: string) => canonical + incoming);
}

/**
 * Check if any conflict block has non-whitespace content on the canonical (HEAD) side.
 * Used to prevent silent data loss during auto-resolve — if the canonical side has
 * real content, blindly keeping incoming would discard it.
 *
 * @param content - File content with potential conflict markers
 * @returns true if any canonical side has non-whitespace content
 */
export function hasContentfulCanonical(content: string): boolean {
	const conflictPattern = /^<{7} .+\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} .+\n?/gm;
	let match = conflictPattern.exec(content);
	while (match !== null) {
		const canonical = match[1] ?? "";
		if (canonical.trim().length > 0) return true;
		match = conflictPattern.exec(content);
	}
	return false;
}

/**
 * Check if text looks like conversational prose rather than code.
 * Prevents LLM prose responses from being written as file content.
 *
 * Detects common AI response patterns like "I think...", "Here's the...",
 * markdown fencing, and refusal patterns.
 *
 * @param text - Text to check
 * @returns true if the text looks like prose/conversation, not code
 */
export function looksLikeProse(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	const prosePatterns = [
		/^(I |I'[a-z]+ |Here |Here's |The |This |Let me |Sure|Unfortunately|Apologies|Sorry)/i,
		/^(To resolve|Looking at|Based on|After reviewing|The conflict)/i,
		/^```/m,
		/I need permission/i,
		/I cannot/i,
		/I don't have/i,
	];
	return prosePatterns.some((p) => p.test(trimmed));
}

// ── Internal tier implementations ────────────────────────────────────────────

async function getConflictedFiles(repoRoot: string): Promise<string[]> {
	const { stdout } = runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
	return stdout.trim().split("\n").filter((l) => l.length > 0);
}

/** Tier 1: Attempt a clean git merge. */
async function tryCleanMerge(
	repoRoot: string,
	branchName: string,
): Promise<{ success: boolean; conflictFiles: string[] }> {
	const { exitCode } = runGit(repoRoot, ["merge", "--no-edit", branchName]);
	if (exitCode === 0) return { success: true, conflictFiles: [] };
	const conflictFiles = await getConflictedFiles(repoRoot);
	return { success: false, conflictFiles };
}

/** Tier 2: Auto-resolve by keeping incoming changes for non-critical conflicts. */
async function tryAutoResolve(
	conflictFiles: string[],
	repoRoot: string,
): Promise<{ success: boolean; remainingConflicts: string[]; warnings: string[] }> {
	const remainingConflicts: string[] = [];
	const warnings: string[] = [];

	for (const file of conflictFiles) {
		const filePath = path.join(repoRoot, file);
		try {
			const content = fs.readFileSync(filePath, "utf-8");

			// Skip if canonical side has real content (prevent data loss)
			if (hasContentfulCanonical(content)) {
				warnings.push(`auto-resolve skipped for ${file}: canonical side has content`);
				remainingConflicts.push(file);
				continue;
			}

			const resolved = resolveConflictsKeepIncoming(content);
			if (resolved === null) {
				remainingConflicts.push(file);
				continue;
			}

			fs.writeFileSync(filePath, resolved, "utf-8");
			const { exitCode } = runGit(repoRoot, ["add", file]);
			if (exitCode !== 0) remainingConflicts.push(file);
		} catch {
			remainingConflicts.push(file);
		}
	}

	if (remainingConflicts.length > 0) {
		return { success: false, remainingConflicts, warnings };
	}

	const { exitCode } = runGit(repoRoot, ["commit", "--no-edit"]);
	return { success: exitCode === 0, remainingConflicts, warnings };
}

/** Tier 3: AI-assisted resolution using pi subprocess. */
async function tryAiResolve(
	conflictFiles: string[],
	repoRoot: string,
	model: string,
	timeoutMs: number,
): Promise<{ success: boolean; remainingConflicts: string[] }> {
	const remainingConflicts: string[] = [];

	for (const file of conflictFiles) {
		const filePath = path.join(repoRoot, file);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const prompt = [
				"You are a merge conflict resolver. Output ONLY the resolved file content.",
				"Rules: NO explanation, NO markdown fencing, NO conversation, NO preamble.",
				"Output the raw file content as it should appear on disk.",
				"Choose the best combination of both sides of this conflict:",
				"\n\n",
				content,
			].join(" ");

			const resolved = await spawnPiForResolve(prompt, repoRoot, model, timeoutMs);
			if (!resolved || looksLikeProse(resolved)) {
				remainingConflicts.push(file);
				continue;
			}

			fs.writeFileSync(filePath, resolved, "utf-8");
			const { exitCode } = runGit(repoRoot, ["add", file]);
			if (exitCode !== 0) remainingConflicts.push(file);
		} catch {
			remainingConflicts.push(file);
		}
	}

	if (remainingConflicts.length > 0) return { success: false, remainingConflicts };

	const { exitCode } = runGit(repoRoot, ["commit", "--no-edit"]);
	return { success: exitCode === 0, remainingConflicts };
}

/** Tier 4: Abort merge and reimplement changes from scratch via LLM. */
async function tryReimagine(
	repoRoot: string,
	branchName: string,
	canonicalBranch: string,
	filesModified: string[],
	model: string,
	timeoutMs: number,
): Promise<{ success: boolean }> {
	runGit(repoRoot, ["merge", "--abort"]);

	for (const file of filesModified) {
		try {
			const { stdout: canonicalContent, exitCode: c1 } = runGit(repoRoot, ["show", `${canonicalBranch}:${file}`]);
			const { stdout: branchContent, exitCode: c2 } = runGit(repoRoot, ["show", `${branchName}:${file}`]);
			if (c1 !== 0 || c2 !== 0) return { success: false };

			const prompt = [
				"You are a merge conflict resolver. Output ONLY the final file content.",
				"Rules: NO explanation, NO markdown fencing, NO conversation, NO preamble.",
				"Reimplement the changes from the branch version onto the canonical version.",
				`\n\n=== CANONICAL VERSION (${canonicalBranch}) ===\n`,
				canonicalContent,
				`\n\n=== BRANCH VERSION (${branchName}) ===\n`,
				branchContent,
			].join("");

			const reimagined = await spawnPiForResolve(prompt, repoRoot, model, timeoutMs);
			if (!reimagined || looksLikeProse(reimagined)) return { success: false };

			const filePath = path.join(repoRoot, file);
			fs.writeFileSync(filePath, reimagined, "utf-8");
			const { exitCode } = runGit(repoRoot, ["add", file]);
			if (exitCode !== 0) return { success: false };
		} catch {
			return { success: false };
		}
	}

	const { exitCode } = runGit(repoRoot, ["commit", "-m", `Reimagine merge: ${branchName} onto ${canonicalBranch}`]);
	return { success: exitCode === 0 };
}

/**
 * Spawn a pi subprocess for AI conflict resolution.
 * Extracts the last assistant text message from JSON mode output.
 */
async function spawnPiForResolve(
	prompt: string,
	cwd: string,
	model: string,
	timeoutMs: number,
): Promise<string | null> {
	const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
		const proc = spawn("pi", ["--mode", "json", "-p", "--no-session", "--model", model, prompt], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve({ stdout: "", exitCode: 1 });
		}, timeoutMs);

		let stdout = "";
		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, exitCode: code ?? 1 });
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve({ stdout: "", exitCode: 1 });
		});
	});

	if (result.exitCode !== 0 || result.stdout.trim() === "") return null;

	// Extract last assistant message from JSON mode output
	const lines = result.stdout.split("\n").filter((l) => l.trim());
	const messages = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const lastAssistant = messages
		.filter((m: Record<string, unknown>) => m.type === "message_end" && (m.message as Record<string, unknown>)?.role === "assistant")
		.pop();

	if (!lastAssistant) return result.stdout;

	const text = lastAssistant.message?.content
		?.filter((p: { type: string }) => p.type === "text")
		?.map((p: { text?: string }) => p.text ?? "")
		?.join("\n") ?? null;

	return text;
}

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve a worktree merge with tiered conflict resolution.
 *
 * Attempts each tier in order. If a tier succeeds, returns immediately.
 * If a tier fails, the next tier is tried. If all tiers fail, the merge
 * is aborted and the branch is preserved for manual resolution.
 *
 * @param repoRoot - Absolute path to the git repository
 * @param branchName - The worktree branch to merge into canonical
 * @param canonicalBranch - The target branch (usually "main")
 * @param filesModified - Files modified by the worktree branch
 * @param options - Tier configuration (tiers 3-4 are opt-in)
 * @returns Resolution result with success status, tier used, and any remaining conflicts
 */
export async function resolveMerge(
	repoRoot: string,
	branchName: string,
	canonicalBranch: string,
	filesModified: string[],
	options: MergeResolverOptions = {},
): Promise<MergeResolutionResult> {
	const {
		aiResolveEnabled = false,
		reimagineEnabled = false,
		aiModel = process.env.PI_MODEL ?? "zai/glm-5",
		statePrefixes = [".pi/"],
		aiTimeoutMs = 60_000,
	} = options;

	const warnings: string[] = [];
	let lastTier: ResolutionTier = "clean-merge";
	let conflictFiles: string[] = [];

	// Auto-stage state files before merging (e.g., .pi/ session data)
	if (statePrefixes.length > 0) {
		const { stdout: statusOut } = runGit(repoRoot, ["status", "--porcelain"]);
		for (const line of statusOut.split("\n").filter(Boolean)) {
			const filePath = line.slice(3);
			if (statePrefixes.some((p) => filePath.startsWith(p))) {
				runGit(repoRoot, ["add", filePath]);
			}
		}
	}

	// Checkout canonical branch
	const { stdout: currentRef } = runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
	if (currentRef.trim() !== canonicalBranch) {
		const { exitCode, stderr } = runGit(repoRoot, ["checkout", canonicalBranch]);
		if (exitCode !== 0) {
			return {
				success: false,
				tier: "clean-merge",
				conflictFiles: [],
				warnings: [],
				errorMessage: `Failed to checkout ${canonicalBranch}: ${stderr.trim()}`,
			};
		}
	}

	// Auto-stash dirty files
	let didStash = false;
	const { stdout: dirtyOut } = runGit(repoRoot, ["status", "--porcelain"]);
	if (dirtyOut.trim().length > 0) {
		const { exitCode } = runGit(repoRoot, ["stash", "push", "-m", "merge-resolver: auto-stash"]);
		if (exitCode === 0) didStash = true;
	}

	try {
		// Tier 1: Clean merge
		const cleanResult = await tryCleanMerge(repoRoot, branchName);
		if (cleanResult.success) {
			return { success: true, tier: "clean-merge", conflictFiles: [], warnings, errorMessage: null };
		}
		conflictFiles = cleanResult.conflictFiles;
		warnings.push(`Clean merge produced ${conflictFiles.length} conflict(s)`);

		// Tier 2: Auto-resolve
		lastTier = "auto-resolve";
		const autoResult = await tryAutoResolve(conflictFiles, repoRoot);
		warnings.push(...autoResult.warnings);
		if (autoResult.success) {
			return { success: true, tier: "auto-resolve", conflictFiles, warnings, errorMessage: null };
		}
		conflictFiles = autoResult.remainingConflicts;

		// Tier 3: AI-resolve (opt-in)
		if (aiResolveEnabled) {
			lastTier = "ai-resolve";
			const aiResult = await tryAiResolve(conflictFiles, repoRoot, aiModel, aiTimeoutMs);
			if (aiResult.success) {
				return { success: true, tier: "ai-resolve", conflictFiles, warnings, errorMessage: null };
			}
			conflictFiles = aiResult.remainingConflicts;
		}

		// Tier 4: Re-imagine (opt-in)
		if (reimagineEnabled) {
			lastTier = "reimagine";
			const reimagineResult = await tryReimagine(repoRoot, branchName, canonicalBranch, filesModified, aiModel, aiTimeoutMs);
			if (reimagineResult.success) {
				return { success: true, tier: "reimagine", conflictFiles: [], warnings, errorMessage: null };
			}
		}

		// All tiers failed — abort and preserve
		try { runGit(repoRoot, ["merge", "--abort"]); } catch { /* ignore */ }

		return {
			success: false,
			tier: lastTier,
			conflictFiles,
			warnings,
			errorMessage: `All enabled resolution tiers failed (last attempted: ${lastTier}). ${conflictFiles.length} file(s) with unresolved conflicts.`,
		};
	} finally {
		if (didStash) {
			try { runGit(repoRoot, ["stash", "pop"]); } catch { /* best effort */ }
		}
	}
}
