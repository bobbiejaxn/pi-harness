/**
 * Streaming Callback Hooks — real-time event stream from child pi processes.
 *
 * Ported from pi_launchpad's apps/multi-team-chat/extensions/modules/subprocess.ts
 * streaming callbacks.
 *
 * Instead of parsing the raw stdout stream in each call site, this module
 * provides a typed `StreamCallbacks` interface and a `createStreamProcessor()`
 * that handles the JSON line protocol and dispatches to callbacks.
 *
 * This is used by the execution layer to emit real-time progress events
 * (tool calls, text deltas, usage) without coupling to the raw stream.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A tool call observed in the child stream. */
export interface ObservedToolCall {
	name: string;
	args: Record<string, unknown>;
	callId?: string;
	blocked?: boolean;
}

/** Callbacks for streaming events from a child process. */
export interface StreamCallbacks {
	/** Called on each text delta from the assistant. */
	onText?: (accumulated: string, delta: string) => void;

	/** Called when a tool call starts. */
	onToolCallStart?: (tool: ObservedToolCall) => void;

	/** Called when a tool execution produces a partial result. */
	onToolUpdate?: (toolCallId: string, toolName: string, partialResult: unknown) => void;

	/** Called when a tool execution completes. */
	onToolEnd?: (toolCallId: string, toolName: string, result: unknown, isError: boolean) => void;

	/** Called when a message_end event arrives with usage stats. */
	onUsage?: (stats: {
		tokensIn: number;
		tokensOut: number;
		cost: number;
		contextTokens: number;
	}) => void;

	/** Called when the model is identified. */
	onModel?: (model: string) => void;
}

/** Aggregate result from processing a child stream. */
export interface StreamResult {
	response: string;
	tokensIn: number;
	tokensOut: number;
	cost: number;
	contextTokens: number;
	model: string;
	toolCalls: ObservedToolCall[];
}

// ── Stream Processor ─────────────────────────────────────────────────────────

/**
 * Create a stream processor that handles JSON lines from pi's `--mode json` output.
 *
 * Usage:
 * ```ts
 * const { processLine, flush, getResult } = createStreamProcessor(callbacks);
 * proc.stdout.on("data", d => { buffer += d; lines.split... processLine(line) });
 * // After close: flush(); const result = getResult();
 * ```
 */
export function createStreamProcessor(callbacks: StreamCallbacks = {}) {
	let accumulatedText = "";
	let tokensIn = 0;
	let tokensOut = 0;
	let cost = 0;
	let contextTokens = 0;
	let model = "";
	let finalResponse = "";
	const toolCalls: ObservedToolCall[] = [];

	function processLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		// Text streaming
		if (event.type === "message_update" && event.assistantMessageEvent) {
			const ame = event.assistantMessageEvent;
			if (ame.type === "text_delta" && (ame.delta || ame.text)) {
				const delta = ame.delta || ame.text;
				accumulatedText += delta;
				callbacks.onText?.(accumulatedText, delta);
			}
		}

		// Tool call detection
		if (event.type === "tool_execution_start" && event.toolName) {
			const tu: ObservedToolCall = {
				name: event.toolName,
				args: event.args || {},
				callId: event.toolCallId,
			};
			toolCalls.push(tu);
			callbacks.onToolCallStart?.(tu);
		} else if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "toolcall_start"
		) {
			const tc =
				event.assistantMessageEvent.toolCall ||
				event.assistantMessageEvent.partial?.content?.[0];
			const toolName = tc?.name;
			if (toolName) {
				const tu: ObservedToolCall = {
					name: toolName,
					args: tc.arguments || {},
				};
				toolCalls.push(tu);
				callbacks.onToolCallStart?.(tu);
			}
		}

		// Tool update
		if (event.type === "tool_execution_update" && event.toolCallId) {
			callbacks.onToolUpdate?.(event.toolCallId, event.toolName, event.partialResult);
		}

		// Tool end
		if (event.type === "tool_execution_end" && event.toolCallId) {
			const isError = event.isError || event.result?.isError;
			callbacks.onToolEnd?.(event.toolCallId, event.toolName, event.result, !!isError);
			if (isError) {
				toolCalls.push({ name: event.toolName, args: {}, blocked: true });
			}
		}

		// Message end — extract final response + usage
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const msg = event.message;
			if (msg.content) {
				for (const p of msg.content) {
					if (p.type === "text") finalResponse = p.text;
				}
			}
			if (msg.usage) {
				tokensIn += msg.usage.input || 0;
				tokensOut += msg.usage.output || 0;
				cost += msg.usage.cost?.total || 0;
				contextTokens = msg.usage.totalTokens || 0;
				callbacks.onUsage?.({ tokensIn, tokensOut, cost, contextTokens });
			}
			if (msg.model) {
				model = msg.model;
				callbacks.onModel?.(model);
			}
		}
	}

	function flush(remaining: string): void {
		if (remaining.trim()) processLine(remaining);
	}

	function getResult(): StreamResult {
		return {
			response: finalResponse || accumulatedText,
			tokensIn,
			tokensOut,
			cost,
			contextTokens,
			model,
			toolCalls,
		};
	}

	return { processLine, flush, getResult };
}
