"use client";

import { useEffect } from "react";

import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";

/**
 * Requests one demand frame per complex display-phase change. The phase
 * values live in shared shader uniforms, so this is the only per-frame work
 * phase animation causes on the React side: no state update, no re-render.
 */
export function Viewport3DComplexPhaseInvalidator({
  subscribe,
}: {
  subscribe: ((listener: () => void) => () => void) | null | undefined;
}) {
  const invalidate = useBatchedInvalidate();
  useEffect(() => {
    if (!subscribe) return undefined;
    return subscribe(() => invalidate("complex-phase"));
  }, [invalidate, subscribe]);
  return null;
}
