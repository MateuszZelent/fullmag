import { describe, expect, it, vi } from "vitest";

import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";
import {
  MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
  VISUALIZATION_DEBUG_EXPORT_MIME,
  VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION,
  buildVisualizationDebugExport,
  buildVisualizationDebugLog,
  createVisualizationDebugEvidenceActions,
} from "./visualizationDebugExport";

const H_EFF_VECTOR_PATH = [
  "",
  "v2",
  "sessions",
  "current",
  "data",
  "fields",
  "H_eff",
  "samples",
  "vector",
].join("/");

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
    model.target = {
      id: `object:${"target".repeat(20_000)}`,
      kind: "object",
      selectionKind: "object.visualization.debug",
    };
    model.disposition = "blocked";
    model.issues = Array.from({ length: 20 }, (_, index) => ({
      code: `issue-${index}`,
      evidence: [`index=${index}:${"evidence".repeat(20_000)}`],
      message: `Issue ${index}:${"message".repeat(20_000)}`,
      severity: index === 0 ? "error" as const : "warning" as const,
      source: "render-derived" as const,
    }));
    let result: ReturnType<typeof buildVisualizationDebugExport> | undefined;

    expect(() => {
      result = buildVisualizationDebugExport(model, 1_234);
    }).not.toThrow();

    expect(result?.document.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export-size-limit" }),
      ]),
    );
    expect(new TextEncoder().encode(result?.json ?? "").byteLength).toBeLessThanOrEqual(
      MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
    );
    expect(result?.document.model).toMatchObject({
      disposition: model.disposition,
      state: model.state,
      issueCount: model.issues.length,
      target: { kind: "object" },
    });
    expect(result?.json).not.toContain("targettargettarget");
    expect(result?.json).not.toContain("evidenceevidenceevidence");
  });

  it("falls back to a bounded document when JSON cloning fails", () => {
    const model = exportModel("resource:key");
    (model as unknown as { cycle: unknown }).cycle = model;

    expect(() => buildVisualizationDebugExport(model, 1_234)).not.toThrow();
    const result = buildVisualizationDebugExport(model, 1_234);

    expect(result.document.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export-serialization-failed" }),
      ]),
    );
    expect(new TextEncoder().encode(result.json).byteLength).toBeLessThanOrEqual(
      MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
    );
  });

  it("returns minimal evidence when even the bounded model cannot be read", () => {
    const model = exportModel("resource:key");
    Object.defineProperty(model, "viewports", {
      get() {
        throw new Error("malformed model");
      },
    });
    let result: ReturnType<typeof buildVisualizationDebugExport> | undefined;

    expect(() => {
      result = buildVisualizationDebugExport(model, 1_234);
    }).not.toThrow();
    expect(result?.document.model).toMatchObject({
      disposition: "unknown",
      issues: [],
      state: "missing-snapshot",
    });
    expect(new TextEncoder().encode(result?.json ?? "").byteLength).toBeLessThanOrEqual(
      MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
    );
  });

  it("builds a readable bounded log with the exact transport evidence", () => {
    const model = exportModel(
      `${H_EFF_VECTOR_PATH}?component=full&scope_kind=airbox`,
    );
    model.transport = [
      {
        byteLength: 0,
        channel: "http",
        contentType: "application/json",
        detail: "ResourcePartialLoadError: One or more quantity field vectors are not ready.",
        direction: "rx",
        durationMs: 12,
        etag: null,
        id: "transport-1",
        messageType: null,
        method: "GET",
        outcome: "error",
        path: H_EFF_VECTOR_PATH,
        requestId: "request-1",
        resourceKey: `${H_EFF_VECTOR_PATH}?component=full&scope_kind=airbox`,
        status: 200,
        timestampMs: 1_234,
      },
    ];
    model.disposition = "blocked";
    model.issues = [
      {
        code: "scope-id-mismatch",
        evidence: ["requestedScopeId=none", "decodedScopeId=airbox"],
        message: "Planned and decoded scope identifiers differ.",
        severity: "error",
        source: "decoded-payload",
      },
    ];

    const log = buildVisualizationDebugLog(model, 1_234);

    expect(log).toContain("Fullmag Visualization Debug Log");
    expect(log).toContain("Health\tblocked");
    expect(log).toContain("scope-id-mismatch");
    expect(log).toContain("scope_kind=airbox");
    expect(log).toContain("Planned and decoded scope identifiers differ.");
    expect(log).toContain("ResourcePartialLoadError: One or more quantity field vectors are not ready.");
    expect(new TextEncoder().encode(log).byteLength).toBeLessThanOrEqual(
      MAX_VISUALIZATION_DEBUG_EXPORT_BYTES,
    );
  });

  it("copies log, snapshot, and exact resource key with bounded success feedback", async () => {
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
    await actions.copyLog();
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining("Fullmag Visualization Debug Log"),
    );
    expect(feedback).toHaveBeenLastCalledWith({
      kind: "success",
      message: "Debug log copied.",
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
    disposition: "ready",
    fieldQueries: [],
    issues: [],
    state: "ready",
    target: {
      id: "object:magnet",
      kind: "object",
      selectionKind: "object.visualization.debug",
    },
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
                    adoption: {
                      frameCommitId: "frame-1",
                      surface: { adoptedAtMs: null, adoptedFieldBufferId: null, adoptedResourceKey: resourceKey, adoptedScalarBufferKey: null, adoptionSequence: null },
                      vector: { adoptedAtMs: null, adoptedFieldBufferId: null, adoptedResourceKey: null, adoptedVectorBuildKey: null, adoptedVectorItemCount: null, adoptionSequence: null },
                    },
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
                wireByteLength: null,
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
