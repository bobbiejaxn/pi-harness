/**
 * Post-completion finalize logic extracted from runSubagent.
 * Handles: output truncation, session sharing, status finalization, result file write.
 */

import * as path from "node:path";
import { appendJsonl } from "../../shared/artifacts.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { truncateOutput, DEFAULT_MAX_OUTPUT } from "../../shared/types.ts";
import { exportSessionHtml, createShareLink, findLatestSessionFile, writeRunLog } from "./runner-utils.ts";
import type { SubagentRunConfig, StepResult } from "./subagent-runner.ts";
import type { RunnerStatusPayload } from "./runner-parallel.ts";

export interface FinalizeInput {
	results: StepResult[];
	maxOutput: SubagentRunConfig["maxOutput"];
	config: SubagentRunConfig;
	statusPayload: RunnerStatusPayload;
	flatSteps: Array<{ agent: string }>;
	shareEnabled: boolean;
	latestSessionFile: string | undefined;
	activityTimer: NodeJS.Timeout | undefined;
	interrupted: boolean;
	id: string;
	overallStartTime: number;
	eventsPath: string;
	logPath: string;
	cwd: string;
	artifactsDir: string;
	asyncDir: string;
	resultPath: string;
	outputs: Record<string, unknown>;
	taskIndex: number | undefined;
	totalTasks: number | undefined;
	writeStatusPayload: () => void;
}

export interface FinalizeOutput {
	summary: string;
	truncated: boolean;
	sessionFile: string | undefined;
	shareUrl: string | undefined;
	gistUrl: string | undefined;
	shareError: string | undefined;
}

export async function finalizeRun(input: FinalizeInput): Promise<FinalizeOutput> {
	const {
		results, maxOutput, config, statusPayload, flatSteps,
		shareEnabled, latestSessionFile, activityTimer, interrupted,
		id, overallStartTime, eventsPath, logPath, cwd, artifactsDir,
		asyncDir, resultPath, outputs, taskIndex, totalTasks,
		writeStatusPayload,
	} = input;

	let summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
	let truncated = false;

	if (maxOutput) {
		const truncConfig = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
		const truncResult = truncateOutput(summary, truncConfig, lastArtifactPath);
		if (truncResult.truncated) {
			summary = truncResult.text;
			truncated = true;
		}
	}

	const resultMode = config.resultMode ?? statusPayload.mode;
	const agentName = flatSteps.length === 1
		? flatSteps[0].agent
		: resultMode === "parallel"
			? `parallel:${flatSteps.map((s) => s.agent).join("+")}`
			: `chain:${flatSteps.map((s) => s.agent).join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (shareEnabled) {
		sessionFile = config.sessionDir
			? (findLatestSessionFile(config.sessionDir) ?? undefined)
			: undefined;
		if (!sessionFile && latestSessionFile) {
			sessionFile = latestSessionFile;
		}
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	if (activityTimer) {
		clearInterval(activityTimer);
	}
	const effectiveSessionFile = sessionFile ?? latestSessionFile;
	const runEndedAt = Date.now();
	statusPayload.state = interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed";
	statusPayload.activityState = undefined;
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = effectiveSessionFile;
	statusPayload.shareUrl = shareUrl;
	statusPayload.gistUrl = gistUrl;
	statusPayload.shareError = shareError;
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	writeStatusPayload();
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.completed",
			ts: runEndedAt,
			runId: id,
			status: statusPayload.state,
			durationMs: runEndedAt - overallStartTime,
		}),
	);
	writeRunLog(logPath, {
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			durationMs: step.durationMs,
		})),
		summary,
		truncated,
		artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	});

	try {
		writeAtomicJson(resultPath, {
			id,
			agent: agentName,
			mode: resultMode,
			success: !interrupted && results.every((r) => r.success),
			state: interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed",
			summary: interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
			})),
			outputs,
			workflowGraph: statusPayload.workflowGraph,
			exitCode: interrupted || results.every((r) => r.success) ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(taskIndex !== undefined && { taskIndex }),
			...(totalTasks !== undefined && { totalTasks }),
		});
	} catch (err) {
		console.error(`Failed to write result file ${resultPath}:`, err);
	}

	return { summary, truncated, sessionFile, shareUrl, gistUrl, shareError };
}
