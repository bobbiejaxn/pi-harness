// Unit tests for the acceptance gates module.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultNodeGates, runGate, runGates } from "../../src/runs/acceptance-gates.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runGate", () => {
	it("returns passed=true on exit 0", async () => {
		const result = await runGate({
			name: "echo",
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
			cwd: tmpDir,
		});
		assert.equal(result.passed, true);
		assert.equal(result.gate, "echo");
		assert.ok(result.durationMs >= 0);
	});

	it("returns passed=false on non-zero exit with reason", async () => {
		const result = await runGate({
			name: "fail",
			command: process.execPath,
			args: ["-e", "process.exit(1)"],
			cwd: tmpDir,
		});
		assert.equal(result.passed, false);
		assert.ok(result.reason, "should have a reason");
		assert.match(result.reason!, /Exit/);
	});

	it("captures stdout and stderr", async () => {
		const result = await runGate({
			name: "io",
			command: process.execPath,
			args: ["-e", "process.stdout.write('hello'); process.stderr.write('world')"],
			cwd: tmpDir,
		});
		assert.equal(result.passed, true);
		assert.match(result.stdout!, /hello/);
		assert.match(result.stderr!, /world/);
	});

	it("truncates long output", async () => {
		const longOut = "x".repeat(10_000);
		const result = await runGate({
			name: "long",
			command: process.execPath,
			args: ["-e", `process.stdout.write('${longOut}')`],
			cwd: tmpDir,
		});
		assert.equal(result.passed, true);
		assert.ok(result.stdout!.length < 6000, "should truncate");
		assert.match(result.stdout!, /truncated/);
	});

	it("returns passed=false on timeout", async () => {
		const result = await runGate({
			name: "slow",
			command: process.execPath,
			args: ["-e", "setTimeout(() => {}, 10000)"],
			cwd: tmpDir,
			timeoutMs: 200,
		});
		assert.equal(result.passed, false);
		assert.match(result.reason!, /Timeout/);
	});
});

describe("runGates", () => {
	it("runs all gates and reports aggregate", async () => {
		const gates = [
			{ name: "a", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir },
			{ name: "b", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir },
			{ name: "c", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir },
		];
		const result = await runGates(gates);
		assert.equal(result.allPassed, true);
		assert.equal(result.results.length, 3);
		assert.equal(result.requiredFailures, 0);
	});

	it("fail-fast stops on first required failure", async () => {
		const gates = [
			{ name: "a", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir },
			{ name: "b", command: process.execPath, args: ["-e", "process.exit(1)"], cwd: tmpDir },
			{ name: "c", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir, required: true },
		];
		const result = await runGates(gates, { failFast: true });
		assert.equal(result.allPassed, false);
		assert.equal(result.results.length, 2, "should stop after b fails");
		assert.equal(result.requiredFailures, 1);
	});

	it("optional gate failure does not block", async () => {
		const gates = [
			{ name: "a", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir, required: true },
			{ name: "b-optional", command: process.execPath, args: ["-e", "process.exit(1)"], cwd: tmpDir, required: false },
			{ name: "c", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir, required: true },
		];
		const result = await runGates(gates, { failFast: false });
		assert.equal(result.allPassed, true, "optional failure should not fail run");
		assert.equal(result.results.length, 3);
		assert.equal(result.requiredFailures, 0);
	});

	it("non-fail-fast runs all gates even after failure", async () => {
		const gates = [
			{ name: "fail", command: process.execPath, args: ["-e", "process.exit(1)"], cwd: tmpDir },
			{ name: "ok", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: tmpDir },
		];
		const result = await runGates(gates, { failFast: false });
		assert.equal(result.results.length, 2);
		assert.equal(result.allPassed, false);
	});
});

describe("defaultNodeGates", () => {
	it("returns 4 standard gates", () => {
		const gates = defaultNodeGates(tmpDir);
		assert.equal(gates.length, 4);
		const names = gates.map((g) => g.name);
		assert.ok(names.includes("typecheck"));
		assert.ok(names.includes("lint"));
		assert.ok(names.includes("test"));
		assert.ok(names.includes("build"));
	});

	it("marks typecheck and test as required, lint and build as optional", () => {
		const gates = defaultNodeGates(tmpDir);
		const byName = Object.fromEntries(gates.map((g) => [g.name, g]));
		assert.equal(byName.typecheck.required, true);
		assert.equal(byName.test.required, true);
		assert.equal(byName.lint.required, false);
		assert.equal(byName.build.required, false);
	});

	it("detects pnpm from pnpm-lock.yaml", () => {
		fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
		const gates = defaultNodeGates(tmpDir);
		const typecheck = gates.find((g) => g.name === "typecheck")!;
		assert.deepEqual(typecheck.args, ["tsc", "--noEmit"]);
		// The command is "npx" for pnpm/yarn/bun to ensure tsc is found
		assert.match(typecheck.command, /npx|pnpm|yarn|bun/);
	});
});
