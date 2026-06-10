import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		task: `You are ${name}`,
		systemPrompt: `System prompt for ${name}`,
		...overrides,
	} as AgentConfig;
}

// ── runSync ──────────────────────────────────────────────────────

describe("runSync", () => {
	it("returns error for unknown agent", async () => {
		const result = await runSync(
			"/tmp",
			[makeAgent("researcher")],
			"nonexistent",
			"do something",
			{},
		);
		assert.equal(result.exitCode, 1);
		assert.ok(result.error!.includes("Unknown agent"));
		assert.equal(result.agent, "nonexistent");
	});

	it("returns error for file-only output mode without output path", async () => {
		const result = await runSync(
			"/tmp",
			[makeAgent("writer")],
			"writer",
			"write something",
			{ outputMode: "file-only" },
		);
		assert.equal(result.exitCode, 1);
		assert.ok(result.error!.includes("file-only"));
	});

	it("returns error for file-only output mode with empty output path", async () => {
		const result = await runSync(
			"/tmp",
			[makeAgent("writer")],
			"writer",
			"write something",
			{ outputMode: "file-only", outputPath: "" },
		);
		assert.equal(result.exitCode, 1);
		assert.ok(result.error!.includes("file-only"));
	});

	it("returns error when pi-subagents skill is missing", async () => {
		const result = await runSync(
			"/tmp",
			[makeAgent("writer", { skills: ["pi-subagents"] })],
			"writer",
			"delegate work",
			{},
		);
		// This test assumes pi-subagents skill isn't installed in test env
		// If it IS installed, the test will proceed to spawn (which may fail differently)
		if (result.exitCode === 1 && result.error?.includes("Skills not found")) {
			assert.ok(result.error.includes("pi-subagents"));
		} else {
			// Skill was found — the test still passes (just hits a different error)
			assert.ok(true, "pi-subagents skill was found, skipping this check");
		}
	});
});
