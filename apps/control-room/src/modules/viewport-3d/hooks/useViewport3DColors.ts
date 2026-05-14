"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { Viewport3DColors } from "../viewport3dTypes";

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
    left.wire === right.wire
  );
}
