import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FieldMetaResource } from "@/kernel/api/apiTypes";
import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";

import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";
import { VisualizationDebugPanelView } from "./VisualizationDebugPanel";
import { memoryGroups } from "./visualizationDebugPresentation";

const SECTION_TITLES = [
  "Health",
  "Active target",
  "Viewport & carriers",
  "Request & transport",
  "Backend metadata",
  "Decoded payload",
  "Statistics",
  "Sample values",
  "Memory",
  "Render passes",
  "Revisions & provenance",
  "Detected inconsistencies",
  "Evidence export",
] as const;

describe("VisualizationDebugPanelView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all 13 scientific evidence sections in the required order", () => {
    const html = renderToStaticMarkup(
      <VisualizationDebugPanelView model={readyModel()} nowMs={2_000} />,
    );

    let previous = -1;
    for (const title of SECTION_TITLES) {
      const escapedTitle = title.replace("&", "&amp;");
      const index = html.indexOf(`>${escapedTitle}<`);
      expect(index, `${title} must be rendered`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(html).toContain("Magnetization");
    expect(html).toContain("A/m");
    expect(html).toContain("1.50 KiB");
    expect(html).toContain("Shared bytes are excluded from target-owned total");
    expect(html).toContain("viewport-wide");
    expect(html).toContain("Raw bounded JSON");
    expect(html).toContain("data-open=\"false\"");
  });

  it("keeps memory row identities unique across carriers with local entry IDs", () => {
    const rowKeys = memoryGroups(multiCarrierMemoryModel()).flatMap((group) =>
      group.rows.map(
        (row) => (row as typeof row & { renderKey?: string }).renderKey,
      ),
    );

    expect(rowKeys.every((key) => typeof key === "string" && key.length > 0)).toBe(
      true,
    );
    expect(new Set(rowKeys).size).toBe(rowKeys.length);
  });

  it("renders the canonical region selection kind without reconstructing it", () => {
    const model = readyModel();
    model.target = {
      id: "region:magnet:core",
      kind: "region",
      selectionKind: "object.region.visualization.debug",
    };

    const html = renderToStaticMarkup(
      <VisualizationDebugPanelView model={model} nowMs={2_000} />,
    );

    expect(html).toContain(">object.region.visualization.debug<");
  });

  it.each([
    ["missing-snapshot", "Loading visualization evidence"],
    ["active-non-3d", "No active 3D viewport"],
    ["missing-viewport", "No active 3D viewport"],
    ["target-not-rendered", "Target is not rendered"],
    ["unsupported-target", "Unsupported visualization target"],
  ] as const)("renders the %s empty state", (state, expected) => {
    const html = renderToStaticMarkup(
      <VisualizationDebugPanelView
        model={{ ...emptyModel(), state }}
        nowMs={2_000}
      />,
    );
    expect(html).toContain(expected);
  });

  it.each([
    ["missing-snapshot", "frame-not-committed"],
    ["target-not-rendered", "target-not-active"],
  ] as const)(
    "keeps %s health evidence and export controls observable",
    (state, code) => {
      const model = {
        ...emptyModel(),
        disposition: "unknown" as const,
        issues: [
          {
            code,
            evidence: [`state=${state}`],
            message: `Evidence for ${state}`,
            severity: "warning" as const,
            source: "render-derived" as const,
          },
        ],
        state,
      };
      const html = renderToStaticMarkup(
        <VisualizationDebugPanelView model={model} nowMs={2_000} />,
      );

      expect(html).toContain("Detected inconsistencies");
      expect(html).toContain(code);
      expect(html).toContain("Evidence export");
      expect(html).toContain('aria-label="Export JSON"');
      expect(html).toContain(`&quot;code&quot;: &quot;${code}&quot;`);
    },
  );

  it.each([
    ["ready", "Evidence is internally consistent"],
    ["degraded", "Evidence is degraded"],
    ["blocked", "Visualization pipeline is blocked"],
    ["unknown", "Health is unknown"],
  ] as const)("renders non-color %s health", (disposition, diagnosis) => {
    const model = readyModel();
    const snapshot = model.viewports[0]!.snapshots[0]!;
    const next = replaceSnapshot(model, { ...snapshot, disposition });
    const html = renderToStaticMarkup(
      <VisualizationDebugPanelView model={next} nowMs={2_000} />,
    );
    expect(html).toContain(`data-disposition=\"${disposition}\"`);
    expect(html).toContain(`>${disposition}<`);
    expect(html).toContain(diagnosis);
  });

  it("renders stale, scanning, no-field-requested and request-error states distinctly", () => {
    const staleHtml = renderToStaticMarkup(
      <VisualizationDebugPanelView model={readyModel()} nowMs={80_000} />,
    );
    expect(staleHtml).toContain("Snapshot is stale");

    const scanning = mapCarrier(readyModel(), (carrier) => ({
      ...carrier,
      scanState: "scanning",
    }));
    expect(
      renderToStaticMarkup(
        <VisualizationDebugPanelView model={scanning} nowMs={2_000} />,
      ),
    ).toContain("Statistics scan in progress");

    const noField = mapCarrier(readyModel(), (carrier) => ({
      ...carrier,
      payload: null,
      request: { plannerRequestId: null, resourceKey: null },
    }));
    expect(
      renderToStaticMarkup(
        <VisualizationDebugPanelView model={noField} nowMs={2_000} />,
      ),
    ).toContain("No field requested");

    const requestError = readyModel();
    requestError.transport = [
      { ...requestError.transport[0]!, outcome: "error", status: 500 },
    ];
    requestError.disposition = "blocked";
    requestError.issues = [
      {
        code: "field-request-error",
        evidence: ["request=http-request-7"],
        message: "The newest completed exact field request failed.",
        severity: "error",
        source: "transport",
      },
    ];
    expect(
      renderToStaticMarkup(
        <VisualizationDebugPanelView model={requestError} nowMs={2_000} />,
      ),
    ).toContain("Matched field request failed");
  });

  it("uses a production render-time clock when nowMs is not injected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000);

    const html = renderToStaticMarkup(
      <VisualizationDebugPanelView model={readyModel()} />,
    );

    expect(html).toContain("Snapshot is stale");
    expect(html).toContain("Snapshot age 79000 ms");
  });

  it("uses semantic table headings and native, accessible evidence actions", () => {
    const html = renderToStaticMarkup(
      <VisualizationDebugPanelView model={readyModel()} nowMs={2_000} />,
    );
    for (const heading of ["Carrier", "Point index", "Node index", "c0", "Magnitude", "Unit"]) {
      expect(html).toContain(`<th scope=\"col\">${heading}</th>`);
    }
    expect(html).toMatch(/data-sample-row=[^>]+>[\s\S]*?<td>A\/m<\/td>/);
    for (const name of ["Copy log", "Copy snapshot", "Copy resource key", "Export JSON"]) {
      expect(html).toContain(`<button`);
      expect(html).toContain(`aria-label=\"${name}\"`);
    }
    expect(html).not.toContain("tabindex=\"-1\"");
  });

  it("caps samples at 12 rows and components at 8 without raw tuples", () => {
    const model = mapCarrier(readyModel(), (carrier) => ({
      ...carrier,
      payload: { ...carrier.payload!, nComp: 10 },
      samples: Array.from({ length: 18 }, (_, pointIndex) => ({
        componentValues: Array.from({ length: 10 }, (_, component) => pointIndex + component / 10),
        magnitude: null,
        nodeIndex: 100 + pointIndex,
        pointIndex,
      })),
    }));
    const html = renderToStaticMarkup(
      <VisualizationDebugPanelView model={model} nowMs={2_000} />,
    );
    expect((html.match(/data-sample-row=/g) ?? [])).toHaveLength(12);
    expect(html).toContain("c7");
    expect(html).not.toContain("c8");
    expect(html).not.toContain("[0,0.1");
    expect(html).not.toMatch(/<tr[^>]*data-sample-row=[^>]*title=/);
    expect(html).toContain("Showing 12 of 18 samples");
  });

  it("defines token-only focus and reduced-motion styling", () => {
    const css = readFileSync(
      new URL(
        "../../../../design/styles/components/visualization-debug.css",
        import.meta.url,
      ),
      "utf8",
    );
    expect(css).toContain(".fm-visualization-debug-action:focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(?:rgb|hsl)a?\(/i);
    expect(css).not.toMatch(/className=/);
    const indexCss = readFileSync(
      new URL("../../../../design/styles/components/index.css", import.meta.url),
      "utf8",
    );
    expect(indexCss.trim()).toBe('@import "./visualization-debug.css";');
  });
});

function emptyModel(): VisualizationDebugPanelModel {
  return {
    disposition: "unknown",
    fieldQueries: [],
    issues: [],
    state: "missing-snapshot",
    target: {
      id: "object:magnet",
      kind: "object",
      selectionKind: "object.visualization.debug",
    },
    transport: [],
    viewports: [],
  };
}

function readyModel(): VisualizationDebugPanelModel {
  const snapshot = debugSnapshot();
  const carrier = snapshot.carriers[0]!;
  const backendMeta: FieldMetaResource = {
    components: 3,
    domain_generation_id: "domain-9",
    field_revision: 42,
    kind: "vector",
    label: "Magnetization",
    location: "node",
    materialization_wall_time_ns: 0,
    materialized_at_unix_ms: 0,
    quantity_id: "m",
    source_revision: 42,
    source_step: 0,
    stale_by_steps: 0,
    state: "complete",
    stats: { min: -1, max: 1, mean: 0.125 },
    unit: "A/m",
  };
  const transport: RequestDiagnosticEntry = {
    byteLength: 1536,
    channel: "http",
    contentType: "application/vnd.fullmag.field-vector",
    detail: null,
    direction: "rx",
    durationMs: 4.25,
    etag: '"field-42"',
    id: "transport-1",
    messageType: null,
    method: "GET",
    outcome: "ok",
    path: DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m"),
    requestId: "http-request-7",
    resourceKey: carrier.request.resourceKey,
    status: 200,
    timestampMs: 1_010,
  };
  return {
    disposition: "ready",
    fieldQueries: [],
    issues: snapshot.issues,
    state: "ready",
    target: {
      id: "object:magnet",
      kind: "object",
      selectionKind: "object.visualization.debug",
    },
    transport: [transport],
    viewports: [
      {
        carriers: [
          {
            carrierId: carrier.carrierId,
            observations: [
              {
                backendMeta,
                backendRenderComparison: { compatible: true, rangesMatch: true },
                carrier,
                query: null,
                snapshot,
                wireByteLength: 1536,
              },
            ],
          },
        ],
        clientAcks: [
          {
            client_id: "client-1",
            received_at_unix_ms: 1_015,
            revision: 42,
            scope: "viewport-wide",
            status: "rendered",
            viewport_id: "viewport-primary",
          },
        ],
        snapshots: [snapshot],
        viewportId: "viewport-primary",
      },
    ],
  };
}

function debugSnapshot(): VisualizationDebugSnapshot {
  const samples = Array.from({ length: 4 }, (_, pointIndex) => ({
    componentValues: [pointIndex, pointIndex + 0.25, pointIndex + 0.5],
    magnitude: pointIndex + 0.75,
    nodeIndex: 40 + pointIndex,
    pointIndex,
  }));
  return {
    capturedAtMs: 1_000,
    carriers: [
      {
        cache: {
          byteLength: 1536,
          entryState: "ready",
          etag: '"field-42"',
          fieldCacheByteLength: 4096,
          fieldCacheEntryCount: 2,
          fieldCacheMaxBytes: 1_048_576,
          retainCount: 1,
        },
        carrierId: "part:magnet",
        carrierRole: "magnetic-volume",
        memory: [
          { byteLength: 96, id: "decoded", label: "Decoded values", ownership: "referenced", source: "cache" },
          { byteLength: 64, id: "scalar", label: "Scalar projection", ownership: "owned", source: "render-derived" },
          { byteLength: 32, id: "estimate", label: "Model estimate", ownership: "estimated", source: "ui-derived" },
        ],
        payload: {
          component: "full",
          dtype: "float64",
          formatVersion: 3,
          grid: [2, 2, 1],
          indexing: "explicit_node_indices",
          nComp: 3,
          nodeIndexCount: 4,
          pointCount: 4,
          quantityId: "m",
          scopeId: "magnet",
          scopeKind: "object",
          valueCount: 12,
        },
        render: {
          adoption: {
            frameCommitId: "frame-42",
            surface: {
              adoptedAtMs: 42,
              adoptedFieldBufferId: "field-buffer-42",
              adoptedResourceKey: "/data/fields/m/samples/vector?scope_kind=object&scope_id=magnet",
              adoptedScalarBufferKey: "scalar-42",
              adoptionSequence: 42,
            },
            vector: {
              adoptedAtMs: 42,
              adoptedFieldBufferId: "field-buffer-42",
              adoptedResourceKey: "/data/fields/m/samples/vector?scope_kind=object&scope_id=magnet",
              adoptedVectorBuildKey: "vectors-42",
              adoptedVectorItemCount: 4,
              adoptionSequence: 43,
            },
          },
          fieldBufferState: "ready",
          requestedFieldBufferId: "field-buffer-42",
          requestedPasses: ["surface", "vectors"],
          surface: {
            bufferKey: "scalar-42",
            colorMode: "magnitude",
            degradation: null,
            projectionMode: "magnitude",
            scalarByteLength: 32,
          },
          vectors: {
            buildKey: "vectors-42",
            degradation: null,
            segmentByteLength: 96,
            segmentCount: 4,
          },
        },
        request: {
          plannerRequestId: "planner-7",
          resourceKey: "/data/fields/m/samples/vector?scope_kind=object&scope_id=magnet",
        },
        revisions: {
          domainGenerationId: "domain-9",
          fieldRevision: "42",
          meshTopologyHash: "mesh-hash-3",
          topologyRevision: "topology-5",
          visualizationRevision: "visualization-11",
        },
        samples,
        scanState: "complete",
        statistics: [
          { finiteCount: 12, max: 3.5, mean: 1.75, min: 0, nonFiniteCount: 0, p01: 0.1, p99: 3.4, source: "decoded-payload", zeroCount: 1 },
          { finiteCount: 4, max: 3.5, mean: 1.75, min: 0, nonFiniteCount: 0, p01: 0.1, p99: 3.4, source: "render-derived", zeroCount: 1 },
        ],
      },
    ],
    disposition: "ready",
    issues: [
      { code: "cache-byte-note", evidence: ["wire=1536", "cache=1536"], message: "Wire and cache evidence agree.", severity: "info", source: "cache" },
    ],
    memoryTotals: { owned: 64, referenced: 96, shared: 2048 },
    ownedByteLength: 64,
    sharedMemory: [
      { byteLength: 2048, id: "webgl-context", label: "WebGL context", ownership: "shared", source: "webgl-shared" },
    ],
    target: {
      carrierIds: ["part:magnet"],
      id: "object:magnet",
      kind: "object",
      label: "Magnet",
    },
    viewport: {
      contextLost: false,
      drawingBuffer: [1280, 720],
      frameCommittedAtMs: 990,
      frameCommitId: "frame-42",
      viewportId: "viewport-primary",
    },
    version: 1,
  };
}

function multiCarrierMemoryModel(): VisualizationDebugPanelModel {
  const model = readyModel();
  const viewport = model.viewports[0]!;
  const snapshot = viewport.snapshots[0]!;
  const firstCarrier = snapshot.carriers[0]!;
  const secondCarrier = {
    ...firstCarrier,
    carrierId: "part:magnet-secondary",
  };
  const multiCarrierSnapshot = {
    ...snapshot,
    carriers: [firstCarrier, secondCarrier],
    target: {
      ...snapshot.target,
      carrierIds: [firstCarrier.carrierId, secondCarrier.carrierId],
    },
  };
  const firstObservation = viewport.carriers[0]!.observations[0]!;

  return {
    ...model,
    viewports: [
      {
        ...viewport,
        carriers: [
          {
            carrierId: firstCarrier.carrierId,
            observations: [
              {
                ...firstObservation,
                snapshot: multiCarrierSnapshot,
              },
            ],
          },
          {
            carrierId: secondCarrier.carrierId,
            observations: [
              {
                ...firstObservation,
                carrier: secondCarrier,
                snapshot: multiCarrierSnapshot,
              },
            ],
          },
        ],
        snapshots: [multiCarrierSnapshot],
      },
    ],
  };
}

function replaceSnapshot(
  model: VisualizationDebugPanelModel,
  snapshot: VisualizationDebugSnapshot,
): VisualizationDebugPanelModel {
  const carrier = snapshot.carriers[0]!;
  return {
    ...model,
    disposition: snapshot.disposition,
    issues: snapshot.issues,
    viewports: model.viewports.map((viewport) => ({
      ...viewport,
      carriers: viewport.carriers.map((group) => ({
        ...group,
        observations: group.observations.map((observation) => ({
          ...observation,
          carrier,
          snapshot,
        })),
      })),
      snapshots: [snapshot],
    })),
  };
}

function mapCarrier(
  model: VisualizationDebugPanelModel,
  transform: (
    carrier: VisualizationDebugSnapshot["carriers"][number],
  ) => VisualizationDebugSnapshot["carriers"][number],
): VisualizationDebugPanelModel {
  const snapshot = model.viewports[0]!.snapshots[0]!;
  const carrier = transform(snapshot.carriers[0]!);
  return replaceSnapshot(model, {
    ...snapshot,
    carriers: [carrier],
  });
}
