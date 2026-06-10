/**
 * Subagent runner — types, constants, and CLI entry point.
 * The main runSubagent implementation lives in runner-impl.ts.
 */

import * as fs from "node:fs";
import { runSubagent } from "./runner-impl.ts";
import type {
	MaxOutputConfig,
	ArtifactConfig,
	ResolvedControlConfig,
	SubagentRunMode,
	WorkflowGraphSnapshot,
	NestedRouteInfo,
	ModelAttempt,
	ArtifactPaths,
	AcceptanceLedger,
	AsyncStatus,
} from "../../shared/types.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";

export { runSubagent, ASYNC_INTERRUPT_SIGNAL } from "./runner-impl.ts";

export interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	piArgv1?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
}

export interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	exitCode?: number | null;
	skipped?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
}

/** A single step's status within the runner status payload. */
export type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
};

// ── CLI entry point ──────────────────────────────────────────────
const configArg = process.argv[2];
if (configArg) {
	try {
		const configJson = fs.readFileSync(configArg, "utf-8");
		const config = JSON.parse(configJson) as SubagentRunConfig;
		try {
			fs.unlinkSync(configArg);
		} catch {
			// Temp config cleanup is best effort.
		}
		runSubagent(config).catch((runErr) => {
			console.error("Subagent runner error:", runErr);
			process.exit(1);
		});
	} catch (err) {
		console.error("Subagent runner error:", err);
		process.exit(1);
	}
} else {
	let input = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
	});
	process.stdin.on("end", () => {
		try {
			const config = JSON.parse(input) as SubagentRunConfig;
			runSubagent(config).catch((runErr) => {
				console.error("Subagent runner error:", runErr);
				process.exit(1);
			});
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	});
}
