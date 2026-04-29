"use client";

import { useCallback, useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";

export function useBatchedInvalidate() {
  const { invalidate } = useThree();
  const rafRef = useRef<number | null>(null);

  const scheduleInvalidate = useCallback(() => {
    if (typeof window === "undefined") {
      invalidate();
      return;
    }
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      invalidate();
    });
  }, [invalidate]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return scheduleInvalidate;
}
