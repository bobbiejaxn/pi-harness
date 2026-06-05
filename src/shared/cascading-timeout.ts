/**
 * Cascading timeouts for subagent runs.
 *
 * Deeper agents get less time to prevent runaway cost accumulation.
 * Depth 0 = base timeout, each level deeper gets a shorter timeout.
 *
 * Ported from ivi's cascading timeout system.
 *
 * ## Config
 *
 * ```json
 * { "timeout": { "cascadeEnabled": true, "baseMs": 900000, "depthSchedule": [900000, 600000, 300000, 180000] } }
 * ```
 *
 * ## Env override
 *
 * `PI_SUBAGENT_TIMEOUT_MS=120000` — sets a fixed timeout, disables cascade.
 *
 * ## Default schedule
 *
 * | Depth | Timeout |
 * |-------|---------|
 * | 0     | 15 min  |
 * | 1     | 10 min  |
 * | 2     | 5 min   |
 * | 3+    | 3 min   |
 *
 * ## How it works
 *
 * execution.ts sets a `setTimeout` with the resolved timeout. When it fires:
 * 1. SIGTERM is sent to the child process
 * 2. After 5 seconds, SIGKILL if still alive
 */

/** User-facing timeout config (all optional, merged with defaults). */
export interface TimeoutConfig {
	/** Whether cascade is enabled (deeper = shorter). Default: true. */
	cascadeEnabled?: boolean;
	/** Base timeout in ms (used when cascade is disabled). Default: 900000 (15min). */
	baseMs?: number;
	/** Timeout per depth level in ms. Index = depth. Default: [15m, 10m, 5m, 3m]. */
	depthSchedule?: number[];
}

/** Fully resolved timeout config with defaults applied. */
export interface ResolvedTimeoutConfig {
	cascadeEnabled: boolean;
	baseMs: number;
	depthSchedule: number[];
}

const MINUTE = 60 * 1000;

/** Default: cascade enabled, 15m→10m→5m→3m. */
export const DEFAULT_TIMEOUT_CONFIG: ResolvedTimeoutConfig = {
	cascadeEnabled: true,
	baseMs: 15 * MINUTE,
	depthSchedule: [15 * MINUTE, 10 * MINUTE, 5 * MINUTE, 3 * MINUTE],
};

/**
 * Resolve timeout config from user config and env vars.
 * If `PI_SUBAGENT_TIMEOUT_MS` is set, disables cascade and uses it as a fixed timeout.
 */
export function resolveTimeoutConfig(
	config: TimeoutConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedTimeoutConfig {
	const envTimeout = parseInt(env.PI_SUBAGENT_TIMEOUT_MS ?? "", 10);

	if (Number.isFinite(envTimeout) && envTimeout > 0) {
		return {
			cascadeEnabled: false,
			baseMs: envTimeout,
			depthSchedule: [envTimeout],
		};
	}

	return {
		cascadeEnabled: config?.cascadeEnabled ?? DEFAULT_TIMEOUT_CONFIG.cascadeEnabled,
		baseMs: config?.baseMs ?? DEFAULT_TIMEOUT_CONFIG.baseMs,
		depthSchedule: config?.depthSchedule ?? DEFAULT_TIMEOUT_CONFIG.depthSchedule,
	};
}

/**
 * Resolve the timeout for a given spawn depth.
 * Uses the depth schedule when cascade is enabled, otherwise returns base.
 * Depths beyond the schedule use the last (shortest) value.
 */
export function resolveTimeout(
	depth: number,
	config: ResolvedTimeoutConfig = DEFAULT_TIMEOUT_CONFIG,
): number {
	if (!config.cascadeEnabled) return config.baseMs;

	const clampedDepth = Math.max(0, depth);
	if (clampedDepth < config.depthSchedule.length) {
		return config.depthSchedule[clampedDepth]!;
	}
	return config.depthSchedule[config.depthSchedule.length - 1]!;
}

/** Format a timeout in ms for human-readable display (e.g. `"15m"`, `"45s"`). */
export function formatTimeout(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return `${hours}h`;
}
