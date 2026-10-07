"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  Viewport3DColors,
  Viewport3DHudColors,
} from "../viewport3dTypes";

const subscribeClientReady = () => () => {};
const MAX_COLOR_READ_ATTEMPTS = 120;
const COLOR_READ_RETRY_MS = 50;

interface StyleTokenSource {
  getPropertyValue(name: string): string;
}

interface Viewport3DColorDocument {
  body?: Element | null;
  documentElement: Element;
}

function useClientReady(): boolean {
  return useSyncExternalStore(
    subscribeClientReady,
    () => true,
    () => false,
  );
}

export function readViewport3DColorsFromStyles(
  styles: StyleTokenSource,
): Viewport3DColors | null {
  const read = (name: string) => styles.getPropertyValue(name).trim();
  const accent = read("--fm-accent");
  const accentStrong = read("--fm-accent-strong");
  const background = read("--fm-bg-viewport");
  const danger = read("--fm-danger");
  const field = read("--fm-syntax-string") || read("--fm-accent");
  const mesh = read("--fm-surface-3") || read("--fm-bg-panel");
  const panel = read("--fm-bg-panel");
  const panelRaised = read("--fm-bg-panel-raised");
  const success = read("--fm-success");
  const textPrimary = read("--fm-text-primary");
  const textSecondary = read("--fm-text-secondary");
  const wire = read("--fm-text-muted") || read("--fm-text-secondary");
  if (accent && background && field && mesh && wire) {
    return {
      accent,
      accentStrong,
      background,
      danger,
      field,
      hud: readViewport3DHudColors(read, {
        background,
        mesh,
        panel,
        panelRaised,
        textPrimary,
        textSecondary,
        wire,
      }),
      mesh,
      panel,
      panelRaised,
      success,
      textPrimary,
      textSecondary,
      wire,
    };
  }
  return null;
}

function readViewport3DHudColors(
  read: (name: string) => string,
  base: {
    background: string;
    mesh: string;
    panel: string;
    panelRaised: string;
    textPrimary: string;
    textSecondary: string;
    wire: string;
  },
): Viewport3DHudColors {
  const label = base.textPrimary || base.textSecondary || base.wire;
  const tick = base.textSecondary || label;
  return {
    axisX: read("--fm-hud-axis-x") || read("--fm-chart-red") || label,
    axisY: read("--fm-hud-axis-y") || read("--fm-chart-green") || label,
    axisZ: read("--fm-hud-axis-z") || read("--fm-chart-blue") || label,
    chip: read("--fm-hud-chip") || base.panel || base.background,
    chipBorder: read("--fm-hud-chip-border") || base.wire,
    cubeEdge: read("--fm-hud-cube-edge") || base.wire,
    cubeFace:
      read("--fm-hud-cube-face") || base.panelRaised || base.panel || base.mesh,
    cubeShade: read("--fm-hud-cube-shade") || base.background,
    grid: read("--fm-hud-grid") || tick,
    halo: read("--fm-hud-halo") || base.background,
    label: read("--fm-hud-label") || label,
    tick: read("--fm-hud-tick") || tick,
  };
}

export function resolveViewport3DColorElement(
  documentLike: Viewport3DColorDocument,
): Element {
  return documentLike.body ?? documentLike.documentElement;
}

function readViewport3DColorsFromDocument(): Viewport3DColors | null {
  if (typeof document === "undefined") {
    return null;
  }

  try {
    return readViewport3DColorsFromStyles(
      getComputedStyle(resolveViewport3DColorElement(document)),
    );
  } catch {
    return null;
  }
}

export function useViewport3DColors() {
  const clientReady = useClientReady();
  const [colors, setColors] = useState<Viewport3DColors | null>(null);

  useEffect(() => {
    if (!clientReady || typeof window === "undefined") {
      return;
    }

    let disposed = false;
    let attempts = 0;
    let retryId: number | null = null;

    const updateColors = () => {
      if (disposed) return;

      const nextColors = readViewport3DColorsFromDocument();
      if (nextColors) {
        setColors((current) =>
          sameViewport3DColors(current, nextColors) ? current : nextColors,
        );
        return;
      }

      attempts += 1;
      if (attempts < MAX_COLOR_READ_ATTEMPTS) {
        retryId = window.setTimeout(updateColors, COLOR_READ_RETRY_MS);
      }
    };

    updateColors();

    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            attempts = 0;
            if (retryId !== null) {
              window.clearTimeout(retryId);
              retryId = null;
            }
            updateColors();
          });
    const observerOptions = {
      attributeFilter: ["class", "data-theme", "style"],
      attributes: true,
    };
    observer?.observe(document.documentElement, observerOptions);
    if (document.body) {
      observer?.observe(document.body, observerOptions);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      if (retryId !== null) {
        window.clearTimeout(retryId);
      }
    };
  }, [clientReady]);

  return { clientReady, colors };
}

function sameViewport3DColors(
  left: Viewport3DColors | null,
  right: Viewport3DColors,
): boolean {
  return (
    left?.accent === right.accent &&
    left.accentStrong === right.accentStrong &&
    left.background === right.background &&
    left.danger === right.danger &&
    left.field === right.field &&
    left.mesh === right.mesh &&
    left.panel === right.panel &&
    left.panelRaised === right.panelRaised &&
    left.success === right.success &&
    left.textPrimary === right.textPrimary &&
    left.textSecondary === right.textSecondary &&
    left.wire === right.wire &&
    sameHudColors(left.hud, right.hud)
  );
}

function sameHudColors(
  left: Viewport3DHudColors | undefined,
  right: Viewport3DHudColors | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (Object.keys(right) as Array<keyof Viewport3DHudColors>).every(
    (key) => left[key] === right[key],
  );
}
