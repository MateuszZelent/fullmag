import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import {
  activeCrossSectionFrameRotationDegrees,
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  crossSectionVisualizationPatchFromDraft,
  crossSectionWorkspaceStore,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
} from "./crossSectionWorkspace";

const visualizationState = {
  clip: {
    axis: "z",
    enabled: true,
    flipped: false,
    position_percent: 62.5,
  },
  revision: 4,
  slice: {
    axis: "z",
    mesh_color_scale: "viridis",
    mesh_filter_expression: "quality < 0.3",
    mesh_quality_metric: "skewness",
    mesh_shrink_factor: 0.8,
    show_mesh: true,
  },
} as VisualizationStateResource;

describe("crossSectionWorkspace", () => {
  it("creates an editable draft from visualization state", () => {
    resetCrossSectionWorkspaceForTests();

    const draft = beginCrossSectionDraft(visualizationState);

    expect(draft).toMatchObject({
      frameExtent: "universe",
      id: "draft",
      metric: "skewness",
      name: "Draft Cross-Section",
      plane: "xy",
      positionPercent: 62.5,
    });
    expect(crossSectionWorkspaceStore.getSnapshot().draft).toEqual(draft);
  });

  it("commits the draft into a saved plot with stable saved parameters", () => {
    resetCrossSectionWorkspaceForTests();
    beginCrossSectionDraft(visualizationState);
    updateCrossSectionDraft({
      metric: "aspect_ratio",
      name: "Interface cut",
      positionPercent: 25,
      rotationDegrees: 37,
    });

    const plot = commitCrossSectionDraft();

    expect(plot).toMatchObject({
      frameExtent: "universe",
      id: "plot-1",
      name: "Interface cut",
      query: {
        includePolygons: true,
        includeWireframe: true,
        plane: "xy",
        positionPercent: 25,
      },
      qualityQuery: {
        metric: "aspect_ratio",
        plane: "xy",
        positionPercent: 25,
      },
      renderOptions: {
        colorScale: "viridis",
        frameRotationDegrees: 37,
        filterExpression: "quality < 0.3",
        shrinkFactor: 0.8,
        wireframeVisible: true,
      },
      rotationDegrees: 37,
    });
    expect(crossSectionWorkspaceStore.getSnapshot()).toMatchObject({
      activePlotId: "plot-1",
      draft: null,
      plots: [plot],
    });
  });

  it("resolves active frame rotation from an editable draft before saved plots", () => {
    resetCrossSectionWorkspaceForTests();
    beginCrossSectionDraft(visualizationState);
    updateCrossSectionDraft({ rotationDegrees: 22 });

    expect(
      activeCrossSectionFrameRotationDegrees(
        crossSectionWorkspaceStore.getSnapshot(),
      ),
    ).toBe(22);

    const plot = commitCrossSectionDraft();

    expect(plot?.rotationDegrees).toBe(22);
    expect(
      activeCrossSectionFrameRotationDegrees(
        crossSectionWorkspaceStore.getSnapshot(),
      ),
    ).toBe(22);
  });

  it("builds the visualization patch that drives the 3D clip frame from the draft", () => {
    resetCrossSectionWorkspaceForTests();
    const draft = beginCrossSectionDraft(visualizationState);
    const updated = updateCrossSectionDraft({
      colorScale: "hot",
      includeWireframe: false,
      metric: "max_angle",
      plane: "yz",
      positionPercent: 12.5,
      shrinkFactor: 0.65,
    });

    expect(updated).not.toBeNull();
    expect(crossSectionVisualizationPatchFromDraft(updated ?? draft)).toEqual({
      clip: {
        axis: "x",
        enabled: true,
        position_percent: 12.5,
      },
      slice: {
        axis: "x",
        mesh_color_scale: "hot",
        mesh_filter_expression: "quality < 0.3",
        mesh_quality_metric: "max_angle",
        mesh_shrink_factor: 0.65,
        position_percent: 12.5,
        show_mesh: false,
      },
    });
  });
});
