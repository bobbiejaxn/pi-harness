import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createState,
	addTask,
	addTasks,
	startTask,
	doneTask,
	updateTask,
	removeTask,
	clearState,
	applyMutation,
	incompleteTasks,
	completedCount,
	progressSummary,
	taskSummaryLines,
	STATUS_ICON,
} from "../../src/shared/tilldone.ts";
import type { TillDoneState } from "../../src/shared/tilldone.ts";

describe("tilldone", () => {
	describe("createState", () => {
		it("creates empty state", () => {
			const s = createState();
			assert.equal(s.title, "");
			assert.equal(s.tasks.length, 0);
			assert.equal(s.nextId, 1);
		});
	});

	describe("addTask", () => {
		it("adds a task with auto-incrementing ID", () => {
			const s = createState();
			const t = addTask(s, "Write tests");
			assert.equal(t.id, 1);
			assert.equal(t.text, "Write tests");
			assert.equal(t.status, "idle");
			assert.equal(s.tasks.length, 1);
		});
		it("adds multiple tasks with sequential IDs", () => {
			const s = createState();
			addTask(s, "A");
			addTask(s, "B");
			addTask(s, "C");
			assert.equal(s.tasks.length, 3);
			assert.equal(s.tasks[0].id, 1);
			assert.equal(s.tasks[1].id, 2);
			assert.equal(s.tasks[2].id, 3);
		});
		it("assigns team and color", () => {
			const s = createState();
			const t = addTask(s, "Build feature", "Engineering", "#72f1b8");
			assert.equal(t.team, "Engineering");
			assert.equal(t.teamColor, "#72f1b8");
		});
	});

	describe("addTasks", () => {
		it("batch adds tasks", () => {
			const s = createState();
			const tasks = addTasks(s, ["A", "B", "C"]);
			assert.equal(tasks.length, 3);
			assert.equal(s.tasks.length, 3);
		});
		it("batch adds with team", () => {
			const s = createState();
			const tasks = addTasks(s, ["A", "B"], "QA", "#ff6e96");
			assert.equal(tasks[0].team, "QA");
			assert.equal(tasks[1].teamColor, "#ff6e96");
		});
	});

	describe("startTask", () => {
		it("transitions idle → inprogress", () => {
			const s = createState();
			addTask(s, "A");
			const t = startTask(s, 1);
			assert.equal(t?.status, "inprogress");
		});
		it("does not regress done → inprogress", () => {
			const s = createState();
			addTask(s, "A");
			doneTask(s, 1);
			const t = startTask(s, 1);
			assert.equal(t?.status, "done");
		});
		it("returns null for non-existent ID", () => {
			const s = createState();
			assert.equal(startTask(s, 999), null);
		});
	});

	describe("doneTask", () => {
		it("transitions to done", () => {
			const s = createState();
			addTask(s, "A");
			startTask(s, 1);
			const t = doneTask(s, 1);
			assert.equal(t?.status, "done");
		});
		it("idempotent — done stays done", () => {
			const s = createState();
			addTask(s, "A");
			doneTask(s, 1);
			const t = doneTask(s, 1);
			assert.equal(t?.status, "done");
		});
		it("returns null for non-existent ID", () => {
			const s = createState();
			assert.equal(doneTask(s, 999), null);
		});
	});

	describe("updateTask", () => {
		it("updates task text", () => {
			const s = createState();
			addTask(s, "Old text");
			const t = updateTask(s, 1, "New text");
			assert.equal(t?.text, "New text");
		});
		it("returns null for non-existent ID", () => {
			const s = createState();
			assert.equal(updateTask(s, 999, "x"), null);
		});
	});

	describe("removeTask", () => {
		it("removes a task", () => {
			const s = createState();
			addTask(s, "A");
			addTask(s, "B");
			const removed = removeTask(s, 1);
			assert.equal(removed?.text, "A");
			assert.equal(s.tasks.length, 1);
			assert.equal(s.tasks[0].id, 2);
		});
		it("returns null for non-existent ID", () => {
			const s = createState();
			assert.equal(removeTask(s, 999), null);
		});
	});

	describe("clearState", () => {
		it("resets everything", () => {
			const s = createState();
			s.title = "Sprint 1";
			s.description = "Build MVP";
			addTask(s, "A");
			addTask(s, "B");
			clearState(s);
			assert.equal(s.title, "");
			assert.equal(s.description, undefined);
			assert.equal(s.tasks.length, 0);
			assert.equal(s.nextId, 1);
		});
	});

	describe("applyMutation", () => {
		it("applies start mutation", () => {
			const s = createState();
			addTask(s, "A");
			applyMutation(s, { action: "start", id: 1 });
			assert.equal(s.tasks[0].status, "inprogress");
		});
		it("applies done mutation", () => {
			const s = createState();
			addTask(s, "A");
			applyMutation(s, { action: "done", id: 1 });
			assert.equal(s.tasks[0].status, "done");
		});
		it("applies start mutation with team", () => {
			const s = createState();
			addTask(s, "A");
			applyMutation(s, { action: "start", id: 1, team: "Eng", teamColor: "#72f1b8" });
			assert.equal(s.tasks[0].team, "Eng");
		});
	});

	describe("query helpers", () => {
		const setupState = (): TillDoneState => {
			const s = createState();
			s.title = "Sprint";
			addTask(s, "A");
			addTask(s, "B");
			addTask(s, "C");
			doneTask(s, 1);
			startTask(s, 2);
			return s;
		};

		it("incompleteTasks returns non-done tasks", () => {
			const s = setupState();
			const inc = incompleteTasks(s);
			assert.equal(inc.length, 2);
		});

		it("completedCount returns done count", () => {
			const s = setupState();
			assert.equal(completedCount(s), 1);
		});

		it("progressSummary formats correctly", () => {
			const s = setupState();
			assert.equal(progressSummary(s), "Sprint: 1/3");
		});

		it("taskSummaryLines generates lines", () => {
			const s = setupState();
			const lines = taskSummaryLines(s);
			assert.equal(lines.length, 3);
			assert.ok(lines[0].includes("done"));
			assert.ok(lines[1].includes("inprogress"));
			assert.ok(lines[2].includes("idle"));
		});
	});

	describe("STATUS_ICON", () => {
		it("has icons for all statuses", () => {
			assert.ok(STATUS_ICON.idle);
			assert.ok(STATUS_ICON.inprogress);
			assert.ok(STATUS_ICON.done);
		});
	});
});
