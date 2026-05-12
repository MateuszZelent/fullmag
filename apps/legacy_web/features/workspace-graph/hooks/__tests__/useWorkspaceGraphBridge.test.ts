import { describe, expect, it } from "vitest";

import { buildWorkspaceGraphBridgeSignature } from "../useWorkspaceGraphBridge";
import type { WorkspaceGraphBridgeInput } from "../../model/types";

const baseInput: WorkspaceGraphBridgeInput = {
  enabled: true,
  projectLabel: "Micromagnetic Workspace",
  workspaceMode: "study",
  workspaceTabs: {
    build: [],
    study: [],
  },
  activeWorkspaceTabByStage: {
    build: null,
    study: "core:3d",
  },
  selectedNodeId: "study.root",
  studyPipeline: null,
  resultsWorkspace: {
    solutions: [
      {
        id: "solution:live",
        label: "Live Solution",
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
        id: "dataset:live",
        label: "Live Dataset",
        nodeKind: "dataset",
        pinned: false,
        createdAt: 2,
        sourceStudyId: "stage-relax",
        sourceSolutionId: "solution:live",
        lineage: {
          sourceStudyId: "stage-relax",
          sourceSolutionId: "solution:live",
        },
        sampleCount: 10,
        hasFinalState: false,
        hasEigen: false,
        eigenModeCount: 0,
        hasDispersion: false,
      },
    ],
    derivedValues: [
      {
        id: "derived:e_total",
        label: "Total Energy",
        nodeKind: "derived_value",
        pinned: false,
        createdAt: 3,
        quantityId: "e_total",
        sourceDatasetId: "dataset:live",
        sourceSolutionId: "solution:live",
        latestValue: 1,
        unit: "J",
      },
    ],
    plotGroups: [],
    tables: [],
    analyses: [],
    exports: [],
    reports: [],
    activeResultNodeId: "derived:e_total",
  },
  quantities: [
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
  ],
  scalarRows: [
    { time: 1e-12, e_total: 1 },
  ],
  requestedPreviewQuantity: "m",
  requestedPreviewComponent: "3D",
  plane: "xy",
  sliceIndex: 0,
  viewMode: "3D",
  renderMode: "surface",
};

describe("buildWorkspaceGraphBridgeSignature", () => {
  it("does not treat live scalar samples as workspace graph structure changes", () => {
    const nextInput: WorkspaceGraphBridgeInput = {
      ...baseInput,
      scalarRows: [
        ...baseInput.scalarRows,
        { time: 2e-12, e_total: 2 },
      ],
      resultsWorkspace: {
        ...baseInput.resultsWorkspace,
        datasets: baseInput.resultsWorkspace.datasets.map((dataset) => ({
          ...dataset,
          sampleCount: dataset.sampleCount + 1,
        })),
        derivedValues: baseInput.resultsWorkspace.derivedValues.map((value) => ({
          ...value,
          latestValue: 2,
        })),
      },
    };

    expect(buildWorkspaceGraphBridgeSignature(nextInput)).toBe(
      buildWorkspaceGraphBridgeSignature(baseInput),
    );
  });

  it("keeps semantic result resource changes in the workspace graph signature", () => {
    const staleInput: WorkspaceGraphBridgeInput = {
      ...baseInput,
      resultsWorkspace: {
        ...baseInput.resultsWorkspace,
        solutions: baseInput.resultsWorkspace.solutions.map((solution) => ({
          ...solution,
          status: "stale",
        })),
      },
    };

    expect(buildWorkspaceGraphBridgeSignature(staleInput)).not.toBe(
      buildWorkspaceGraphBridgeSignature(baseInput),
    );
  });
});
