/**
 * Parallel and single foreground path runners — re-exports.
 * Implementations extracted to runner-parallel-path.ts and runner-single-path.ts.
 */

export { runParallelPath } from "./runner-parallel-path.ts";
export { runSinglePath } from "./runner-single-path.ts";

export type {
	ExecutionContextData,
	ExecutorDeps,
} from "./executor-types.ts";
