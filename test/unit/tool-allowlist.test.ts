import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveToolAllowlist,
	isToolAllowed,
	getAlwaysAllowedTools,
} from "../../src/shared/tool-allowlist.ts";
import type { ResolvedToolAllowlist } from "../../src/shared/tool-allowlist.ts";

describe("tool-allowlist", () => {
	describe("resolveToolAllowlist", () => {
		it("returns permissive (no restrictions) by default", () => {
			const result = resolveToolAllowlist();
			assert.equal(result.active, false);
			assert.equal(result.tools.size, 0);
		});
		it("returns permissive for empty config", () => {
			const result = resolveToolAllowlist({ allowedTools: [] });
			assert.equal(result.active, false);
		});
		it("returns permissive for undefined allowedTools", () => {
			const result = resolveToolAllowlist({});
			assert.equal(result.active, false);
		});
		it("resolves from config with tools", () => {
			const result = resolveToolAllowlist({ allowedTools: ["read", "write", "bash"] });
			assert.equal(result.active, true);
			assert.equal(result.tools.size, 3);
			assert.equal(result.tools.has("write"), true);
		});
		it("resolves from env AGENT_ALLOWED_TOOLS", () => {
			const result = resolveToolAllowlist(undefined, {
				AGENT_ALLOWED_TOOLS: '["read","write"]',
			} as NodeJS.ProcessEnv);
			assert.equal(result.active, true);
			assert.equal(result.tools.size, 2);
		});
		it("env takes precedence over config", () => {
			const result = resolveToolAllowlist(
				{ allowedTools: ["read"] },
				{ AGENT_ALLOWED_TOOLS: '["read","write","bash"]' } as NodeJS.ProcessEnv,
			);
			assert.equal(result.active, true);
			assert.equal(result.tools.size, 3); // env wins
		});
		it("ignores invalid JSON in env", () => {
			const result = resolveToolAllowlist(undefined, {
				AGENT_ALLOWED_TOOLS: "not-json",
			} as NodeJS.ProcessEnv);
			assert.equal(result.active, false);
		});
		it("ignores non-array JSON in env", () => {
			const result = resolveToolAllowlist(undefined, {
				AGENT_ALLOWED_TOOLS: '"read"',
			} as NodeJS.ProcessEnv);
			assert.equal(result.active, false);
		});
		it("ignores empty array in env", () => {
			const result = resolveToolAllowlist(undefined, {
				AGENT_ALLOWED_TOOLS: "[]",
			} as NodeJS.ProcessEnv);
			assert.equal(result.active, false);
		});
	});

	describe("isToolAllowed", () => {
		const permissive: ResolvedToolAllowlist = { active: false, tools: new Set() };
		const restricted: ResolvedToolAllowlist = {
			active: true,
			tools: new Set(["read", "write", "bash"]),
		};

		describe("permissive mode", () => {
			it("allows any tool", () => {
				const result = isToolAllowed("write", permissive);
				assert.deepEqual(result, { allowed: true });
			});
			it("allows bash", () => {
				const result = isToolAllowed("bash", permissive);
				assert.deepEqual(result, { allowed: true });
			});
			it("allows unknown tools", () => {
				const result = isToolAllowed("custom_tool", permissive);
				assert.deepEqual(result, { allowed: true });
			});
		});

		describe("restricted mode", () => {
			it("allows listed tool", () => {
				const result = isToolAllowed("write", restricted);
				assert.deepEqual(result, { allowed: true });
			});
			it("blocks unlisted tool", () => {
				const result = isToolAllowed("edit", restricted);
				assert.equal(result.allowed, false);
				if (!result.allowed) {
					assert.ok(result.reason.includes("edit"));
				}
			});
		});

		describe("always-allowed tools", () => {
			it("read is always allowed (even when not in list)", () => {
				const strict: ResolvedToolAllowlist = {
					active: true,
					tools: new Set(["write"]),
				};
				const result = isToolAllowed("read", strict);
				assert.deepEqual(result, { allowed: true });
			});
			it("grep is always allowed", () => {
				const strict: ResolvedToolAllowlist = {
					active: true,
					tools: new Set(["write"]),
				};
				const result = isToolAllowed("grep", strict);
				assert.deepEqual(result, { allowed: true });
			});
			it("find is always allowed", () => {
				const result = isToolAllowed("find", restricted);
				assert.deepEqual(result, { allowed: true });
			});
			it("ls is always allowed", () => {
				const result = isToolAllowed("ls", restricted);
				assert.deepEqual(result, { allowed: true });
			});
			it("glob is always allowed", () => {
				const result = isToolAllowed("glob", restricted);
				assert.deepEqual(result, { allowed: true });
			});
			it("subagent is always allowed", () => {
				const result = isToolAllowed("subagent", restricted);
				assert.deepEqual(result, { allowed: true });
			});
		});
	});

	describe("getAlwaysAllowedTools", () => {
		it("returns a set with expected tools", () => {
			const tools = getAlwaysAllowedTools();
			assert.ok(tools.has("read"));
			assert.ok(tools.has("subagent"));
			assert.ok(tools.has("grep"));
		});
	});
});
