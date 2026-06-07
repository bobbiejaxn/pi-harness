#!/usr/bin/env node

/**
 * pi-harness installer — project-level only.
 *
 * Installs the pi-harness subagent extension to the current project's
 * `.pi/extensions/subagent/` directory. Never installs to user-level.
 *
 * Usage:
 *   cd /path/to/your/project
 *   node install.mjs              # Install to .pi/extensions/subagent/
 *   node install.mjs --remove     # Remove the extension
 *   node install.mjs --check      # Check if installed and report version
 *   node install.mjs --update     # Pull latest from GitHub and reinstall
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const GITHUB_REPO = "bobbiejaxn/pi-harness";
const EXTENSION_DIR_NAME = "subagent";

function getProjectRoot() {
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

function getExtensionDir(projectRoot) {
	return path.join(projectRoot, ".pi", "extensions", EXTENSION_DIR_NAME);
}

function install(projectRoot) {
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
		console.warn("   Remove it: rm -rf ~/.pi/agent/extensions/subagent");
		console.warn("");
	}

	// If existing install, remove old files first (clean install)
	if (fs.existsSync(extDir)) {
		console.log("Removing previous installation...");
		fs.rmSync(extDir, { recursive: true });
	}

	console.log(`Cloning from github.com/${GITHUB_REPO}...`);
	try {
		execSync(`git clone https://github.com/${GITHUB_REPO}.git "${extDir}"`, {
			stdio: "inherit",
		});
	} catch {
		console.error("Failed to clone. Check your network and GitHub access.");
		process.exit(1);
	}

	// Verify installation
	const indexPath = path.join(extDir, "src", "extension", "index.ts");
	if (!fs.existsSync(indexPath)) {
		console.error(`Installation incomplete: ${indexPath} not found.`);
		process.exit(1);
	}

	// Install runtime dependencies. The extension's package.json declares
	// `typebox`, `jiti`, and `@earendil-works/pi-tui` as dependencies, but
	// a bare `git clone` doesn't materialize `node_modules/`. Without this
	// step, every `typebox`/`typebox/compile` import in the extension throws
	// `Cannot find package 'typebox'` at load time and the extension fails to
	// register its tools. See: https://github.com/bobbiejaxn/pi-harness/issues
	// (regression: #1208 era — the original installer shipped before
	// `typebox` was added to the dep list).
	//
	// We use `npm install --omit=dev` to avoid pulling test deps. The install
	// is scoped to the extension directory; nothing leaks to user-level.
	// If `npm` is unavailable (extremely rare), warn and continue — the
	// user can run `npm install` in the extension dir manually.
	console.log("Installing runtime dependencies...");
	try {
		execSync("npm install --omit=dev --no-audit --no-fund --loglevel=error", {
			cwd: extDir,
			stdio: "inherit",
		});
	} catch (e) {
		console.warn("⚠️  npm install failed (extension may not load at runtime).");
		console.warn(`   Run manually: cd "${extDir}" && npm install --omit=dev`);
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

function remove(projectRoot) {
	const extDir = getExtensionDir(projectRoot);
	if (fs.existsSync(extDir)) {
		fs.rmSync(extDir, { recursive: true });
		console.log(`pi-harness removed from ${extDir}`);
	} else {
		console.log("pi-harness is not installed in this project");
	}
}

function check(projectRoot) {
	const extDir = getExtensionDir(projectRoot);
	if (!fs.existsSync(extDir)) {
		console.log("pi-harness: not installed in this project");
		return;
	}

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

function update(projectRoot) {
	const extDir = getExtensionDir(projectRoot);
	if (!fs.existsSync(extDir)) {
		console.log("pi-harness is not installed. Run install first.");
		process.exit(1);
	}
	console.log("Pulling latest...");
	try {
		execSync(`git -C "${extDir}" pull`, { stdio: "inherit" });
		console.log("✅ pi-harness updated");
	} catch {
		console.error("Update failed. Try removing and reinstalling:");
		console.error("  node install.mjs --remove && node install.mjs");
		process.exit(1);
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const projectRoot = getProjectRoot();

if (args.includes("--help") || args.includes("-h")) {
	console.log(`
pi-harness - Project-level subagent execution engine for pi

Usage:
  node install.mjs              Install to .pi/extensions/subagent/
  node install.mjs --remove     Remove from this project
  node install.mjs --check      Check installation status
  node install.mjs --update     Pull latest from GitHub

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
