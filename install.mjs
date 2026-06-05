#!/usr/bin/env node

/**
 * pi-harness installer — project-level only.
 *
 * Installs the pi-harness subagent extension to the current project's
 * `.pi/extensions/subagent/` directory. Never installs to user-level
 * (`~/.pi/agent/extensions/`) to avoid conflicts with upstream pi-subagents.
 *
 * ## Why project-level only
 *
 * pi-harness is a heavily customized fork (circuit breaker, session learner,
 * execution guard, domain enforcement). Loading it at user-level would:
 *   1. Conflict with upstream pi-subagents (both register the `subagent` tool)
 *   2. Break projects that depend on the vanilla extension
 *   3. Create implicit, version-uncontrolled dependencies
 *
 * ## Usage
 *
 *   cd /path/to/your/project
 *   npx pi-harness              # Install to .pi/extensions/subagent/
 *   npx pi-harness --remove     # Remove the extension
 *   npx pi-harness --check      # Check if installed and report version
 *   npx pi-harness --update     # Pull latest from GitHub and reinstall
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const GITHUB_REPO = "bobbiejaxn/pi-harness";
const EXTENSION_DIR_NAME = "subagent";

function getProjectRoot(): string {
	// Walk up from cwd to find a package.json, .git, or .pi directory
	let dir = process.cwd();
	for (let i = 0; i < 20; i++) {
		if (
			fs.existsSync(path.join(dir, "package.json")) ||
			fs.existsSync(path.join(dir, ".git")) ||
			fs.existsSync(path.join(dir, ".pi"))
		) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

function getExtensionDir(projectRoot: string): string {
	return path.join(projectRoot, ".pi", "extensions", EXTENSION_DIR_NAME);
}

function install(projectRoot: string): void {
	const extDir = getExtensionDir(projectRoot);

	console.log(`pi-harness: Installing to ${extDir}\n`);

	// Ensure parent directory exists
	fs.mkdirSync(path.dirname(extDir), { recursive: true });

	// Check if user-level subagent exists — warn about conflict
	const userLevel = path.join(
		process.env.HOME || "/dev/null",
		".pi/agent/extensions/subagent",
	);
	if (fs.existsSync(userLevel)) {
		console.warn(`⚠️  WARNING: User-level subagent found at ${userLevel}`);
		console.warn("   This WILL conflict with the project-level extension.");
		console.warn("   Remove it with: mv ~/.pi/agent/extensions/subagent ~/.pi/agent/extensions/.subagent");
		console.warn("");
	}

	if (fs.existsSync(extDir)) {
		console.log("Updating existing project-level installation...");
		try {
			execSync(`git -C "${extDir}" pull`, { stdio: "inherit" });
		} catch {
			// Not a git repo or pull failed — overwrite
			console.log("Pull failed. Replacing with fresh clone...");
			fs.rmSync(extDir, { recursive: true });
		}
	}

	if (!fs.existsSync(extDir)) {
		console.log(`Cloning from github.com/${GITHUB_REPO}...`);
		try {
			execSync(`git clone https://github.com/${GITHUB_REPO}.git "${extDir}"`, {
				stdio: "inherit",
			});
		} catch {
			console.error("Failed to clone. Check your network and GitHub access.");
			process.exit(1);
		}
	}

	// Verify installation
	const indexPath = path.join(extDir, "src", "extension", "index.ts");
	if (!fs.existsSync(indexPath)) {
		console.error(`Installation incomplete: ${indexPath} not found.`);
		process.exit(1);
	}

	console.log(`
✅ pi-harness installed to: ${extDir}

Extension is loaded automatically by pi when you run it in this project.
Do NOT install to ~/.pi/agent/extensions/ — it conflicts with upstream pi-subagents.

Tools added:
  • subagent — Delegate tasks to agents with circuit breaker, session learning,
               execution guard, domain enforcement, cost control, and retry
`);
}

function remove(projectRoot: string): void {
	const extDir = getExtensionDir(projectRoot);
	if (fs.existsSync(extDir)) {
		fs.rmSync(extDir, { recursive: true });
		console.log(`pi-harness removed from ${extDir}`);
	} else {
		console.log("pi-harness is not installed in this project");
	}
}

function check(projectRoot: string): void {
	const extDir = getExtensionDir(projectRoot);
	if (!fs.existsSync(extDir)) {
		console.log("pi-harness: not installed in this project");
		return;
	}

	// Read version from package.json
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf-8"));
		console.log(`pi-harness v${pkg.version} installed at ${extDir}`);
	} catch {
		console.log(`pi-harness installed at ${extDir} (version unknown)`);
	}

	// Check for user-level conflict
	const userLevel = path.join(
		process.env.HOME || "/dev/null",
		".pi/agent/extensions/subagent",
	);
	if (fs.existsSync(userLevel)) {
		console.warn(`⚠️  CONFLICT: User-level subagent at ${userLevel} — this WILL cause tool name conflicts`);
	}
}

function update(projectRoot: string): void {
	const extDir = getExtensionDir(projectRoot);
	if (!fs.existsSync(extDir)) {
		console.log("pi-harness is not installed. Run `npx pi-harness` first.");
		process.exit(1);
	}
	console.log("Pulling latest...");
	try {
		execSync(`git -C "${extDir}" pull`, { stdio: "inherit" });
		console.log("✅ pi-harness updated");
	} catch {
		console.error("Update failed. Try removing and reinstalling:");
		console.error("  npx pi-harness --remove && npx pi-harness");
		process.exit(1);
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const projectRoot = getProjectRoot();

if (args.includes("--help") || args.includes("-h")) {
	console.log(`
pi-harness - Project-level subagent execution engine for pi

Usage:
  npx pi-harness              Install to .pi/extensions/subagent/
  npx pi-harness --remove     Remove from this project
  npx pi-harness --check      Check installation status
  npx pi-harness --update     Pull latest from GitHub

Project root detected: ${projectRoot}

IMPORTANT: This installs at PROJECT level only (.pi/extensions/subagent/).
Never install to ~/.pi/agent/extensions/ — it conflicts with upstream pi-subagents.
`);
	process.exit(0);
}

if (args.includes("--remove") || args.includes("-r")) {
	remove(projectRoot);
} else if (args.includes("--check") || args.includes("-c")) {
	check(projectRoot);
} else if (args.includes("--update") || args.includes("-u")) {
	update(projectRoot);
} else {
	install(projectRoot);
}
