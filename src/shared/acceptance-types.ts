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
	| "review-override";

export interface AcceptanceGate {
	readonly level: AcceptanceLevel;
	readonly description?: string;
	readonly verifyCommand?: AcceptanceVerifyCommand;
	readonly review?: AcceptanceReviewGate;
	readonly autoCheck?: AcceptanceRuntimeCheck[];
}

export interface AcceptanceVerifyCommand {
	readonly command: string;
	readonly args?: string[];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs?: number;
	readonly expectExitCode?: number;
	readonly captureOutput?: boolean;
	readonly id?: string;
	readonly allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
	readonly requireHuman?: boolean;
	readonly requireApproval?: boolean;
	readonly timeoutMs?: number;
}

export interface AcceptanceConfig {
	readonly level?: AcceptanceLevel;
	readonly gates?: AcceptanceGate[];
	readonly autoFailOnTestFailure?: boolean;
	readonly autoFailOnLintError?: boolean;
	readonly autoFailOnTypeError?: boolean;
	readonly autoFailOnBuildError?: boolean;
	readonly requireCoverage?: boolean;
	readonly minCoveragePercent?: number;
	readonly requireTests?: boolean;
	readonly minTestsAdded?: number;
	readonly skip?: boolean;
	readonly verify?: AcceptanceVerifyCommand | AcceptanceVerifyCommand[];
	readonly review?: AcceptanceReviewGate | AcceptanceReviewGate[];
	readonly criteria?: string | string[];
	readonly evidence?: AcceptanceEvidenceKind[];
	readonly reason?: string;
	readonly stopRules?: Array<{ condition: string; action: "fail" | "warn" }>;
}

export type AcceptanceInput = AcceptanceLevel | false | AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
	readonly resolvedLevel: AcceptanceLevel;
	readonly verifyCommand?: AcceptanceVerifyCommand;
	readonly review?: AcceptanceReviewGate;
	readonly id?: string;
	readonly severity?: "info" | "warning" | "error" | "critical";
}

export interface ResolvedAcceptanceConfig {
	readonly level: AcceptanceLevel;
	readonly gates: ResolvedAcceptanceGate[];
	readonly autoFailOnTestFailure: boolean;
	readonly autoFailOnLintError: boolean;
	readonly autoFailOnTypeError: boolean;
	readonly autoFailOnBuildError: boolean;
	readonly requireCoverage: boolean;
	readonly minCoveragePercent: number;
	readonly requireTests: boolean;
	readonly minTestsAdded: number;
	readonly verify?: AcceptanceVerifyCommand | AcceptanceVerifyCommand[];
	readonly review?: AcceptanceReviewGate | AcceptanceReviewGate[];
	readonly criteria?: string | string[];
	readonly evidence?: AcceptanceEvidenceKind[];
	readonly stopRules?: Array<{ condition: string; action: "fail" | "warn" }>;
	readonly explicit?: boolean;
	readonly inferredReason?: string;
}

export interface AcceptanceReport {
	readonly gateId: string;
	readonly gateLevel: AcceptanceLevel;
	readonly passed: boolean;
	readonly evidence: Array<{
		readonly kind: AcceptanceEvidenceKind;
		readonly value: string | number | boolean;
		readonly timestamp: number;
	}>;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly error?: string;
	readonly skipped?: boolean;
	readonly skipReason?: string;
	readonly criteriaSatisfied?: boolean;
	readonly changedFiles?: string[];
	readonly commandsRun?: string[];
	readonly testsAddedOrUpdated?: string[];
	readonly validationOutput?: string;
	readonly diffSummary?: string;
	readonly reviewFindings?: string[];
	readonly residualRisks?: string[];
	readonly notes?: string;
	readonly manualNotes?: string;
	readonly noStagedFiles?: boolean;
	readonly gates?: AcceptanceGate[];
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
	readonly id: string;
	readonly description: string;
	readonly check(): Promise<AcceptanceRuntimeCheckStatus> | AcceptanceRuntimeCheckStatus;
}

export interface AcceptanceVerifyResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly passed: boolean;
	readonly error?: string;
}

export interface AcceptanceReviewResult {
	readonly approved: boolean;
	readonly reviewer?: string;
	readonly reason?: string;
	readonly timestamp: number;
	readonly status?: "approved" | "rejected" | "pending";
}

export type AcceptanceLedgerStatus =
	| "pending"
	| "in-progress"
	| "passed"
	| "failed"
	| "skipped"
	| "waived";

export interface AcceptanceLedger {
	readonly gates: Array<{
		readonly gateId: string;
		readonly level: AcceptanceLevel;
		readonly status: AcceptanceLedgerStatus;
		readonly report?: AcceptanceReport;
		readonly reviewResult?: AcceptanceReviewResult;
		readonly verifyResult?: AcceptanceVerifyResult;
		readonly waivedAt?: number;
		readonly waivedReason?: string;
	}>;
	readonly status?: AcceptanceLedgerStatus;
	readonly verifyRuns?: AcceptanceVerifyResult[];
	readonly runtimeChecks?: AcceptanceRuntimeCheck[];
	readonly reviewResult?: AcceptanceReviewResult;
	readonly childReport?: AcceptanceReport;
	readonly childReportParseError?: string;
	readonly overallStatus: AcceptanceLedgerStatus;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly summary?: string;
	readonly reason?: string;
};
