/**
 * viewport3dBatchedInvalidate — Deduplicates R3F invalidation calls.
 *
 * Ported from legacy `useBatchedInvalidate.ts`.  Multiple layers may call
 * `invalidate()` during the same React commit (color update + camera fit +
 * resource change).  Without batching, each call schedules a separate frame,
 * which can produce visible intermediate states.
 *
 * This utility coalesces all invalidation requests into one short timer tick
 * so that the viewport re-renders once per commit batch instead of N times.
 */

"use client";

import { useCallback, useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";

const pendingInvalidates = new Set<() => void>();
let pendingTimer: number | null = null;

function flushPendingInvalidates() {
  pendingTimer = null;
  const callbacks = Array.from(pendingInvalidates);
  pendingInvalidates.clear();
  for (const invalidate of callbacks) {
    invalidate();
  }
}

export function scheduleBatchedViewportInvalidate(invalidate: () => void): void {
  if (typeof window === "undefined") {
    invalidate();
    return;
  }
  pendingInvalidates.add(invalidate);
  if (pendingTimer !== null) {
    return;
  }
  pendingTimer = window.setTimeout(flushPendingInvalidates, 0);
}

export function cancelBatchedViewportInvalidate(invalidate: () => void): void {
  pendingInvalidates.delete(invalidate);
  if (
    pendingInvalidates.size > 0 ||
    pendingTimer === null ||
    typeof window === "undefined"
  ) {
    return;
  }
  window.clearTimeout(pendingTimer);
  pendingTimer = null;
}

/**
 * Hook that returns a batched invalidate function.  Use this instead of
 * `useThree(s => s.invalidate)` directly in layer components.
 */
export function useBatchedInvalidate(): () => void {
  const { invalidate } = useThree();
  const invalidateRef = useRef(invalidate);

  useEffect(() => {
    invalidateRef.current = invalidate;
  }, [invalidate]);

  const scheduleInvalidate = useCallback(() => {
    scheduleBatchedViewportInvalidate(invalidateRef.current);
  }, []);

  useEffect(() => {
    const current = invalidateRef.current;
    return () => {
      cancelBatchedViewportInvalidate(current);
    };
  }, []);

  return scheduleInvalidate;
}
