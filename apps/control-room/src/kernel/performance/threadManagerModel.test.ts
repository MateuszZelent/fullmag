import { describe, expect, it } from "vitest";

import type { RequestDiagnosticEntry } from "../api/RequestDiagnosticsController";

import {
  buildThreadManagerClipboardLog,
  buildThreadManagerMemoryBudgetRows,
  buildThreadManagerModel,
  formatMs,
} from "./threadManagerModel";

function entry(
  path: string,
  durationMs: number,
  timestampMs: number,
): RequestDiagnosticEntry {
  return {
    byteLength: null,
    channel: "performance",
    contentType: null,
    detail: "performance measure",
    direction: "rx",
    durationMs,
    id: `${timestampMs}`,
    messageType: "measure",
    method: "MEASURE",
    outcome: "ok",
    path,
    requestId: "performance-measure",
    status: null,
    timestampMs,
  };
}

describe("threadManagerModel", () => {
  it("groups browser performance measures by execution area", () => {
    const model = buildThreadManagerModel([
      entry("fullmag.viewport3d.buildViewport3DFieldRenderModel", 12, 1),
      entry("fullmag.viewport3d.buildMeshQualityVertexColors", 18, 2),
      entry("fullmag.api.requestBinaryResource.topology", 40, 3),
      entry("fullmag.react.render.InspectorModule.update", 8, 4),
      entry("fullmag.react.render.WorkspaceDockLayout.update", 5, 5),
      {
        ...entry("fullmag.browser.longtask", 80, 6),
        detail: "source=workspace;attribution=script",
      },
    ]);

    expect(model.sampleCount).toBe(6);
    expect(model.totalMeasuredMs).toBe(163);
    expect(model.rows.map((row) => row.id)).toEqual([
      "browser-longtask:workspace",
      "api-binary",
      "viewport-3d",
      "react:InspectorModule",
      "react:WorkspaceDockLayout",
    ]);
    expect(model.rows[4]).toMatchObject({
      label: "Workspace dock aggregate",
      lane: "aggregate",
    });
    expect(model.rows[2]).toMatchObject({
      averageMs: 15,
      label: "Viewport 3D",
      lane: "main",
      lastMs: 18,
      maxMs: 18,
      sampleCount: 2,
      totalMs: 30,
    });
  });

  it("reports viewport frame-loop activity separately from duration work", () => {
    const model = buildThreadManagerModel([
      {
        ...entry("fullmag.viewport3d.frame-window", 1000, 2),
        detail: "frames=30;fps=29.5;windowMs=1017;dirty=camera-control:6",
      },
      {
        ...entry("fullmag.viewport3d.frame-window", 1000, 1),
        detail:
          "frames=61;fps=60.8;windowMs=1003;dirty=camera-control:12,resources-updated:1",
      },
    ]);

    expect(model.sampleCount).toBe(0);
    expect(
      model.activityRows.find((row) => row.id === "viewport-3d-frame-loop"),
    ).toEqual({
      id: "viewport-3d-frame-loop",
      label: "Viewport 3D frame loop",
      lane: "main",
      latestRate: 29.5,
      maxRate: 60.8,
      sampleCount: 2,
      totalCount: 91,
      unit: "fps",
    });

    const cameraControl = model.activityRows.find(
      (row) => row.id === "viewport-3d-dirty:camera-control",
    );
    expect(cameraControl).toMatchObject({
      label: "Viewport dirty: camera-control",
      lane: "main",
      sampleCount: 2,
      totalCount: 18,
      unit: "dirty/s",
    });
    expect(cameraControl?.latestRate).toBeCloseTo(5.8997, 4);
    expect(cameraControl?.maxRate).toBeCloseTo(11.9641, 4);

    const resourcesUpdated = model.activityRows.find(
      (row) => row.id === "viewport-3d-dirty:resources-updated",
    );
    expect(resourcesUpdated).toMatchObject({
      label: "Viewport dirty: resources-updated",
      lane: "main",
      sampleCount: 1,
      totalCount: 1,
      unit: "dirty/s",
    });
    expect(resourcesUpdated?.latestRate).toBeCloseTo(0.997, 4);
    expect(resourcesUpdated?.maxRate).toBeCloseTo(0.997, 4);
  });

  it("reports untracked viewport frames when no dirty reason was captured", () => {
    const model = buildThreadManagerModel([
      {
        ...entry("fullmag.viewport3d.frame-window", 1000, 1),
        detail: "frames=11;fps=10.4;windowMs=1058;dirty=none",
      },
    ]);

    expect(
      model.activityRows.find(
        (row) => row.id === "viewport-3d-untracked-frames",
      ),
    ).toEqual({
      id: "viewport-3d-untracked-frames",
      label: "Viewport frames without tracked dirty reason",
      lane: "main",
      latestRate: 10.4,
      maxRate: 10.4,
      sampleCount: 1,
      totalCount: 11,
      unit: "frames/s",
    });
  });

  it("builds a clipboard log from the current diagnostic snapshot", () => {
    const entries = [
      {
        ...entry("fullmag.browser.longtask", 72, 10),
        detail: "source=workspace;attribution=script",
      },
    ];
    const model = buildThreadManagerModel(entries);

    const log = buildThreadManagerClipboardLog({
      browserCores: 48,
      entries,
      generatedAt: new Date("2026-05-28T07:30:00.000Z"),
      jsHeapBytes: 2048,
      model,
      reactProfilerEnabled: true,
    });

    expect(log).toContain("Thread Manager Snapshot");
    expect(log).toContain("Generated: 2026-05-28T07:30:00.000Z");
    expect(log).toContain("Browser cores: 48");
    expect(log).toContain("JS heap: 2.0 KB");
    expect(log).toContain("React profiler: on");
    expect(log).toContain(
      "Long task: workspace\tmain\t1\t72.0 ms\t72.0 ms\t72.0 ms\t100%\tfullmag.browser.longtask",
    );
    expect(log).toContain(
      "10\tMEASURE\tfullmag.browser.longtask\t72.0 ms\tsource=workspace;attribution=script",
    );
  });

  it("includes memory budgets in the clipboard log", () => {
    const entries = [entry("fullmag.api.requestBinaryResource.field-vector", 8, 1)];
    const model = buildThreadManagerModel(entries);
    const memoryBudgetRows = buildThreadManagerMemoryBudgetRows([
      {
        byteLength: 128 * 1024 * 1024,
        category: "viewport-cache",
        createdAtMs: 0,
        entryCount: 4,
        id: "viewport3d.fieldVectorCache",
        label: "Field vector cache",
        maxBytes: 128 * 1024 * 1024,
        owner: "viewport-3d",
        releaseReason: null,
      },
      {
        byteLength: 120 * 1024 * 1024,
        category: "render-buffer",
        createdAtMs: 0,
        entryCount: 48,
        id: "viewport3d.render.partVectorSegmentCache",
        label: "Part vector segment cache",
        maxBytes: null,
        owner: "viewport-3d",
        releaseReason: null,
      },
    ]);

    const log = buildThreadManagerClipboardLog({
      browserCores: null,
      entries,
      generatedAt: new Date("2026-05-28T07:30:00.000Z"),
      jsHeapBytes: null,
      memoryBudgetRows,
      model,
      reactProfilerEnabled: false,
    });

    expect(log).toContain("Memory Budgets");
    expect(log).toContain(
      "Field vector cache\tviewport-cache\t128.0 MB\t128.0 MB\t4\t100%\tok",
    );
    expect(log).toContain(
      "Part vector segment cache\trender-buffer\t120.0 MB\tunbounded\t48\tn/a\tunbounded-high",
    );
  });

  it("reports binary decode worker activity from binary resource measures", () => {
    const model = buildThreadManagerModel([
      entry("fullmag.api.requestBinaryResource.field-vector", 25, 1),
    ]);

    expect(model.workerRows).toEqual([
      {
        detail: "25.0 ms measured across 1 binary decode/request sample(s)",
        id: "binary-decode",
        label: "Binary decode worker",
        sampleCount: 1,
        status: "active",
      },
    ]);
  });

  it("formats short and large durations compactly", () => {
    expect(formatMs(4.321)).toBe("4.32 ms");
    expect(formatMs(14.321)).toBe("14.3 ms");
    expect(formatMs(141.9)).toBe("142 ms");
  });
});
