/**
 * Retry logic for subagent runs.
 *
 * Retries on transient/retriable errors (429, 503, ETIMEDOUT, rate_limit, etc.)
 * with exponential backoff + jitter. Does NOT retry on code errors, lint failures,
 * or non-zero exits from non-retriable causes.
 *
 * Ported from ivi's production retry guard and adapted for pi-subagents'
 * model-fallback architecture.
 *
 * ## Config
 *
 * ```json
 * { "retry": { "maxRetries": 2, "baseMs": 1000, "maxMs": 16000 } }
 * ```
 *
 * ## Env override
 *
 * `PI_SUBAGENT_MAX_RETRIES=2`
 *
 * ## Backoff formula
 *
 * `delay = min(baseMs × 2^(attempt-1), maxMs) ± 20% jitter`
 *
 * ## Retriable patterns
 *
 * By default retries on: `etimedout`, `econnreset`, `econnrefused`, `enotfound`,
 * `429`, `503`, `rate_limit`, `rate limit`, `model_unavailable`, `overloaded`,
 * `capacity`, `temporarily unavailable`.
 */

/** User-facing retry config (all optional, merged with defaults). */
export interface RetryConfig {
	/** Maximum retry attempts. Default: 2. */
	maxRetries?: number;
	/** Initial backoff delay in ms. Default: 1000. */
	baseMs?: number;
	/** Backoff ceiling in ms. Default: 16000. */
	maxMs?: number;
	/** Custom patterns to match against stderr for retriable errors. */
	retriablePatterns?: string[];
}

/** Fully resolved retry config with defaults applied. */
export interface ResolvedRetryConfig {
	maxRetries: number;
	baseMs: number;
	maxMs: number;
	retriablePatterns: string[];
}

/** Default config: 2 retries, 1s base backoff, 16s max. */
export const DEFAULT_RETRY_CONFIG: ResolvedRetryConfig = {
	maxRetries: 2,
	baseMs: 1000,
	maxMs: 16000,
	retriablePatterns: [
		"etimedout",
		"econnreset",
		"econnrefused",
		"enotfound",
		"429",
		"503",
		"rate_limit",
		"rate limit",
		"model_unavailable",
		"model unavailable",
		"overloaded",
		"capacity",
		"temporarily unavailable",
	],
};

/**
 * Resolve retry config from user config and env vars.
 * `PI_SUBAGENT_MAX_RETRIES` env var takes precedence over config.
 */
export function resolveRetryConfig(
	config: RetryConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedRetryConfig {
	const envRetries = parseInt(env.PI_SUBAGENT_MAX_RETRIES ?? "", 10);

	return {
		maxRetries:
			Number.isInteger(envRetries) && envRetries >= 0
				? envRetries
				: config?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
		baseMs: config?.baseMs ?? DEFAULT_RETRY_CONFIG.baseMs,
		maxMs: config?.maxMs ?? DEFAULT_RETRY_CONFIG.maxMs,
		retriablePatterns:
			config?.retriablePatterns ?? DEFAULT_RETRY_CONFIG.retriablePatterns,
	};
}

/**
 * Determine if an error is retriable based on stderr output and exit code.
 * - `null` exit code (killed by signal) is always retriable
 * - stderr is lowercased and checked against known retriable patterns
 */
export function isRetriable(
	stderr: string,
	exitCode: number | null,
	patterns: string[] = DEFAULT_RETRY_CONFIG.retriablePatterns,
): boolean {
	if (exitCode === null) return true;
	const lower = stderr.toLowerCase();
	return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * Calculate backoff delay for a given attempt number.
 * Formula: `min(baseMs × 2^(attempt-1), maxMs)` with ±20% jitter.
 * @param attempt 1-based attempt number
 */
export function backoffMs(attempt: number, config: ResolvedRetryConfig = DEFAULT_RETRY_CONFIG): number {
	const delay = Math.min(config.baseMs * Math.pow(2, attempt - 1), config.maxMs);
	const jitter = delay * 0.2 * (Math.random() * 2 - 1);
	return Math.max(0, Math.round(delay + jitter));
}

/**
 * Decide whether to retry a failed run.
 * @returns `{ delayMs }` if should retry, or `null` if no more retries.
 */
export function shouldRetry(
	stderr: string,
	exitCode: number | null,
	currentAttempt: number,
	config: ResolvedRetryConfig = DEFAULT_RETRY_CONFIG,
): { delayMs: number } | null {
	if (currentAttempt >= config.maxRetries) return null;
	if (!isRetriable(stderr, exitCode, config.retriablePatterns)) return null;
	return { delayMs: backoffMs(currentAttempt, config) };
}

/** Sleep for a given number of milliseconds. Used between retry attempts. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
