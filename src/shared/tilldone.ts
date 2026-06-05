/**
 * TillDone — Structured task list state machine for multi-task delegation.
 *
 * Ported from pi_launchpad's apps/multi-team-chat/extensions/modules/tilldone.ts.
 *
 * Pure state machine — no side effects, no I/O.
 * The extension layer wires it to the TUI and agent loop.
 *
 * Lifecycle:
 *   1. `createState()` → empty state
 *   2. `addTask()` / `addTasks()` → populate tasks
 *   3. `startTask()` → mark in progress
 *   4. `doneTask()` → mark complete
 *   5. `clearState()` → reset
 *
 * All mutations are idempotent — calling `doneTask()` on an already-done task
 * is a no-op, and `startTask()` won't regress a done task back to inprogress.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Task lifecycle stages. Transitions: idle → inprogress → done. */
export type TaskStatus = "idle" | "inprogress" | "done";

/** A single task in the list. */
export interface TillDoneTask {
	id: number;
	text: string;
	status: TaskStatus;
	/** Optional team/agent name this task is assigned to. */
	team?: string;
	/** Optional hex color for TUI rendering. */
	teamColor?: string;
}

/** The full TillDone state — title, description, ordered task list, and auto-incrementing ID counter. */
export interface TillDoneState {
	title: string;
	description?: string;
	tasks: TillDoneTask[];
	nextId: number;
}

/** A discrete mutation to apply to the task list. Used for batching and remote sync. */
export interface TillDoneMutation {
	action: "start" | "done";
	id: number;
	team?: string;
	teamColor?: string;
}

// ── Status Icons ─────────────────────────────────────────────────────────────

/** Visual icons for each task status. ○ = idle, ● = inprogress, ✓ = done. */
export const STATUS_ICON: Record<TaskStatus, string> = {
	idle: "○",
	inprogress: "●",
	done: "✓",
};

// ── State Factory ────────────────────────────────────────────────────────────

/** Create an empty TillDone state with no tasks. */
export function createState(): TillDoneState {
	return { title: "", tasks: [], nextId: 1 };
}

// ── Mutations (all idempotent) ───────────────────────────────────────────────

/**
 * Add a single task to the list. Auto-increments the ID counter.
 * @returns The newly created task with status "idle".
 */
export function addTask(
	state: TillDoneState,
	text: string,
	team?: string,
	teamColor?: string,
): TillDoneTask {
	const task: TillDoneTask = { id: state.nextId++, text, status: "idle" };
	if (team) task.team = team;
	if (teamColor) task.teamColor = teamColor;
	state.tasks.push(task);
	return task;
}

/**
 * Add multiple tasks in one call. Delegates to `addTask()` for each.
 * @returns Array of newly created tasks.
 */
export function addTasks(
	state: TillDoneState,
	texts: string[],
	team?: string,
	teamColor?: string,
): TillDoneTask[] {
	return texts.map(t => addTask(state, t, team, teamColor));
}

/**
 * Mark a task as inprogress.
 * **Idempotent:** if the task is already done, it stays done (no regression).
 * @returns The updated task, or null if ID not found.
 */
export function startTask(
	state: TillDoneState,
	id: number,
	team?: string,
	teamColor?: string,
): TillDoneTask | null {
	const task = state.tasks.find(t => t.id === id);
	if (!task) return null;
	if (task.status === "done") return task;
	task.status = "inprogress";
	if (team) task.team = team;
	if (teamColor) task.teamColor = teamColor;
	return task;
}

/**
 * Mark a task as done.
 * **Idempotent:** calling on an already-done task is a no-op.
 * @returns The updated task, or null if ID not found.
 */
export function doneTask(state: TillDoneState, id: number): TillDoneTask | null {
	const task = state.tasks.find(t => t.id === id);
	if (!task) return null;
	task.status = "done";
	return task;
}

/**
 * Update a task's text content.
 * @returns The updated task, or null if ID not found.
 */
export function updateTask(
	state: TillDoneState,
	id: number,
	text: string,
): TillDoneTask | null {
	const task = state.tasks.find(t => t.id === id);
	if (!task) return null;
	task.text = text;
	return task;
}

/**
 * Remove a task from the list entirely.
 * @returns The removed task, or null if ID not found.
 */
export function removeTask(state: TillDoneState, id: number): TillDoneTask | null {
	const idx = state.tasks.findIndex(t => t.id === id);
	if (idx === -1) return null;
	return state.tasks.splice(idx, 1)[0];
}

/** Reset the state to empty. Clears title, description, all tasks, and resets the ID counter. */
export function clearState(state: TillDoneState): void {
	state.tasks = [];
	state.nextId = 1;
	state.title = "";
	state.description = undefined;
}

/** Apply a discrete mutation (start or done) to the state. Used for batching. */
export function applyMutation(state: TillDoneState, mutation: TillDoneMutation): void {
	switch (mutation.action) {
		case "start":
			startTask(state, mutation.id, mutation.team, mutation.teamColor);
			break;
		case "done":
			doneTask(state, mutation.id);
			break;
	}
}

// ── Query Helpers ────────────────────────────────────────────────────────────

/** Return all tasks that are not yet done (idle or inprogress). */
export function incompleteTasks(state: TillDoneState): TillDoneTask[] {
	return state.tasks.filter(t => t.status !== "done");
}

/** Count of tasks with status "done". */
export function completedCount(state: TillDoneState): number {
	return state.tasks.filter(t => t.status === "done").length;
}

/** Human-readable progress string: `"Sprint 1: 3/5"`. */
export function progressSummary(state: TillDoneState): string {
	const done = completedCount(state);
	const total = state.tasks.length;
	const title = state.title || "TillDone";
	return `${title}: ${done}/${total}`;
}

/** Render each task as a summary line with status icon, ID, status, text, and team. */
export function taskSummaryLines(state: TillDoneState): string[] {
	return state.tasks.map(t =>
		`${STATUS_ICON[t.status]} #${t.id} (${t.status}): ${t.text}${t.team ? ` [${t.team}]` : ""}`
	);
}
