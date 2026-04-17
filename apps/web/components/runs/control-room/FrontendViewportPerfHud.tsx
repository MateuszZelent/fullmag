"use client";

import { memo, useMemo, useSyncExternalStore } from "react";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import {
  getFrontendPerfSamples,
  subscribeFrontendPerfSamples,
  type PerfSample,
} from "@/lib/debug/frontendPerfDebug";
import { useViewportTelemetrySnapshot } from "@/lib/debug/viewportTelemetry";
import { cn } from "@/lib/utils";

function useFrontendPerfSamples(): PerfSample[] {
  return useSyncExternalStore(
    subscribeFrontendPerfSamples,
    getFrontendPerfSamples,
    getFrontendPerfSamples,
  );
}

function latestSample(
  samples: PerfSample[],
  scope: string,
  phase: string,
): PerfSample | null {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (sample.scope === scope && sample.phase === phase) {
      return sample;
    }
  }
  return null;
}

function fmtMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  return value >= 10 ? `${value.toFixed(1)} ms` : `${value.toFixed(2)} ms`;
}

function fmtInt(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Math.round(value).toLocaleString();
}

export const FrontendViewportPerfHud = memo(function FrontendViewportPerfHud() {
  const perfSamples = useFrontendPerfSamples();
  const viewportEntries = useViewportTelemetrySnapshot();

  const hidden = process.env.NODE_ENV === "production" || !FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showTelemetryHud;
  const metrics = useMemo(() => {
    const webglEntries = viewportEntries.filter((entry) => entry.renderer === "webgl");
    return {
      activeCanvases: webglEntries.length,
      drawCalls: webglEntries.reduce((sum, entry) => sum + entry.drawCalls, 0),
      triangles: webglEntries.reduce((sum, entry) => sum + entry.triangles, 0),
      geometries: webglEntries.reduce((sum, entry) => sum + entry.geometries, 0),
      textures: webglEntries.reduce((sum, entry) => sum + entry.textures, 0),
      entries: webglEntries.slice(0, 2),
      femTopology: latestSample(perfSamples, "FemGeometry", "topologyTotal")?.durationMs ?? null,
      femColors: latestSample(perfSamples, "FemGeometry", "colors")?.durationMs ?? null,
      femSliceTopology: latestSample(perfSamples, "FemSlice2D", "topology")?.durationMs ?? null,
      femSliceField: latestSample(perfSamples, "FemSlice2D", "field")?.durationMs ?? null,
      fdmInstances: latestSample(perfSamples, "FdmInstances", "update")?.durationMs ?? null,
    };
  }, [perfSamples, viewportEntries]);

  if (hidden) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-20">
      <div
        className={cn(
          "min-w-[18rem] rounded-xl border border-border/40 bg-background/78 px-3 py-2",
          "font-mono text-[0.65rem] text-foreground shadow-xl backdrop-blur-md",
        )}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Viewport Perf
          </span>
          <span className="text-muted-foreground">
            canvases {fmtInt(metrics.activeCanvases)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-muted-foreground">draw calls</span>
          <span>{fmtInt(metrics.drawCalls)}</span>
          <span className="text-muted-foreground">triangles</span>
          <span>{fmtInt(metrics.triangles)}</span>
          <span className="text-muted-foreground">geometries</span>
          <span>{fmtInt(metrics.geometries)}</span>
          <span className="text-muted-foreground">textures</span>
          <span>{fmtInt(metrics.textures)}</span>
          <span className="text-muted-foreground">Fem topo</span>
          <span>{fmtMs(metrics.femTopology)}</span>
          <span className="text-muted-foreground">Fem colors</span>
          <span>{fmtMs(metrics.femColors)}</span>
          <span className="text-muted-foreground">Slice topo</span>
          <span>{fmtMs(metrics.femSliceTopology)}</span>
          <span className="text-muted-foreground">Slice field</span>
          <span>{fmtMs(metrics.femSliceField)}</span>
          <span className="text-muted-foreground">FDM inst</span>
          <span>{fmtMs(metrics.fdmInstances)}</span>
        </div>
        {metrics.entries.length > 0 ? (
          <div className="mt-2 border-t border-border/30 pt-2 text-[0.6rem] text-muted-foreground">
            {metrics.entries.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-3">
                <span className="truncate">{entry.label}</span>
                <span>{fmtInt(entry.drawCalls)} dc</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});
