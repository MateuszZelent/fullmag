import { act, createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { KernelApi } from "@/kernel/types";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { createAnalysisResultFieldOverlayIntent } from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import {
  analysisResultSelectionFromProjectionPoint,
  analysisResultProjectionMatchesSelection,
  analysisResultSelectionOwnsOverlay,
  useAnalysisResultProjectionController,
} from "./useAnalysisResultProjectionController";
import {
  analysisResultSelectionRef,
  type AnalysisResultDatasetManifestResource,
  type AnalysisResultProjectionResource,
} from "@/shared/domain/analysis/results";
import type {
  AnalysisResultProjectionSelection,
  AnalysisResultProjectionSurfaceProps,
} from "./components/AnalysisResultProjectionSurface";

let mockSelectedResultSelection: ReturnType<typeof resultSelection> | null = null;
let mockResultManifest: AnalysisResultDatasetManifestResource | null = null;
let mockResultProjection: AnalysisResultProjectionResource | null = null;
const mockSelectionListeners = new Set<() => void>();

vi.mock("@/kernel/resources/analysisResultResources", () => ({
  useAnalysisResultDatasetManifestResource: () => ({ data: mockResultManifest }),
  useAnalysisResultProjectionResource: () => ({ data: mockResultProjection, status: "ready" }),
}));

vi.mock("@/kernel/selection/useSelection", () => ({
  useSelectionSelector: (selector: (selection: { ref: typeof mockSelectedResultSelection }) => unknown) =>
    useSyncExternalStore(
      (listener) => {
        mockSelectionListeners.add(listener);
        return () => mockSelectionListeners.delete(listener);
      },
      () => selector({ ref: mockSelectedResultSelection }),
      () => selector({ ref: mockSelectedResultSelection }),
    ),
}));

const projectionIdentity = {
  dataset_id: "result:dataset-1",
  dataset_revision: "dataset-revision-1",
  run_id: "run-1",
} satisfies Pick<
  AnalysisResultProjectionResource,
  "dataset_id" | "dataset_revision" | "run_id"
>;

const manifestIdentity = {
  dataset_id: "result:dataset-1",
  dataset_revision: "dataset-revision-1",
  run_id: "run-1",
} satisfies Pick<
  AnalysisResultDatasetManifestResource,
  "dataset_id" | "dataset_revision" | "run_id"
>;

const fieldRef = {
  field_id: "analysis:eigen:sample-1:mode-1",
  field_revision: "field-revision-1",
  mesh_ref: {
    mesh_id: "mesh-1",
    mesh_revision: "mesh-revision-1",
    topology_fingerprint: "sha256:topology-1",
  },
  quantity_id: "m",
  representation: "complex-vector-xyz",
  resource_key: "data/fields/result-field-1",
  status: "ready",
} as const;

function resultSelection() {
  return analysisResultSelectionRef({
    datasetId: "result:dataset-1",
    datasetRevision: "dataset-revision-1",
    fieldId: fieldRef.field_id,
    fieldRef,
    fieldRevision: fieldRef.field_revision,
    focus: "item",
    itemId: "mode-1",
    itemKind: "eigen_mode",
    runId: "run-1",
    sampleId: "sample-1",
    stageId: "stage-1",
  });
}

function resultOverlay(): AnalysisFieldOverlayState {
  const selection = resultSelection();
  const intent = createAnalysisResultFieldOverlayIntent(selection)!;
  return {
    analysisResultFieldIntent: intent,
    fieldId: intent.fieldId,
    label: "Mode 1",
    query: { component: "full", scope_kind: "full", view: "abs" },
    source: intent.source,
    visualizationPhaseRad: 0,
    provenance: {
      datasetId: intent.datasetId,
      datasetRevision: intent.datasetRevision,
      fieldRevision: intent.fieldRevision,
      representation: "complex-vector-xyz",
      runId: intent.analysisRunId,
      stageId: intent.analysisStageId,
    },
  };
}

function ProjectionOverlayBridge({
  kernel,
  onLayoutOverlay,
}: {
  kernel: KernelApi;
  onLayoutOverlay: (fieldId: string) => void;
}) {
  const observedSelection = useSelectionSelector((selection) => selection.ref);
  useAnalysisResultProjectionController(kernel);
  useLayoutEffect(() => {
    onLayoutOverlay(kernel.analysisFieldOverlay.getRenderableSnapshot()?.fieldId ?? "none");
  }, [kernel.analysisFieldOverlay, observedSelection, onLayoutOverlay]);
  return null;
}

function ProjectionModelBridge({
  kernel,
  onSurface,
}: {
  kernel: KernelApi;
  onSurface: (surface: AnalysisResultProjectionSurfaceProps) => void;
}) {
  const surface = useAnalysisResultProjectionController(kernel);
  useLayoutEffect(() => {
    if (surface) onSurface(surface);
  }, [onSurface, surface]);
  return null;
}

function setMockSelectedResultSelection(
  selection: ReturnType<typeof resultSelection> | null,
): void {
  mockSelectedResultSelection = selection;
  mockSelectionListeners.forEach((listener) => listener());
}

describe("analysis result projection overlay ownership", () => {
  it("keeps a typed result overlay owned by the selected dataset item", () => {
    expect(analysisResultSelectionOwnsOverlay(resultSelection(), resultOverlay())).toBe(true);
  });

  it("rejects the same item when its dataset revision changes", () => {
    const selection = resultSelection();
    expect(
      analysisResultSelectionOwnsOverlay(
        { ...selection, datasetRevision: "dataset-revision-2" },
        resultOverlay(),
      ),
    ).toBe(false);
  });

  it("clears a foreign overlay before the layout snapshot after selection changes", async () => {
    const controller = new AnalysisFieldOverlayController();
    const kernel = {
      analysisFieldOverlay: controller,
      selection: { set: vi.fn() },
    } as unknown as KernelApi;
    controller.setResultContext("run-1");
    controller.set(resultOverlay());
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const layoutOverlayIds: string[] = [];
    const onLayoutOverlay = (fieldId: string) => layoutOverlayIds.push(fieldId);

    try {
      setMockSelectedResultSelection(resultSelection());
      await act(async () => {
        root.render(
          createElement(ProjectionOverlayBridge, {
            kernel,
            onLayoutOverlay,
          }),
        );
      });
      expect(controller.getRenderableSnapshot()?.fieldId).toBe("analysis:eigen:sample-1:mode-1");

      layoutOverlayIds.length = 0;
      await act(async () => {
        setMockSelectedResultSelection({ ...resultSelection(), datasetRevision: "dataset-revision-2" });
      });

      expect(layoutOverlayIds).toEqual(["none"]);
      expect(controller.getRenderableSnapshot()).toBeNull();
    } finally {
      setMockSelectedResultSelection(null);
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe("analysis result projection identity gate", () => {
  it("accepts a projection matching the selected dataset manifest", () => {
    expect(
      analysisResultProjectionMatchesSelection(
        projectionIdentity,
        resultSelection(),
        manifestIdentity,
      ),
    ).toBe(true);
  });

  it("rejects a projection from an older dataset revision", () => {
    expect(
      analysisResultProjectionMatchesSelection(
        { ...projectionIdentity, dataset_revision: "dataset-revision-0" },
        resultSelection(),
        manifestIdentity,
      ),
    ).toBe(false);
  });

  it.each([
    ["run", { run_id: "run-foreign" }],
    ["dataset", { dataset_id: "result:dataset-foreign" }],
  ] as const)("rejects a projection with a foreign %s identity", (_label, patch) => {
    expect(
      analysisResultProjectionMatchesSelection(
        { ...projectionIdentity, ...patch },
        resultSelection(),
        manifestIdentity,
      ),
    ).toBe(false);
  });

  it("rejects a projection until the matching manifest is available", () => {
    expect(
      analysisResultProjectionMatchesSelection(
        projectionIdentity,
        resultSelection(),
        null,
      ),
    ).toBe(false);
  });
});

describe("analysis result projection point selection", () => {
  it("does not inherit the previous item kind when a new point has no typed kind", () => {
    const selection = resultSelection();
    const point: AnalysisResultProjectionSelection = {
      branchId: "branch-dsf",
      itemId: "dsf-point-1",
      itemKind: null,
      ordinal: 4,
      sampleId: "sample-dsf",
    };

    expect(
      analysisResultSelectionFromProjectionPoint(
        selection,
        {
          projection_id: "dsf-map",
          projection_revision: "projection-dsf-1",
        },
        point,
      ),
    ).toMatchObject({
      itemId: "dsf-point-1",
      itemKind: undefined,
      sampleId: "sample-dsf",
    });
  });

  it("preserves canonical coordinates when a projection point changes the selected item", () => {
    const coordinates = [{
      axisId: "bias-field",
      category: null,
      entityRef: null,
      label: "75 mT",
      scalarSI: 0.075,
      token: "bias:75mT",
      vector3SI: [59683.1, 0, 0] as const,
    }];
    const selection = { ...resultSelection(), coordinates };

    expect(
      analysisResultSelectionFromProjectionPoint(
        selection,
        {
          projection_id: "field-frequency-map",
          projection_revision: "projection-revision-1",
        },
        {
          branchId: "branch-2",
          itemId: "mode-2",
          itemKind: "eigen_mode",
          ordinal: 2,
          sampleId: "sample-2",
        },
      ).coordinates,
    ).toEqual(coordinates);
  });
});

describe("analysis result projection scope binding", () => {
  it("uses the selected sample by default and can select the global collection", async () => {
    const resource = {
      axis_labels: { x: "Wavevector", y: "Frequency" },
      axis_mapping: { x: "k_rad_per_m", y: "frequency_hz" },
      axis_units: { x: "rad/m", y: "Hz" },
      dataset_id: "result:dataset-1",
      dataset_revision: "dataset-revision-1",
      fixed_coordinates: [],
      projection_id: "field-frequency-map",
      projection_revision: "projection-revision-1",
      run_id: "run-1",
      schema_version: "fullmag.analysis.result_dataset_index.v1",
      selection_index: [
        { branch_id: "branch:0", item_id: "mode:k-negative:0", item_kind: "eigen_mode", ordinal: 0, sample_id: "sample:k-negative" },
        { branch_id: "branch:0", item_id: "mode:k-zero:0", item_kind: "eigen_mode", ordinal: 1, sample_id: "sample:k-zero" },
        { branch_id: "branch:0", item_id: "mode:k-positive:0", item_kind: "eigen_mode", ordinal: 2, sample_id: "sample:k-positive" },
        { branch_id: "branch:1", item_id: "mode:k-negative:1", item_kind: "eigen_mode", ordinal: 3, sample_id: "sample:k-negative" },
        { branch_id: "branch:1", item_id: "mode:k-zero:1", item_kind: "eigen_mode", ordinal: 4, sample_id: "sample:k-zero" },
        { branch_id: "branch:1", item_id: "mode:k-positive:1", item_kind: "eigen_mode", ordinal: 5, sample_id: "sample:k-positive" },
      ],
      series: [
        {
          label: "mode 0",
          points: [
            { branch_id: "branch:0", item_id: "mode:k-negative:0", ordinal: 0, sample_id: "sample:k-negative", status: "ready", value: 1e9, x: -1, y: 1e9 },
            { branch_id: "branch:0", item_id: "mode:k-zero:0", ordinal: 1, sample_id: "sample:k-zero", status: "ready", value: 2e9, x: 0, y: 2e9 },
            { branch_id: "branch:0", item_id: "mode:k-positive:0", ordinal: 2, sample_id: "sample:k-positive", status: "ready", value: 3e9, x: 1, y: 3e9 },
          ],
          series_id: "branch:0",
        },
        {
          label: "mode 1",
          points: [
            { branch_id: "branch:1", item_id: "mode:k-negative:1", ordinal: 3, sample_id: "sample:k-negative", status: "ready", value: 1.5e9, x: -1, y: 1.5e9 },
            { branch_id: "branch:1", item_id: "mode:k-zero:1", ordinal: 4, sample_id: "sample:k-zero", status: "ready", value: 2e9, x: 0, y: 2e9 },
            { branch_id: "branch:1", item_id: "mode:k-positive:1", ordinal: 5, sample_id: "sample:k-positive", status: "ready", value: 3.5e9, x: 1, y: 3.5e9 },
          ],
          series_id: "branch:1",
        },
      ],
      status: {
        completeness: "ready",
        detail: null,
        execution: "published",
        qualification: "unvalidated",
        reason_code: null,
        resource: "ready",
      },
      unsupported_reason: null,
    } as unknown as AnalysisResultProjectionResource;
    mockResultManifest = {
      ...manifestIdentity,
      item_count: 2,
      product_kind: "modal_eigen",
      projections: [{ kind: "line", projection_id: "field-frequency-map", selectable: true, title: "Mode frequencies" }],
      spectrum_output_scopes: ["per_sample", "global"],
    } as unknown as AnalysisResultDatasetManifestResource;
    mockResultProjection = resource;
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    const observedSurfaces: AnalysisResultProjectionSurfaceProps[] = [];
    const controller = new AnalysisFieldOverlayController();
    const kernel = {
      analysisFieldOverlay: controller,
      selection: { set: vi.fn() },
    } as unknown as KernelApi;
    const onSurface = (surface: AnalysisResultProjectionSurfaceProps) => observedSurfaces.push(surface);

    try {
      setMockSelectedResultSelection({ ...resultSelection(), sampleId: "sample:k-zero" });
      await act(async () => {
        root.render(createElement(ProjectionModelBridge, { kernel, onSurface }));
      });

      expect(observedSurfaces.at(-1)?.model.scopeView?.kind).toBe("per_sample");
      expect(observedSurfaces.at(-1)?.model.exportSeries?.flatMap((series) => series.points)).toEqual([
        expect.objectContaining({ itemId: "mode:k-zero:0", sampleId: "sample:k-zero" }),
        expect.objectContaining({ itemId: "mode:k-zero:1", sampleId: "sample:k-zero" }),
      ]);

      await act(async () => {
        observedSurfaces.at(-1)?.onSpectrumOutputScopeSelect?.("global");
      });
      expect(observedSurfaces.at(-1)?.model.scopeView?.kind).toBe("global");
      expect(
        observedSurfaces.at(-1)?.model.exportSeries?.reduce(
          (count, series) => count + series.points.length,
          0,
        ),
      ).toBe(6);
    } finally {
      setMockSelectedResultSelection(null);
      mockResultManifest = null;
      mockResultProjection = null;
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
