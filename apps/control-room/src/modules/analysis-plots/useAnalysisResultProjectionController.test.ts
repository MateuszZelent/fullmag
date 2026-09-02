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
import type { AnalysisResultProjectionSelection } from "./components/AnalysisResultProjectionSurface";

let mockSelectedResultSelection: ReturnType<typeof resultSelection> | null = null;
const mockSelectionListeners = new Set<() => void>();

vi.mock("@/kernel/resources/analysisResultResources", () => ({
  useAnalysisResultDatasetManifestResource: () => ({ data: null }),
  useAnalysisResultProjectionResource: () => ({ data: null, status: "idle" }),
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
});
