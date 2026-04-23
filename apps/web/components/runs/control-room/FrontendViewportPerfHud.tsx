"use client";

import { memo, useMemo, useSyncExternalStore } from "react";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import {
  getFrontendPerfSamples,
  subscribeFrontendPerfSamples,
  type PerfSample,
} from "@/lib/debug/frontendPerfDebug";
import { useFrontendResourceBuckets } from "@/lib/debug/frontendResourceManager";
import { useViewportTelemetrySnapshot } from "@/lib/debug/viewportTelemetry";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
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

function recentDurations(
  samples: PerfSample[],
  scope: string,
  phase: string,
  limit = 10,
): number[] {
  const values: number[] = [];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (sample.scope !== scope || sample.phase !== phase) {
      continue;
    }
    if (Number.isFinite(sample.durationMs)) {
      values.push(sample.durationMs);
    }
    if (values.length >= limit) {
      break;
    }
  }
  return values.reverse();
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
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

function fmtPair(last: number | null, p95: number | null): string {
  return `${fmtMs(last)} / ${fmtMs(p95)}`;
}

function fmtBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export const FrontendViewportPerfHud = memo(function FrontendViewportPerfHud() {
  const perfSamples = useFrontendPerfSamples();
  const viewportEntries = useViewportTelemetrySnapshot();
  const resourceBuckets = useFrontendResourceBuckets();
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const stageTabs = useWorkspaceStore((state) => state.workspaceTabsByStage[state.currentStage]);

  const hidden = process.env.NODE_ENV === "production" || !FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showTelemetryHud;
  const metrics = useMemo(() => {
    const webglEntries = viewportEntries.filter((entry) => entry.renderer === "webgl");
    const warmTabs = stageTabs.filter((tab) => tab.lifecycle === "warm").length;
    const resourceBytes = resourceBuckets.reduce((sum, bucket) => sum + bucket.estimatedBytes, 0);
    // Approximate VRAM-like proxy for quick diagnostics (not exact GPU memory).
    const webglProxyBytes =
      webglEntries.reduce((sum, entry) => sum + entry.textures * 4 * 1024 * 1024, 0) +
      webglEntries.reduce((sum, entry) => sum + entry.geometries * 256 * 1024, 0) +
      webglEntries.reduce((sum, entry) => sum + entry.triangles * 36, 0);
    return {
      activeCanvases: webglEntries.length,
      warmTabs,
      stage: currentStage,
      resourceBytes,
      webglProxyBytes,
      resourceBuckets,
      drawCalls: webglEntries.reduce((sum, entry) => sum + entry.drawCalls, 0),
      triangles: webglEntries.reduce((sum, entry) => sum + entry.triangles, 0),
      geometries: webglEntries.reduce((sum, entry) => sum + entry.geometries, 0),
      textures: webglEntries.reduce((sum, entry) => sum + entry.textures, 0),
      entries: webglEntries.slice(0, 2),
      femTopology: (() => {
        const recent = recentDurations(perfSamples, "FemGeometry", "topologyTotal");
        return {
          last: latestSample(perfSamples, "FemGeometry", "topologyTotal")?.durationMs ?? null,
          p95: percentile95(recent),
        };
      })(),
      femColors: (() => {
        const recent = recentDurations(perfSamples, "FemGeometry", "colors");
        const fallbackRecent = recent.length === 0
          ? recentDurations(perfSamples, "FemGeometry", "colorTotal")
          : recent;
        return {
          last:
            latestSample(perfSamples, "FemGeometry", "colors")?.durationMs
            ?? latestSample(perfSamples, "FemGeometry", "colorTotal")?.durationMs
            ?? null,
          p95: percentile95(fallbackRecent),
        };
      })(),
      femSliceTopology: (() => {
        const recent = recentDurations(perfSamples, "FemSlice2D", "topology");
        return {
          last: latestSample(perfSamples, "FemSlice2D", "topology")?.durationMs ?? null,
          p95: percentile95(recent),
        };
      })(),
      femSliceField: (() => {
        const recent = recentDurations(perfSamples, "FemSlice2D", "field");
        return {
          last: latestSample(perfSamples, "FemSlice2D", "field")?.durationMs ?? null,
          p95: percentile95(recent),
        };
      })(),
      fdmInstances: (() => {
        const recent = recentDurations(perfSamples, "FdmInstances", "update");
        return {
          last: latestSample(perfSamples, "FdmInstances", "update")?.durationMs ?? null,
          p95: percentile95(recent),
        };
      })(),
      quantitySwitchRequest: (() => {
        const recent = recentDurations(perfSamples, "QuantitySwitch", "request");
        return {
          last: latestSample(perfSamples, "QuantitySwitch", "request")?.durationMs ?? null,
          p95: percentile95(recent),
        };
      })(),
      quantitySwitchFieldSelected: (() => {
        const recent = recentDurations(perfSamples, "QuantitySwitch", "field-selected");
        return {
          last: latestSample(perfSamples, "QuantitySwitch", "field-selected")?.durationMs ?? null,
          p95: percentile95(recent),
        };
      })(),
      quantitySwitchFrameRendered: (() => {
        const recent = recentDurations(perfSamples, "QuantitySwitch", "frame-rendered");
        return {
          last: latestSample(perfSamples, "QuantitySwitch", "frame-rendered")?.durationMs ?? null,
          p95: percentile95(recent),
        };
      })(),
      quantitySwitchColorUpload: (() => {
        const recent = recentDurations(perfSamples, "QuantitySwitch", "geometry-color-upload-done");
        return {
          last:
            latestSample(perfSamples, "QuantitySwitch", "geometry-color-upload-done")?.durationMs ??
            null,
          p95: percentile95(recent),
        };
      })(),
      viewport3DRollout: (() => {
        const routeSample = latestSample(perfSamples, "Viewport3DRollout", "route-selected");
        const fallbackCount = perfSamples.filter(
          (sample) =>
            sample.scope === "Viewport3DRollout" &&
            sample.phase === "fallback-used",
        ).length;
        return {
          route:
            typeof routeSample?.meta?.route === "string"
              ? routeSample.meta.route
              : "n/a",
          fallbackCount,
        };
      })(),
    };
  }, [currentStage, perfSamples, resourceBuckets, stageTabs, viewportEntries]);

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
          <span className="text-muted-foreground">stage</span>
          <span>{metrics.stage}</span>
          <span className="text-muted-foreground">warm tabs</span>
          <span>{fmtInt(metrics.warmTabs)}</span>
          <span className="text-muted-foreground">resource cache</span>
          <span>{fmtBytes(metrics.resourceBytes)}</span>
          <span className="text-muted-foreground">webgl proxy</span>
          <span>{fmtBytes(metrics.webglProxyBytes)}</span>
          <span className="text-muted-foreground">draw calls</span>
          <span>{fmtInt(metrics.drawCalls)}</span>
          <span className="text-muted-foreground">triangles</span>
          <span>{fmtInt(metrics.triangles)}</span>
          <span className="text-muted-foreground">geometries</span>
          <span>{fmtInt(metrics.geometries)}</span>
          <span className="text-muted-foreground">textures</span>
          <span>{fmtInt(metrics.textures)}</span>
          <span className="text-muted-foreground">Fem topo (last/p95)</span>
          <span>{fmtPair(metrics.femTopology.last, metrics.femTopology.p95)}</span>
          <span className="text-muted-foreground">Fem colors (last/p95)</span>
          <span>{fmtPair(metrics.femColors.last, metrics.femColors.p95)}</span>
          <span className="text-muted-foreground">Slice topo (last/p95)</span>
          <span>{fmtPair(metrics.femSliceTopology.last, metrics.femSliceTopology.p95)}</span>
          <span className="text-muted-foreground">Slice field (last/p95)</span>
          <span>{fmtPair(metrics.femSliceField.last, metrics.femSliceField.p95)}</span>
          <span className="text-muted-foreground">FDM inst (last/p95)</span>
          <span>{fmtPair(metrics.fdmInstances.last, metrics.fdmInstances.p95)}</span>
          <span className="text-muted-foreground">Q switch req (last/p95)</span>
          <span>{fmtPair(metrics.quantitySwitchRequest.last, metrics.quantitySwitchRequest.p95)}</span>
          <span className="text-muted-foreground">Q switch field (last/p95)</span>
          <span>{fmtPair(metrics.quantitySwitchFieldSelected.last, metrics.quantitySwitchFieldSelected.p95)}</span>
          <span className="text-muted-foreground">Q switch frame (last/p95)</span>
          <span>{fmtPair(metrics.quantitySwitchFrameRendered.last, metrics.quantitySwitchFrameRendered.p95)}</span>
          <span className="text-muted-foreground">Q switch upload (last/p95)</span>
          <span>{fmtPair(metrics.quantitySwitchColorUpload.last, metrics.quantitySwitchColorUpload.p95)}</span>
          <span className="text-muted-foreground">3D route</span>
          <span>{metrics.viewport3DRollout.route}</span>
          <span className="text-muted-foreground">3D fallback hits</span>
          <span>{fmtInt(metrics.viewport3DRollout.fallbackCount)}</span>
        </div>
        {metrics.resourceBuckets.length > 0 ? (
          <div className="mt-2 border-t border-border/30 pt-2 text-[0.6rem] text-muted-foreground">
            {metrics.resourceBuckets.slice(0, 4).map((bucket) => (
              <div key={bucket.id} className="flex items-center justify-between gap-3">
                <span className="truncate">{bucket.label}</span>
                <span>
                  {fmtInt(bucket.entries)} · {fmtBytes(bucket.estimatedBytes)}
                  {bucket.capacity != null ? ` / ${fmtInt(bucket.capacity)}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}
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
