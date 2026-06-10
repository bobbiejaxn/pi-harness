/**
 * Skill resolution — public API.
 * Internal implementation lives in skill-internal.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import {
	type ResolvedSkill,
	type CachedSkillEntry,
	type SkillSource,
	skillCache,
	loadSkillsCache,
	getCachedSkills,
	stripSkillFrontmatter,
	MAX_CACHE_SIZE,
	SUBAGENT_ORCHESTRATION_SKILL,
	clearSkillCache,
} from "./skill-internal.ts";

export type { SkillSource } from "./skill-internal.ts";

export function resolveSkillPath(
	skillName: string,
	cwd: string,
): { path: string; source: SkillSource } | undefined {
	const skills = getCachedSkills(cwd);
	const skill = skills.find((s) => s.name === skillName);
	if (!skill) return undefined;
	return { path: skill.filePath, source: skill.source };
}

export function readSkill(
	skillName: string,
	skillPath: string,
	source: SkillSource,
): ResolvedSkill | undefined {
	try {
		const stat = fs.statSync(skillPath);
		const cached = skillCache.get(skillPath);
		if (cached && cached.mtime === stat.mtimeMs) {
			return cached.skill;
		}

		const raw = fs.readFileSync(skillPath, "utf-8");
		const content = stripSkillFrontmatter(raw);
		const skill: ResolvedSkill = {
			name: skillName,
			path: skillPath,
			content,
			source,
		};

		skillCache.set(skillPath, { mtime: stat.mtimeMs, skill });
		if (skillCache.size > MAX_CACHE_SIZE) {
			const firstKey = skillCache.keys().next().value;
			if (firstKey) skillCache.delete(firstKey);
		}

		return skill;
	} catch {
		// Treat unreadable skill files as unresolved so callers can surface as missing.
		return undefined;
	}
}

export function resolveSkills(
	skillNames: string[],
	cwd: string,
): { resolved: ResolvedSkill[]; missing: string[] } {
	const resolved: ResolvedSkill[] = [];
	const missing: string[] = [];

	for (const name of skillNames) {
		const trimmed = name.trim();
		if (!trimmed) continue;
		if (trimmed === SUBAGENT_ORCHESTRATION_SKILL) {
			missing.push(trimmed);
			continue;
		}

		const location = resolveSkillPath(trimmed, cwd);
		if (!location) {
			missing.push(trimmed);
			continue;
		}

		const skill = readSkill(trimmed, location.path, location.source);
		if (skill) {
			resolved.push(skill);
		} else {
			missing.push(trimmed);
		}
	}

	return { resolved, missing };
}

export function resolveSkillsWithFallback(
	skillNames: string[],
	primaryCwd: string,
	fallbackCwd?: string,
): { resolved: ResolvedSkill[]; missing: string[] } {
	const primary = resolveSkills(skillNames, primaryCwd);
	if (!fallbackCwd || primary.missing.length === 0) return primary;
	if (path.resolve(primaryCwd) === path.resolve(fallbackCwd)) return primary;

	const fallback = resolveSkills(primary.missing, fallbackCwd);
	return {
		resolved: [...primary.resolved, ...fallback.resolved],
		missing: fallback.missing,
	};
}

export function buildSkillInjection(skills: ResolvedSkill[]): string {
	if (skills.length === 0) return "";

	return skills
		.map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
		.join("\n\n");
}

export function normalizeSkillInput(
	input: string | string[] | boolean | undefined,
): string[] | false | undefined {
	if (input === false) return false;
	if (input === true || input === undefined) return undefined;
	if (Array.isArray(input)) {
		return [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
	}
	// Guard against JSON-encoded arrays arriving as strings (e.g. '["a","b"]').
	// Models sometimes serialise the skill parameter as a JSON string instead of
	// a native array, and naively splitting on "," would embed brackets/quotes
	// into the skill names, causing resolution to silently fail.
	const trimmed = input.trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return normalizeSkillInput(parsed);
			}
		} catch {
			// Not valid JSON – fall through to comma-split
		}
	}
	return [...new Set(input.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

export function discoverAvailableSkills(cwd: string): Array<{
	name: string;
	source: SkillSource;
	description?: string;
}> {
	const skills = getCachedSkills(cwd);
	return skills
		.filter((s) => s.name !== SUBAGENT_ORCHESTRATION_SKILL)
		.map((s) => ({
			name: s.name,
			source: s.source,
			description: s.description,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export { clearSkillCache };

