/**
 * Trace propagation for subagent runs.
 *
 * Propagates a trace run ID through environment variables so all agents
 * in a session (including nested children) share one trace context.
 * Writes per-run manifests with cost/timing/agent data and PID files
 * for liveness checking.
 *
 * Ported from ivi's trace propagation system.
 *
 * ## Propagated env vars
 *
 * | Var | Description |
 * |-----|-------------|
 * | `PI_TRACE_RUN_ID` | Shared run ID across all nested children |
 * | `PI_TRACE_AGENT_NAME` | Name of the agent that spawned this process |
 * | `PI_TRACE_SPAWN_DEPTH` | Nesting depth (0 = top-level) |
 *
 * ## Written artifacts
 *
 * - **PID files**: `~/.pi/agents-live/<runId>/<agent>.pid` — for liveness checking
 * - **Manifests**: `.pi/traces/runs/<runId>/manifest.json` — cost, timing, agent results
 * - **Subagent logs**: `.pi/traces/subagents/<timestamp>-<agent>-d<depth>.json`
 *
 * All writes are best-effort (failures are silent).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Env vars propagated to child processes for trace context. */
export interface TraceEnv {
	[key: string]: string | undefined;
	/** Shared run ID across all nested children. */
	PI_TRACE_RUN_ID?: string;
	/** Name of the agent that spawned this process. */
	PI_TRACE_AGENT_NAME?: string;
	/** Current nesting depth (0 = top-level). Incremented on each spawn. */
	PI_TRACE_SPAWN_DEPTH?: string;
}

/** Per-run manifest written after a subagent run completes. */
export interface RunManifest {
	runId: string;
	timestamp: string;
	mode: string;
	agent: string;
	taskCount: number;
	successCount: number;
	failCount: number;
	totalCost: number;
	totalTokens: { input: number; output: number };
	tasks: Array<{
		agent: string;
		exitCode: number;
		cost: number;
		durationMs?: number;
	}>;
}

/**
 * Resolve the trace run ID for subagent propagation.
 * Uses `PI_TRACE_RUN_ID` env var if set, otherwise auto-generates
 * a timestamped ID (e.g. `run-2026-06-04T23-12-07`).
 */
export function resolveTraceRunId(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_TRACE_RUN_ID) return env.PI_TRACE_RUN_ID;
	return `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

/**
 * Get current spawn depth from environment.
 * Returns 0 if not set (top-level).
 */
export function resolveSpawnDepth(env: NodeJS.ProcessEnv = process.env): number {
	return parseInt(env.PI_TRACE_SPAWN_DEPTH ?? "0", 10) || 0;
}

/**
 * Build env vars to propagate to a child process.
 * Increments spawn depth by 1.
 */
export function buildTraceEnv(
	runId: string,
	agentName: string,
	currentDepth: number,
): TraceEnv {
	return {
		PI_TRACE_RUN_ID: runId,
		PI_TRACE_AGENT_NAME: agentName,
		PI_TRACE_SPAWN_DEPTH: String(currentDepth + 1),
	};
}

/**
 * Write a PID file for liveness checking.
 * Written to `~/.pi/agents-live/<runId>/<agent>.pid`.
 * Best-effort: failures are silent.
 * @returns The PID file path.
 */
export function writePidFile(runId: string, agentName: string, pid: number): string {
	const pidDir = path.join(os.homedir(), ".pi", "agents-live", runId);
	const pidFile = path.join(pidDir, `${agentName}.pid`);
	try {
		fs.mkdirSync(pidDir, { recursive: true });
		fs.writeFileSync(pidFile, String(pid), { mode: 0o600 });
	} catch {
		// Best effort
	}
	return pidFile;
}

/**
 * Remove a PID file (after child exits).
 * Best-effort: failures are silent.
 */
export function removePidFile(runId: string, agentName: string): void {
	const pidFile = path.join(os.homedir(), ".pi", "agents-live", runId, `${agentName}.pid`);
	try {
		if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
	} catch {
		// Best effort
	}
}

/**
 * Write a per-run manifest JSON file atomically (write to .tmp, then rename).
 * Written to `<projectRoot>/.pi/traces/runs/<runId>/manifest.json`.
 * Best-effort: returns undefined on failure.
 * @returns The manifest file path, or undefined on failure.
 */
export function writeRunManifest(
	projectRoot: string,
	manifest: RunManifest,
): string | undefined {
	const manifestDir = path.join(projectRoot, ".pi", "traces", "runs", manifest.runId);
	try {
		fs.mkdirSync(manifestDir, { recursive: true });
		const manifestFile = path.join(manifestDir, "manifest.json");
		const tmpFile = manifestFile + ".tmp";
		fs.writeFileSync(tmpFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
		fs.renameSync(tmpFile, manifestFile);
		return manifestFile;
	} catch {
		return undefined;
	}
}

/** A single subagent result log entry. Written to `.pi/traces/subagents/`. */
export interface SubagentLogEntry {
	timestamp: string;
	agent: string;
	depth: number;
	task: string;
	exitCode: number;
	model?: string;
	usage: {
		input: number;
		output: number;
		cost: number;
	};
	stopReason?: string;
	toolCallCount: number;
	finalOutput: string;
}

/**
 * Write a subagent result log entry as JSON.
 * Written to `<projectRoot>/.pi/traces/subagents/<timestamp>-<agent>-d<depth>.json`.
 * Best-effort: returns undefined on failure.
 */
export function writeSubagentLog(
	projectRoot: string,
	entry: SubagentLogEntry,
): string | undefined {
	const tracesDir = path.join(projectRoot, ".pi", "traces", "subagents");
	try {
		if (!fs.existsSync(tracesDir)) fs.mkdirSync(tracesDir, { recursive: true });
		const timestamp = entry.timestamp.replace(/[:.]/g, "-").slice(0, 19);
		const logFile = path.join(tracesDir, `${timestamp}-${entry.agent}-d${entry.depth}.json`);
		fs.writeFileSync(logFile, JSON.stringify(entry, null, 2), { mode: 0o600 });
		return logFile;
	} catch {
		return undefined;
	}
}
