/**
 * Types for the coms-net HTTP client.
 *
 * Mirrors the coms-net server API from disler/pi-vs-claude-code.
 * The client is transport-only — it does not manage SSE, heartbeat loops,
 * or the TUI widget. Those live in the consumer (e.g. the pi_launchpad
 * extension).
 *
 * ## API surface
 *
 * | Method | Endpoint |
 * |--------|----------|
 * | health | GET /health |
 * | register | POST /v1/agents/register |
 * | heartbeat | POST /v1/agents/:sessionId/heartbeat |
 * | send | POST /v1/messages |
 * | getMessage | GET /v1/messages/:msgId |
 * | awaitMessage | GET /v1/messages/:msgId/await?timeout_ms=… |
 * | submitResponse | POST /v1/messages/:msgId/response |
 * | leave | DELETE /v1/agents/:sessionId |
 */

// ── Agent card (server → client) ────────────────────────────────────────────

export interface AgentCard {
	sessionId: string;
	name: string;
	purpose?: string;
	model?: string;
	color?: string;
	cwd?: string;
	project?: string;
	explicit?: boolean;
	contextUsedPct?: number;
	queueDepth?: number;
	status?: "online" | "stale" | "offline";
	startedAt?: string;
}

// ── Registration ────────────────────────────────────────────────────────────

export interface RegisterRequest {
	project: string;
	sessionId: string;
	name: string;
	purpose?: string;
	model?: string;
	color?: string;
	cwd?: string;
	explicit?: boolean;
}

export interface RegisterResponse {
	agent: AgentCard;
	sseUrl: string;
}

// ── Heartbeat ───────────────────────────────────────────────────────────────

export interface HeartbeatRequest {
	project?: string;
	contextUsedPct?: number;
	queueDepth?: number;
	model?: string;
	status?: string;
}

// ── Messaging ───────────────────────────────────────────────────────────────

export interface SendRequest {
	project: string;
	senderSession: string;
	target: string;
	targetSession?: string | null;
	prompt: string;
	conversationId?: string | null;
	responseSchema?: unknown;
	hops?: number;
}

export interface SendResponse {
	msgId: string;
	targetSession: string;
}

export interface MessageStatus {
	msgId: string;
	status: "queued" | "delivered" | "complete" | "error" | "timeout";
	response?: unknown;
	error?: string;
}

export interface ResponseSubmitRequest {
	project?: string;
	responderSession: string;
	response: unknown;
	error?: string | null;
}

// ── Server health ───────────────────────────────────────────────────────────

export interface ServerHealth {
	status?: string;
	version?: string;
	serverId?: string;
	uptime?: number;
}

// ── Config resolution ───────────────────────────────────────────────────────

export interface ComsConfig {
	serverUrl: string | null;
	authToken: string | null;
}

export interface ComsCliFlags {
	serverUrl?: string;
	authToken?: string;
}

export interface ComsEnv {
	COMS_NET_SERVER_URL?: string;
	PI_COMS_NET_SERVER_URL?: string;
	COMS_NET_AUTH_TOKEN?: string;
	PI_COMS_NET_AUTH_TOKEN?: string;
}
