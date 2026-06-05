/**
 * Tests for the Circuit Breaker — per-agent failure tracking with cooldown.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../../src/shared/circuit-breaker.ts";

describe("CircuitBreaker — Closed State (healthy)", () => {
	it("starts in closed state", () => {
		const cb = new CircuitBreaker();
		assert.equal(cb.getState("scout").state, "closed");
		assert.equal(cb.isBlocked("scout"), false);
	});

	it("stays closed under threshold", () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.recordFailure("scout", "err1");
		cb.recordFailure("scout", "err2");
		assert.equal(cb.isBlocked("scout"), false);
		assert.equal(cb.getState("scout").state, "closed");
	});

	it("success resets consecutive failures", () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.recordFailure("scout", "err1");
		cb.recordFailure("scout", "err2");
		cb.recordSuccess("scout");
		assert.equal(cb.getState("scout").consecutiveFailures, 0);
		assert.equal(cb.getState("scout").totalSuccesses, 1);
		// Now need 3 more failures to trip
		cb.recordFailure("scout", "err3");
		cb.recordFailure("scout", "err4");
		assert.equal(cb.isBlocked("scout"), false);
	});

	it("record() helper dispatches correctly", () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.record("scout", 0);
		assert.equal(cb.getState("scout").totalSuccesses, 1);
		cb.record("scout", 1, "some error");
		assert.equal(cb.getState("scout").totalFailures, 1);
	});
});

describe("CircuitBreaker — Open State (blocked)", () => {
	it("trips after reaching threshold", () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.recordFailure("scout", "err1");
		cb.recordFailure("scout", "err2");
		cb.recordFailure("scout", "err3");
		assert.equal(cb.isBlocked("scout"), true);
		assert.equal(cb.getState("scout").state, "open");
	});

	it("provides block reason with details", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2 });
		cb.recordFailure("scout", "timeout");
		cb.recordFailure("scout", "timeout");
		const state = cb.getState("scout");
		assert.ok(state.blockReason);
		assert.ok(state.blockReason!.includes("scout"));
		assert.ok(state.blockReason!.includes("timeout"));
	});

	it("independent agents have independent breakers", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2 });
		cb.recordFailure("scout", "err");
		cb.recordFailure("scout", "err");
		assert.equal(cb.isBlocked("scout"), true);
		assert.equal(cb.isBlocked("worker"), false);
	});

	it("summary lists blocked agents", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2 });
		cb.recordFailure("scout", "err");
		cb.recordFailure("scout", "err");
		cb.recordSuccess("worker");
		const s = cb.summary();
		assert.equal(s.blocked.length, 1);
		assert.equal(s.blocked[0]!.agent, "scout");
		assert.equal(s.healthy.length, 1);
	});
});

describe("CircuitBreaker — Half-Open State (probe)", () => {
	it("transitions to half-open after cooldown", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10 });
		cb.recordFailure("scout", "err");
		cb.recordFailure("scout", "err");
		assert.equal(cb.isBlocked("scout"), true);

		// Wait for cooldown to expire
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				assert.equal(cb.isBlocked("scout"), false);
				assert.equal(cb.getState("scout").state, "half_open");
				resolve();
			}, 30);
		});
	});

	it("probe success closes the breaker", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10 });
		cb.recordFailure("scout", "err");
		cb.recordFailure("scout", "err");

		return new Promise<void>((resolve) => {
			setTimeout(() => {
				cb.isBlocked("scout"); // triggers half-open
				cb.recordSuccess("scout"); // probe succeeds
				assert.equal(cb.getState("scout").state, "closed");
				assert.equal(cb.getState("scout").consecutiveFailures, 0);
				resolve();
			}, 30);
		});
	});

	it("probe failure re-opens with doubled cooldown", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10, backoffMultiplier: 2 });
		cb.recordFailure("scout", "err");
		cb.recordFailure("scout", "err");
		const firstCooldown = cb.getState("scout").currentCooldownMs;

		return new Promise<void>((resolve) => {
			setTimeout(() => {
				cb.isBlocked("scout"); // triggers half-open
				cb.recordFailure("scout", "probe failed"); // probe fails
				assert.equal(cb.getState("scout").state, "open");
				assert.ok(cb.getState("scout").currentCooldownMs > firstCooldown);
				resolve();
			}, 30);
		});
	});
});

describe("CircuitBreaker — Reset", () => {
	it("reset() clears a single agent", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2 });
		cb.recordFailure("scout", "err");
		cb.recordFailure("scout", "err");
		cb.reset("scout");
		assert.equal(cb.getState("scout").state, "closed");
		assert.equal(cb.isBlocked("scout"), false);
	});

	it("resetAll() clears everything", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2 });
		cb.recordFailure("scout", "err");
		cb.recordFailure("scout", "err");
		cb.recordFailure("worker", "err");
		cb.recordFailure("worker", "err");
		cb.resetAll();
		assert.equal(cb.isBlocked("scout"), false);
		assert.equal(cb.isBlocked("worker"), false);
	});
});

describe("CircuitBreaker — Cooldown Backoff", () => {
	it("cooldown doubles on each re-open up to max", () => {
		const cb = new CircuitBreaker({
			failureThreshold: 1,
			cooldownMs: 100,
			maxCooldownMs: 500,
			backoffMultiplier: 2,
		});

		// First trip
		cb.recordFailure("scout", "err1");
		assert.equal(cb.getState("scout").currentCooldownMs, 100);

		// Simulate cooldown expiry + probe failure
		cb["breakers"].get("scout")!.state = "half_open";
		cb.recordFailure("scout", "probe1");
		assert.equal(cb.getState("scout").currentCooldownMs, 200);

		// Again
		cb["breakers"].get("scout")!.state = "half_open";
		cb.recordFailure("scout", "probe2");
		assert.equal(cb.getState("scout").currentCooldownMs, 400);

		// Should cap at max
		cb["breakers"].get("scout")!.state = "half_open";
		cb.recordFailure("scout", "probe3");
		assert.equal(cb.getState("scout").currentCooldownMs, 500);
	});
});
