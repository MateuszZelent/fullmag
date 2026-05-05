"use client";

import { useEffect, useRef } from "react";

import {
  recordFrontendPerfSample,
  type PerfSample,
} from "@/lib/debug/frontendPerfDebug";
import type {
  Viewport3DRolloutRouteState,
} from "@/features/viewport-unified/model/viewport3dRolloutRoute";

export function buildViewport3DRolloutPerfSamples(args: {
  routeState: Pick<Viewport3DRolloutRouteState, "route" | "fallbackUsed">;
  cutover: boolean;
  timestampMs: number;
}): PerfSample[] {
  const selected: PerfSample = {
    scope: "Viewport3DRollout",
    phase: "route-selected",
    durationMs: 0,
    timestampMs: args.timestampMs,
    meta: {
      route: args.routeState.route,
      fallbackUsed: args.routeState.fallbackUsed,
      cutover: args.cutover,
    },
  };
  if (!args.routeState.fallbackUsed) {
    return [selected];
  }
  return [
    selected,
    {
      scope: "Viewport3DRollout",
      phase: "fallback-used",
      durationMs: 0,
      timestampMs: args.timestampMs,
      meta: {
        route: args.routeState.route,
        cutover: args.cutover,
      },
    },
  ];
}

export function useViewport3DRolloutTelemetry(
  routeState: Viewport3DRolloutRouteState,
  cutover: boolean,
): void {
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastSignatureRef.current === routeState.signature) {
      return;
    }
    lastSignatureRef.current = routeState.signature;
    const timestampMs =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    for (const sample of buildViewport3DRolloutPerfSamples({
      routeState,
      cutover,
      timestampMs,
    })) {
      recordFrontendPerfSample(sample);
    }
  }, [cutover, routeState]);
}
