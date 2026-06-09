/**
 * Unit tests for coms-net HTTP client.
 *
 * Uses a global fetch mock to simulate server responses.
 * Each test restores the original fetch after completion.
 */

import * as assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ComsClient, ComsClientError, resolveComsConfig } from "../../src/coms/coms-client.ts";
import type { ComsEnv } from "../../src/coms/coms-types.ts";

// ── fetch mock ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(
	handler: (url: string, init: RequestInit) => { status: number; body: unknown },
) {
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const result = handler(url, init ?? {});
		return new Response(
			result.body === undefined ? "" : JSON.stringify(result.body),
			{ status: result.status, headers: { "Content-Type": "application/json" } },
		);
	};
}

function restoreFetch() {
	globalThis.fetch = originalFetch;
}

const SERVER = "http://localhost:8090";
const TOKEN = "test-secret-token";

function makeClient() {
	return new ComsClient({ serverUrl: SERVER, authToken: TOKEN, timeoutMs: 2_000 });
}

// ── Config resolution ───────────────────────────────────────────────────────

describe("resolveComsConfig", () => {
	it("returns nulls when nothing is set", () => {
		const cfg = resolveComsConfig({});
		assert.equal(cfg.serverUrl, null);
		assert.equal(cfg.authToken, null);
	});

	it("uses PI_ env vars over COMS_NET_ env vars", () => {
		const env: ComsEnv = {
			COMS_NET_SERVER_URL: "http://old:8090",
			PI_COMS_NET_SERVER_URL: "http://new:8090",
			COMS_NET_AUTH_TOKEN: "old-token",
			PI_COMS_NET_AUTH_TOKEN: "new-token",
		};
		const cfg = resolveComsConfig(env);
		assert.equal(cfg.serverUrl, "http://new:8090");
		assert.equal(cfg.authToken, "new-token");
	});

	it("CLI flags override env vars", () => {
		const env: ComsEnv = { PI_COMS_NET_SERVER_URL: "http://env:8090" };
		const cfg = resolveComsConfig(env, { serverUrl: "http://cli:8090" });
		assert.equal(cfg.serverUrl, "http://cli:8090");
	});

	it("trims whitespace and treats empty strings as null", () => {
		const cfg = resolveComsConfig({ PI_COMS_NET_SERVER_URL: "  " });
		assert.equal(cfg.serverUrl, null);
	});
});

// ── Client methods ──────────────────────────────────────────────────────────

describe("ComsClient", () => {
	afterEach(() => restoreFetch());

	it("health() returns server health", async () => {
		mockFetch((url) => {
			assert.equal(url, `${SERVER}/health`);
			return { status: 200, body: { status: "ok", version: "1.0.0", serverId: "abc" } };
		});
		const client = makeClient();
		const health = await client.health();
		assert.equal(health.version, "1.0.0");
	});

	it("register() sends request and normalises response", async () => {
		mockFetch((_url, init) => {
			assert.equal(init.method, "POST");
			const body = JSON.parse(init.body as string);
			assert.equal(body.project, "default");
			assert.equal(body.name, "agent-1");
			return {
				status: 200,
				body: {
					agent: { session_id: "s1", name: "agent-1", model: "claude-4" },
					sse_url: "/v1/sse/s1",
				},
			};
		});
		const client = makeClient();
		const reg = await client.register({
			project: "default",
			sessionId: "s1",
			name: "agent-1",
		});
		assert.equal(reg.agent.sessionId, "s1");
		assert.equal(reg.sseUrl, "/v1/sse/s1");
	});

	it("register() normalises camelCase agent fields", async () => {
		mockFetch(() => ({
			status: 200,
			body: {
				agent: { sessionId: "s2", name: "agent-2" },
				sseUrl: "/v1/sse/s2",
			},
		}));
		const client = makeClient();
		const reg = await client.register({ project: "p", sessionId: "s2", name: "agent-2" });
		assert.equal(reg.agent.sessionId, "s2");
		assert.equal(reg.sseUrl, "/v1/sse/s2");
	});

	it("send() sends message and returns msgId", async () => {
		mockFetch((_url, init) => {
			const body = JSON.parse(init.body as string);
			assert.equal(body.target, "agent-2");
			assert.equal(body.prompt, "Hello");
			assert.equal(body.hops, 0);
			return {
				status: 200,
				body: { msg_id: "m1", target_session: "s2" },
			};
		});
		const client = makeClient();
		const resp = await client.send({
			project: "default",
			senderSession: "s1",
			target: "agent-2",
			prompt: "Hello",
		});
		assert.equal(resp.msgId, "m1");
		assert.equal(resp.targetSession, "s2");
	});

	it("getMessage() returns message status", async () => {
		mockFetch((url) => {
			assert.ok(url.includes("/v1/messages/m1"));
			return {
				status: 200,
				body: { msg_id: "m1", status: "complete", response: "Hi back" },
			};
		});
		const client = makeClient();
		const msg = await client.getMessage("m1");
		assert.equal(msg.status, "complete");
		assert.equal(msg.response, "Hi back");
	});

	it("awaitMessage() long-polls with timeout", async () => {
		mockFetch((url) => {
			assert.ok(url.includes("timeout_ms="));
			return {
				status: 200,
				body: { msg_id: "m1", status: "complete", response: "Done" },
			};
		});
		const client = makeClient();
		const msg = await client.awaitMessage("m1", 5_000);
		assert.equal(msg.status, "complete");
	});

	it("submitResponse() posts response", async () => {
		let called = false;
		mockFetch((_url, init) => {
			called = true;
			const body = JSON.parse(init.body as string);
			assert.equal(body.responder_session, "s2");
			assert.equal(body.response, "My reply");
			return { status: 200, body: {} };
		});
		const client = makeClient();
		await client.submitResponse("m1", { responderSession: "s2", response: "My reply" });
		assert.equal(called, true);
	});

	it("leave() sends DELETE request", async () => {
		mockFetch((url) => {
			assert.ok(url.startsWith(`${SERVER}/v1/agents/s1`));
			assert.ok(url.includes("project=default"));
			return { status: 200, body: {} };
		});
		const client = makeClient();
		await client.leave("s1", "default");
	});

	it("heartbeat() posts heartbeat", async () => {
		mockFetch((url) => {
			assert.ok(url.includes("/v1/agents/s1/heartbeat"));
			return { status: 200, body: {} };
		});
		const client = makeClient();
		await client.heartbeat("s1", { contextUsedPct: 42 });
	});

	it("listPeers() returns agent cards", async () => {
		mockFetch(() => ({
			status: 200,
			body: {
				agents: [
					{ session_id: "s2", name: "agent-2", model: "gpt-5", context_used_pct: 30 },
					{ session_id: "s3", name: "agent-3", status: "offline" },
				],
			},
		}));
		const client = makeClient();
		const peers = await client.listPeers("default");
		assert.equal(peers.length, 2);
		assert.equal(peers[0]!.name, "agent-2");
		assert.equal(peers[0]!.contextUsedPct, 30);
		assert.equal(peers[1]!.status, "offline");
	});

	it("throws ComsClientError on HTTP error", async () => {
		mockFetch(() => ({
			status: 404,
			body: { error: "agent not found" },
		}));
		const client = makeClient();
		await assert.rejects(
			() => client.leave("nonexistent"),
			(err) => {
				assert.ok(err instanceof ComsClientError);
				assert.equal(err.status, 404);
				assert.ok(err.message.includes("agent not found"));
				return true;
			},
		);
	});

	it("strips auth token from fetch errors", async () => {
		globalThis.fetch = async () => {
			throw new Error(`Connection refused to ${SERVER} with token ${TOKEN}`);
		};
		const client = makeClient();
		await assert.rejects(
			() => client.health(),
			(err) => {
				assert.ok(err instanceof ComsClientError);
				assert.ok(!(err.message.includes(TOKEN)));
				assert.ok(err.message.includes("<redacted>"));
				return true;
			},
		);
	});

	it("injects Bearer auth header", async () => {
		let capturedAuth: string | undefined;
		mockFetch((_url, init) => {
			capturedAuth = (init.headers as Record<string, string>)?.Authorization;
			return { status: 200, body: {} };
		});
		const client = makeClient();
		await client.health();
		assert.equal(capturedAuth, `Bearer ${TOKEN}`);
	});

	it("strips trailing slashes from serverUrl", async () => {
		const client = new ComsClient({ serverUrl: "http://localhost:8090///", authToken: "x" });
		mockFetch((url) => {
			assert.ok(!url.includes("////"), `URL has double slashes: ${url}`);
			return { status: 200, body: {} };
		});
		await client.health();
	});
});
