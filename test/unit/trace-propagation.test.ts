/**
 * Unit tests for trace-propagation module
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveTraceRunId,
	resolveSpawnDepth,
	buildTraceEnv,
	writeRunManifest,
	removePidFile,
} from "../../src/shared/trace-propagation.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("trace-propagation", () => {
	describe("resolveTraceRunId", () => {
		it("returns env var when set", () => {
			assert.equal(resolveTraceRunId({ PI_TRACE_RUN_ID: "test-run-123" }), "test-run-123");
		});

		it("auto-generates when not set", () => {
			const id = resolveTraceRunId({});
			assert.ok(id.startsWith("run-"));
			assert.ok(id.length > 10);
		});
	});

	describe("resolveSpawnDepth", () => {
		it("returns 0 when not set", () => {
			assert.equal(resolveSpawnDepth({}), 0);
		});

		it("parses numeric env", () => {
			assert.equal(resolveSpawnDepth({ PI_TRACE_SPAWN_DEPTH: "3" }), 3);
		});

		it("returns 0 for invalid values", () => {
			assert.equal(resolveSpawnDepth({ PI_TRACE_SPAWN_DEPTH: "abc" }), 0);
		});
	});

	describe("buildTraceEnv", () => {
		it("builds correct env for child", () => {
			const env = buildTraceEnv("run-123", "worker", 0);
			assert.equal(env.PI_TRACE_RUN_ID, "run-123");
			assert.equal(env.PI_TRACE_AGENT_NAME, "worker");
			assert.equal(env.PI_TRACE_SPAWN_DEPTH, "1");
		});

		it("increments depth", () => {
			const env = buildTraceEnv("run-123", "scout", 2);
			assert.equal(env.PI_TRACE_SPAWN_DEPTH, "3");
		});
	});

	describe("writeRunManifest", () => {
		it("writes manifest to disk", () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-manifest-"));
			try {
				const manifestPath = writeRunManifest(tmpDir, {
					runId: "test-run",
					timestamp: new Date().toISOString(),
					mode: "parallel",
					agent: "worker",
					taskCount: 2,
					successCount: 2,
					failCount: 0,
					totalCost: 0.05,
					totalTokens: { input: 1000, output: 500 },
					tasks: [
						{ agent: "worker", exitCode: 0, cost: 0.025 },
						{ agent: "scout", exitCode: 0, cost: 0.025 },
					],
				});
				assert.ok(manifestPath);
				assert.ok(fs.existsSync(manifestPath));
				const content = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
				assert.equal(content.runId, "test-run");
				assert.equal(content.totalCost, 0.05);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("returns undefined on write failure", () => {
			const result = writeRunManifest("/nonexistent/path/that/does/not/exist", {
				runId: "test",
				timestamp: "",
				mode: "single",
				agent: "worker",
				taskCount: 0,
				successCount: 0,
				failCount: 0,
				totalCost: 0,
				totalTokens: { input: 0, output: 0 },
				tasks: [],
			});
			assert.equal(result, undefined);
		});
	});
});
