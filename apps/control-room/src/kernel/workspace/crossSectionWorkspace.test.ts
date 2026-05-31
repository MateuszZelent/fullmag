import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import {
  activeCrossSectionFrameRotationDegrees,
  activeCrossSectionFramePreview,
  beginCrossSectionDraft,
  beginCrossSectionDraftFromPlot,
  commitCrossSectionDraft,
  crossSectionFramePreviewToClip,
  crossSectionWorkspaceStore,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
  updateCrossSectionPlot,
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
      name: "Plot 1",
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

  it("keeps an empty draft name editable and falls back when committing", () => {
    resetCrossSectionWorkspaceForTests();
    beginCrossSectionDraft(visualizationState);

    const draft = updateCrossSectionDraft({ name: "" });
    const plot = commitCrossSectionDraft();

    expect(draft?.name).toBe("");
    expect(plot?.name).toBe("Plot 1");
  });

  it("commits repeated drafts as separate saved plots and keeps stable active references", () => {
    resetCrossSectionWorkspaceForTests();

    beginCrossSectionDraft(visualizationState);
    updateCrossSectionDraft({ name: "First cut", positionPercent: 20 });
    const first = commitCrossSectionDraft();
    beginCrossSectionDraft(visualizationState);
    updateCrossSectionDraft({ name: "Second cut", positionPercent: 80 });
    const second = commitCrossSectionDraft();

    expect(first?.id).toBe("plot-1");
    expect(second?.id).toBe("plot-2");
    expect(crossSectionWorkspaceStore.getSnapshot()).toMatchObject({
      activePlotId: "plot-2",
      draft: null,
      plots: [
        { id: "plot-1", name: "First cut", positionPercent: 20 },
        { id: "plot-2", name: "Second cut", positionPercent: 80 },
      ],
    });
  });

  it("starts the next draft from a saved plot without replacing that plot", () => {
    resetCrossSectionWorkspaceForTests();
    beginCrossSectionDraft(visualizationState);
    updateCrossSectionDraft({
      colorScale: "hot",
      metric: "gamma",
      name: "Reusable cut",
      plane: "yz",
      positionPercent: 33,
      rotationDegrees: 45,
    });
    const plot = commitCrossSectionDraft();
    if (!plot) throw new Error("Expected committed cross-section plot");

    const draft = beginCrossSectionDraftFromPlot(plot.id);

    expect(draft).toMatchObject({
      colorScale: "hot",
      metric: "gamma",
      name: "Plot 2",
      plane: "yz",
      positionPercent: 33,
      rotationDegrees: 45,
    });
    expect(crossSectionWorkspaceStore.getSnapshot().plots).toHaveLength(1);
  });

  it("edits saved plot settings without changing its object identity", () => {
    resetCrossSectionWorkspaceForTests();
    beginCrossSectionDraft(visualizationState);
    const plot = commitCrossSectionDraft();
    if (!plot) throw new Error("Expected committed cross-section plot");

    const updated = updateCrossSectionPlot(plot.id, {
      includeWireframe: false,
      metric: "min_edge",
      name: "Moved cut",
      plane: "xz",
      positionPercent: 12.5,
      rotationDegrees: -30,
      shrinkFactor: 0.7,
    });

    expect(updated).toMatchObject({
      id: "plot-1",
      metric: "min_edge",
      name: "Moved cut",
      plane: "xz",
      positionPercent: 12.5,
      query: {
        includeWireframe: false,
        plane: "xz",
        positionPercent: 12.5,
      },
      renderOptions: {
        shrinkFactor: 0.7,
        wireframeVisible: false,
      },
      rotationDegrees: -30,
    });
    expect(crossSectionWorkspaceStore.getSnapshot().activePlotId).toBe("plot-1");
    expect(crossSectionWorkspaceStore.getSnapshot().plots).toHaveLength(1);
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

  it("builds a local 3D frame preview from the draft without producing a visualization patch", () => {
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
    const preview = activeCrossSectionFramePreview(
      crossSectionWorkspaceStore.getSnapshot(),
    );
    expect(preview).toEqual({
      axis: "x",
      positionPercent: 12.5,
      rotationDegrees: draft.rotationDegrees,
    });
    expect(crossSectionFramePreviewToClip(preview)).toEqual({
      axis: "x",
      enabled: true,
      flipped: false,
      position_percent: 12.5,
    });
  });
});
