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

const LEVEL_RANK: Record<Exclude<AcceptanceLevel, "auto">, number> = {
	none: 0,
	attested: 1,
	checked: 2,
	verified: 3,
	reviewed: 4,
};

const VALID_LEVELS = new Set<AcceptanceLevel>(["auto", "none", "attested", "checked", "verified", "reviewed"]);
const VALID_EVIDENCE = new Set<AcceptanceEvidenceKind>([
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
	"diff-summary",
	"review-findings",
	"manual-notes",
]);

function normalizeLevel(level: AcceptanceLevel | undefined): Exclude<AcceptanceLevel, "auto"> | "auto" {
	return level ?? "auto";
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function requiredEvidenceForLevel(level: Exclude<AcceptanceLevel, "auto">): AcceptanceEvidenceKind[] {
	switch (level) {
		case "none":
			return [];
		case "attested":
			return ["manual-notes", "residual-risks"];
		case "checked":
			return ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"];
		case "verified":
		case "reviewed":
			return ["changed-files", "tests-added", "commands-run", "validation-output", "residual-risks", "no-staged-files"];
	}
}

function inferLevel(input: {
	agentName: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): { level: Exclude<AcceptanceLevel, "auto">; reasons: string[]; criteria: string[]; evidence: AcceptanceEvidenceKind[]; review?: { agent?: string; required?: boolean } } {
	const agent = input.agentName.toLowerCase();
	const task = input.task?.toLowerCase() ?? "";
	const reasons: string[] = [];
	const readOnlyAgent = /\b(?:reviewer|scout|context-builder|researcher|analyst)\b/.test(agent);
	const readOnlyTask = /\b(?:read[- ]only|review[- ]only|do not edit|don't edit|no edits|without edits|inspect|summari[sz]e)\b/.test(task);
	const writeTask = /\b(?:fix|implement|update|write|edit|modify|migrate|release|security|delete|remove|refactor|commit)\b/.test(task)
		|| /\bworker\b/.test(agent);
	const risky = Boolean(input.async && writeTask)
		|| Boolean(input.dynamic)
		|| Boolean(input.dynamicGroup)
		|| /\b(?:release|migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/.test(task);

	if (risky) {
		reasons.push(input.async ? "async write-capable or risky run" : "risky write-capable run");
		if (input.dynamic || input.dynamicGroup) reasons.push("dynamic fanout context");
		return {
			level: "reviewed",
			reasons,
			criteria: ["Implement the requested change without widening scope", "Return evidence sufficient for an independent acceptance review"],
			evidence: requiredEvidenceForLevel("reviewed"),
			review: { agent: "reviewer", required: true },
		};
	}
	if (writeTask && !readOnlyTask) {
		reasons.push("write-capable worker/task");
		return {
			level: "checked",
			reasons,
			criteria: ["Implement the requested change without widening scope"],
			evidence: requiredEvidenceForLevel("checked"),
		};
	}
	if (readOnlyAgent || readOnlyTask) {
		reasons.push(readOnlyAgent ? "read-only/reviewer-style agent" : "read-only task wording");
		return {
			level: "attested",
			reasons,
			criteria: ["Return concrete findings with file paths and severity when applicable"],
			evidence: ["review-findings", "residual-risks"],
		};
	}
	reasons.push("default lightweight attestation");
	return {
		level: "attested",
		reasons,
		criteria: ["Return a concise result and residual risks when applicable"],
		evidence: ["manual-notes", "residual-risks"],
	};
}

export function normalizeAcceptanceInput(input: AcceptanceInput | undefined): AcceptanceConfig {
	if (input === undefined || input === "auto") return { level: "auto" };
	if (input === false) return { level: "none", reason: "disabled by deprecated false shorthand" };
	if (typeof input === "string") return { level: input };
	return { ...input };
}

function explicitAcceptanceCanDisable(explicit: AcceptanceConfig): boolean {
	return explicit.level === "none" && typeof explicit.reason === "string" && explicit.reason.trim().length > 0;
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	const errors: string[] = [];
	if (input === undefined) return errors;
	if (input === false) return errors;
	if (typeof input === "string") {
		if (!VALID_LEVELS.has(input as AcceptanceLevel)) errors.push(`${pathLabel} has invalid level '${input}'.`);
		return errors;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		errors.push(`${pathLabel} must be a string level, false, or an object.`);
		return errors;
	}
	const value = input as Record<string, unknown>;
	if (value.level !== undefined && (typeof value.level !== "string" || !VALID_LEVELS.has(value.level as AcceptanceLevel))) {
		errors.push(`${pathLabel}.level must be one of auto, none, attested, checked, verified, reviewed.`);
	}
	if (value.level === "none" && (typeof value.reason !== "string" || !value.reason.trim())) {
		errors.push(`${pathLabel}.reason is required when level is none.`);
	}
	if (value.criteria !== undefined && !Array.isArray(value.criteria)) errors.push(`${pathLabel}.criteria must be an array.`);
	if (Array.isArray(value.evidence)) {
		for (const [index, item] of value.evidence.entries()) {
			if (typeof item !== "string" || !VALID_EVIDENCE.has(item as AcceptanceEvidenceKind)) {
				errors.push(`${pathLabel}.evidence[${index}] is not a supported evidence kind.`);
			}
		}
	} else if (value.evidence !== undefined) {
		errors.push(`${pathLabel}.evidence must be an array.`);
	}
	if (value.verify !== undefined && !Array.isArray(value.verify)) errors.push(`${pathLabel}.verify must be an array.`);
	if (Array.isArray(value.verify)) {
		for (const [index, command] of value.verify.entries()) {
			if (!command || typeof command !== "object" || Array.isArray(command)) {
				errors.push(`${pathLabel}.verify[${index}] must be an object.`);
				continue;
			}
			const cmd = command as Record<string, unknown>;
			if (typeof cmd.id !== "string" || !cmd.id.trim()) errors.push(`${pathLabel}.verify[${index}].id is required.`);
			if (typeof cmd.command !== "string" || !cmd.command.trim()) errors.push(`${pathLabel}.verify[${index}].command is required.`);
			if (cmd.timeoutMs !== undefined && (typeof cmd.timeoutMs !== "number" || cmd.timeoutMs <= 0)) {
				errors.push(`${pathLabel}.verify[${index}].timeoutMs must be a positive number.`);
			}
		}
	}
	return errors;
}

function normalizeCriteria(criteria: Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }> | undefined, evidence: AcceptanceEvidenceKind[]): ResolvedAcceptanceGate[] {
		// @ts-expect-error — runtime shape differs from type definition
	return (criteria ?? []).map((criterion, index) => {
		if (typeof criterion === "string") {
			return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" };
		}
		return {
			id: criterion.id?.trim() || `criterion-${index + 1}`,
			must: criterion.must ?? "",
			evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
			severity: criterion.severity ?? "required",
		};
	}).filter((criterion) => criterion.must.trim());
}

export function resolveEffectiveAcceptance(input: {
	explicit?: AcceptanceInput;
	agentName: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): ResolvedAcceptanceConfig {
	const explicit = normalizeAcceptanceInput(input.explicit);
	const inferred = inferLevel(input);
	const explicitLevel = normalizeLevel(explicit.level);
	const level = explicitAcceptanceCanDisable(explicit)
		? "none"
		: explicitLevel === "auto"
			? inferred.level
			: (LEVEL_RANK[explicitLevel] >= LEVEL_RANK[inferred.level] ? explicitLevel : inferred.level);
	const evidence = unique([...(level === inferred.level ? inferred.evidence : requiredEvidenceForLevel(level)), ...(explicit.evidence ?? [])]);
	const criteria = normalizeCriteria(
		(explicit.criteria?.length ? explicit.criteria : inferred.criteria) as Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }>,
		evidence,
	);
	let review = explicit.review !== undefined ? explicit.review : inferred.review;
		// @ts-expect-error — runtime shape differs from type definition
	if (level === "reviewed" && explicitLevel !== "auto" && explicitLevel !== "reviewed" && explicit.review === undefined && review && review !== false) {
		review = { ...review, required: false };
	}
	return {
		level,
		explicit: input.explicit !== undefined,
		// @ts-expect-error — runtime shape differs from type definition
		inferredReason: inferred.reasons,
		// @ts-expect-error — runtime shape differs from type definition
		criteria,
		evidence,
		verify: explicit.verify ?? [],
		review,
		stopRules: explicit.stopRules ?? [],
		reason: explicit.reason,
	};
}

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig): string {
	if (acceptance.level === "none") return "";
	const lines = [
		"",
		"## Acceptance Contract",
		`Acceptance level: ${acceptance.level}`,
		"Completion is not accepted from prose alone. End with a structured acceptance report.",
		"",
		"Criteria:",
		// @ts-expect-error — runtime shape differs from type definition
		...(acceptance.criteria.length ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- Return the requested result."]),
		"",
		`Required evidence: ${acceptance.evidence.join(", ") || "none"}`,
	];
	if (acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands configured by parent:");
		for (const command of acceptance.verify) lines.push(`- ${command.id}: ${command.command}`);
	}
		// @ts-expect-error — runtime shape differs from type definition
	if (acceptance.review && acceptance.review !== false) {
		lines.push("", `Review gate: ${acceptance.review.required === false ? "optional" : "required"}${acceptance.review.agent ? ` by ${acceptance.review.agent}` : ""}.`);
		if (acceptance.review.focus) lines.push(`Review focus: ${acceptance.review.focus}`);
	}
	if (acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof" }],
			changedFiles: [],
			testsAddedOrUpdated: [],
			commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
			validationOutput: [],
			residualRisks: [],
			noStagedFiles: true,
			notes: "anything else the parent should know",
		}, null, 2),
		"```",
	);
	return lines.join("\n");
}

function extractBalancedJson(text: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
	const fenced = [...output.matchAll(/```acceptance-report\s*\n([\s\S]*?)```/gi)]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value));
	const parseErrors: string[] = [];
	for (const body of fenced) {
		try {
			const parsed = JSON.parse(body) as unknown;
			const report = (parsed && typeof parsed === "object" && "acceptance" in parsed)
				? (parsed as { acceptance?: unknown }).acceptance
				: parsed;
			if (isAcceptanceReport(report)) return { report };
			parseErrors.push("acceptance-report block does not contain a valid acceptance report");
		} catch (error) {
			parseErrors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (parseErrors.length > 0) return { error: `Failed to parse acceptance-report: ${parseErrors.join("; ")}` };
	const markerIndex = output.search(/ACCEPTANCE_REPORT\s*:/i);
	if (markerIndex !== -1) {
		const jsonStart = output.indexOf("{", markerIndex);
		if (jsonStart !== -1) {
			const json = extractBalancedJson(output, jsonStart);
			if (json) {
				try {
					const parsed = JSON.parse(json) as unknown;
					if (isAcceptanceReport(parsed)) return { report: parsed };
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			}
		}
	}
	return { error: "Structured acceptance report not found." };
}

export function stripAcceptanceReport(output: string): string {
	return output
		.replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "")
		.replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
		.trimEnd();
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAcceptanceReport(value: unknown): value is AcceptanceReport {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const report = value as AcceptanceReport;
	if (report.criteriaSatisfied !== undefined) {
		if (!Array.isArray(report.criteriaSatisfied)) return false;
		for (const item of report.criteriaSatisfied) {
			if (!item || typeof item !== "object" || Array.isArray(item)) return false;
			const criterion = item as { id?: unknown; status?: unknown; evidence?: unknown };
			if (criterion.id !== undefined && typeof criterion.id !== "string") return false;
			if (criterion.status !== "satisfied" && criterion.status !== "not-satisfied" && criterion.status !== "not-applicable") return false;
			if (typeof criterion.evidence !== "string" || !criterion.evidence.trim()) return false;
		}
	}
	return report.criteriaSatisfied !== undefined
		|| report.changedFiles !== undefined
		|| report.testsAddedOrUpdated !== undefined
		|| report.commandsRun !== undefined
		|| report.residualRisks !== undefined
		|| report.manualNotes !== undefined
		|| report.reviewFindings !== undefined;
}

// Runtime checks extracted to acceptance-checks.ts
import {
	checkCriteriaSatisfied,
	reportEvidencePresent,
	checkNoStagedFiles,
	runStructuralChecks,
	trimOutput,
	uniqueStrings,
	runVerifyCommand,
} from "./acceptance-checks.ts";
// Re-export for backward compat
export { aggregateAcceptanceReport } from "./acceptance-checks.ts";

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd: string;
	report?: AcceptanceReport;
	reviewResult?: AcceptanceReviewResult;
}): Promise<AcceptanceLedger> {
	const acceptance = input.acceptance;
	const ledger: AcceptanceLedger = {
		status: acceptance.level === "none" ? "not-required" : "claimed",
		explicit: acceptance.explicit,
		// @ts-expect-error — runtime shape differs from type definition
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
	if (acceptance.level === "none") return ledger;

	const parsed = input.report ? { report: input.report } : parseAcceptanceReport(input.output);
	if (parsed.report) {
		ledger.childReport = parsed.report;
		ledger.status = "attested";
	} else {
		ledger.childReportParseError = parsed.error;
		ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
		ledger.status = "rejected";
		return ledger;
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
		ledger.runtimeChecks = [
		// @ts-expect-error — runtime shape differs from type definition
			...checkCriteriaSatisfied(acceptance.criteria, parsed.report),
			...runStructuralChecks(acceptance, parsed.report, input.cwd),
		];
		if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "checked";
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.verified && (acceptance.level === "verified" || acceptance.verify.length > 0)) {
		if (acceptance.level === "verified" && acceptance.verify.length === 0) {
			ledger.runtimeChecks.push({ id: "verification-config", status: "failed", message: "verified acceptance requires runtime verify commands." });
			ledger.status = "rejected";
			return ledger;
		}
		ledger.verifyRuns = [];
		for (const command of acceptance.verify) ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd));
		if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "verified";
	}

	if (acceptance.level === "reviewed") {
		if (input.reviewResult) {
			ledger.reviewResult = input.reviewResult;
			ledger.status = input.reviewResult.status === "no-blockers" ? "reviewed" : "rejected";
		} else {
		// @ts-expect-error — runtime shape differs from type definition
			const optionalReview = acceptance.review && acceptance.review !== false && acceptance.review.required === false;
			ledger.reviewResult = {
				status: "needs-parent-decision",
		// @ts-expect-error — runtime shape differs from type definition
				findings: [{
					severity: acceptance.explicit && !optionalReview ? "blocker" : "non-blocking",
					issue: "Reviewed acceptance requires an independent reviewer result.",
					rationale: "The run cannot be marked reviewed from child evidence alone.",
				}],
			};
		// @ts-expect-error — runtime shape differs from type definition
			if (acceptance.review === false || (acceptance.explicit && !optionalReview)) ledger.status = "rejected";
		}
	}

	return ledger;
}

export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
	if (ledger.status !== "rejected") return undefined;
	const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
	if (failedCheck) return `Acceptance rejected: ${failedCheck.message}`;
	const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
	if (ledger.reviewResult?.status === "needs-parent-decision") return "Acceptance review required but no automatic reviewer result is available.";
	if (ledger.reviewResult?.status === "blockers") return "Acceptance review found blockers.";
	return "Acceptance rejected.";
}
