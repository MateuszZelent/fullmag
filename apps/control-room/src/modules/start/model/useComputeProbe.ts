"use client";

import { useEffect, useState } from "react";

import { probeCompute } from "./computeProbe";
import type { ComputeProbeState } from "./types";

export const COMPUTE_POLL_MS = 5000;

/**
 * Live GPU/VRAM state for the rail. `undefined` while the first probe is in
 * flight, `null` when this host cannot probe; the refresh loop stops in that case and
 * is always cleared on unmount so it never outlives the start screen.
 */
export function useComputeProbe(): ComputeProbeState {
  const [state, setState] = useState<ComputeProbeState>(undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // A hidden window has no one watching VRAM; skip the spawn, keep the cadence.
      const next = document.hidden ? undefined : await probeCompute();
      if (cancelled) return;
      if (next !== undefined) setState(next);
      if (next !== null) timer = setTimeout(() => void tick(), COMPUTE_POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return state;
}
