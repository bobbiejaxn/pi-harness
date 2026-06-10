/**
 * Acceptance runtime checks and verification runner.
 * Extracted from acceptance.ts.
 */

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceInput,
	AcceptanceLedger,
	AcceptanceLevel,
	AcceptanceReport,
	AcceptanceRuntimeCheck,
	AcceptanceReviewResult,
	AcceptanceVerifyCommand,
	AcceptanceVerifyResult,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
	SingleResult,
	SubagentRunMode,
} from "../../shared/types.ts";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function isAcceptanceReport(value: unknown): value is AcceptanceReport {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const report = value as AcceptanceReport;
	if (report.criteriaSatisfied !== undefined) {
		return isStringArray(report.criteriaSatisfied);
	}
	if (report.gates && Array.isArray(report.gates)) {
		return report.gates.every((gate: unknown) =>
			gate && typeof gate === "object" && typeof (gate as Record<string, unknown>).gateId === "string" && typeof (gate as Record<string, unknown>).passed === "boolean",
		);
	}
	return false;
}

export function checkCriteriaSatisfied(criteria: ResolvedAcceptanceGate[], report: AcceptanceReport): AcceptanceRuntimeCheck[] {
		// @ts-expect-error — runtime uses dynamic shapes
	const reports = new Map((report.criteriaSatisfied ?? []).filter((item) => item.id).map((item) => [item.id!, item]));
	return criteria.filter((criterion) => criterion.severity !== "recommended").map((criterion) => {
		const item = reports.get(criterion.id);
		if (!item) return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was not reported.` };
		// @ts-expect-error — runtime uses dynamic shapes
		if (item.status !== "satisfied") return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was reported as ${item.status}.` };
		return { id: `criterion:${criterion.id}`, status: "passed", message: `Required criterion '${criterion.id}' satisfied.` };
	});
}

export function reportEvidencePresent(report: AcceptanceReport, kind: AcceptanceEvidenceKind): boolean {
	switch (kind) {
		case "changed-files": return isStringArray(report.changedFiles) && report.changedFiles.length > 0;
		case "tests-added": return isStringArray(report.testsAddedOrUpdated) && report.testsAddedOrUpdated.length > 0;
		case "commands-run": return Array.isArray(report.commandsRun) && report.commandsRun.length > 0;
		case "validation-output": return isStringArray(report.validationOutput) && report.validationOutput.length > 0;
		case "residual-risks": return isStringArray(report.residualRisks);
		case "no-staged-files": return report.noStagedFiles === true;
		case "diff-summary": return typeof report.diffSummary === "string" && report.diffSummary.trim().length > 0;
		case "review-findings": return isStringArray(report.reviewFindings);
		case "manual-notes": return Boolean((report.manualNotes ?? report.notes)?.trim());
	}
}

export function checkNoStagedFiles(cwd: string): AcceptanceRuntimeCheck {
	const result = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		return { id: "no-staged-files", status: "not-applicable", message: "git status unavailable; no staged-files check skipped" };
	}
	const staged = result.stdout.split(/\r?\n/).filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
	return staged.length === 0
		? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
		: { id: "no-staged-files", status: "failed", message: `Staged files present: ${staged.join(", ")}` };
}

export function runStructuralChecks(acceptance: ResolvedAcceptanceConfig, report: AcceptanceReport, cwd: string): AcceptanceRuntimeCheck[] {
	const checks: AcceptanceRuntimeCheck[] = [];
	for (const kind of acceptance.evidence) {
		const present = reportEvidencePresent(report, kind);
		checks.push({
			id: `evidence:${kind}`,
			status: present ? "passed" : "failed",
			message: present ? `${kind} evidence present.` : `${kind} evidence missing from child report.`,
		});
	}
	if (acceptance.evidence.includes("no-staged-files")) checks.push(checkNoStagedFiles(cwd));
	return checks;
}

export function trimOutput(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n...[truncated]` : trimmed;
}

export function uniqueStrings(items: Array<string | undefined>): string[] {
	return unique(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)));
}

export function aggregateAcceptanceReport(input: {
	results: Array<Pick<SingleResult, "agent" | "acceptance" | "error" | "exitCode">>;
	notes?: string;
}): AcceptanceReport {
	const childReports = input.results.map((result) => result.acceptance?.childReport).filter((report): report is AcceptanceReport => Boolean(report));
	const blockers = input.results.filter((result) => result.exitCode !== 0 || result.acceptance?.status === "rejected");
	const successfulChildren = input.results.length > 0 && blockers.length === 0;
	return {
		// @ts-expect-error — runtime uses dynamic shapes
		criteriaSatisfied: [
			{ id: "criterion-1", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? `All ${input.results.length} dynamic child run(s) completed without child or acceptance blockers.` : "Dynamic fanout produced no accepted child evidence." },
			{ id: "criterion-2", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? "Collected child acceptance evidence for aggregate review." : "Dynamic fanout produced no aggregate review evidence." },
			...input.results.map((result, index) => ({
				id: `child-${index + 1}`,
				status: result.exitCode === 0 && result.acceptance?.status !== "rejected" ? "satisfied" : "not-satisfied",
				evidence: `${result.agent}: acceptance ${result.acceptance?.status ?? "unreported"}${result.error ? ` (${result.error})` : ""}`,
			})),
		],
		changedFiles: uniqueStrings(childReports.flatMap((report) => report.changedFiles ?? [])),
		testsAddedOrUpdated: uniqueStrings(childReports.flatMap((report) => report.testsAddedOrUpdated ?? [])),
		commandsRun: childReports.flatMap((report) => report.commandsRun ?? []),
		// @ts-expect-error — runtime uses dynamic shapes
		validationOutput: uniqueStrings(childReports.flatMap((report) => report.validationOutput ?? [])),
		residualRisks: uniqueStrings([
			...childReports.flatMap((report) => report.residualRisks ?? []),
			...blockers.map((result) => `${result.agent}: ${result.error ?? "child or acceptance gate failed"}`),
		]),
		noStagedFiles: childReports.length > 0 && childReports.every((report) => report.noStagedFiles === true),
		reviewFindings: uniqueStrings(childReports.flatMap((report) => report.reviewFindings ?? [])),
		manualNotes: input.notes ?? `Aggregated acceptance evidence from ${input.results.length} dynamic fanout child run(s).`,
		notes: input.notes,
	};
}

export function runVerifyCommand(command: AcceptanceVerifyCommand, defaultCwd: string): Promise<AcceptanceVerifyResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(command.command, {
			cwd,
			env: { ...process.env, ...(command.env ?? {}) },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
		}, command.timeoutMs ?? 120_000);
		timeout.unref?.();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			const durationMs = Date.now() - startedAt;
			const passed = exitCode === 0 && !timedOut;
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				exitCode,
				status: timedOut ? "timed-out" : passed ? "passed" : command.allowFailure ? "allowed-failure" : "failed",
				stdout: trimOutput(stdout),
				stderr: trimOutput(stderr),
		// @ts-expect-error — runtime uses dynamic shapes
				durationMs,
			});
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				exitCode: 1,
				status: command.allowFailure ? "allowed-failure" : "failed",
				stderr: error instanceof Error ? error.message : String(error),
		// @ts-expect-error — runtime uses dynamic shapes
				durationMs: Date.now() - startedAt,
			});
		});
	});
}
