// Cron — in-process scheduler for periodic jobs.
//
// The manifesto (system-design.md §1.4) defines a sweep cron that runs
// every 30 min during active work. This module is the foundation: a
// minimal, testable scheduler that:
//   - Holds named jobs with intervals (no crontab syntax for simplicity)
//   - Runs them in a single Node process, with bounded concurrency
//   - Catches errors so one bad job doesn't kill the loop
//   - Is restartable: state is reconstructed from the runs directory
//
// Per Manifesto V.19 ("assume it breaks"), every job run is wrapped in:
//   - A try/catch (no swallowed exceptions)
//   - A DLQ entry on terminal failure (the same JSONL trace file the
//     trace recorder writes to)
//
// Per Manifesto III.11, schedules live in config, never hardcoded.

import * as fs from "node:fs";
import * as path from "node:path";
import { TraceRecorder } from "../shared/trace-recorder.ts";

/** Definition of a single cron job. */
export interface CronJob {
	/** Human-readable name. */
	name: string;
	/** Run interval in milliseconds. */
	intervalMs: number;
	/** The function to invoke on each tick. */
	run: (ctx: CronContext) => Promise<void>;
	/** Whether to fire immediately on start. Default: false. */
	runOnStart?: boolean;
	/** Max consecutive failures before the job is paused. Default: 5. */
	maxFailures?: number;
}

/** Context provided to each job run. */
export interface CronContext {
	/** Unique ID for this run (UUID). */
	runId: string;
	/** When the run started (ISO timestamp). */
	startedAt: string;
	/** When the previous successful run completed, if any. */
	lastSuccessAt?: string;
	/** Number of consecutive failures before this run. */
	consecutiveFailures: number;
	/** TraceRecorder for emitting events about this run. */
	recorder: TraceRecorder;
}

/** Internal state for a single job. */
interface JobState {
	job: CronJob;
	running: boolean;
	timer?: NodeJS.Timeout;
	consecutiveFailures: number;
	lastSuccessAt?: string;
	lastRunAt?: string;
	paused: boolean;
	dlqPath: string;
}

/** Configuration for a Cron instance. */
export interface CronConfig {
	/** TraceRecorder for emitting cron events. */
	recorder: TraceRecorder;
	/** Directory for DLQ files (one .jsonl per failed job). */
	dlqDir: string;
	/** Optional logger. */
	log?: (level: "info" | "warn" | "error", msg: string) => void;
}

/**
 * The Cron scheduler. Holds a set of named jobs, runs them on their
 * intervals, and handles failures gracefully.
 *
 * Usage:
 *   const cron = new Cron({ recorder, dlqDir: ".pi/traces/cron-dlq" });
 *   cron.register({ name: "trace-summarizer", intervalMs: 30 * 60_000, run: summarizeTraces });
 *   cron.start();
 *   // ...
 *   await cron.stop();
 */
export class Cron {
	private readonly jobs: Map<string, JobState> = new Map();
	private readonly config: CronConfig;
	private started = false;

	constructor(config: CronConfig) {
		this.config = config;
		fs.mkdirSync(config.dlqDir, { recursive: true });
	}

	/** Register a new job. Throws if a job with this name is already registered. */
	register(job: CronJob): void {
		if (this.jobs.has(job.name)) {
			throw new Error(`Job '${job.name}' is already registered`);
		}
		if (job.intervalMs < 100) {
			throw new Error(`Job '${job.name}' interval too small (${job.intervalMs}ms); minimum is 100ms`);
		}
		this.jobs.set(job.name, {
			job,
			running: false,
			consecutiveFailures: 0,
			paused: false,
			dlqPath: path.join(this.config.dlqDir, `${job.name}.jsonl`),
		});
		this.log("info", `Registered job: ${job.name} (interval=${job.intervalMs}ms)`);
	}

	/** Start the scheduler. If `runOnStart` is true, each job runs once on start. */
	start(): void {
		if (this.started) return;
		this.started = true;

		for (const [, state] of this.jobs) {
			if (state.job.runOnStart) {
				this.tick(state).catch(() => {
					/* tick catches its own errors */
				});
			}
			this.scheduleNext(state);
		}
		this.log("info", `Cron started with ${this.jobs.size} job(s)`);
	}

	/**
	 * Stop the scheduler. Waits for any in-flight job to finish.
	 * Returns once all timers are cleared.
	 */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;

		const pending: Promise<void>[] = [];
		for (const [, state] of this.jobs) {
			if (state.timer) {
				clearTimeout(state.timer);
				state.timer = undefined;
			}
			if (state.running) {
				// Best-effort wait. We don't cancel the in-flight run.
				pending.push(new Promise((resolve) => {
					const interval = setInterval(() => {
						if (!state.running) {
							clearInterval(interval);
							resolve();
						}
					}, 50);
				}));
			}
		}
		await Promise.all(pending);
		this.log("info", "Cron stopped");
	}

	/**
	 * Manually trigger a job. Returns when the run completes (success or failure).
	 * The error (if any) is logged to DLQ and re-thrown.
	 */
	async runOnce(name: string): Promise<void> {
		const state = this.jobs.get(name);
		if (!state) throw new Error(`Job '${name}' not registered`);
		if (state.running) throw new Error(`Job '${name}' is already running`);
		return this.tick(state);
	}

	/** Read the current state of all jobs. Useful for /status output. */
	status(): Array<{
		name: string;
		intervalMs: number;
		paused: boolean;
		consecutiveFailures: number;
		lastRunAt?: string;
		lastSuccessAt?: string;
	}> {
		return Array.from(this.jobs.values()).map((s) => ({
			name: s.job.name,
			intervalMs: s.job.intervalMs,
			paused: s.paused,
			consecutiveFailures: s.consecutiveFailures,
			lastRunAt: s.lastRunAt,
			lastSuccessAt: s.lastSuccessAt,
		}));
	}

	private scheduleNext(state: JobState): void {
		if (!this.started || state.paused) return;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			this.tick(state).catch(() => {
				/* tick catches its own errors */
			}).finally(() => {
				this.scheduleNext(state);
			});
		}, state.job.intervalMs);
		// Don't keep the process alive just for cron timers.
		try { (state.timer as NodeJS.Timeout & { unref?: () => void }).unref?.(); } catch { /* ignore */ }
	}

	private async tick(state: JobState): Promise<void> {
		if (state.running) {
			this.log("warn", `Skipping tick for '${state.job.name}' — already running`);
			return;
		}
		state.running = true;
		const runId = randomUUID();
		const startedAt = new Date().toISOString();
		state.lastRunAt = startedAt;

		const maxFailures = state.job.maxFailures ?? 5;
		const ctx: CronContext = {
			runId,
			startedAt,
			lastSuccessAt: state.lastSuccessAt,
			consecutiveFailures: state.consecutiveFailures,
			recorder: this.config.recorder,
		};

		try {
			await state.job.run(ctx);
			state.consecutiveFailures = 0;
			state.lastSuccessAt = new Date().toISOString();
			this.config.recorder.emit("cron.job_success", {
				job: state.job.name,
				runId,
				startedAt,
			});
			this.log("info", `Job '${state.job.name}' completed (runId=${runId})`);
		} catch (err: unknown) {
			state.consecutiveFailures++;
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			this.log("error", `Job '${state.job.name}' failed: ${message}`);

			// Surface to DLQ
			const dlqEntry = {
				ts: startedAt,
				runId,
				job: state.job.name,
				error: message,
				stack,
				consecutiveFailures: state.consecutiveFailures,
			};
			try {
				fs.appendFileSync(state.dlqPath, JSON.stringify(dlqEntry) + "\n", "utf-8");
			} catch (dlqErr) {
				this.log("error", `Failed to write DLQ entry for '${state.job.name}': ${String(dlqErr)}`);
			}

			// Pause after too many consecutive failures
			if (state.consecutiveFailures >= maxFailures) {
				state.paused = true;
				this.log("error", `Job '${state.job.name}' paused after ${maxFailures} consecutive failures — needs human review (1-3-1 per manifesto II.8)`);
			}

			// Re-throw so callers (including scheduled ticks) know the job failed
			throw err;
		} finally {
			state.running = false;
		}
	}

	private log(level: "info" | "warn" | "error", msg: string): void {
		if (this.config.log) {
			this.config.log(level, msg);
		}
	}
}

// ── Built-in jobs ─────────────────────────────────────────────────────────────

/** Read all trace files and emit a summary event with total counts. */
export function createTraceSummarizerJob(intervalMs: number = 30 * 60_000): CronJob {
	return {
		name: "trace-summarizer",
		intervalMs,
		run: async (ctx) => {
			const list = ctx.recorder.listRuns();
			let totalEvents = 0;
			let runsWithErrors = 0;
			const modelCounts = new Map<string, number>();
			const now = Date.now();
			const oneDayAgo = now - 24 * 60 * 60 * 1000;
			let recentRuns = 0;

			for (const runId of list) {
				const lines = ctx.recorder.read(runId);
				totalEvents += lines.length;
				for (const line of lines) {
					const p = line.payload as { model?: string; error?: string };
					if (p.model) {
						modelCounts.set(p.model, (modelCounts.get(p.model) ?? 0) + 1);
					}
					if (p.error || line.type.endsWith("error") || line.type.endsWith("timeout")) {
						runsWithErrors++;
					}
					if (new Date(line.ts).getTime() > oneDayAgo) {
						recentRuns++;
					}
				}
			}

			ctx.recorder.emit("cron.trace_summary", {
				job: "trace-summarizer",
				runId: ctx.runId,
				totalRuns: list.length,
				totalEvents,
				runsWithErrors,
				recentRuns24h: recentRuns,
				topModels: Array.from(modelCounts.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, 5)
					.map(([model, count]) => ({ model, count })),
			});
		},
	};
}

// UUID helper (avoiding the randomUUID import dance for clarity)
function randomUUID(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}
