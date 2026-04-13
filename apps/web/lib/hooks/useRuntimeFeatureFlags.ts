"use client";

/**
 * useRuntimeFeatureFlags — fetches feature flags from the backend once on mount.
 *
 * Returns `null` while loading (first render), then the resolved flags.
 * Components should show a loading placeholder or nothing until flags are
 * available to avoid mounting expensive subsystems (e.g. Three.js) that might
 * be immediately disabled.
 *
 * The backend reads `~/.fullmag/feature_flags.json` (or env vars as fallback)
 * and exposes them at `GET /v1/live/feature-flags`.
 */

import { useEffect, useState } from "react";
import { currentLiveApiClient, type RuntimeFeatureFlags } from "../liveApiClient";

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
    const client = currentLiveApiClient();
    client
      .fetchFeatureFlags()
      .then((result) => {
        if (cancelled) return;
        cachedFlags = result;
        setFlags(result);
        const active = Object.entries(result)
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
