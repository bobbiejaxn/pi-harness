import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveForegroundResumeTarget } from "../../src/runs/foreground/executor-interrupt.ts";
import type { SubagentParamsLike, SubagentState } from "../../src/shared/types.ts";

function makeState(runs: Array<{
	runId: string;
	mode: "single" | "parallel" | "chain";
	cwd: string;
	children: Array<{ agent: string; status: string; sessionFile?: string }>;
}>): SubagentState {
	const map = new Map();
	for (const run of runs) {
		map.set(run.runId, run);
	}
	return { foregroundRuns: map } as SubagentState;
}

// ── resolveForegroundResumeTarget ────────────────────────────────

describe("resolveForegroundResumeTarget", () => {
	it("returns undefined for empty id", () => {
		const result = resolveForegroundResumeTarget(
			{} as SubagentParamsLike,
			makeState([]),
		);
		assert.equal(result, undefined);
	});

	it("returns undefined when no foreground runs", () => {
		const result = resolveForegroundResumeTarget(
			{ id: "run-1" } as SubagentParamsLike,
			makeState([]),
		);
		assert.equal(result, undefined);
	});

	it("resolves by exact run id", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-harness-resume-'));
		const sessionFile = path.join(tmpDir, 'session.jsonl');
		fs.writeFileSync(sessionFile, '{}', 'utf-8');

		try {
			const result = resolveForegroundResumeTarget(
				{ id: "run-abc" } as SubagentParamsLike,
				makeState([{
					runId: "run-abc",
					mode: "single",
					cwd: "/project",
					children: [{ agent: "researcher", status: "complete", sessionFile }],
				}]),
			);
			assert.ok(result);
			assert.equal(result.runId, "run-abc");
			assert.equal(result.agent, "researcher");
			assert.equal(result.mode, "single");
			assert.equal(result.state, "complete");
			assert.equal(result.index, 0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns undefined for non-matching prefix", () => {
		const result = resolveForegroundResumeTarget(
			{ id: "xyz" } as SubagentParamsLike,
			makeState([{
				runId: "run-abc",
				mode: "single",
				cwd: "/project",
				children: [{ agent: "researcher", status: "complete" }],
			}]),
		);
		assert.equal(result, undefined);
	});

	it("throws on ambiguous prefix", () => {
		assert.throws(
			() => resolveForegroundResumeTarget(
				{ id: "run" } as SubagentParamsLike,
				makeState([
					{
						runId: "run-alpha",
						mode: "single",
						cwd: "/project",
						children: [{ agent: "a", status: "complete" }],
					},
					{
						runId: "run-beta",
						mode: "single",
						cwd: "/project",
						children: [{ agent: "b", status: "complete" }],
					},
				]),
			),
			/Ambiguous/,
		);
	});

	it("throws when run has multiple children but no index specified", () => {
		assert.throws(
			() => resolveForegroundResumeTarget(
				{ id: "run-multi" } as SubagentParamsLike,
				makeState([{
					runId: "run-multi",
					mode: "parallel",
					cwd: "/project",
					children: [
						{ agent: "a", status: "complete" },
						{ agent: "b", status: "complete" },
					],
				}]),
			),
			/children/,
		);
	});

	it("throws on detached child", () => {
		assert.throws(
			() => resolveForegroundResumeTarget(
				{ id: "run-det" } as SubagentParamsLike,
				makeState([{
					runId: "run-det",
					mode: "single",
					cwd: "/project",
					children: [{ agent: "a", status: "detached" }],
				}]),
			),
			/detached/,
		);
	});

	it("throws on non-integer index", () => {
		assert.throws(
			() => resolveForegroundResumeTarget(
				{ id: "run-idx", index: 1.5 } as SubagentParamsLike,
				makeState([{
					runId: "run-idx",
					mode: "single",
					cwd: "/project",
					children: [{ agent: "a", status: "complete" }],
				}]),
			),
			/integer/,
		);
	});

	it("throws on out-of-range index", () => {
		assert.throws(
			() => resolveForegroundResumeTarget(
				{ id: "run-idx", index: 5 } as SubagentParamsLike,
				makeState([{
					runId: "run-idx",
					mode: "single",
					cwd: "/project",
					children: [{ agent: "a", status: "complete" }],
				}]),
			),
			/out of range/,
		);
	});

	it("throws when child has no session file", () => {
		assert.throws(
			() => resolveForegroundResumeTarget(
				{ id: "run-no-sess" } as SubagentParamsLike,
				makeState([{
					runId: "run-no-sess",
					mode: "single",
					cwd: "/project",
					children: [{ agent: "a", status: "complete" }],
				}]),
			),
			/session file/,
		);
	});
});
