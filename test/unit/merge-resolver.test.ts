/**
 * Tests for the tiered merge resolver.
 *
 * Tests the pure helpers (conflict parsing, prose detection) with real data.
 * Tier tests mock git via execSync — no actual git repo needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveConflictsKeepIncoming,
	resolveConflictsUnion,
	hasContentfulCanonical,
	looksLikeProse,
} from "../../src/shared/merge-resolver.ts";

// ── Conflict parsing fixtures ────────────────────────────────────────────────

const CONFLICT_SIMPLE = `<<<<<<< HEAD
const x = 1;
=======
const x = 2;
>>>>>>> feature-branch
`;

const CONFLICT_MULTI = `// file header
<<<<<<< HEAD
import { a } from "a";
import { b } from "b";
=======
import { a } from "a";
import { c } from "c";
>>>>>>> feature-branch
// rest of file
`;

const CONFLICT_CANONICAL_CONTENT = `<<<<<<< HEAD
this is real code on the canonical side
function important() { return 42; }
=======
const x = 2;
>>>>>>> feature-branch
`;

const CONFLICT_EMPTY_CANONICAL = `<<<<<<< HEAD
=======
const newFunction = () => "hello";
>>>>>>> feature-branch
`;

const NO_CONFLICT = `const x = 1;
const y = 2;
`;

// ── resolveConflictsKeepIncoming ──────────────────────────────────────────────

describe("resolveConflictsKeepIncoming", () => {
	it("extracts incoming side from a simple conflict", () => {
		const result = resolveConflictsKeepIncoming(CONFLICT_SIMPLE);
		assert.ok(result);
		assert.ok(result!.includes('const x = 2;'));
		assert.ok(!result!.includes('const x = 1;'));
		assert.ok(!result!.includes('<<<<<<<'));
		assert.ok(!result!.includes('======='));
	});

	it("extracts incoming side from multi-line conflict", () => {
		const result = resolveConflictsKeepIncoming(CONFLICT_MULTI);
		assert.ok(result);
		assert.ok(result!.includes('import { c } from "c";'));
		assert.ok(!result!.includes('import { b } from "b";'));
		// Shared context preserved
		assert.ok(result!.includes("// file header"));
	});

	it("returns null when no conflict markers", () => {
		assert.equal(resolveConflictsKeepIncoming(NO_CONFLICT), null);
	});

	it("returns null for empty string", () => {
		assert.equal(resolveConflictsKeepIncoming(""), null);
	});
});

// ── resolveConflictsUnion ────────────────────────────────────────────────────

describe("resolveConflictsUnion", () => {
	it("keeps both sides in a union merge", () => {
		const result = resolveConflictsUnion(CONFLICT_SIMPLE);
		assert.ok(result);
		assert.ok(result!.includes('const x = 1;'));
		assert.ok(result!.includes('const x = 2;'));
	});

	it("returns null when no conflict markers", () => {
		assert.equal(resolveConflictsUnion(NO_CONFLICT), null);
	});
});

// ── hasContentfulCanonical ───────────────────────────────────────────────────

describe("hasContentfulCanonical", () => {
	it("returns true when canonical side has content", () => {
		assert.equal(hasContentfulCanonical(CONFLICT_CANONICAL_CONTENT), true);
	});

	it("returns false when canonical side is empty", () => {
		assert.equal(hasContentfulCanonical(CONFLICT_EMPTY_CANONICAL), false);
	});

	it("returns false when canonical side is whitespace only", () => {
		const ws = `<<<<<<< HEAD\n   \n\t\n=======\ncode here\n>>>>>>> branch\n`;
		assert.equal(hasContentfulCanonical(ws), false);
	});

	it("returns false when no conflict markers", () => {
		assert.equal(hasContentfulCanonical(NO_CONFLICT), false);
	});
});

// ── looksLikeProse ───────────────────────────────────────────────────────────

describe("looksLikeProse", () => {
	it("detects AI apology patterns", () => {
		assert.equal(looksLikeProse("I'm sorry, I can't do that."), true);
		assert.equal(looksLikeProse("Unfortunately, I don't have access to that file."), true);
		assert.equal(looksLikeProse("Apologies for the confusion. Here's what I found:"), true);
	});

	it("detects explanatory responses", () => {
		assert.equal(looksLikeProse("Let me analyze the conflict markers."), true);
		assert.equal(looksLikeProse("Based on the code, the correct resolution is:"), true);
		assert.equal(looksLikeProse("Here's the resolved content:"), true);
	});

	it("detects permission/refusal patterns", () => {
		assert.equal(looksLikeProse("I need permission to write to that file."), true);
		assert.equal(looksLikeProse("I cannot resolve this conflict automatically."), true);
		assert.equal(looksLikeProse("I don't have access to the file system."), true);
	});

	it("returns true for empty string", () => {
		assert.equal(looksLikeProse(""), true);
	});

	it("returns true for whitespace only", () => {
		assert.equal(looksLikeProse("   \n\t  "), true);
	});

	it("returns false for actual code", () => {
		assert.equal(looksLikeProse("const x = 1;"), false);
		assert.equal(looksLikeProse("export function hello() { return 'world'; }"), false);
		assert.equal(looksLikeProse("import { readFileSync } from 'node:fs';"), false);
	});

	it("returns false for JSON/YAML content", () => {
		assert.equal(looksLikeProse('{"key": "value"}'), false);
		assert.equal(looksLikeProse("name: my-project\nversion: 1.0.0"), false);
	});

	it("returns false for HTML/markup", () => {
		assert.equal(looksLikeProse("<div class=\"container\">Hello</div>"), false);
	});
});
