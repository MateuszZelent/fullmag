/**
 * viewport3dBatchedInvalidate — Deduplicates R3F invalidation calls.
 *
 * A viewport owns its pending demand frame. Reasons are typed, bounded, and
 * flushed with that frame so an invalid caller cannot create an unaccounted
 * render while `frameloop="demand"` is active.
 */

"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useThree } from "@react-three/fiber";

import type { Viewport3DDirtyReason } from "./viewport3dTypes";

export const VIEWPORT_3D_BATCHED_INVALIDATE_REASON_LIMIT = 16;

type Viewport3DInvalidate = (reason?: Viewport3DDirtyReason) => void;

const Viewport3DInvalidationContext = createContext<Viewport3DInvalidate | null>(
  null,
);

interface Viewport3DBatchedInvalidatorOptions {
  invalidate: (reasons: readonly Viewport3DDirtyReason[]) => void;
  maxReasons?: number;
  schedule: (flush: () => void) => void;
}

export function createViewport3DBatchedInvalidator({
  invalidate,
  maxReasons = VIEWPORT_3D_BATCHED_INVALIDATE_REASON_LIMIT,
  schedule,
}: Viewport3DBatchedInvalidatorOptions) {
  const reasons = new Set<Viewport3DDirtyReason>();
  let overflowed = false;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (overflowed || reasons.size === 0) return;
    const frameReasons = Array.from(reasons);
    reasons.clear();
    invalidate(frameReasons);
  };

  return {
    cancel(): void {
      reasons.clear();
      overflowed = false;
    },
    getSnapshot() {
      return {
        overflowed,
        reasons: Array.from(reasons),
      };
    },
    invalidate(reason: Viewport3DDirtyReason): boolean {
      if (overflowed) return false;
      if (!reasons.has(reason) && reasons.size >= maxReasons) {
        overflowed = true;
        return false;
      }
      reasons.add(reason);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
      return true;
    },
  };
}

export function Viewport3DInvalidationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const rootInvalidate = useThree((state) => state.invalidate);
  const [controller] = useState(() =>
    createViewport3DBatchedInvalidator({
      invalidate: () => rootInvalidate(),
      schedule: (flush) => {
        if (typeof window === "undefined") {
          flush();
          return;
        }
        queueMicrotask(flush);
      },
    }),
  );

  useEffect(() => () => controller.cancel(), [controller]);

  const invalidate = useCallback<Viewport3DInvalidate>(
    (reason = "frame-commit") => {
      controller.invalidate(reason);
    },
    [controller],
  );

  return createElement(
    Viewport3DInvalidationContext.Provider,
    { value: invalidate },
    children,
  );
}

/** Returns the active Canvas/root's typed invalidation controller. */
export function useBatchedInvalidate(
  defaultReason: Viewport3DDirtyReason = "frame-commit",
): (reason?: Viewport3DDirtyReason) => void {
  const invalidate = useContext(Viewport3DInvalidationContext);
  if (!invalidate) {
    throw new Error("Viewport3D invalidation requires the active Canvas root");
  }

  const scheduleInvalidate = useCallback(
    (reason: Viewport3DDirtyReason = defaultReason) => {
      invalidate(reason);
    },
    [defaultReason, invalidate],
  );

  return scheduleInvalidate;
}
