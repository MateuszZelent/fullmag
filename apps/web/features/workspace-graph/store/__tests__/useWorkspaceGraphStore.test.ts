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
    expect(snapshot.viewportDocuments["viewport:study:core:3d"]?.camera).toBeNull();
    expect(snapshot.scalarRows).toEqual([]);
  });

  it("keeps live scalar row payloads out of workspace graph snapshots", () => {
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
        { time: 2e-12, e_total: 1.2e-18 },
      ],
      requestedPreviewQuantity: "m",
      requestedPreviewComponent: "3D",
      plane: "xy",
      sliceIndex: 0,
      viewMode: "3D",
      renderMode: "surface",
    });

    expect(snapshot.scalarRows).toEqual([]);
    expect(snapshot.datasets[0]?.sampleCount).toBe(2);
    expect(snapshot.solutions[0]?.revision).toBe(2);
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
      camera: null,
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

  it("does not publish a new snapshot for identical viewport document upserts", () => {
    const document = {
      id: "viewport:study:core:2d",
      workspaceMode: "study" as const,
      tabId: "core:2d",
      viewMode: "2D" as const,
      quantityId: "m",
      component: "x",
      plane: "xz" as const,
      sliceIndex: 4,
      selectedDatasetId: "ds-1",
      selectedResultNodeId: "dv-1",
      renderMode: "surface",
      camera: {
        position: [1, 2, 3] as [number, number, number],
        target: [0, 0, 0] as [number, number, number],
        up: [0, 1, 0] as [number, number, number],
        projection: "perspective" as const,
        navigation: "trackball" as const,
        lastFocusedObjectId: null,
      },
      overlayToggles: {
        telemetryHudVisible: true,
        previewNoticesVisible: false,
      },
    };

    useWorkspaceGraphStore.getState().upsertViewportDocument(document);
    const firstSnapshot = useWorkspaceGraphStore.getState().snapshot;
    useWorkspaceGraphStore.getState().upsertViewportDocument({ ...document });

    expect(useWorkspaceGraphStore.getState().snapshot).toBe(firstSnapshot);
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
            camera: {
              position: [3, 2, 1],
              target: [0, 0, 0],
              up: [0, 1, 0],
              projection: "perspective",
              navigation: "trackball",
              lastFocusedObjectId: "free",
            },
          },
        },
      },
    );

    expect(rebuilt.viewportDocuments["viewport:study:core:3d"]?.selectedDatasetId).toBe("ds-1");
    expect(rebuilt.viewportDocuments["viewport:study:core:3d"]?.camera?.position).toEqual([
      3,
      2,
      1,
    ]);
    expect(rebuilt.selection.activeResultNodeId).toBe("ds-1");
  });

  it("preserves active viewport document id and camera when active tab temporarily resolves to null", () => {
    const firstSnapshot = createWorkspaceGraphSnapshot({
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
      viewMode: "3D",
      renderMode: "surface",
    });

    const previousSnapshot = {
      ...firstSnapshot,
      viewportDocuments: {
        ...firstSnapshot.viewportDocuments,
        "viewport:study:core:3d": {
          ...firstSnapshot.viewportDocuments["viewport:study:core:3d"]!,
          camera: {
            position: [4, 3, 2] as [number, number, number],
            target: [0, 0, 0] as [number, number, number],
            up: [0, 1, 0] as [number, number, number],
            projection: "perspective" as const,
            navigation: "trackball" as const,
            lastFocusedObjectId: "obj-1",
          },
        },
      },
      selection: {
        ...firstSnapshot.selection,
        activeViewportDocumentId: "viewport:study:core:3d",
      },
    };

    const rebuilt = createWorkspaceGraphSnapshot(
      {
        projectLabel: "Micromagnetic Workspace",
        workspaceMode: "study",
        workspaceTabs: { build: [], study: [], analyze: [] },
        activeWorkspaceTabByStage: { build: null, study: null, analyze: null },
        selectedNodeId: "study.root",
        studyPipeline,
        resultsWorkspace,
        quantities,
        scalarRows: [{ time: 1e-12 }],
        requestedPreviewQuantity: "m",
        requestedPreviewComponent: "x",
        plane: "xy",
        sliceIndex: 1,
        viewMode: "3D",
        renderMode: "surface",
      },
      previousSnapshot,
    );

    expect(rebuilt.selection.activeViewportDocumentId).toBe("viewport:study:core:3d");
    expect(rebuilt.viewportDocuments["viewport:study:core:3d"]?.camera?.position).toEqual([
      4,
      3,
      2,
    ]);
  });

  it("maps active datasets from typed result nodes", () => {
    expect(resultNodeToTreeNodeId("plot_group", "pg-1")).toBe("res-plot-group-pg-1");
    expect(activeDatasetIdForResultNode(resultsWorkspace, "dv-1")).toBe("ds-1");
    expect(activeDatasetIdForResultNode(resultsWorkspace, null)).toBe("ds-1");
  });

  it("treats applySnapshot as idempotent for identical signature", () => {
    const firstSnapshot = createWorkspaceGraphSnapshot({
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
      viewMode: "3D",
      renderMode: "surface",
    });
    useWorkspaceGraphStore.getState().applySnapshot(firstSnapshot, "sig:a");

    const snapshotRefAfterFirstSet = useWorkspaceGraphStore.getState().snapshot;
    const secondSnapshot = createWorkspaceGraphSnapshot({
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
      viewMode: "3D",
      renderMode: "surface",
    });
    useWorkspaceGraphStore.getState().applySnapshot(secondSnapshot, "sig:a");

    expect(useWorkspaceGraphStore.getState().snapshot).toBe(snapshotRefAfterFirstSet);

    useWorkspaceGraphStore.getState().applySnapshot(secondSnapshot, "sig:b");
    // P-26: structural sharing means the stored snapshot is a merged object,
    // not the exact secondSnapshot reference, but values must match.
    expect(useWorkspaceGraphStore.getState().snapshot).toEqual(secondSnapshot);
    expect(useWorkspaceGraphStore.getState().snapshot).not.toBe(snapshotRefAfterFirstSet);
  });

  it("preserves stable viewport and computed array references without JSON serialization", () => {
    const firstSnapshot = createWorkspaceGraphSnapshot({
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
      viewMode: "3D",
      renderMode: "surface",
    });
    useWorkspaceGraphStore.getState().applySnapshot(firstSnapshot, "sig:refs-a");
    const storedFirst = useWorkspaceGraphStore.getState().snapshot;
    const firstViewportDoc = storedFirst.viewportDocuments["viewport:study:core:3d"];
    const firstStudyNodes = storedFirst.studyNodes;
    const firstSolutions = storedFirst.solutions;
    const firstDatasets = storedFirst.datasets;
    const firstDerivedValues = storedFirst.derivedValues;
    const firstQuantityFrames = storedFirst.quantityFrames;

    const secondSnapshot = createWorkspaceGraphSnapshot({
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
      viewMode: "3D",
      renderMode: "surface",
    });
    useWorkspaceGraphStore.getState().applySnapshot(secondSnapshot, "sig:refs-b");
    const storedSecond = useWorkspaceGraphStore.getState().snapshot;

    expect(storedSecond.viewportDocuments["viewport:study:core:3d"]).toBe(firstViewportDoc);
    expect(storedSecond.studyNodes).toBe(firstStudyNodes);
    expect(storedSecond.solutions).toBe(firstSolutions);
    expect(storedSecond.datasets).toBe(firstDatasets);
    expect(storedSecond.derivedValues).toBe(firstDerivedValues);
    expect(storedSecond.quantityFrames).toBe(firstQuantityFrames);
    expect(storedSecond).toEqual(secondSnapshot);
  });
});
