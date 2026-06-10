import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { discoverAgents, discoverAgentsAll, type ChainConfig } from "../agents/agents.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../shared/settings.ts";
import { assertJsonSchemaObject } from "../runs/shared/structured-output.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import { registerStatusCommand } from "./status.ts";
import {
	applySlashUpdate,
	buildSlashInitialResult,
	failSlashResult,
	finalizeSlashResult,
} from "./slash-live-state.ts";
import {
	SLASH_RESULT_TYPE,
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type JsonSchemaObject,
	type SingleResult,
	type SubagentState,
} from "../shared/types.ts";

// Helpers extracted to slash-helpers.ts
import {
	loadSavedOutputSchema,
	extractSlashMessageText,
	formatExportPathList,
	collectResultPaths,
	buildSlashExportText,
	persistSlashSessionSnapshot,
	makeAgentCompletions,
	makeChainCompletions,
	discoverSavedChains,
	extractExecutionFlags,
	mapSavedChainSteps,
	parseAgentArgs,
	parseAgentToken,
	runSlashSubagent,
} from "./slash-helpers.ts";

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
): void {
	pi.registerCommand("run", {
		description: "Run a subagent directly: /run agent[output=file] [task] [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, false),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const input = cleanedArgs.trim();
			const firstSpace = input.indexOf(" ");
			if (!input) { ctx.ui.notify("Usage: /run <agent> [task] [--bg] [--fork]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(firstSpace === -1 ? input : input.slice(0, firstSpace));
			const task = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();

			if (!state.baseCwd) { ctx.ui.notify("Subagent session cwd is not initialized yet", "error"); return; }
			const agents = discoverAgents(state.baseCwd, "both").agents;
			if (!agents.find((a) => a.name === agentName)) { ctx.ui.notify(`Unknown agent: ${agentName}`, "error"); return; }

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				finalTask = `[Read from: ${inline.reads.join(", ")}]\n\n${finalTask}`;
			}
			const params: SubagentParamsLike = { agent: agentName, task: finalTask, clarify: false, agentScope: "both" };
			if (inline.output !== undefined) params.output = inline.output;
			if (inline.outputMode !== undefined) params.outputMode = inline.outputMode;
			if (inline.skill !== undefined) params.skill = inline.skill;
			if (inline.model) params.model = inline.model;
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("chain", {
		description: "Run agents in sequence: /chain scout \"task\" -> planner [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "chain", ctx);
			if (!parsed) return;
			const chain = parsed.steps.map(({ name, config, task: stepTask }, i) => ({
				agent: name,
				...(stepTask ? { task: stepTask } : i === 0 && parsed.task ? { task: parsed.task } : {}),
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: SubagentParamsLike = { chain, task: parsed.task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("run-chain", {
		description: "Run a saved chain: /run-chain chainName -- task [--bg] [--fork]",
		getArgumentCompletions: makeChainCompletions(state),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const delimiterIndex = cleanedArgs.indexOf(" -- ");
			const usage = "Usage: /run-chain <chainName> -- <task> [--bg] [--fork]";
			if (delimiterIndex === -1) {
				ctx.ui.notify(usage, "error");
				return;
			}
			const chainName = cleanedArgs.slice(0, delimiterIndex).trim();
			const task = cleanedArgs.slice(delimiterIndex + 4).trim();
			if (!chainName || !task) {
				ctx.ui.notify(usage, "error");
				return;
			}
			if (!state.baseCwd) { ctx.ui.notify("Subagent session cwd is not initialized yet", "error"); return; }
			const chain = discoverSavedChains(state.baseCwd).find((candidate) => candidate.name === chainName);
			if (!chain) {
				ctx.ui.notify(`Unknown chain: ${chainName}`, "error");
				return;
			}
			const params: SubagentParamsLike = { chain: mapSavedChainSteps(chain), task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("parallel", {
		description: "Run agents in parallel: /parallel scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "parallel", ctx);
			if (!parsed) return;
			const tasks = parsed.steps.map(({ name, config, task: stepTask }) => ({
				agent: name,
				task: stepTask ?? parsed.task,
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: SubagentParamsLike = { tasks, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});


	pi.registerCommand("subagents-doctor", {
		description: "Show subagent diagnostics",
		handler: async (_args, ctx) => {
			await runSlashSubagent(pi, ctx, { action: "doctor" });
		},
	});

	registerStatusCommand(pi, state);
}
