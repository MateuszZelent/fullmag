"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  CONTEXT_LOSS_RETRY_DELAY_MS,
  CONTEXT_LOSS_RETRY_WINDOW_MS,
  resolveContextLossRecovery,
  type ContextLossRecoveryDecision,
} from "./viewportContextLossPolicy";

export interface ViewportContextLossRecoveryCallbacks {
  hidden: boolean;
  onRemount: () => void;
  onContextLost?: () => void;
  onHiddenContextLost?: () => void;
  onRecoveryBlocked?: (decision: ContextLossRecoveryDecision) => void;
  onRecoveryScheduled?: (decision: ContextLossRecoveryDecision) => void;
  onContextRestored?: () => void;
}

export function useViewportContextLossRecovery({
  hidden,
  onRemount,
  onContextLost,
  onHiddenContextLost,
  onRecoveryBlocked,
  onRecoveryScheduled,
  onContextRestored,
}: ViewportContextLossRecoveryCallbacks) {
  const retryTimestampsRef = useRef<number[]>([]);
  const retryTimerRef = useRef<number | null>(null);
  const [contextLossBlocked, setContextLossBlocked] = useState(false);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) {
      return;
    }
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const retryWebglViewport = useCallback(() => {
    clearRetryTimer();
    retryTimestampsRef.current = [];
    setContextLossBlocked(false);
    onRemount();
  }, [clearRetryTimer, onRemount]);

  const handleContextLost = useCallback((event: Event) => {
    event.preventDefault();
    onContextLost?.();
    if (hidden) {
      onHiddenContextLost?.();
      return;
    }
    const decision = resolveContextLossRecovery({
      nowMs: Date.now(),
      retryTimestamps: retryTimestampsRef.current,
    });
    retryTimestampsRef.current = decision.nextTimestamps;
    if (!decision.allowed) {
      setContextLossBlocked(true);
      onRecoveryBlocked?.(decision);
      return;
    }
    setContextLossBlocked(false);
    if (retryTimerRef.current !== null) {
      return;
    }
    onRecoveryScheduled?.(decision);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      onRemount();
    }, decision.retryDelayMs);
  }, [
    hidden,
    onContextLost,
    onHiddenContextLost,
    onRecoveryBlocked,
    onRecoveryScheduled,
    onRemount,
  ]);

  const handleContextRestored = useCallback(() => {
    setContextLossBlocked(false);
    onContextRestored?.();
  }, [onContextRestored]);

  useEffect(() => clearRetryTimer, [clearRetryTimer]);

  return {
    contextLossBlocked,
    retryWebglViewport,
    handleContextLost,
    handleContextRestored,
    clearRetryTimer,
    retryWindowMs: CONTEXT_LOSS_RETRY_WINDOW_MS,
    retryDelayMs: CONTEXT_LOSS_RETRY_DELAY_MS,
  } as const;
}
