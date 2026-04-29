"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";

type ChartsViewportComponent = ComponentType;

const CHARTS_RETRY_DELAY_MS = 400;
const CHARTS_CHUNK_RELOAD_KEY = "fullmag.charts_chunk_reload_once";

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === "ChunkLoadError" ||
    message.includes("loading chunk") ||
    message.includes("chunkloaderror")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requestSingleHardReloadForChunkError(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    if (window.sessionStorage.getItem(CHARTS_CHUNK_RELOAD_KEY) === "1") {
      return false;
    }
    window.sessionStorage.setItem(CHARTS_CHUNK_RELOAD_KEY, "1");
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

function ChartsUnavailableFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-background/70 p-6 text-center">
      <div className="max-w-sm rounded-lg border border-border/60 bg-card/70 px-4 py-3 text-sm text-muted-foreground shadow-sm">
        Charts module is temporarily unavailable. Refresh the page if charts do not recover.
      </div>
    </div>
  );
}

async function loadChartsViewport(): Promise<{ default: ChartsViewportComponent }> {
  try {
    return await import("@/components/runs/control-room/ChartsViewport");
  } catch (error) {
    if (!isChunkLoadError(error)) {
      throw error;
    }

    if (requestSingleHardReloadForChunkError()) {
      return { default: ChartsUnavailableFallback };
    }

    console.warn("[ChartsTabPanel] Charts chunk load failed, retrying once", error);
    await sleep(CHARTS_RETRY_DELAY_MS);

    try {
      return await import("@/components/runs/control-room/ChartsViewport");
    } catch (retryError) {
      console.error(
        "[ChartsTabPanel] Charts chunk failed after retry; using fallback component",
        retryError,
      );
      return { default: ChartsUnavailableFallback };
    }
  }
}

const ChartsViewport = dynamic(loadChartsViewport, {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
      Loading charts...
    </div>
  ),
});

export function ChartsTabPanel({ disabled }: { disabled: boolean }) {
  if (disabled) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        Charts disabled via feature flags
      </div>
    );
  }
  return <ChartsViewport />;
}
