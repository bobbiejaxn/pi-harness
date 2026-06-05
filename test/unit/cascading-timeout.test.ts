/**
 * Unit tests for cascading-timeout module
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveTimeoutConfig,
	resolveTimeout,
	formatTimeout,
	DEFAULT_TIMEOUT_CONFIG,
} from "../../src/shared/cascading-timeout.ts";

describe("cascading-timeout", () => {
	describe("resolveTimeoutConfig", () => {
		it("returns defaults when no config or env", () => {
			const result = resolveTimeoutConfig(undefined, {});
			assert.equal(result.cascadeEnabled, true);
			assert.equal(result.baseMs, 15 * 60 * 1000);
			assert.deepEqual(result.depthSchedule, [15 * 60 * 1000, 10 * 60 * 1000, 5 * 60 * 1000, 3 * 60 * 1000]);
		});

		it("uses config values", () => {
			const result = resolveTimeoutConfig(
				{ cascadeEnabled: false, baseMs: 60000 },
				{},
			);
			assert.equal(result.cascadeEnabled, false);
			assert.equal(result.baseMs, 60000);
		});

		it("env PI_SUBAGENT_TIMEOUT_MS disables cascade", () => {
			const result = resolveTimeoutConfig(
				{ cascadeEnabled: true, baseMs: 60000 },
				{ PI_SUBAGENT_TIMEOUT_MS: "120000" },
			);
			assert.equal(result.cascadeEnabled, false);
			assert.equal(result.baseMs, 120000);
			assert.deepEqual(result.depthSchedule, [120000]);
		});

		it("ignores invalid env values", () => {
			const result = resolveTimeoutConfig(undefined, { PI_SUBAGENT_TIMEOUT_MS: "not-a-number" });
			assert.equal(result.cascadeEnabled, true);
		});

		it("ignores zero env values", () => {
			const result = resolveTimeoutConfig(undefined, { PI_SUBAGENT_TIMEOUT_MS: "0" });
			assert.equal(result.cascadeEnabled, true);
		});
	});

	describe("resolveTimeout", () => {
		it("returns depth-based timeout from schedule", () => {
			const config = { ...DEFAULT_TIMEOUT_CONFIG };
			assert.equal(resolveTimeout(0, config), 15 * 60 * 1000);
			assert.equal(resolveTimeout(1, config), 10 * 60 * 1000);
			assert.equal(resolveTimeout(2, config), 5 * 60 * 1000);
			assert.equal(resolveTimeout(3, config), 3 * 60 * 1000);
		});

		it("uses last schedule value for deep nesting", () => {
			assert.equal(resolveTimeout(10, DEFAULT_TIMEOUT_CONFIG), 3 * 60 * 1000);
			assert.equal(resolveTimeout(100, DEFAULT_TIMEOUT_CONFIG), 3 * 60 * 1000);
		});

		it("handles negative depth (clamped to 0)", () => {
			assert.equal(resolveTimeout(-1, DEFAULT_TIMEOUT_CONFIG), 15 * 60 * 1000);
		});

		it("returns baseMs when cascade disabled", () => {
			const config: typeof DEFAULT_TIMEOUT_CONFIG = {
				cascadeEnabled: false,
				baseMs: 30000,
				depthSchedule: [30000],
			};
			assert.equal(resolveTimeout(0, config), 30000);
			assert.equal(resolveTimeout(5, config), 30000);
		});
	});

	describe("formatTimeout", () => {
		it("formats seconds", () => {
			assert.equal(formatTimeout(30_000), "30s");
			assert.equal(formatTimeout(1000), "1s");
		});

		it("formats minutes", () => {
			assert.equal(formatTimeout(60_000), "1m");
			assert.equal(formatTimeout(15 * 60_000), "15m");
		});

		it("formats hours", () => {
			assert.equal(formatTimeout(3600_000), "1h");
		});
	});
});
