/**
 * Tests for the child domain guard extension.
 *
 * The guard is a pi extension that reads env vars and blocks tool calls.
 * We test the core logic by importing the guard factory and verifying
 * its behavior through the env var interface.
 *
 * Since we can't easily instantiate a full ExtensionAPI mock, we test:
 *   1. The guard is a no-op when no env vars are set
 *   2. The guard path resolves correctly
 *   3. The env vars it reads match what buildDomainEnv produces
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDomainEnv } from "../../src/shared/domain-enforcement.ts";
import type { DomainRule, ExpertiseEntry } from "../../src/shared/domain-enforcement.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = join(__dirname, "..", "..", "src", "runs", "foreground", "child-domain-guard.ts");

describe("child-domain-guard", () => {
	it("guard file exists at expected path", () => {
		assert.ok(existsSync(GUARD_PATH), `Guard not found at ${GUARD_PATH}`);
	});

	it("guard file exports a default factory function", async () => {
		const mod = await import(GUARD_PATH);
		assert.equal(typeof mod.default, "function");
	});

	it("guard is a no-op when AGENT_DOMAIN_RULES is not set", async () => {
		const mod = await import(GUARD_PATH);
		// Create a minimal mock that tracks whether any hooks were registered
		const hooks: string[] = [];
		const mockPi = {
			on: (event: string, handler: Function) => { hooks.push(event); },
		};
		// Clear the env var to ensure no enforcement
		const origRules = process.env.AGENT_DOMAIN_RULES;
		delete process.env.AGENT_DOMAIN_RULES;
		mod.default(mockPi);
		// Guard should return early without registering any hooks
		assert.equal(hooks.length, 0, "Should not register hooks when no rules set");
		// Restore
		if (origRules) process.env.AGENT_DOMAIN_RULES = origRules;
	});

	it("guard registers tool_call hook when AGENT_DOMAIN_RULES is set", async () => {
		const mod = await import(GUARD_PATH);
		const hooks: string[] = [];
		const mockPi = {
			on: (event: string, handler: Function) => { hooks.push(event); },
		};
		const origRules = process.env.AGENT_DOMAIN_RULES;
		const origRoot = process.env.AGENT_PROJECT_ROOT;
		process.env.AGENT_DOMAIN_RULES = JSON.stringify([
			{ path: "src", read: true, upsert: false, delete: false },
		]);
		process.env.AGENT_PROJECT_ROOT = "/tmp/test-project";
		mod.default(mockPi);
		assert.ok(hooks.includes("tool_call"), "Should register tool_call hook");
		assert.ok(hooks.includes("tool_result"), "Should register tool_result hook for line limits");
		// Restore
		if (origRules) process.env.AGENT_DOMAIN_RULES = origRules;
		else delete process.env.AGENT_DOMAIN_RULES;
		if (origRoot) process.env.AGENT_PROJECT_ROOT = origRoot;
		else delete process.env.AGENT_PROJECT_ROOT;
	});

	it("buildDomainEnv produces valid AGENT_DOMAIN_RULES for the guard", () => {
		const domain: DomainRule[] = [
			{ path: "src", read: true, upsert: true, delete: false },
			{ path: "docs", read: true, upsert: false, delete: false },
		];
		const expertise: ExpertiseEntry[] = [
			{ absPath: "/project/config.ts", updatable: true, maxLines: 100 },
		];
		const env = buildDomainEnv(domain, expertise, ["read", "write"], "/project");

		// Verify the guard can parse what buildDomainEnv produces
		const parsedRules = JSON.parse(env.AGENT_DOMAIN_RULES!);
		assert.equal(parsedRules.length, 2);
		assert.equal(parsedRules[0].path, "src");
		assert.equal(parsedRules[0].read, true);

		const parsedExpertise = JSON.parse(env.AGENT_EXPERTISE!);
		assert.equal(parsedExpertise.length, 1);
		assert.equal(parsedExpertise[0].maxLines, 100);

		const parsedTools = JSON.parse(env.AGENT_ALLOWED_TOOLS!);
		assert.deepEqual(parsedTools, ["read", "write"]);
	});

	it("guard rejects invalid AGENT_DOMAIN_RULES gracefully", async () => {
		const mod = await import(GUARD_PATH);
		const hooks: string[] = [];
		const mockPi = {
			on: (event: string, handler: Function) => { hooks.push(event); },
		};
		const origRules = process.env.AGENT_DOMAIN_RULES;
		process.env.AGENT_DOMAIN_RULES = "not-valid-json";
		mod.default(mockPi);
		assert.equal(hooks.length, 0, "Should be no-op on invalid JSON");
		if (origRules) process.env.AGENT_DOMAIN_RULES = origRules;
		else delete process.env.AGENT_DOMAIN_RULES;
	});

	it("guard rejects empty domain rules array", async () => {
		const mod = await import(GUARD_PATH);
		const hooks: string[] = [];
		const mockPi = {
			on: (event: string, handler: Function) => { hooks.push(event); },
		};
		const origRules = process.env.AGENT_DOMAIN_RULES;
		process.env.AGENT_DOMAIN_RULES = "[]";
		mod.default(mockPi);
		assert.equal(hooks.length, 0, "Should be no-op on empty rules");
		if (origRules) process.env.AGENT_DOMAIN_RULES = origRules;
		else delete process.env.AGENT_DOMAIN_RULES;
	});
});
