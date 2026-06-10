/**
 * Streaming child process execution and single step runner.
 * Shared by subagent-runner.ts and runner-parallel.ts.
 */

/**
 * Parallel group management for subagent runner.
 * Extracted from subagent-runner.ts.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl, getArtifactPaths } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, getPiSpawnCommand, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	type RunnerSubagentStep as SubagentStep,
} from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, readStructuredOutput } from "../shared/structured-output.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../shared/dynamic-fanout.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../shared/model-fallback.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../shared/utils.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import {
	isMutatingTool,
} from "../shared/long-running-guard.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import type { TokenUsage } from "../../shared/types.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { writeInitialProgressFile } from "../../shared/settings.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { acceptanceFailureMessage, aggregateAcceptanceReport, evaluateAcceptance, formatAcceptancePrompt, stripAcceptanceReport } from "../shared/acceptance.ts";

import type { RunnerStep } from "../shared/parallel-utils.ts";
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
} from "../../shared/types.ts";

interface SubagentRunConfig {
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

interface StepResult {
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

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

// Utility helpers extracted to runner-utils.ts
import {
	emptyUsage,
} from "./runner-utils.ts";
import type { ChildEvent, ChildEventContext, RunPiStreamingResult, SingleStepContext } from "./runner-utils.ts";

export function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	piPackageRoot?: string,
	piArgv1?: string,
	maxSubagentDepth?: number,
	childEventContext?: ChildEventContext,
	registerInterrupt?: (interrupt: (() => void) | undefined) => void,
	onChildEvent?: (event: ChildEvent) => void,
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = { ...process.env, ...(env ?? {}), ...getSubagentDepthEnv(maxSubagentDepth) };
		const spawnSpec = getPiSpawnCommand(args, {
			...(piPackageRoot ? { piPackageRoot } : {}),
			...(piArgv1 ? { argv1: piArgv1 } : {}),
		});
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv,
			windowsHide: true,
		});
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let observedMutationAttempt = false;
		const rawStdoutLines: string[] = [];

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			outputStream.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const appendChildEvent = (event: Record<string, unknown>) => {
			if (!childEventContext) return;
			appendJsonl(childEventContext.eventsPath, JSON.stringify({
				...event,
				subagentSource: "child",
				subagentRunId: childEventContext.runId,
				subagentStepIndex: childEventContext.stepIndex,
				subagentAgent: childEventContext.agent,
				observedAt: Date.now(),
			}));
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdoutLines.push(line);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
				return;
			}

			appendChildEvent(event);
			onChildEvent?.(event);

			if (event.type === "tool_execution_start" && event.toolName) {
				observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, event.args);
				const toolArgs = extractToolArgsPreview(event.args ?? {});
				writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);

				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (event.message.model) model = event.message.model;
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				const stopReason = (event.message as { stopReason?: string }).stopReason;
				const hasToolCall = Array.isArray(event.message.content)
					&& event.message.content.some((part) => (part as { type?: string }).type === "toolCall");
				if (stopReason === "stop" && !hasToolCall) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim()) assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
					startFinalDrain();
				}
			}
		};

		const processStderrText = (text: string) => {
			stderr += text;
			stderrBuf += text;
			outputStream.write(text);
			if (!childEventContext) return;
			const lines = stderrBuf.split("\n");
			stderrBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendChildLine("subagent.child.stderr", line);
			}
		};

		// Guard both cases that can leave the parent waiting on `close` forever:
		// a lingering stdio holder after `exit`, or a child that never exits.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let settled = false;
		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdoutBuf += text;
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			processStderrText(chunk.toString());
		});
		registerInterrupt?.(() => {
			if (settled) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			trySignalChild(child, "SIGINT");
			setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGTERM");
			}, 1000).unref?.();
		});
		const clearDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};
		function startFinalDrain(): void {
			if (childExited || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled) return;
				const termSent = trySignalChild(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
					error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled) return;
					forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		child.on("exit", () => {
			childExited = true;
			clearDrainTimers();
		});
		child.on("close", (exitCode, signal) => {
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			outputStream.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const finalError = error ?? assistantError;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !finalError;
			resolve({
				stderr,
				exitCode: interrupted || forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				model,
				error: interrupted || forcedDrainAfterFinalSuccess ? undefined : finalError,
				finalOutput,
				interrupted,
				observedMutationAttempt,
			});
		});

		child.on("error", (spawnError) => {
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			outputStream.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve({ stderr, exitCode: 1, messages, usage, model, error: error ?? assistantError ?? spawnErrorMessage, finalOutput, observedMutationAttempt });
		});
	});
}

async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<{
	agent: string;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	interrupted?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	completionGuardTriggered?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: import("../../shared/types.ts").AcceptanceLedger;
}> {
	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"))
		: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	task = resolveOutputReferences(task, ctx.outputs ?? {});
	const taskForCompletionGuard = task;
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance);
		if (acceptancePrompt) task = `${task}\n${acceptancePrompt}`;
	}
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	let artifactPaths: ArtifactPaths | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
		}
	}

	const candidates = step.modelCandidates && step.modelCandidates.length > 0
		? step.modelCandidates
		: step.model
			? [step.model]
			: [undefined];
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const attemptNotes: string[] = [];
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	let finalResult: RunPiStreamingResult | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;
	let completionGuardTriggeredFinal = false;

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		ctx.onAttemptStart?.({ model: candidate, thinking: resolveEffectiveThinking(candidate, step.thinking) });
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		if (effectiveStructuredOutput) {
			try {
				if (fs.existsSync(effectiveStructuredOutput.outputPath)) fs.unlinkSync(effectiveStructuredOutput.outputPath);
			} catch {
				// Missing/stale structured-output files are handled after the child exits.
			}
		}
		const { args, env, tempDir } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task,
			sessionEnabled,
			sessionDir,
			sessionFile: step.sessionFile,
			model: candidate,
			inheritProjectContext: step.inheritProjectContext,
			inheritSkills: step.inheritSkills,
			tools: step.tools,
			extensions: step.extensions,
			systemPrompt: step.systemPrompt,
			systemPromptMode: step.systemPromptMode,
			mcpDirectTools: step.mcpDirectTools,
			cwd: step.cwd ?? ctx.cwd,
			promptFileStem: step.agent,
			intercomSessionName: ctx.childIntercomTarget,
			orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
			runId: ctx.id,
			childAgentName: step.agent,
			childIndex: ctx.flatIndex,
			parentEventSink: ctx.nestedRoute?.eventSink,
			parentControlInbox: ctx.nestedRoute?.controlInbox,
			parentRootRunId: ctx.nestedRoute?.rootRunId,
			parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
			structuredOutput: effectiveStructuredOutput,
		});
		const run = await runPiStreaming(
			args,
			step.cwd ?? ctx.cwd,
			ctx.outputFile,
			env,
			ctx.piPackageRoot,
			ctx.piArgv1,
			step.maxSubagentDepth,
			{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
			ctx.registerInterrupt,
			ctx.onChildEvent,
		);
		cleanupTempDir(tempDir);

		const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
		let structuredOutput: unknown;
		let structuredError: string | undefined;
		if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !hiddenError?.hasError) {
			const structured = readStructuredOutput({
				schema: effectiveStructuredOutput.schema,
				schemaPath: effectiveStructuredOutput.schemaPath,
				outputPath: effectiveStructuredOutput.outputPath,
			});
			if (structured.error) structuredError = structured.error;
			else structuredOutput = structured.value;
		}
		const completionGuard = run.exitCode === 0 && !run.error && !hiddenError?.hasError && step.completionGuard !== false
			? evaluateCompletionMutationGuard({
				agent: step.agent,
				task: taskForCompletionGuard,
				messages: run.messages,
				tools: step.tools,
				mcpDirectTools: step.mcpDirectTools,
			})
			: undefined;
		const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
		const completionGuardError = completionGuardTriggered
			? "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes."
			: undefined;
		const effectiveExitCode = completionGuardTriggered
			? 1
			: structuredError
				? 1
				: hiddenError?.hasError
				? (hiddenError.exitCode ?? 1)
				: run.error && run.exitCode === 0
					? 1
					: run.exitCode;
		const error = completionGuardError
			?? structuredError
			?? (hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined));
		const attempt: ModelAttempt = {
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		};
		modelAttempts.push(attempt);
		if (candidate) attemptedModels.push(candidate);
		completionGuardTriggeredFinal = completionGuardTriggered;
		finalOutputSnapshot = outputSnapshot;
		finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error, structuredOutput } as RunPiStreamingResult & { structuredOutput?: unknown };
		if (attempt.success || completionGuardTriggered) break;
		if (!isRetryableModelFailure(error) || index === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = stripAcceptanceReport(rawOutput);
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot)
		: { fullOutput: outputForPersistence };
	const output = resolvedOutput.fullOutput;
	const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, output) : undefined;
	let outputForSummary = output;
		if (attemptNotes.length > 0) {
			outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
		}
	const outputForAcceptance = rawOutput;
		const finalizedOutput = finalizeSingleOutput({
			fullOutput: outputForSummary,
		outputPath: step.outputPath,
		outputMode: step.outputMode,
		exitCode: finalResult?.exitCode ?? 1,
		savedPath: resolvedOutput.savedPath,
		outputReference,
		saveError: resolvedOutput.saveError,
	});
	outputForSummary = finalizedOutput.displayOutput;
	const acceptance = step.effectiveAcceptance
			? await evaluateAcceptance({
				acceptance: step.effectiveAcceptance,
				output: outputForAcceptance,
				cwd: step.cwd ?? ctx.cwd,
			})
		: undefined;
	const acceptanceFailure = acceptance ? acceptanceFailureMessage(acceptance) : undefined;
	const acceptanceCanFailRun = acceptanceFailure && acceptance?.explicit && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted;
	const effectiveFinalExitCode = acceptanceCanFailRun ? 1 : finalResult?.exitCode ?? 1;
	const effectiveFinalError = acceptanceCanFailRun
		? (finalResult?.error ? `${finalResult.error}\n${acceptanceFailure}` : acceptanceFailure)
		: finalResult?.error;

	if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
		if (ctx.artifactConfig?.includeOutput !== false) {
			fs.writeFileSync(artifactPaths.outputPath, output, "utf-8");
		}
		if (ctx.artifactConfig?.includeMetadata !== false) {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify({
					runId: ctx.id,
					agent: step.agent,
					task,
					exitCode: effectiveFinalExitCode,
					model: finalResult?.model,
					attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
					modelAttempts,
					skills: step.skills,
					timestamp: Date.now(),
				}, null, 2),
				"utf-8",
			);
		}
	}

	return {
		agent: step.agent,
		output: outputForSummary,
		exitCode: effectiveFinalExitCode,
		error: effectiveFinalError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		artifactPaths,
		interrupted: finalResult?.interrupted,
		completionGuardTriggered: completionGuardTriggeredFinal,
		structuredOutput: (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath: effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: effectiveStructuredOutput?.schemaPath,
		acceptance,
	};
}
