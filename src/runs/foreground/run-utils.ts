// Pure helper functions for the subagent foreground executor.
//
// Extracted from subagent-executor.ts to reduce file size and isolate the
// smallest unit of testable logic. These have minimal external dependencies
// (just `path` and `fs` from node) and no internal subagent state.

import * as fs from "node:fs";
import * as path from "node:path";
import type { NestedRunSummary } from "../background/run-id-resolver.ts";

/** True if the error indicates the async run does not exist. */
export function isAsyncRunNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Async run not found.");
}

/** True if the error indicates an ambiguous run id prefix (multiple matches). */
export function isResumeAmbiguity(error: unknown): boolean {
	return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

/** True if the target's runId exactly matches the requested id. */
export function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
	return target?.runId === requested;
}

/** Escape a string for safe inclusion in a RegExp. */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if the error indicates the requested run id was an exact match for the given source. */
export function isExactResumeError(error: unknown, source: "async" | "foreground", requested: string): boolean {
	if (!(error instanceof Error) || !requested) return false;
	return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

/** Best-effort lookup of a session file path for a nested run summary. */
export function nestedRunSessionFile(run: NestedRunSummary): string | undefined {
	return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}

/** Best-effort lookup of the agent name for a nested run summary. */
export function nestedRunAgent(run: NestedRunSummary): string | undefined {
	return run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
}

/** True if `candidate` resolves to a path inside `base`. */
export function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

/**
 * Validates a nested run's session file: must be absolute, must exist, must
 * be a regular file (not a symlink), must be inside one of the trusted
 * session roots, and must be inside a directory containing the run's id.
 *
 * Throws an Error with a descriptive message on any validation failure.
 * Returns the realpath of the session file on success.
 */
export function validateNestedSessionFile(run: NestedRunSummary, trustedSessionRoots: string[]): string {
	const sessionFile = nestedRunSessionFile(run);
	if (!sessionFile) throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!path.isAbsolute(sessionFile)) throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
	if (!fs.existsSync(resolved)) throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
	const realSessionFile = fs.realpathSync(resolved);
	const trustedRoots = trustedSessionRoots
		.filter((root) => fs.existsSync(root))
		.map((root) => fs.realpathSync(root));
	if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
		throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
	}
	if (!realSessionFile.split(path.sep).includes(run.id)) {
		throw new Error(`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`);
	}
	return realSessionFile;
}
