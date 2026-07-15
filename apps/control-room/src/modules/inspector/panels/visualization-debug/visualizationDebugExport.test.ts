import { describe, expect, it, vi } from "vitest";

import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";
import {
  MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
  VISUALIZATION_DEBUG_EXPORT_MIME,
  VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION,
  buildVisualizationDebugExport,
  createVisualizationDebugEvidenceActions,
} from "./visualizationDebugExport";

describe("visualization debug evidence export", () => {
  it("builds deterministic schema-versioned, JSON-safe evidence within the byte budget", () => {
    const model = exportModel("/data/fields/m/samples/vector?scope_kind=object&scope_id=magnet");
    const result = buildVisualizationDebugExport(model, 1_234);

    expect(result.document.schemaVersion).toBe(
      VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION,
    );
    expect(result.document.exportedAtMs).toBe(1_234);
    expect(result.document.model.state).toBe("ready");
    expect(result.mime).toBe(VISUALIZATION_DEBUG_EXPORT_MIME);
    expect(new TextEncoder().encode(result.json).byteLength).toBeLessThanOrEqual(
      MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
    );
    expect(JSON.parse(result.json)).toEqual(result.document);
  });

  it("replaces oversized evidence with a bounded, explicit size-limit summary", () => {
    const model = exportModel(`/data/fields/m/${"x".repeat(80_000)}`);
    const result = buildVisualizationDebugExport(model, 1_234);

    expect(result.document.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export-size-limit" }),
      ]),
    );
    expect(new TextEncoder().encode(result.json).byteLength).toBeLessThanOrEqual(
      MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
    );
  });

  it("copies snapshot and exact resource key with bounded success feedback", async () => {
    const writeText = vi.fn(async () => undefined);
    const feedback = vi.fn();
    const timers = fakeTimers();
    const actions = createVisualizationDebugEvidenceActions(exportModel("resource:key"), {
      clipboard: { writeText },
      createObjectURL: vi.fn(() => "blob:unused"),
      download: vi.fn(),
      feedback,
      now: () => 1_234,
      revokeObjectURL: vi.fn(),
      timers,
    });

    await actions.copySnapshot();
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining(VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION),
    );
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "success",
      message: "Snapshot copied.",
    });
    await actions.copyResourceKey();
    expect(writeText).toHaveBeenLastCalledWith("resource:key");
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "success",
      message: "Resource key copied.",
    });
    expect(timers.pending()).toBe(1);
    timers.runPending();
    expect(feedback).toHaveBeenLastCalledWith(null);
  });

  it("reports clipboard failure without throwing and clears the feedback timer on dispose", async () => {
    const feedback = vi.fn();
    const timers = fakeTimers();
    const actions = createVisualizationDebugEvidenceActions(exportModel("resource:key"), {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      createObjectURL: vi.fn(() => "blob:unused"),
      download: vi.fn(),
      feedback,
      now: () => 1_234,
      revokeObjectURL: vi.fn(),
      timers,
    });

    await expect(actions.copySnapshot()).resolves.toBeUndefined();
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "error",
      message: "Snapshot could not be copied.",
    });
    expect(timers.pending()).toBe(1);
    actions.dispose();
    expect(timers.pending()).toBe(0);
    expect(feedback).toHaveBeenLastCalledWith(null);
  });

  it("exports application/json and always revokes the object URL after the action", () => {
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return "blob:visualization-debug";
    });
    const download = vi.fn();
    const revokeObjectURL = vi.fn();
    const actions = createVisualizationDebugEvidenceActions(exportModel("resource:key"), {
      clipboard: { writeText: vi.fn(async () => undefined) },
      createObjectURL,
      download,
      feedback: vi.fn(),
      now: () => 1_234,
      revokeObjectURL,
      timers: fakeTimers(),
    });

    actions.exportJson();
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe(VISUALIZATION_DEBUG_EXPORT_MIME);
    expect(download).toHaveBeenCalledWith(
      "blob:visualization-debug",
      expect.stringMatching(/^fullmag-visualization-debug-.*\.json$/),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:visualization-debug");
  });

  it("revokes an object URL even if the browser download seam fails", () => {
    const revokeObjectURL = vi.fn();
    const feedback = vi.fn();
    const actions = createVisualizationDebugEvidenceActions(exportModel("resource:key"), {
      clipboard: { writeText: vi.fn(async () => undefined) },
      createObjectURL: vi.fn(() => "blob:failed-download"),
      download: vi.fn(() => {
        throw new Error("download blocked");
      }),
      feedback,
      now: () => 1_234,
      revokeObjectURL,
      timers: fakeTimers(),
    });

    expect(() => actions.exportJson()).not.toThrow();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-download");
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "error",
      message: "JSON evidence could not be exported.",
    });
  });
});

function exportModel(resourceKey: string): VisualizationDebugPanelModel {
  return {
    fieldQueries: [],
    state: "ready",
    target: { id: "object:magnet", kind: "object" },
    transport: [],
    viewports: [
      {
        carriers: [
          {
            carrierId: "part:magnet",
            observations: [
              {
                backendMeta: null,
                backendRenderComparison: null,
                carrier: {
                  cache: { byteLength: 24, entryState: "ready", etag: null, fieldCacheByteLength: 24, fieldCacheEntryCount: 1, fieldCacheMaxBytes: 1024, retainCount: 1 },
                  carrierId: "part:magnet",
                  carrierRole: "magnetic",
                  memory: [],
                  payload: null,
                  render: {
                    adoption: { adoptedFieldBufferId: null, adoptedResourceKey: resourceKey, adoptedScalarBufferKey: null, adoptedVectorBuildKey: null, frameCommitId: "frame-1" },
                    fieldBufferState: "ready",
                    requestedFieldBufferId: null,
                    requestedPasses: [],
                    surface: { bufferKey: null, colorMode: null, degradation: null, projectionMode: null, scalarByteLength: null },
                    vectors: { buildKey: null, degradation: null, segmentByteLength: null, segmentCount: null },
                  },
                  request: { plannerRequestId: "planner-1", resourceKey },
                  revisions: { domainGenerationId: "domain-1", fieldRevision: "1", meshTopologyHash: "mesh-1", topologyRevision: "topology-1", visualizationRevision: "1" },
                  samples: [],
                  scanState: "unavailable",
                  statistics: [],
                },
                query: null,
                snapshot: {
                  capturedAtMs: 1_000,
                  carriers: [],
                  disposition: "ready",
                  issues: [],
                  sharedMemory: [],
                  target: { carrierIds: ["part:magnet"], id: "object:magnet", kind: "object", label: "Magnet" },
                  viewport: { contextLost: false, drawingBuffer: [640, 480], frameCommittedAtMs: 990, frameCommitId: "frame-1", viewportId: "viewport-primary" },
                  version: 1,
                },
              },
            ],
          },
        ],
        clientAcks: [],
        snapshots: [],
        viewportId: "viewport-primary",
      },
    ],
  };
}

function fakeTimers() {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  return {
    clear(id: unknown) {
      pending.delete(id as number);
    },
    pending: () => pending.size,
    runPending() {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
    set(callback: () => void) {
      const id = ++nextId;
      pending.set(id, callback);
      return id;
    },
  };
}
