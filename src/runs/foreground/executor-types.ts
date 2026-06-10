// Shared types for the subagent foreground executor.
//
// Extracted from subagent-executor.ts to:
// 1. Reduce the main executor file size (it was 2700+ LOC).
// 2. Enable clean modularization: types have no runtime cost, so they
//    can be imported by run-single.ts, run-parallel.ts, run-chain.ts,
//    run-utils.ts, and other future split modules without circular
//    runtime imports.
// 3. Make types reusable across the executor and the intercom helpers
//    that were previously tangled with type definitions.
//
// The subagent-executor.ts file re-exports these for backward compat
// with existing consumers in src/slash/ and src/extension/.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "../../agents/agents.ts";
import type {
	AcceptanceInput,
	ArtifactConfig,
	ControlConfig,
	Details,
	ExtensionConfig,
	IntercomEventBus,
	MaxOutputConfig,
	NestedRouteInfo,
	ResolvedControlConfig,
	SingleResult,
	SubagentState,
	AgentProgress,
} from "../../shared/types.ts";
import type { WorktreeSetup } from "../shared/worktree.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { ChainStep, resolveStepBehavior } from "../../shared/settings.ts";
import type { ControlEvent } from "../../shared/types.ts";
import type { IntercomBridgeState } from "../../intercom/intercom-bridge.ts";

/** Parameters for a single task entry (used in `tasks` array for parallel mode). */
export interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	acceptance?: AcceptanceInput;
}

/** Public subagent tool parameter shape. */
export interface SubagentParamsLike {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	agent?: string;
	task?: string;
	message?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	agentScope?: unknown;
	chainDir?: string;
	acceptance?: AcceptanceInput;
}

/** Dependencies the foreground executor needs at construction. */
export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	allowMutatingManagementActions?: boolean;
	// Cost & Reliability
	costGuardConfig?: import("../../shared/cost-guard.ts").ResolvedCostGuardConfig;
	sessionCostTracker?: import("../../shared/cost-guard.ts").SessionCostTracker;
	retryConfig?: import("../../shared/retry-logic.ts").ResolvedRetryConfig;
	timeoutConfig?: import("../../shared/cascading-timeout.ts").ResolvedTimeoutConfig;
	// Domain & Tool Restrictions
	domain?: import("../../shared/domain-enforcement.ts").DomainRule[];
	expertise?: import("../../shared/domain-enforcement.ts").ExpertiseEntry[];
	allowedTools?: string[];
	// Circuit Breaker & Execution Guard
	circuitBreaker?: import("../../shared/circuit-breaker.ts").CircuitBreaker;
	sessionLearner?: import("../../shared/session-learner.ts").SessionLearner;
	mergeResolverOptions?: import("../../shared/merge-resolver.ts").MergeResolverOptions;
	/** Parent session model ID (e.g. 'zai/glm-5.1'). Passed to merge resolver. */
	parentModel?: string;
}

/** Per-execution context shared across foreground run paths (single/parallel/chain/async). */
export interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
}

export type AsyncResumeSourceTarget = ReturnType<typeof import("../background/async-resume.ts").resolveAsyncResumeTarget> & { source: "async" };
export type ForegroundResumeSourceTarget = NonNullable<ReturnType<typeof import("./executor-helpers.ts").resolveForegroundResumeTarget>> & { kind: "revive"; source: "foreground" };
export type NestedResumeSourceTarget = {
	kind: "revive";
	source: "nested";
	runId: string;
	state: "complete" | "failed" | "paused";
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile: string;
};
export type ResumeSourceTarget = AsyncResumeSourceTarget | ForegroundResumeSourceTarget | NestedResumeSourceTarget;

/** Input shape for the foreground-parallel runner (used by runParallelPath). */
export interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents: IntercomEventBus;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd: string;
	maxSubagentDepths: number[];
	availableModels: ModelInfo[];
	modelOverrides: (string | undefined)[];
	behaviors: Array<ReturnType<typeof resolveStepBehavior>>;
	firstProgressIndex: number;
	controlConfig: ResolvedControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: AgentToolResult<Details>) => void;
	worktreeSetup?: WorktreeSetup;
}
