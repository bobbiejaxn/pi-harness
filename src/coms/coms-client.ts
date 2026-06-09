/**
 * Coms-net HTTP client — transport layer for the peer-to-peer agent network.
 *
 * Provides typed methods for every coms-net server endpoint. All methods:
 *   - Inject Bearer auth automatically
 *   - Enforce a bounded timeout (default 10s, overridable per-call)
 *   - Sanitise error messages to strip auth tokens
 *   - Return parsed JSON (or throw a typed ComsClientError)
 *
 * This module does NOT manage SSE streams, heartbeat loops, or the TUI widget.
 * Those are the consumer's responsibility.
 *
 * Usage:
 * ```ts
 * const client = new ComsClient({ serverUrl: "http://localhost:8090", authToken: "secret" });
 * const health = await client.health();
 * const reg = await client.register({ project: "default", sessionId: "abc", name: "agent-1" });
 * ```
 */

import {
	type AgentCard,
	type ComsCliFlags,
	type ComsConfig,
	type ComsEnv,
	type HeartbeatRequest,
	type MessageStatus,
	type RegisterRequest,
	type RegisterResponse,
	type ResponseSubmitRequest,
	type SendRequest,
	type SendResponse,
	type ServerHealth,
} from "./coms-types.ts";

// ── Error class ─────────────────────────────────────────────────────────────

export class ComsClientError extends Error {
	readonly status: number | undefined;
	readonly body: unknown;

	constructor(message: string, status?: number, body?: unknown) {
		super(message);
		this.name = "ComsClientError";
		this.status = status;
		this.body = body;
	}
}

// ── Config resolution ───────────────────────────────────────────────────────

/**
 * Resolve coms-net config from environment and CLI flags.
 *
 * Priority: CLI flags > PI_* env vars > COMS_NET_* env vars > null.
 * The returned object never contains empty strings — null means "not configured".
 */
export function resolveComsConfig(env: ComsEnv, flags?: ComsCliFlags): ComsConfig {
	const serverUrl =
		flags?.serverUrl?.trim() ||
		env.PI_COMS_NET_SERVER_URL?.trim() ||
		env.COMS_NET_SERVER_URL?.trim() ||
		null;
	const authToken =
		flags?.authToken?.trim() ||
		env.PI_COMS_NET_AUTH_TOKEN?.trim() ||
		env.COMS_NET_AUTH_TOKEN?.trim() ||
		null;
	return {
		serverUrl: serverUrl || null,
		authToken: authToken || null,
	};
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface ComsClientOptions {
	serverUrl: string;
	authToken: string;
	timeoutMs?: number;
}

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

export class ComsClient {
	private readonly serverUrl: string;
	private readonly authToken: string;
	private readonly defaultTimeoutMs: number;

	constructor(options: ComsClientOptions) {
		this.serverUrl = options.serverUrl.replace(/\/+$/, "");
		this.authToken = options.authToken;
		this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private sanitizeError(err: unknown): ComsClientError {
		if (err instanceof ComsClientError) return err;
		const msg = err instanceof Error ? err.message : String(err);
		// Strip auth token from error message (defense in depth).
		const safe = this.authToken ? msg.split(this.authToken).join("<redacted>") : msg;
		return new ComsClientError(safe);
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		opts?: { timeoutMs?: number },
	): Promise<T> {
		const url = `${this.serverUrl}${path}`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.authToken}`,
			Accept: "application/json",
		};
		const init: RequestInit = { method, headers };
		const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;

		// Timeout via AbortController.
		const ac = new AbortController();
		const timer = setTimeout(() => {
			try { ac.abort(); } catch { /* ignore */ }
		}, timeoutMs);
		try { (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.(); } catch { /* ignore */ }
		init.signal = ac.signal;

		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}

		let resp: Response;
		try {
			resp = await fetch(url, init);
		} catch (err: unknown) {
			throw this.sanitizeError(err);
		} finally {
			clearTimeout(timer);
		}

		const text = await resp.text();
		let parsed: unknown = null;
		if (text.length > 0) {
			try { parsed = JSON.parse(text); } catch { parsed = text; }
		}

		if (!resp.ok) {
			const detail = parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as { error?: unknown }).error
				: undefined;
			const message = typeof detail === "string"
				? detail
				: `HTTP ${resp.status} ${method} ${path}`;
			throw new ComsClientError(message, resp.status, parsed);
		}

		return parsed as T;
	}

	// ── API methods ──────────────────────────────────────────────────────

	/** GET /health — check server reachability. */
	async health(): Promise<ServerHealth> {
		return this.request<ServerHealth>("GET", "/health");
	}

	/** POST /v1/agents/register — register this agent. */
	async register(req: RegisterRequest): Promise<RegisterResponse> {
		const raw = await this.request<Record<string, unknown>>("POST", "/v1/agents/register", req);
		// Normalise the response to our camelCase types.
		const agent = (raw.agent ?? {}) as Record<string, unknown>;
		return {
			agent: {
				sessionId: (agent.session_id ?? agent.sessionId ?? "") as string,
				name: (agent.name ?? "") as string,
				purpose: (agent.purpose ?? undefined) as string | undefined,
				model: (agent.model ?? undefined) as string | undefined,
				color: (agent.color ?? undefined) as string | undefined,
				cwd: (agent.cwd ?? undefined) as string | undefined,
				project: (agent.project ?? undefined) as string | undefined,
				explicit: (agent.explicit ?? undefined) as boolean | undefined,
			},
			sseUrl: (raw.sse_url ?? raw.sseUrl ?? "") as string,
		};
	}

	/** POST /v1/agents/:sessionId/heartbeat — send heartbeat. */
	async heartbeat(sessionId: string, req: HeartbeatRequest): Promise<void> {
		await this.request("POST", `/v1/agents/${encodeURIComponent(sessionId)}/heartbeat`, req);
	}

	/** POST /v1/messages — send a prompt to a peer. */
	async send(req: SendRequest): Promise<SendResponse> {
		// Convert camelCase → snake_case for the server.
		const body = {
			project: req.project,
			sender_session: req.senderSession,
			target: req.target,
			target_session: req.targetSession ?? null,
			prompt: req.prompt,
			conversation_id: req.conversationId ?? null,
			response_schema: req.responseSchema ?? null,
			hops: req.hops ?? 0,
		};
		const raw = await this.request<Record<string, unknown>>("POST", "/v1/messages", body);
		return {
			msgId: (raw.msg_id ?? raw.msgId ?? "") as string,
			targetSession: (raw.target_session ?? raw.targetSession ?? "") as string,
		};
	}

	/** GET /v1/messages/:msgId — poll message status. */
	async getMessage(msgId: string): Promise<MessageStatus> {
		const raw = await this.request<Record<string, unknown>>("GET", `/v1/messages/${encodeURIComponent(msgId)}`);
		return {
			msgId: (raw.msg_id ?? raw.msgId ?? msgId) as string,
			status: (raw.status ?? "pending") as MessageStatus["status"],
			response: raw.response,
			error: (raw.error ?? undefined) as string | undefined,
		};
	}

	/** GET /v1/messages/:msgId/await?timeout_ms=… — long-poll for response. */
	async awaitMessage(msgId: string, timeoutMs = 30_000): Promise<MessageStatus> {
		const serverTimeout = Math.min(timeoutMs, 180_000); // 3 min cap
		const raw = await this.request<Record<string, unknown>>(
			"GET",
			`/v1/messages/${encodeURIComponent(msgId)}/await?timeout_ms=${serverTimeout}`,
			undefined,
			{ timeoutMs: serverTimeout + 5_000 },
		);
		return {
			msgId: (raw.msg_id ?? raw.msgId ?? msgId) as string,
			status: (raw.status ?? "pending") as MessageStatus["status"],
			response: raw.response,
			error: (raw.error ?? undefined) as string | undefined,
		};
	}

	/** POST /v1/messages/:msgId/response — submit a response. */
	async submitResponse(msgId: string, req: ResponseSubmitRequest): Promise<void> {
		const body = {
			project: req.project ?? null,
			responder_session: req.responderSession,
			response: req.response,
			error: req.error ?? null,
		};
		await this.request("POST", `/v1/messages/${encodeURIComponent(msgId)}/response`, body);
	}

	/** DELETE /v1/agents/:sessionId — clean leave (best-effort). */
	async leave(sessionId: string, project?: string): Promise<void> {
		const qs = project ? `?project=${encodeURIComponent(project)}` : "";
		await this.request("DELETE", `/v1/agents/${encodeURIComponent(sessionId)}${qs}`);
	}

	/** GET /v1/agents?project=… — list peers. */
	async listPeers(project: string, includeExplicit = false): Promise<AgentCard[]> {
		const qs = `?project=${encodeURIComponent(project)}&include_explicit=${includeExplicit ? "true" : "false"}`;
		const raw = await this.request<Record<string, unknown>>("GET", `/v1/agents${qs}`);
		const agents = Array.isArray(raw?.agents) ? raw.agents : [];
		return agents.map((a: Record<string, unknown>) => ({
			sessionId: (a.session_id ?? a.sessionId ?? "") as string,
			name: (a.name ?? "") as string,
			purpose: (a.purpose ?? undefined) as string | undefined,
			model: (a.model ?? undefined) as string | undefined,
			color: (a.color ?? undefined) as string | undefined,
			cwd: (a.cwd ?? undefined) as string | undefined,
			project: (a.project ?? undefined) as string | undefined,
			explicit: (a.explicit ?? undefined) as boolean | undefined,
			contextUsedPct: (a.context_used_pct ?? a.contextUsedPct ?? undefined) as number | undefined,
			queueDepth: (a.queue_depth ?? a.queueDepth ?? undefined) as number | undefined,
			status: (a.status ?? undefined) as AgentCard["status"],
		}));
	}
}
