import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildChainExecutionDetails,
	buildChainExecutionErrorResult,
} from "../../src/runs/foreground/chain-helpers.ts";
import type { ChainExecutionDetailsInput } from "../../src/runs/foreground/chain-helpers.ts";

function makeDetailsInput(overrides: Partial<ChainExecutionDetailsInput> = {}): ChainExecutionDetailsInput {
	return {
		results: [],
		allProgress: [],
		allArtifactPaths: [],
		artifactsDir: "/tmp",
		chainAgents: ["researcher", "writer"],
		chainSteps: [],
		totalSteps: 2,
		runId: "test-run",
		...overrides,
	};
}

// ── buildChainExecutionDetails ───────────────────────────────────

describe("buildChainExecutionDetails", () => {
	it("includes chain mode", () => {
		const details = buildChainExecutionDetails(makeDetailsInput());
		assert.equal(details.mode, "chain");
	});

	it("includes chain agents", () => {
		const details = buildChainExecutionDetails(makeDetailsInput({
			chainAgents: ["researcher", "writer"],
		}));
		assert.ok(details.chainAgents);
		assert.deepEqual(details.chainAgents, ["researcher", "writer"]);
	});

	it("includes total steps", () => {
		const details = buildChainExecutionDetails(makeDetailsInput({ totalSteps: 5 }));
		assert.equal(details.totalSteps, 5);
	});

	it("omits progress when not included", () => {
		const details = buildChainExecutionDetails(makeDetailsInput({
			includeProgress: false,
			allProgress: [{ agent: "test" } as any],
		}));
		assert.equal(details.progress, undefined);
	});

	it("includes progress when flag is set", () => {
		const progress = [{ agent: "test", turns: 1 }] as any[];
		const details = buildChainExecutionDetails(makeDetailsInput({
			includeProgress: true,
			allProgress: progress,
		}));
		assert.ok(details.progress);
	});

	it("omits artifacts when none collected", () => {
		const details = buildChainExecutionDetails(makeDetailsInput({
			allArtifactPaths: [],
		}));
		assert.equal(details.artifacts, undefined);
	});

	it("includes artifacts when collected", () => {
		const details = buildChainExecutionDetails(makeDetailsInput({
			artifactsDir: "/tmp/artifacts",
			allArtifactPaths: [{ outputPath: "/tmp/artifacts/out.md" }] as any[],
		}));
		assert.ok(details.artifacts);
		assert.equal(details.artifacts!.dir, "/tmp/artifacts");
	});
});

// ── buildChainExecutionErrorResult ───────────────────────────────

describe("buildChainExecutionErrorResult", () => {
	it("creates error result with message", () => {
		const result = buildChainExecutionErrorResult("Something went wrong", makeDetailsInput());
		assert.equal(result.isError, true);
		assert.ok(result.content[0].text.includes("Something went wrong"));
		assert.ok(result.details);
		assert.equal(result.details.mode, "chain");
	});
});
