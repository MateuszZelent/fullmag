"use client";

import { useCallback, useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";

const pendingInvalidates = new Set<() => void>();
let pendingFrame: number | null = null;

function flushPendingInvalidates() {
  pendingFrame = null;
  const callbacks = Array.from(pendingInvalidates);
  pendingInvalidates.clear();
  for (const invalidate of callbacks) {
    invalidate();
  }
}

export function scheduleBatchedViewportInvalidate(invalidate: () => void) {
  if (typeof window === "undefined") {
    invalidate();
    return;
  }
  pendingInvalidates.add(invalidate);
  if (pendingFrame !== null) {
    return;
  }
  pendingFrame = window.requestAnimationFrame(flushPendingInvalidates);
}

export function cancelBatchedViewportInvalidate(invalidate: () => void) {
  pendingInvalidates.delete(invalidate);
  if (pendingInvalidates.size > 0 || pendingFrame === null || typeof window === "undefined") {
    return;
  }
  window.cancelAnimationFrame(pendingFrame);
  pendingFrame = null;
}

export function useBatchedInvalidate() {
  const { invalidate } = useThree();
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;

  const scheduleInvalidate = useCallback(() => {
    scheduleBatchedViewportInvalidate(invalidate);
  }, [invalidate]);

  useEffect(() => {
    return () => {
      cancelBatchedViewportInvalidate(invalidateRef.current);
    };
  }, []);

  return scheduleInvalidate;
}
