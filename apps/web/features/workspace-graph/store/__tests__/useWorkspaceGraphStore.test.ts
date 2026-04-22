import { beforeEach, describe, expect, it } from "vitest";

import { createWorkspaceGraphSnapshot } from "../../model/createWorkspaceGraphSnapshot";
import { useWorkspaceGraphStore } from "../useWorkspaceGraphStore";
import type { ResultsWorkspaceState } from "@/features/analyze/model/resultsWorkspace";
import { activeDatasetIdForResultNode, resultNodeToTreeNodeId } from "@/features/analyze/model/resultTreeNodeId";
import type { StudyPipelineDocument } from "@/lib/study-builder/types";
import type { QuantityDescriptor } from "@/lib/session/types";

const studyPipeline: StudyPipelineDocument = {
  version: "study_pipeline.v1",
  nodes: [
    {
      id: "stage-relax",
      label: "Relax",
      enabled: true,
      node_kind: "primitive",
      stage_kind: "relax",
      payload: {},
      source: "ui_authored",
    },
  ],
};

const resultsWorkspace: ResultsWorkspaceState = {
  solutions: [
    {
      id: "sol-1",
      label: "Time Domain Solution",
      nodeKind: "solution",
      pinned: false,
      createdAt: 1,
      lineage: {
        sourceStudyId: "stage-relax",
        sourceSolutionId: null,
      },
      solutionKind: "time_dependent",
      revision: 7,
      status: "available",
    },
  ],
  datasets: [
    {
      id: "ds-1",
      label: "Dataset 1",
      nodeKind: "dataset",
      pinned: false,
      createdAt: 2,
      sourceStudyId: "stage-relax",
      sourceSolutionId: "sol-1",
      lineage: {
        sourceStudyId: "stage-relax",
        sourceSolutionId: "sol-1",
      },
      sampleCount: 12,
      hasFinalState: true,
      hasEigen: false,
      eigenModeCount: 0,
      hasDispersion: false,
    },
  ],
  derivedValues: [
    {
      id: "dv-1",
      label: "Total Energy",
      nodeKind: "derived_value",
      pinned: false,
      createdAt: 3,
      quantityId: "e_total",
      sourceDatasetId: "ds-1",
      sourceSolutionId: "sol-1",
      latestValue: 1.25e-18,
      unit: "J",
    },
  ],
  plotGroups: [],
  tables: [],
  analyses: [],
  exports: [],
  reports: [],
  activeResultNodeId: "dv-1",
};

const quantities: QuantityDescriptor[] = [
  {
    id: "m",
    label: "Magnetization",
    unit: "dimensionless",
    kind: "vector_field",
    location: "cell_center",
    domain: "magnetic",
    n_comp: 3,
    interactive_preview: true,
    available: true,
    quick_access_label: "m",
  },
  {
    id: "e_total",
    label: "Total energy",
    unit: "J",
    kind: "global_scalar",
    location: "global",
    domain: "global",
    n_comp: 1,
    interactive_preview: false,
    available: true,
    quick_access_label: "Etot",
  },
] as QuantityDescriptor[];

describe("workspace graph store", () => {
  beforeEach(() => {
    useWorkspaceGraphStore.getState().reset();
  });

  it("creates a graph snapshot with lineage-aware datasets, solutions, and derived values", () => {
    const snapshot = createWorkspaceGraphSnapshot({
      projectLabel: "Micromagnetic Workspace",
      workspaceMode: "study",
      workspaceTabs: {
        build: [],
        study: [],
        analyze: [],
      },
      activeWorkspaceTabByStage: {
        build: null,
        study: "core:3d",
        analyze: null,
      },
      selectedNodeId: "study.root",
      studyPipeline,
      resultsWorkspace,
      quantities,
      scalarRows: [
        { time: 1e-12, e_total: 1.25e-18 },
      ],
      requestedPreviewQuantity: "m",
      requestedPreviewComponent: "3D",
      plane: "xy",
      sliceIndex: 0,
      viewMode: "3D",
      renderMode: "surface",
    });

    expect(snapshot.project.label).toBe("Micromagnetic Workspace");
    expect(snapshot.studyNodes).toHaveLength(1);
    expect(snapshot.solutions[0]?.id).toBe("solution:live");
    expect(snapshot.datasets[0]?.sourceSolutionId).toBe("sol-1");
    expect(snapshot.derivedValues[0]?.quantityId).toBe("e_total");
    expect(snapshot.selection.activeViewportDocumentId).toBe("viewport:study:core:3d");
  });

  it("applies patches and viewport document upserts deterministically", () => {
    useWorkspaceGraphStore.getState().applySnapshot(
      createWorkspaceGraphSnapshot({
        projectLabel: "Micromagnetic Workspace",
        workspaceMode: "study",
        workspaceTabs: { build: [], study: [], analyze: [] },
        activeWorkspaceTabByStage: { build: null, study: "core:3d", analyze: null },
        selectedNodeId: "study.root",
        studyPipeline,
        resultsWorkspace,
        quantities,
        scalarRows: [],
        requestedPreviewQuantity: "m",
        requestedPreviewComponent: "x",
        plane: "xy",
        sliceIndex: 1,
        viewMode: "2D",
        renderMode: "wireframe",
      }),
    );

    useWorkspaceGraphStore.getState().applyPatch({
      selection: {
        activeNodeId: "res-dataset-ds-1",
      },
    });
    useWorkspaceGraphStore.getState().upsertViewportDocument({
      id: "viewport:study:core:2d",
      workspaceMode: "study",
      tabId: "core:2d",
      viewMode: "2D",
      quantityId: "m",
      component: "x",
      plane: "xz",
      sliceIndex: 4,
      selectedDatasetId: "ds-1",
      selectedResultNodeId: "dv-1",
      renderMode: "surface",
      overlayToggles: {
        telemetryHudVisible: true,
        previewNoticesVisible: false,
      },
    });

    const snapshot = useWorkspaceGraphStore.getState().snapshot;
    expect(snapshot.selection.activeNodeId).toBe("res-dataset-ds-1");
    expect(snapshot.viewportDocuments["viewport:study:core:2d"]?.plane).toBe("xz");
    expect(snapshot.viewportDocuments["viewport:study:core:2d"]?.selectedDatasetId).toBe("ds-1");
  });

  it("preserves active viewport dataset selection when rebuilding the snapshot", () => {
    const firstSnapshot = createWorkspaceGraphSnapshot({
      projectLabel: "Micromagnetic Workspace",
      workspaceMode: "study",
      workspaceTabs: { build: [], study: [], analyze: [] },
      activeWorkspaceTabByStage: { build: null, study: "core:3d", analyze: null },
      selectedNodeId: "results",
      studyPipeline,
      resultsWorkspace,
      quantities,
      scalarRows: [],
      requestedPreviewQuantity: "m",
      requestedPreviewComponent: "x",
      plane: "xy",
      sliceIndex: 1,
      viewMode: "3D",
      renderMode: "surface",
    });

    const rebuilt = createWorkspaceGraphSnapshot(
      {
        projectLabel: "Micromagnetic Workspace",
        workspaceMode: "study",
        workspaceTabs: { build: [], study: [], analyze: [] },
        activeWorkspaceTabByStage: { build: null, study: "core:3d", analyze: null },
        selectedNodeId: resultNodeToTreeNodeId("dataset", "ds-1"),
        studyPipeline,
        resultsWorkspace: {
          ...resultsWorkspace,
          activeResultNodeId: "ds-1",
        },
        quantities,
        scalarRows: [],
        requestedPreviewQuantity: "m",
        requestedPreviewComponent: "x",
        plane: "xz",
        sliceIndex: 4,
        viewMode: "2D",
        renderMode: "wireframe",
      },
      {
        ...firstSnapshot,
        viewportDocuments: {
          ...firstSnapshot.viewportDocuments,
          "viewport:study:core:3d": {
            ...firstSnapshot.viewportDocuments["viewport:study:core:3d"]!,
            selectedDatasetId: "ds-1",
            selectedResultNodeId: "ds-1",
          },
        },
      },
    );

    expect(rebuilt.viewportDocuments["viewport:study:core:3d"]?.selectedDatasetId).toBe("ds-1");
    expect(rebuilt.selection.activeResultNodeId).toBe("ds-1");
  });

  it("maps active datasets from typed result nodes", () => {
    expect(resultNodeToTreeNodeId("plot_group", "pg-1")).toBe("res-plot-group-pg-1");
    expect(activeDatasetIdForResultNode(resultsWorkspace, "dv-1")).toBe("ds-1");
    expect(activeDatasetIdForResultNode(resultsWorkspace, null)).toBe("ds-1");
  });
});
