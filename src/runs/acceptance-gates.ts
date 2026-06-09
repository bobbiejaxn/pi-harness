// Acceptance gates — verifies project health after a /ship or feature delivery.
//
// A "gate" is a deterministic check that returns PASS or FAIL with a
// reason. Gates are run after implementation to confirm the work
// integrates cleanly before declaring success.
//
// The 4 standard gates:
//   1. typecheck  — TypeScript / language-level type checking
//   2. lint       — code style and rule compliance
//   3. test       — unit + integration tests
//   4. build      — production build (catches bundler errors)
//
// The exact commands are project-specific. This module provides:
// - The Gate interface and GateResult type
// - A default implementation that runs npm/pnpm scripts via child_process
// - A function to run all gates in sequence and aggregate the result

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/** Result of running a single gate. */
export interface GateResult {
	gate: string;
	passed: boolean;
	durationMs: number;
	stdout?: string;
	stderr?: string;
	/** Human-readable failure reason (set when passed=false). */
	reason?: string;
}

/** Definition of a gate. */
export interface Gate {
	/** Name shown in output. */
	name: string;
	/** Shell command to run (executed via execFile, not shell). */
	command: string;
	/** Arguments to pass to execFile. */
	args: string[];
	/** Working directory. */
	cwd: string;
	/** Whether the gate is required. If false, failure is reported but
	 *  overall run still passes. */
	required?: boolean;
	/** Maximum runtime in ms. 0 = no limit. Default 120_000. */
	timeoutMs?: number;
}

/** Aggregated result of running all gates. */
export interface GatesRunResult {
	allPassed: boolean;
	totalDurationMs: number;
	results: GateResult[];
	/** Number of required gates that failed. */
	requiredFailures: number;
}

/**
 * Run a single gate. Returns a GateResult. Failures are caught and
 * returned as a `passed: false` result rather than throwing.
 */
export async function runGate(gate: Gate): Promise<GateResult> {
	const start = Date.now();
	const timeoutMs = gate.timeoutMs ?? 120_000;
	try {
		const { stdout, stderr } = await execFileAsync(gate.command, gate.args, {
			cwd: gate.cwd,
			timeout: timeoutMs,
			maxBuffer: 10 * 1024 * 1024, // 10 MB
			// intentionally NOT using shell: true; args are passed directly
		});
		return {
			gate: gate.name,
			passed: true,
			durationMs: Date.now() - start,
			stdout: truncate(stdout, 5000),
			stderr: truncate(stderr, 5000),
		};
	} catch (err: unknown) {
		const e = err as { code?: string; stdout?: string; stderr?: string; message?: string; killed?: boolean };
		const isTimeout = e.code === "ETIMEDOUT" || e.killed;
		return {
			gate: gate.name,
			passed: false,
			durationMs: Date.now() - start,
			stdout: truncate(e.stdout ?? "", 5000),
			stderr: truncate(e.stderr ?? e.message ?? "", 5000),
			reason: isTimeout
				? `Timeout after ${timeoutMs}ms`
				: `Exit ${e.code ?? "non-zero"}: ${e.message ?? "command failed"}`,
		};
	}
}

/**
 * Run a list of gates in sequence. Stops on the first failure of a
 * required gate (fail-fast). Optional gates always run.
 */
export async function runGates(gates: Gate[], opts: { failFast?: boolean } = {}): Promise<GatesRunResult> {
	const failFast = opts.failFast ?? true;
	const start = Date.now();
	const results: GateResult[] = [];
	let requiredFailures = 0;

	for (const gate of gates) {
		const result = await runGate(gate);
		results.push(result);
		if (!result.passed) {
			if (gate.required !== false) requiredFailures++;
			if (failFast) break;
		}
	}

	return {
		allPassed: requiredFailures === 0,
		totalDurationMs: Date.now() - start,
		results,
		requiredFailures,
	};
}

/**
 * Default gates for a Node/TypeScript project. Detects the package
 * manager from lockfile presence and uses the appropriate command.
 */
export function defaultNodeGates(cwd: string): Gate[] {
	const pkgManager = detectPackageManager(cwd);
	const prefix = pkgManager === "npm" ? "npx" : pkgManager;
	return [
		{
			name: "typecheck",
			command: prefix,
			args: ["tsc", "--noEmit"],
			cwd,
			required: true,
			timeoutMs: 120_000,
		},
		{
			name: "lint",
			command: prefix,
			args: ["eslint", ".", "--max-warnings=0"],
			cwd,
			required: false, // lint failures are warnings, not blockers
			timeoutMs: 120_000,
		},
		{
			name: "test",
			command: prefix,
			args: ["test", "--run"],
			cwd,
			required: true,
			timeoutMs: 300_000,
		},
		{
			name: "build",
			command: prefix,
			args: ["run", "build"],
			cwd,
			required: false, // not all projects have a build step
			timeoutMs: 300_000,
		},
	];
}

function detectPackageManager(cwd: string): "npm" | "pnpm" | "yarn" | "bun" {
	if (path.basename(cwd) === "") return "npm";
	const checks: Array<["npm" | "pnpm" | "yarn" | "bun", string]> = [
		["pnpm", "pnpm-lock.yaml"],
		["yarn", "yarn.lock"],
		["bun", "bun.lockb"],
		["npm", "package-lock.json"],
	];
	for (const [mgr, lockfile] of checks) {
		try {
			// require() would cache; use fs directly to keep this synchronous-safe
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const fs = require("node:fs") as typeof import("node:fs");
			if (fs.existsSync(path.join(cwd, lockfile))) return mgr;
		} catch {
			// ignore
		}
	}
	return "npm";
}

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen) + `... [truncated ${s.length - maxLen} chars]`;
}
