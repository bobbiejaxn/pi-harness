/**
 * Unit tests for retry-logic module
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isRetriable,
	backoffMs,
	shouldRetry,
	resolveRetryConfig,
	DEFAULT_RETRY_CONFIG,
} from "../../src/shared/retry-logic.ts";

describe("retry-logic", () => {
	describe("isRetriable", () => {
		it("retries on null exit code (killed by signal)", () => {
			assert.equal(isRetriable("some output", null), true);
		});

		it("retries on 429", () => {
			assert.equal(isRetriable("HTTP 429 Too Many Requests", 1), true);
		});

		it("retries on 503", () => {
			assert.equal(isRetriable("Service Unavailable 503", 1), true);
		});

		it("retries on ETIMEDOUT", () => {
			assert.equal(isRetriable("Error: ETIMEDOUT connection refused", 1), true);
		});

		it("retries on ECONNRESET", () => {
			assert.equal(isRetriable("read ECONNRESET", 1), true);
		});

		it("retries on rate_limit", () => {
			assert.equal(isRetriable("rate_limit exceeded for model", 1), true);
		});

		it("retries on overloaded", () => {
			assert.equal(isRetriable("Provider is overloaded", 1), true);
		});

		it("does NOT retry on normal exit code with no retriable pattern", () => {
			assert.equal(isRetriable("TypeError: undefined is not a function", 1), false);
		});

		it("does NOT retry on exit code 0", () => {
			assert.equal(isRetriable("success", 0), false);
		});

		it("case insensitive matching", () => {
			assert.equal(isRetriable("ERROR: RATE_LIMIT EXCEEDED", 1), true);
			assert.equal(isRetriable("EtImEdOuT", 1), true);
		});

		it("custom patterns", () => {
			assert.equal(isRetriable("custom error xyz", 1, ["xyz"]), true);
			assert.equal(isRetriable("custom error xyz", 1, ["abc"]), false);
		});
	});

	describe("backoffMs", () => {
		it("increases exponentially", () => {
			const b1 = backoffMs(1, { ...DEFAULT_RETRY_CONFIG, baseMs: 1000, maxMs: 16000 });
			const b2 = backoffMs(2, { ...DEFAULT_RETRY_CONFIG, baseMs: 1000, maxMs: 16000 });
			const b3 = backoffMs(3, { ...DEFAULT_RETRY_CONFIG, baseMs: 1000, maxMs: 16000 });
			// With jitter (±20%), verify rough ordering
			assert.ok(b1 < 2000, `b1=${b1} should be < 2000`);
			assert.ok(b2 > b1 * 0.5, `b2=${b2} should be > b1*0.5`);
			assert.ok(b3 > b2 * 0.5, `b3=${b3} should be > b2*0.5`);
		});

		it("caps at maxMs", () => {
			const result = backoffMs(10, { ...DEFAULT_RETRY_CONFIG, baseMs: 1000, maxMs: 2000 });
			// With jitter, could be up to 2400
			assert.ok(result <= 2400, `result=${result} should be <= 2400`);
		});

		it("never goes negative", () => {
			const result = backoffMs(1, { ...DEFAULT_RETRY_CONFIG, baseMs: 100, maxMs: 1000 });
			assert.ok(result >= 0);
		});
	});

	describe("shouldRetry", () => {
		it("returns delay on retriable error with attempts remaining", () => {
			const result = shouldRetry("ETIMEDOUT", null, 0, DEFAULT_RETRY_CONFIG);
			assert.ok(result !== null);
			assert.ok(result.delayMs > 0);
		});

		it("returns null when max retries reached", () => {
			const result = shouldRetry("ETIMEDOUT", null, 2, DEFAULT_RETRY_CONFIG);
			assert.equal(result, null);
		});

		it("returns null on non-retriable error", () => {
			const result = shouldRetry("TypeError: foo", 1, 0, DEFAULT_RETRY_CONFIG);
			assert.equal(result, null);
		});

		it("returns null on exit code 0", () => {
			const result = shouldRetry("success", 0, 0, DEFAULT_RETRY_CONFIG);
			assert.equal(result, null);
		});
	});

	describe("resolveRetryConfig", () => {
		it("returns defaults when no config or env", () => {
			const result = resolveRetryConfig(undefined, {});
			assert.equal(result.maxRetries, 2);
			assert.equal(result.baseMs, 1000);
			assert.equal(result.maxMs, 16000);
		});

		it("uses config values", () => {
			const result = resolveRetryConfig({ maxRetries: 5, baseMs: 2000 }, {});
			assert.equal(result.maxRetries, 5);
			assert.equal(result.baseMs, 2000);
		});

		it("env overrides config", () => {
			const result = resolveRetryConfig({ maxRetries: 1 }, { PI_SUBAGENT_MAX_RETRIES: "3" });
			assert.equal(result.maxRetries, 3);
		});

		it("ignores invalid env values", () => {
			const result = resolveRetryConfig({ maxRetries: 1 }, { PI_SUBAGENT_MAX_RETRIES: "abc" });
			assert.equal(result.maxRetries, 1);
		});
	});
});
