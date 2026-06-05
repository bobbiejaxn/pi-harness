import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isDomainAllowed,
	isToolAllowed as isDomainToolAllowed,
	checkExpertise,
	normalizePath,
	buildDomainBlock,
	aggregatePermissions,
	buildDomainEnv,
	BASH_WRITE_PATTERNS,
	BASH_DELETE_PATTERNS,
} from "../../src/shared/domain-enforcement.ts";
import type { DomainRule, ExpertiseEntry } from "../../src/shared/domain-enforcement.ts";

describe("domain-enforcement", () => {
	const root = "/home/user/project";

	describe("normalizePath", () => {
		it("strips project root prefix", () => {
			assert.equal(normalizePath("/home/user/project/src/foo.ts", root), "src/foo.ts");
		});
		it("strips ./ prefix", () => {
			assert.equal(normalizePath("./src/foo.ts", root), "src/foo.ts");
		});
		it("returns . for root path", () => {
			assert.equal(normalizePath("/home/user/project", root), ".");
		});
		it("passes through relative paths", () => {
			assert.equal(normalizePath("src/foo.ts", root), "src/foo.ts");
		});
	});

	describe("isDomainAllowed", () => {
		it("returns true when no domain rules (permissive default)", () => {
			assert.equal(isDomainAllowed("anything", "read", [], root), true);
		});
		it("returns true when domain is undefined", () => {
			assert.equal(isDomainAllowed("anything", "read", undefined as any, root), true);
		});

		describe("with root rule", () => {
			const domain: DomainRule[] = [{ path: ".", read: true, upsert: true, delete: false }];

			it("allows read", () => {
				assert.equal(isDomainAllowed("src/foo.ts", "read", domain, root), true);
			});
			it("allows upsert", () => {
				assert.equal(isDomainAllowed("src/foo.ts", "upsert", domain, root), true);
			});
			it("denies delete", () => {
				assert.equal(isDomainAllowed("src/foo.ts", "delete", domain, root), false);
			});
		});

		describe("with scoped rule", () => {
			const domain: DomainRule[] = [
				{ path: "src", read: true, upsert: false, delete: false },
			];

			it("allows read under src/", () => {
				assert.equal(isDomainAllowed("src/main.ts", "read", domain, root), true);
			});
			it("denies write under src/", () => {
				assert.equal(isDomainAllowed("src/main.ts", "upsert", domain, root), false);
			});
			it("denies read outside src/", () => {
				assert.equal(isDomainAllowed("docs/readme.md", "read", domain, root), false);
			});
		});

		describe("with multiple rules", () => {
			const domain: DomainRule[] = [
				{ path: "src", read: true, upsert: true, delete: false },
				{ path: "docs", read: true, upsert: false, delete: false },
			];

			it("allows src write", () => {
				assert.equal(isDomainAllowed("src/main.ts", "upsert", domain, root), true);
			});
			it("denies docs write", () => {
				assert.equal(isDomainAllowed("docs/api.md", "upsert", domain, root), false);
			});
			it("allows docs read", () => {
				assert.equal(isDomainAllowed("docs/api.md", "read", domain, root), true);
			});
		});
	});

	describe("checkExpertise", () => {
		const expertise: ExpertiseEntry[] = [
			{ absPath: "/home/user/project/src/config.ts", updatable: true, maxLines: 100 },
			{ absPath: "/home/user/project/README.md", updatable: false },
		];

		it("allows read for any expertise file", () => {
			assert.equal(checkExpertise("src/config.ts", "read", expertise, root), true);
		});
		it("allows upsert for updatable file", () => {
			assert.equal(checkExpertise("src/config.ts", "upsert", expertise, root), true);
		});
		it("denies upsert for read-only expertise file", () => {
			assert.equal(checkExpertise("README.md", "upsert", expertise, root), false);
		});
		it("returns null for non-expertise file", () => {
			assert.equal(checkExpertise("src/other.ts", "read", expertise, root), null);
		});
		it("returns null when no expertise entries", () => {
			assert.equal(checkExpertise("src/config.ts", "read", [], root), null);
		});
	});

	describe("isDomainToolAllowed", () => {
		it("returns true when no allowlist", () => {
			assert.equal(isDomainToolAllowed("bash"), true);
		});
		it("returns true when empty allowlist", () => {
			assert.equal(isDomainToolAllowed("bash", []), true);
		});
		it("returns true when tool in allowlist", () => {
			assert.equal(isDomainToolAllowed("bash", ["read", "bash"]), true);
		});
		it("returns false when tool not in allowlist", () => {
			assert.equal(isDomainToolAllowed("bash", ["read"]), false);
		});
	});

	describe("buildDomainBlock", () => {
		it("returns empty string for no rules", () => {
			assert.equal(buildDomainBlock([], root), "");
		});
		it("generates markdown block", () => {
			const domain: DomainRule[] = [
				{ path: "src", read: true, upsert: true, delete: false },
			];
			const block = buildDomainBlock(domain, root);
			assert.ok(block.includes("restricted"));
			assert.ok(block.includes("read"));
			assert.ok(block.includes("write/edit"));
		});
	});

	describe("aggregatePermissions", () => {
		it("detects upsert", () => {
			const { anyUpsert, anyDelete } = aggregatePermissions([
				{ path: ".", read: true, upsert: true, delete: false },
			]);
			assert.equal(anyUpsert, true);
			assert.equal(anyDelete, false);
		});
		it("detects delete", () => {
			const { anyUpsert, anyDelete } = aggregatePermissions([
				{ path: ".", read: true, upsert: false, delete: true },
			]);
			assert.equal(anyUpsert, false);
			assert.equal(anyDelete, true);
		});
		it("detects expertise upsert", () => {
			const { anyUpsert } = aggregatePermissions(
				[{ path: "src", read: true, upsert: false, delete: false }],
				[{ absPath: "/foo", updatable: true }],
			);
			assert.equal(anyUpsert, true);
		});
	});

	describe("buildDomainEnv", () => {
		it("sets AGENT_PROJECT_ROOT always", () => {
			const env = buildDomainEnv([], [], [], root);
			assert.equal(env.AGENT_PROJECT_ROOT, root);
		});
		it("sets AGENT_DOMAIN_RULES when rules present", () => {
			const env = buildDomainEnv([{ path: "src", read: true, upsert: false, delete: false }], [], [], root);
			assert.ok(env.AGENT_DOMAIN_RULES);
			const parsed = JSON.parse(env.AGENT_DOMAIN_RULES);
			assert.equal(parsed.length, 1);
		});
		it("sets AGENT_EXPERTISE when entries present", () => {
			const env = buildDomainEnv([], [{ absPath: "/foo", updatable: true }], [], root);
			assert.ok(env.AGENT_EXPERTISE);
		});
		it("sets AGENT_ALLOWED_TOOLS when tools present", () => {
			const env = buildDomainEnv([], [], ["read", "write"], root);
			assert.ok(env.AGENT_ALLOWED_TOOLS);
			const parsed = JSON.parse(env.AGENT_ALLOWED_TOOLS);
			assert.deepEqual(parsed, ["read", "write"]);
		});
		it("omits empty arrays", () => {
			const env = buildDomainEnv([], [], [], root);
			assert.equal(env.AGENT_DOMAIN_RULES, undefined);
			assert.equal(env.AGENT_EXPERTISE, undefined);
			assert.equal(env.AGENT_ALLOWED_TOOLS, undefined);
		});
	});

	describe("bash patterns", () => {
		it("write patterns detect > redirect", () => {
			assert.ok(BASH_WRITE_PATTERNS.some(p => p.test("echo foo > bar.txt")));
		});
		it("write patterns detect npm install", () => {
			assert.ok(BASH_WRITE_PATTERNS.some(p => p.test("npm install lodash")));
		});
		it("write patterns do not flag echo to stdout", () => {
			assert.ok(!BASH_WRITE_PATTERNS.some(p => p.test("echo hello world")));
		});
		it("delete patterns detect rm", () => {
			assert.ok(BASH_DELETE_PATTERNS.some(p => p.test("rm -rf /tmp/foo")));
		});
		it("delete patterns detect git clean", () => {
			assert.ok(BASH_DELETE_PATTERNS.some(p => p.test("git clean -fd")));
		});
	});
});
