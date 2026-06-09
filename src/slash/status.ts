/**
 * /status slash command
 *
 * Reports a snapshot of the project's current state:
 *   - Unit test count (static analysis of test/unit/*.test.ts)
 *   - Last commit (git log -1)
 *   - Outstanding GitHub issues (gh issue list)
 *
 * Each data source is fail-soft: if a tool is missing or returns an error,
 * the section is marked unavailable rather than crashing the whole command.
 *
 * No new dependencies. Uses node:child_process.execFile with bounded timeouts
 * to match the pattern in runs/acceptance-gates.ts.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../shared/types.ts";

const execFileAsync = promisify(execFile);

/** Bounded timeout (ms) for each external command. /status must stay snappy. */
const COMMAND_TIMEOUT_MS = 5_000;

/** Match `test(`, `test.serial(`, `test.skip(`, `test.todo(` at line start. */
const TEST_CALL_RE = /^\s*test(?:\.(?:serial|skip|todo))?\s*\(/gm;

export interface TestStatus {
	readonly count: number;
	readonly files: number;
	readonly note?: string;
}

export interface CommitInfo {
	readonly hash: string;
	readonly subject: string;
	readonly author: string;
	readonly relativeTime: string;
	readonly branch: string;
}

export interface CommitStatus extends CommitInfo {
	readonly note?: string;
}

export interface OpenIssue {
	readonly number: number;
	readonly title: string;
}

export interface IssuesStatus {
	readonly count: number;
	readonly items: ReadonlyArray<OpenIssue>;
	readonly repo: string | null;
	readonly note?: string;
}

export interface ProjectStatus {
	readonly cwd: string;
	readonly tests: TestStatus;
	readonly commit: CommitStatus;
	readonly issues: IssuesStatus;
}

export function collectTestFiles(cwd: string): string[] {
	const dir = path.join(cwd, "test", "unit");
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.endsWith(".test.ts"))
		.sort()
		.map((name) => path.join(dir, name));
}

export function countTestsInFile(filePath: string): number {
	try {
		const source = fs.readFileSync(filePath, "utf-8");
		// Strip block + line comments before counting so commented-out tests
		// do not inflate the number. String literals can still match, but the
		// margin of error is well within rounding for a status snapshot.
		const stripped = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/.*$/gm, "$1");
		const matches = stripped.match(TEST_CALL_RE);
		return matches ? matches.length : 0;
	} catch {
		return 0;
	}
}

export function getTestStatus(cwd: string): TestStatus {
	const files = collectTestFiles(cwd);
	if (files.length === 0) {
		return { count: 0, files: 0, note: "no test/unit/*.test.ts files found" };
	}
	let count = 0;
	for (const file of files) count += countTestsInFile(file);
	return { count, files: files.length };
}

export function getRepoFromPackage(cwd: string): string | null {
	try {
		const pkgPath = path.join(cwd, "package.json");
		const raw = fs.readFileSync(pkgPath, "utf-8");
		const parsed = JSON.parse(raw) as { repository?: { url?: string } | string };
		const url = typeof parsed.repository === "string" ? parsed.repository : parsed.repository?.url;
		if (typeof url !== "string") return null;
		// Strip "git+" prefix and trailing ".git"
		const cleaned = url.replace(/^git\+/, "").replace(/\.git$/, "");
		const match = cleaned.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
		if (!match) return null;
		return `${match[1]}/${match[2]}`;
	} catch {
		return null;
	}
}

async function safeExec(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(args[0]!, args.slice(1), {
		cwd,
		timeout: COMMAND_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
	});
	return stdout.trim();
}

export async function getLastCommit(cwd: string): Promise<CommitStatus> {
	try {
		const [hashLine, subjectLine, branchLine] = await Promise.all([
			safeExec(["git", "log", "-1", "--format=%h"], cwd),
			safeExec(["git", "log", "-1", "--format=%s"], cwd),
			safeExec(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd),
		]);
		// %ar (relative time) and %an (author) are best-effort — fall back gracefully.
		let relativeTime = "";
		let author = "";
		try {
			relativeTime = await safeExec(["git", "log", "-1", "--format=%ar"], cwd);
		} catch {
			relativeTime = "";
		}
		try {
			author = await safeExec(["git", "log", "-1", "--format=%an"], cwd);
		} catch {
			author = "";
		}
		return {
			hash: hashLine,
			subject: subjectLine,
			author,
			relativeTime,
			branch: branchLine,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			hash: "",
			subject: "",
			author: "",
			relativeTime: "",
			branch: "",
			note: `git unavailable: ${message.split("\n")[0]}`,
		};
	}
}

export async function getOpenIssues(cwd: string, repo: string | null = getRepoFromPackage(cwd)): Promise<IssuesStatus> {
	if (!repo) {
		return { count: 0, items: [], repo: null, note: "no GitHub repo in package.json" };
	}
	try {
		const stdout = await safeExec(
			["gh", "issue", "list", "--repo", repo, "--state", "open", "--json", "number,title", "--limit", "100"],
			cwd,
		);
		const parsed = JSON.parse(stdout) as Array<{ number: number; title: string }>;
		const items: OpenIssue[] = parsed.map((issue) => ({ number: issue.number, title: issue.title }));
		return { count: items.length, items, repo };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const reason = message.split("\n")[0] ?? "unknown error";
		const note = message.includes("ENOENT")
			? "gh CLI not installed"
			: message.toLowerCase().includes("auth")
				? "gh not authenticated (run `gh auth status`)"
				: `gh failed: ${reason}`;
		return { count: 0, items: [], repo, note };
	}
}

export async function getProjectStatus(cwd: string): Promise<ProjectStatus> {
	const [commit, issues] = await Promise.all([getLastCommit(cwd), getOpenIssues(cwd)]);
	return {
		cwd,
		tests: getTestStatus(cwd),
		commit,
		issues,
	};
}

function shortCwd(cwd: string, home: string): string {
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export function formatStatusReport(status: ProjectStatus): string {
	const home = (process.env.HOME ?? "").replace(/\/$/, "");
	const cwd = shortCwd(status.cwd, home);
	const lines: string[] = [`## Project status — \`${cwd}\``, ""];

	// Tests
	lines.push("### Tests");
	if (status.tests.note) {
		lines.push(`- ${status.tests.note}`);
	} else {
		lines.push(`- **${status.tests.count}** unit tests across **${status.tests.files}** files (static count)`);
	}

	// Commit
	lines.push("", "### Last commit");
	if (status.commit.note || !status.commit.hash) {
		lines.push(`- ${status.commit.note ?? "no commit info available"}`);
	} else {
		const parts = [
			`\`${status.commit.hash}\``,
			status.commit.subject,
		];
		if (status.commit.author) parts.push(`by ${status.commit.author}`);
		if (status.commit.relativeTime) parts.push(`(${status.commit.relativeTime})`);
		lines.push(`- ${parts.join(" ")}`);
		lines.push(`- branch: \`${status.commit.branch}\``);
	}

	// Issues
	lines.push("", "### Open issues");
	if (status.issues.repo) {
		lines.push(`- repo: \`${status.issues.repo}\``);
	} else {
		lines.push("- repo: _(unknown — no package.json repository field)_");
	}
	if (status.issues.note) {
		lines.push(`- ${status.issues.note}`);
	} else if (status.issues.count === 0) {
		lines.push("- 0 open issues");
	} else {
		lines.push(`- **${status.issues.count}** open:`);
		for (const issue of status.issues.items.slice(0, 20)) {
			lines.push(`  - #${issue.number} — ${issue.title}`);
		}
		if (status.issues.items.length > 20) {
			lines.push(`  - …and ${status.issues.items.length - 20} more`);
		}
	}

	return lines.join("\n");
}

export function registerStatusCommand(pi: ExtensionAPI, _state: SubagentState): void {
	pi.registerCommand("status", {
		description: "Show project status: test count, last commit, open GitHub issues",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd || process.cwd();
			const status = await getProjectStatus(cwd);
			pi.sendMessage({
				customType: "status-report",
				content: formatStatusReport(status),
				display: true,
			});
		},
	});
}
