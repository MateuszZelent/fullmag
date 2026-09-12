export const CONTEXT_LOSS_RETRY_WINDOW_MS = 30_000;
export const CONTEXT_LOSS_MAX_RETRIES = 2;
export const CONTEXT_LOSS_RETRY_DELAY_MS = 250;

export interface ContextLossRecoveryDecision {
  allowed: boolean;
  nextTimestamps: number[];
  retryDelayMs: number;
}

export function resolveContextLossRecovery({
  nowMs,
  retryTimestamps,
  retryWindowMs = CONTEXT_LOSS_RETRY_WINDOW_MS,
  maxRetries = CONTEXT_LOSS_MAX_RETRIES,
  retryDelayMs = CONTEXT_LOSS_RETRY_DELAY_MS,
}: {
  nowMs: number;
  retryTimestamps: readonly number[];
  retryWindowMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}): ContextLossRecoveryDecision {
  const windowStart = nowMs - retryWindowMs;
  const recentTimestamps = retryTimestamps.filter((timestamp) => timestamp >= windowStart);
  if (recentTimestamps.length >= maxRetries) {
    return {
      allowed: false,
      nextTimestamps: recentTimestamps,
      retryDelayMs: 0,
    };
  }
  const nextTimestamps = [...recentTimestamps, nowMs];
  return {
    allowed: true,
    nextTimestamps,
    retryDelayMs: retryDelayMs * nextTimestamps.length,
  };
}
