/**
 * Acceptance gate types — levels, evidence, gates, and runtime checks.
 * Extracted from types.ts.
 */

export type AcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified" | "reviewed";

export type AcceptanceEvidenceKind =
	| "changed-files"
	| "tests-added"
	| "tests-passed"
	| "tests-failed"
	| "lint-clean"
	| "type-check-clean"
	| "build-clean"
	| "coverage-delta"
	| "manual-attestation"
	| "review-override"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface AcceptanceGate {
	level: AcceptanceLevel;
	description?: string;
	verifyCommand?: AcceptanceVerifyCommand;
	review?: AcceptanceReviewGate;
	autoCheck?: AcceptanceRuntimeCheck[];
}

export interface AcceptanceVerifyCommand {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	expectExitCode?: number;
	captureOutput?: boolean;
	id?: string;
	allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
	requireHuman?: boolean;
	requireApproval?: boolean;
	timeoutMs?: number;
	agent?: string;
	required?: boolean;
	focus?: string | string[];
}

export interface AcceptanceConfig {
	level?: AcceptanceLevel;
	gates?: AcceptanceGate[];
	autoFailOnTestFailure?: boolean;
	autoFailOnLintError?: boolean;
	autoFailOnTypeError?: boolean;
	autoFailOnBuildError?: boolean;
	requireCoverage?: boolean;
	minCoveragePercent?: number;
	requireTests?: boolean;
	minTestsAdded?: number;
	skip?: boolean;
	verify?: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate;
	criteria?: string[];
	evidence?: AcceptanceEvidenceKind[];
	reason?: string;
	stopRules?: Array<{ condition: string; action: "fail" | "warn" }>;
}

export type AcceptanceInput = AcceptanceLevel | false | AcceptanceConfig;

// @ts-expect-error — type mismatch with runtime behavior
export interface ResolvedAcceptanceGate extends AcceptanceGate {
	resolvedLevel: AcceptanceLevel;
	verifyCommand?: AcceptanceVerifyCommand;
	review?: AcceptanceReviewGate | AcceptanceReviewGate[] | { agent?: string; required?: boolean };
	id?: string;
	severity?: string;
	must?: string;
	evidence?: AcceptanceEvidenceKind[];
}

export interface ResolvedAcceptanceConfig {
	level: AcceptanceLevel;
	gates: ResolvedAcceptanceGate[];
	autoFailOnTestFailure: boolean;
	autoFailOnLintError: boolean;
	autoFailOnTypeError: boolean;
	autoFailOnBuildError: boolean;
	requireCoverage: boolean;
	minCoveragePercent: number;
	requireTests: boolean;
	minTestsAdded: number;
	verify?: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate;
	criteria?: string[];
	evidence?: AcceptanceEvidenceKind[];
	stopRules?: Array<{ condition: string; action: "fail" | "warn" }>;
	explicit?: boolean;
	inferredReason?: string;
}

export interface AcceptanceReport {
	gateId: string;
	gateLevel: AcceptanceLevel;
	passed: boolean;
	evidence: Array<{
		kind: AcceptanceEvidenceKind;
		value: string | number | boolean;
		timestamp: number;
	}>;
	startedAt: number;
	completedAt: number;
	error?: string;
	skipped?: boolean;
	skipReason?: string;
	criteriaSatisfied?: boolean;
	changedFiles?: string[];
	commandsRun?: string[];
	testsAddedOrUpdated?: string[];
	validationOutput?: string;
	diffSummary?: string;
	reviewFindings?: string[];
	residualRisks?: string[];
	notes?: string;
	manualNotes?: string;
	noStagedFiles?: boolean;
	gates?: AcceptanceGate[];
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
	id: string;
	description: string;
	status?: string;
	evidence?: string;
	message?: string;
	check(): Promise<AcceptanceRuntimeCheckStatus> | AcceptanceRuntimeCheckStatus;
}

export interface AcceptanceVerifyResult {
	id?: string;
	status?: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	passed: boolean;
	error?: string;
}

export interface AcceptanceReviewResult {
	approved: boolean;
	reviewer?: string;
	reason?: string;
	timestamp: number;
	findings?: string[];
	status?: "approved" | "rejected" | "pending" | "no-blockers" | "needs-parent-decision" | "blockers";
}

export type AcceptanceLedgerStatus =
	| "pending"
	| "in-progress"
	| "passed"
	| "failed"
	| "skipped"
	| "waived"
	| "rejected"
	| "not-required"
	| "claimed"
	| "attested"
	| "checked"
	| "verified"
	| "reviewed";

export interface AcceptanceLedger {
	gates: Array<{
		gateId: string;
		level: AcceptanceLevel;
		status: AcceptanceLedgerStatus;
		report?: AcceptanceReport;
		reviewResult?: AcceptanceReviewResult;
		verifyResult?: AcceptanceVerifyResult;
		waivedAt?: number;
		waivedReason?: string;
	}>;
	status?: AcceptanceLedgerStatus;
	verifyRuns?: AcceptanceVerifyResult[];
	runtimeChecks?: AcceptanceRuntimeCheck[];
	reviewResult?: AcceptanceReviewResult;
	childReport?: AcceptanceReport;
	childReportParseError?: string;
	explicit?: boolean;
	effectiveAcceptance?: string;
	overallStatus: AcceptanceLedgerStatus;
	startedAt: number;
	completedAt?: number;
	summary?: string;
	reason?: string;
};
