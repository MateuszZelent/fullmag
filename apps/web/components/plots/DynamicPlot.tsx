"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { PlotParams } from "react-plotly.js";

type PlotComponent = ComponentType<PlotParams>;

const PLOTLY_RETRY_DELAY_MS = 400;

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

function PlotlyUnavailableFallback() {
  return (
    <div className="flex h-full w-full min-h-[220px] items-center justify-center bg-background/60 p-6 text-center">
      <div className="max-w-sm rounded-xl border border-border/60 bg-card/70 px-4 py-3 text-sm text-muted-foreground shadow-sm">
        Plot module is temporarily unavailable. Refresh the page if charts do not recover.
      </div>
    </div>
  );
}

async function loadPlotlyModule(): Promise<{ default: PlotComponent }> {
  try {
    return await import("react-plotly.js");
  } catch (error) {
    if (!isChunkLoadError(error)) {
      throw error;
    }

    console.warn("[DynamicPlot] Plotly chunk load failed, retrying once", error);
    await sleep(PLOTLY_RETRY_DELAY_MS);

    try {
      return await import("react-plotly.js");
    } catch (retryError) {
      console.error(
        "[DynamicPlot] Plotly chunk failed after retry; using fallback component",
        retryError,
      );
      return { default: PlotlyUnavailableFallback };
    }
  }
}

const DynamicPlot = dynamic(loadPlotlyModule, {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full min-h-[220px] items-center justify-center text-sm text-muted-foreground">
      Loading chart module...
    </div>
  ),
});

export default DynamicPlot;
