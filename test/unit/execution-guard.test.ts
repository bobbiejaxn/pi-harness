/**
 * Tests for the Execution Guard — turn limit, repetition, and stall detection.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ExecutionGuard } from "../../src/shared/execution-guard.ts";
import type { StreamEvent, GuardAction } from "../../src/shared/execution-guard.ts";

function assistantEnd(): StreamEvent {
	return { type: "message_end", message: { role: "assistant", stopReason: "stop" } };
}

function toolStart(tool: string, args?: unknown): StreamEvent {
	return { type: "tool_execution_start", toolName: tool, args };
}

describe("ExecutionGuard — Turn Limit", () => {
	it("allows events under the turn limit", () => {
		const guard = new ExecutionGuard({ maxTurns: 5 });
		for (let i = 0; i < 4; i++) {
			const action = guard.processEvent(assistantEnd());
			assert.equal(action, null);
		}
		assert.equal(guard.getState().turnCount, 4);
	});

	it("kills when turn limit is exceeded", () => {
		const guard = new ExecutionGuard({ maxTurns: 3 });
		guard.processEvent(assistantEnd()); // turn 1
		guard.processEvent(assistantEnd()); // turn 2
		guard.processEvent(assistantEnd()); // turn 3
		assert.equal(guard.getState().killedBy, null); // still ok
		const action = guard.processEvent(assistantEnd()); // turn 4 = exceeded
		assert.equal(action?.type, "kill");
		assert.ok(action!.reason.includes("Turn limit"));
		assert.equal(guard.getState().killedBy, "turn_limit");
	});

	it("does not count non-assistant message_end as turns", () => {
		const guard = new ExecutionGuard({ maxTurns: 2 });
		guard.processEvent(assistantEnd()); // turn 1
		guard.processEvent({ type: "message_end", message: { role: "toolResult" } }); // not a turn
		guard.processEvent(assistantEnd()); // turn 2 = limit
		const action = guard.processEvent(assistantEnd()); // turn 3 = kill
		assert.equal(action?.type, "kill");
	});

	it("disables turn limit when set to 0", () => {
		const guard = new ExecutionGuard({ maxTurns: 0 });
		for (let i = 0; i < 100; i++) {
			const action = guard.processEvent(assistantEnd());
			assert.equal(action, null);
		}
	});

	it("stops processing after kill", () => {
		const guard = new ExecutionGuard({ maxTurns: 1 });
		guard.processEvent(assistantEnd()); // turn 1
		const action1 = guard.processEvent(assistantEnd()); // turn 2 = kill
		assert.equal(action1?.type, "kill");
		// Further events should be ignored
		const action2 = guard.processEvent(assistantEnd());
		assert.equal(action2, null);
	});
});

describe("ExecutionGuard — Repetition Detection", () => {
	it("allows diverse tool calls", () => {
		const guard = new ExecutionGuard({ maxRepetitions: 3 });
		guard.processEvent(toolStart("read", { path: "a.ts" }));
		guard.processEvent(toolStart("read", { path: "b.ts" }));
		guard.processEvent(toolStart("bash", { command: "ls" }));
		// No kill — all different
		assert.equal(guard.getState().killedBy, null);
	});

	it("kills on repeated identical tool calls", () => {
		const guard = new ExecutionGuard({ maxRepetitions: 3 });
		const args = { path: "/same/file.ts" };
		guard.processEvent(toolStart("read", args)); // 1
		guard.processEvent(toolStart("read", args)); // 2
		const action = guard.processEvent(toolStart("read", args)); // 3 = limit
		assert.equal(action?.type, "kill");
		assert.ok(action!.reason.includes("Repetition"));
		assert.equal(guard.getState().killedBy, "repetition");
	});

	it("does not count different args as repetition", () => {
		const guard = new ExecutionGuard({ maxRepetitions: 3 });
		guard.processEvent(toolStart("read", { path: "a.ts" }));
		guard.processEvent(toolStart("read", { path: "b.ts" }));
		guard.processEvent(toolStart("read", { path: "c.ts" }));
		assert.equal(guard.getState().killedBy, null);
	});

	it("does not count different tools with same args as repetition", () => {
		const guard = new ExecutionGuard({ maxRepetitions: 3 });
		const args = { path: "/same/file.ts" };
		guard.processEvent(toolStart("read", args));
		guard.processEvent(toolStart("edit", args));
		guard.processEvent(toolStart("write", args));
		assert.equal(guard.getState().killedBy, null);
	});

	it("sliding window: old repetitions age out", () => {
		const guard = new ExecutionGuard({ maxRepetitions: 3 });
		const args = { path: "/file.ts" };
		guard.processEvent(toolStart("read", args)); // 1
		guard.processEvent(toolStart("read", args)); // 2
		// Insert enough other calls to push old ones out of the 20-item window
		for (let i = 0; i < 20; i++) {
			guard.processEvent(toolStart("bash", { command: `cmd${i}` }));
		}
		// Now same call again — should be count 1 in the window
		const action = guard.processEvent(toolStart("read", args));
		assert.equal(action, null);
	});

	it("disables repetition detection when set to 0", () => {
		const guard = new ExecutionGuard({ maxRepetitions: 0 });
		const args = { path: "/same" };
		for (let i = 0; i < 10; i++) {
			const action = guard.processEvent(toolStart("read", args));
			assert.equal(action, null);
		}
	});
});

describe("ExecutionGuard — Stall Detection", () => {
	it("startStallTimer sets up a timer that fires after timeout", async () => {
		let killed = false;
		const guard = new ExecutionGuard({ stallTimeoutMs: 50 });
		guard.startStallTimer(() => { killed = true; });

		await new Promise(r => setTimeout(r, 120));
		assert.ok(killed, "Stall timer should have fired");
		assert.equal(guard.getState().killedBy, "stall");
		guard.destroy();
	});

	it("events reset the stall timer", async () => {
		let killed = false;
		const guard = new ExecutionGuard({ stallTimeoutMs: 100 });
		guard.startStallTimer(() => { killed = true; });

		// Send events before the stall fires
		await new Promise(r => setTimeout(r, 30));
		guard.processEvent(assistantEnd());
		await new Promise(r => setTimeout(r, 30));
		guard.processEvent(assistantEnd());
		await new Promise(r => setTimeout(r, 30));

		assert.equal(killed, false, "Should not kill — events were flowing");
		guard.destroy();
	});

	it("disables stall detection when set to 0", () => {
		let killed = false;
		const guard = new ExecutionGuard({ stallTimeoutMs: 0 });
		guard.startStallTimer(() => { killed = true; });
		assert.equal(guard.getState().killedBy, null);
		guard.destroy();
	});

	it("destroy clears the stall timer", async () => {
		let killed = false;
		const guard = new ExecutionGuard({ stallTimeoutMs: 50 });
		guard.startStallTimer(() => { killed = true; });
		guard.destroy();

		await new Promise(r => setTimeout(r, 100));
		assert.equal(killed, false, "Destroy should cancel timer");
	});
});

describe("ExecutionGuard — Combined", () => {
	it("turn limit fires before repetition if exceeded first", () => {
		const guard = new ExecutionGuard({ maxTurns: 2, maxRepetitions: 5 });
		guard.processEvent(assistantEnd()); // turn 1
		guard.processEvent(assistantEnd()); // turn 2
		const action = guard.processEvent(assistantEnd()); // turn 3 = exceeded
		assert.equal(action?.type, "kill");
		assert.equal(guard.getState().killedBy, "turn_limit");
	});

	it("repetition fires before turn limit if hit first", () => {
		const guard = new ExecutionGuard({ maxTurns: 100, maxRepetitions: 3 });
		const args = { path: "/loop" };
		guard.processEvent(toolStart("read", args)); // 1
		guard.processEvent(toolStart("read", args)); // 2
		const action = guard.processEvent(toolStart("read", args)); // 3 = repetition
		assert.equal(action?.type, "kill");
		assert.equal(guard.getState().killedBy, "repetition");
	});

	it("getState returns accurate snapshot", () => {
		const guard = new ExecutionGuard({ maxTurns: 10, maxRepetitions: 3, stallTimeoutMs: 0 });
		guard.processEvent(assistantEnd());
		guard.processEvent(toolStart("read", { path: "a.ts" }));
		guard.processEvent(toolStart("bash", { command: "ls" }));
		guard.processEvent(assistantEnd());

		const state = guard.getState();
		assert.equal(state.turnCount, 2);
		assert.equal(state.recentToolCalls.length, 2);
		assert.equal(state.killedBy, null);
		assert.equal(state.active, true);
		assert.ok(state.lastEventAt !== null);
	});
});
