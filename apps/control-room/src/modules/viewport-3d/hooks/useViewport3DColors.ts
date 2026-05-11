"use client";

import { useMemo, useSyncExternalStore } from "react";

import type { Viewport3DColors } from "../viewport3dTypes";

const subscribeClientReady = () => () => {};

function useClientReady(): boolean {
  return useSyncExternalStore(
    subscribeClientReady,
    () => true,
    () => false,
  );
}

function readViewport3DColors(clientReady: boolean): Viewport3DColors | null {
  if (!clientReady || typeof document === "undefined") {
    return null;
  }

  try {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string) => styles.getPropertyValue(name).trim();
    const accent = read("--fm-accent");
    const field = read("--fm-syntax-string") || read("--fm-accent");
    const mesh = read("--fm-surface-3") || read("--fm-bg-panel");
    const wire = read("--fm-text-muted") || read("--fm-text-secondary");
    if (accent && field && mesh && wire) {
      return { accent, field, mesh, wire };
    }
  } catch {
    return null;
  }

  return null;
}

export function useViewport3DColors() {
  const clientReady = useClientReady();
  const colors = useMemo(
    () => readViewport3DColors(clientReady),
    [clientReady],
  );

  return { clientReady, colors };
}
