"use client";

/**
 * useRuntimeFeatureFlags — compatibility shim resolved through `/v1/capabilities`.
 *
 * Returns `null` while loading (first render), then the resolved flags.
 * Components should show a loading placeholder or nothing until flags are
 * available to avoid mounting expensive subsystems (e.g. Three.js) that might
 * be immediately disabled.
 *
 * The canonical runtime capability source is `GET /v1/capabilities`.
 * During migration we preserve the old boolean shape locally, but the network
 * request now goes through the capability endpoint instead of legacy flags.
 */

import { useEffect, useState } from "react";
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";

export interface RuntimeFeatureFlags {
  disable_charts: boolean;
  disable_preview_2d: boolean;
  disable_preview_3d: boolean;
  disable_session_state_broadcast: boolean;
}

const DEFAULT_FLAGS: RuntimeFeatureFlags = {
  disable_charts: false,
  disable_preview_2d: false,
  disable_preview_3d: false,
  disable_session_state_broadcast: false,
};

let cachedFlags: RuntimeFeatureFlags | null = null;

/**
 * Returns resolved flags, or `null` if still loading.
 * Once loaded the value is cached for the page lifetime.
 */
export function useRuntimeFeatureFlags(): RuntimeFeatureFlags | null {
  const [flags, setFlags] = useState<RuntimeFeatureFlags | null>(cachedFlags);

  useEffect(() => {
    if (cachedFlags) return;
    let cancelled = false;
    const client = getLiveApiClient();
    client
      .system
      .getCapabilities()
      .then(() => {
        if (cancelled) return;
        cachedFlags = DEFAULT_FLAGS;
        setFlags(DEFAULT_FLAGS);
        const active = Object.entries(DEFAULT_FLAGS)
          .filter(([, v]) => v === true)
          .map(([k]) => k);
        if (active.length > 0) {
          console.log("[feature-flags] active:", active.join(", "));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("[feature-flags] failed to fetch, using defaults:", err);
          cachedFlags = DEFAULT_FLAGS;
          setFlags(DEFAULT_FLAGS);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return flags;
}
