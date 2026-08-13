import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import {
  activeCrossSectionFrameRotationDegrees,
  activeCrossSectionFramePreview,
  beginPlanarMonitorDraft,
  beginCrossSectionDraft,
  beginCrossSectionDraftFromPlot,
  commitCrossSectionDraft,
  crossSectionFramePreviewToClip,
  crossSectionWorkspaceStore,
  discardPlanarMonitorDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  planarMonitorDraftFromMonitor,
  planarMonitorDuplicateRequest,
  planarMonitorIdentityForCreate,
  planarMonitorValidationErrors,
  convertLength,
  resetCrossSectionWorkspaceForTests,
  updatePlanarMonitorDraft,
  updateCrossSectionDraft,
  updateCrossSectionPlot,
} from "./crossSectionWorkspace";

type Monitor = Parameters<typeof planarMonitorDraftFromMonitor>[0];

const fullMonitor: Monitor = {
  id: "monitor-1",
  name: "Full monitor",
  target: { kind: "region", object_id: "film", region_id: "edge" },
  frame: {
    origin_m: [1e-9, 2e-9, 3e-9],
    u_axis: [1, 0, 0],
    v_axis: [0, 1, 0],
    normal: [0, 0, 1],
    preset: null,
    normalization_version: "planar_frame_v1",
    extent: {
      kind: "explicit",
      u_min_m: -4e-9,
      u_max_m: 4e-9,
      v_min_m: -5e-9,
      v_max_m: 5e-9,
    },
  },
  operator: {
    kind: "surface_projection",
    boundary: { kind: "named_surface", surface_id: "top" },
    visibility_policy: "nearest_to_origin",
  },
};

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
  it("owns planar monitor drafts separately from legacy cross-section image plots", () => {
    resetCrossSectionWorkspaceForTests();

    expect(crossSectionWorkspaceStore.getSnapshot()).toHaveProperty(
      "planarMonitorDraft",
      null,
    );
  });

  it("starts a geometry-only planar monitor draft without legacy PNG settings", () => {
    resetCrossSectionWorkspaceForTests();

    const draft = beginPlanarMonitorDraft(visualizationState);

    expect(draft.monitor).toMatchObject({
      id: "planar_monitor_1",
      name: "Midplane",
      target: { kind: "domain" },
      frame: {
        origin_m: [0, 0, 0],
        preset: "xy",
        normalization_version: "planar_frame_v1",
        extent: { kind: "universe", padding_m: 0 },
      },
      operator: { kind: "plane_sample" },
    });
    expect(draft.ui).toEqual({
      displayLengthUnit: "nm",
    });
    expect(draft).not.toHaveProperty("colorScale");
    expect(draft).not.toHaveProperty("metric");
    expect(draft).not.toHaveProperty("shrinkFactor");
    expect(crossSectionWorkspaceStore.getSnapshot().draft).toBeNull();
    expect(
      crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft,
    ).toEqual(draft);
  });

  it("updates and discards the planar monitor draft without touching legacy plots", () => {
    resetCrossSectionWorkspaceForTests();
    beginPlanarMonitorDraft(visualizationState);

    const updated = updatePlanarMonitorDraft({
      monitor: {
        ...fullMonitor,
        name: "Oblique view",
      },
      ui: {
        displayLengthUnit: "um",
      },
    });

    expect(updated?.monitor).toEqual({ ...fullMonitor, name: "Oblique view" });
    expect(updated?.ui).toEqual({
      displayLengthUnit: "um",
    });
    expect(crossSectionWorkspaceStore.getSnapshot().draft).toBeNull();
    expect(crossSectionWorkspaceStore.getSnapshot().plots).toEqual([]);

    discardPlanarMonitorDraft();

    expect(
      crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft,
    ).toBeNull();
  });

  it("uses the planar monitor draft as the lightweight 3D frame preview", () => {
    resetCrossSectionWorkspaceForTests();
    beginPlanarMonitorDraft(visualizationState);
    const current = crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft;
    if (!current) throw new Error("Expected monitor draft");
    updatePlanarMonitorDraft({
      monitor: {
        ...current.monitor,
        frame: {
          ...current.monitor.frame,
          normal: [1, 0, 0],
          preset: "yz",
          u_axis: [0, 1, 0],
          v_axis: [0, 0, 1],
        },
      },
      ui: {
        ...current.ui,
      },
    });

    expect(
      activeCrossSectionFramePreview(
        crossSectionWorkspaceStore.getSnapshot(),
      ),
    ).toEqual({
      normal: [1, 0, 0],
      originM: [0, 0, 0],
      uAxis: [0, 1, 0],
      vAxis: [0, 0, 1],
    });
  });

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

  it("lowers the compatibility axis draft into a revision-guarded planar monitor", () => {
    resetCrossSectionWorkspaceForTests();
    beginCrossSectionDraft(visualizationState);
    const updated = updateCrossSectionDraft({
      name: "Mid plane",
      plane: "xz",
      positionPercent: 25,
      rotationDegrees: 90,
    });
    if (!updated) throw new Error("Expected an editable planar monitor draft");

    const monitorDraft = planarMonitorDraftFromMonitor({
      ...fullMonitor,
      id: "mid_plane_8",
      name: "Mid plane",
      target: { kind: "domain" },
      frame: {
        ...fullMonitor.frame,
        normal: [0, -1, 0],
        origin_m: [0, -2, 0],
        preset: "xz",
        u_axis: [0, 0, 1],
        v_axis: [-1, 0, 0],
      },
      operator: { kind: "plane_sample" },
    });
    const request = planarMonitorCreateRequestFromDraft(monitorDraft, 7);

    expect(request.expected_scene_revision).toBe(7);
    expect(request.monitor).toMatchObject({
      id: "mid_plane_8",
      name: "Mid plane",
      operator: { kind: "plane_sample" },
      target: { kind: "domain" },
      frame: {
        normal: [0, -1, 0],
        origin_m: [0, -2, 0],
        preset: "xz",
      },
    });
    expect(request.monitor.frame.u_axis).toEqual([
      expect.closeTo(0, 12),
      0,
      expect.closeTo(1, 12),
    ]);
    expect(request.monitor.frame.v_axis).toEqual([
      expect.closeTo(-1, 12),
      0,
      expect.closeTo(0, 12),
    ]);
  });

  it.each([
    { kind: "domain" } as const,
    { kind: "magnetic_domain" } as const,
    { kind: "object", object_id: "film" } as const,
    { kind: "region", object_id: "film", region_id: "edge" } as const,
  ])("round-trips authored target $kind without a second form model", (target) => {
    const draft = planarMonitorDraftFromMonitor({ ...fullMonitor, target });
    expect(planarMonitorCreateRequestFromDraft(draft, 9).monitor.target).toEqual(target);
  });

  it("round-trips arbitrary frame, every extent and every operator discriminant", () => {
    const extents: Monitor["frame"]["extent"][] = [
      fullMonitor.frame.extent,
      { kind: "target_bounds", padding_m: 1e-9 },
      { kind: "magnetic_domain", padding_m: 2e-9 },
      { kind: "universe", padding_m: 3e-9 },
    ];
    const operators: Monitor["operator"][] = [
      { kind: "plane_sample" },
      { kind: "slab_average", thickness_m: 6e-9 },
      { kind: "depth_projection", reduction: "rms", empty_policy: "exclude_empty" },
      fullMonitor.operator,
    ];
    for (const extent of extents) {
      for (const operator of operators) {
        const monitor = {
          ...fullMonitor,
          frame: { ...fullMonitor.frame, extent },
          operator,
        };
        expect(
          planarMonitorCreateRequestFromDraft(planarMonitorDraftFromMonitor(monitor), 3).monitor,
        ).toEqual(monitor);
      }
    }
  });

  it("converts display lengths to canonical SI and back within tolerance", () => {
    for (const unit of ["m", "mm", "um", "nm"] as const) {
      const displayed = convertLength(7.25e-9, "m", unit);
      expect(convertLength(displayed, unit, "m")).toBeCloseTo(7.25e-9, 18);
    }
  });

  it("validates arbitrary basis, operator parameters and required selectors", () => {
    expect(planarMonitorValidationErrors(fullMonitor)).toEqual([]);
    expect(
      planarMonitorValidationErrors({
        ...fullMonitor,
        frame: { ...fullMonitor.frame, normal: [0, 0, 0] },
        operator: { kind: "slab_average", thickness_m: 0 },
        target: { kind: "object", object_id: "" },
      }),
    ).toEqual(expect.arrayContaining([
      "Object target requires an object ID.",
      "Frame normal must be a finite unit vector.",
      "Slab thickness must be finite and greater than zero.",
    ]));
  });

  it("builds an explicit typed duplicate request without mutating the source", () => {
    const source = structuredClone(fullMonitor);
    expect(planarMonitorDuplicateRequest(source, 12)).toEqual({
      expected_scene_revision: 12,
    });
    expect(fullMonitor).toEqual(source);
  });

  it("derives a unique create identity and delegates duplicate identity allocation to the backend", () => {
    expect(planarMonitorIdentityForCreate("Midplane", [
      { ...fullMonitor, id: "midplane", name: "Midplane" },
      { ...fullMonitor, id: "midplane_2", name: "Midplane 2" },
    ])).toEqual({ id: "midplane_3", name: "Midplane 3" });
    expect(planarMonitorDuplicateRequest(fullMonitor, 12)).toEqual({
      expected_scene_revision: 12,
    });
  });

  it("uses only canonical frame data for preset and arbitrary previews", () => {
    const draft = planarMonitorDraftFromMonitor(fullMonitor);
    expect(draft.ui).toEqual({ displayLengthUnit: "nm" });
    beginPlanarMonitorDraft();
    updatePlanarMonitorDraft(draft);
    expect(activeCrossSectionFramePreview(crossSectionWorkspaceStore.getSnapshot())).toEqual({
      normal: [0, 0, 1],
      originM: [1e-9, 2e-9, 3e-9],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
    });
  });

  it("converts compatibility clip position to canonical SI before creating the draft", () => {
    const draft = beginPlanarMonitorDraft(visualizationState, {
      min: [-4e-9, -6e-9, -8e-9],
      max: [4e-9, 6e-9, 8e-9],
    });
    expect(draft.monitor.frame.origin_m[2]).toBeCloseTo(2e-9, 20);
  });

  it("mirrors canonical IR basis tolerance and depth empty-policy restriction", () => {
    expect(planarMonitorValidationErrors({
      ...fullMonitor,
      frame: { ...fullMonitor.frame, u_axis: [1 + 2e-12, 0, 0] },
      operator: {
        kind: "depth_projection",
        reduction: "rms",
        empty_policy: "include_air_as_zero",
      },
    })).toEqual(expect.arrayContaining([
      "Frame u axis must be a finite unit vector.",
      "include_air_as_zero is valid only for mean_occupied.",
    ]));
  });

  it("recognizes a revision conflict without treating other failures as conflicts", () => {
    expect(isPlanarMonitorRevisionConflict({ status: 409, code: "scene_revision_conflict" })).toBe(true);
    expect(isPlanarMonitorRevisionConflict({ status: 409, code: "duplicate_planar_monitor_id" })).toBe(false);
    expect(isPlanarMonitorRevisionConflict({ status: 422 })).toBe(false);
    expect(isPlanarMonitorRevisionConflict(new Error("network"))).toBe(false);
  });
});
