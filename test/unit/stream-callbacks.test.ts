import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createStreamProcessor,
} from "../../src/shared/stream-callbacks.ts";
import type { ObservedToolCall } from "../../src/shared/stream-callbacks.ts";

describe("stream-callbacks", () => {
	describe("createStreamProcessor", () => {
		it("ignores empty lines", () => {
			const { getResult } = createStreamProcessor();
			assert.equal(getResult().response, "");
		});

		it("ignores non-JSON lines", () => {
			const { processLine, getResult } = createStreamProcessor();
			processLine("not json");
			assert.equal(getResult().response, "");
		});

		it("captures text deltas", () => {
			const deltas: string[] = [];
			const { processLine, getResult } = createStreamProcessor({
				onText: (_acc, delta) => deltas.push(delta),
			});

			processLine(JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello " },
			}));
			processLine(JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "World" },
			}));

			assert.deepEqual(deltas, ["Hello ", "World"]);
			assert.equal(getResult().response, "Hello World");
		});

		it("captures text delta from ame.text field", () => {
			const texts: string[] = [];
			const { processLine } = createStreamProcessor({
				onText: (acc) => texts.push(acc),
			});

			processLine(JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", text: "alt text" },
			}));

			assert.deepEqual(texts, ["alt text"]);
		});

		it("captures tool_execution_start", () => {
			const tools: ObservedToolCall[] = [];
			const { processLine, getResult } = createStreamProcessor({
				onToolCallStart: (t) => tools.push(t),
			});

			processLine(JSON.stringify({
				type: "tool_execution_start",
				toolName: "bash",
				toolCallId: "tc_1",
				args: { command: "ls" },
			}));

			assert.equal(tools.length, 1);
			assert.equal(tools[0].name, "bash");
			assert.equal(tools[0].callId, "tc_1");
			assert.equal(getResult().toolCalls.length, 1);
		});

		it("captures toolcall_start from message_update", () => {
			const tools: ObservedToolCall[] = [];
			const { processLine } = createStreamProcessor({
				onToolCallStart: (t) => tools.push(t),
			});

			processLine(JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					toolCall: { name: "read", arguments: { path: "/foo" } },
				},
			}));

			assert.equal(tools.length, 1);
			assert.equal(tools[0].name, "read");
		});

		it("captures tool_execution_update", () => {
			const updates: any[] = [];
			const { processLine } = createStreamProcessor({
				onToolUpdate: (id, name, result) => updates.push({ id, name, result }),
			});

			processLine(JSON.stringify({
				type: "tool_execution_update",
				toolCallId: "tc_1",
				toolName: "bash",
				partialResult: { status: "running" },
			}));

			assert.equal(updates.length, 1);
			assert.equal(updates[0].id, "tc_1");
			assert.equal(updates[0].name, "bash");
		});

		it("captures tool_execution_end", () => {
			const ends: any[] = [];
			const { processLine } = createStreamProcessor({
				onToolEnd: (id, name, result, isError) => ends.push({ id, name, result, isError }),
			});

			processLine(JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "tc_1",
				toolName: "bash",
				result: { content: "ok" },
			}));

			assert.equal(ends.length, 1);
			assert.equal(ends[0].isError, false);
		});

		it("captures tool_execution_end with error", () => {
			const ends: any[] = [];
			const { processLine, getResult } = createStreamProcessor({
				onToolEnd: (id, name, result, isError) => ends.push({ id, name, isError }),
			});

			processLine(JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "tc_1",
				toolName: "bash",
				result: { isError: true },
				isError: true,
			}));

			assert.equal(ends.length, 1);
			assert.equal(ends[0].isError, true);
		});

		it("captures usage from message_end", () => {
			const usages: any[] = [];
			const { processLine, getResult } = createStreamProcessor({
				onUsage: (s) => usages.push(s),
			});

			processLine(JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 100, output: 50, cost: { total: 0.01 }, totalTokens: 150 },
				},
			}));

			assert.equal(usages.length, 1);
			assert.equal(usages[0].tokensIn, 100);
			assert.equal(usages[0].tokensOut, 50);
			assert.equal(usages[0].cost, 0.01);
			assert.equal(getResult().response, "done");
		});

		it("captures model from message_end", () => {
			const models: string[] = [];
			const { processLine, getResult } = createStreamProcessor({
				onModel: (m) => models.push(m),
			});

			processLine(JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					model: "zai/glm-5",
					usage: {},
				},
			}));

			assert.deepEqual(models, ["zai/glm-5"]);
			assert.equal(getResult().model, "zai/glm-5");
		});

		it("flush processes remaining buffer", () => {
			const { flush, getResult } = createStreamProcessor();
			flush(JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "flushed" }],
					usage: {},
				},
			}));
			assert.equal(getResult().response, "flushed");
		});

		it("getResult returns accumulated text when no final response", () => {
			const { processLine, getResult } = createStreamProcessor();
			processLine(JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "partial" },
			}));
			assert.equal(getResult().response, "partial");
		});

		it("prefers finalResponse over accumulated text", () => {
			const { processLine, getResult } = createStreamProcessor();
			processLine(JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "partial" },
			}));
			processLine(JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "final" }],
					usage: {},
				},
			}));
			assert.equal(getResult().response, "final");
		});
	});
});
