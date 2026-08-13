import { describe, expect, it, vi } from "vitest";

import type { PlanarMonitorDraft } from "./crossSectionWorkspace";
import { planarMonitorFramePreviewFromDraft } from "./planarMonitorFramePreview";
import {
  planarMonitorFramePreviewCanSelect,
  planarMonitorFramePreviewStore,
  resolvePlanarMonitorPreviewSupport,
} from "./planarMonitorFramePreview";

describe("planar monitor 3D frame preview store", () => {
  it("publishes and clears only the lightweight resolved frame", () => {
    const listener = vi.fn();
    const unsubscribe = planarMonitorFramePreviewStore.subscribe(listener);
    const frame = {
      boundsUvM: [-1, 1, -2, 2] as const,
      monitorId: "plane-1",
      normal: [0, 0, 1] as const,
      operator: null,
      originM: [0, 0, 0] as const,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };

    planarMonitorFramePreviewStore.set(frame);
    expect(planarMonitorFramePreviewStore.getSnapshot()).toBe(frame);
    planarMonitorFramePreviewStore.clear();
    expect(planarMonitorFramePreviewStore.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("keeps an Inspector draft in the existing preview owner and clears it independently of a resolved frame", () => {
    const resolved = {
      boundsUvM: [-1, 1, -1, 1] as const,
      monitorId: "resolved",
      normal: [0, 0, 1] as const,
      operator: null,
      originM: [0, 0, 0] as const,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    const draft: PlanarMonitorDraft = {
      monitor: {
        frame: {
          extent: { kind: "target_bounds", padding_m: 0 },
          normal: [0, 0, 1],
          normalization_version: "planar_frame_v1",
          origin_m: [0, 0, 0],
          preset: "xy",
          u_axis: [1, 0, 0],
          v_axis: [0, 1, 0],
        },
        id: "draft",
        name: "Draft",
        operator: { kind: "plane_sample" },
        target: { kind: "magnetic_domain" },
      },
      ui: { displayLengthUnit: "nm" as const },
    };
    planarMonitorFramePreviewStore.set(resolved);
    planarMonitorFramePreviewStore.setDraft(draft);
    expect(planarMonitorFramePreviewStore.getSnapshot()).toBe(resolved);
    expect(planarMonitorFramePreviewStore.getDraftSnapshot()).toBe(draft);
    planarMonitorFramePreviewStore.clearDraft();
    expect(planarMonitorFramePreviewStore.getSnapshot()).toBe(resolved);
    expect(planarMonitorFramePreviewStore.getDraftSnapshot()).toBeNull();
    planarMonitorFramePreviewStore.clear();
  });
});

describe("planar monitor preview support", () => {
  it("keeps creation and committed-editor preview selection identities distinct", () => {
    const draft: PlanarMonitorDraft = {
      monitor: { id: "plane-1", name: "Plane", target: { kind: "magnetic_domain" }, operator: { kind: "plane_sample" }, frame: { origin_m: [0, 0, 0], u_axis: [1, 0, 0], v_axis: [0, 1, 0], normal: [0, 0, 1], preset: "xy", normalization_version: "planar_frame_v1", extent: { kind: "target_bounds", padding_m: 0 } } },
      ui: { displayLengthUnit: "nm" },
    };
    const bounds = { center: [0, 0, 0] as const, size: [2, 2, 2] as const };
    expect(planarMonitorFramePreviewFromDraft(draft, bounds, "draft")?.isDraft).toBe(true);
    expect(planarMonitorFramePreviewFromDraft(draft, bounds, "committed")?.isDraft).toBe(false);
  });
  it("fails closed with a diagnostic for depth and surface operators that have no published finite 3D support", () => {
    expect(resolvePlanarMonitorPreviewSupport({
      kind: "depth_projection",
      reduction: "mean_occupied",
      empty_policy: "exclude_empty",
    })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("no finite 3D support") });
    expect(resolvePlanarMonitorPreviewSupport({
      kind: "surface_projection",
      boundary: { kind: "object_boundary" },
      visibility_policy: "nearest_to_origin",
    })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("backend-resolved") });
  });

  it("allows a frame hit only while the exact preview is visible and selectable", () => {
    const preview = {
      boundsUvM: [-1, 1, -1, 1] as const,
      monitorId: "plane-1",
      normal: [0, 0, 1] as const,
      operator: { kind: "plane_sample" as const },
      originM: [0, 0, 0] as const,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    expect(planarMonitorFramePreviewCanSelect(preview)).toBe(true);
    expect(planarMonitorFramePreviewCanSelect({ ...preview, visible: false })).toBe(false);
    expect(planarMonitorFramePreviewCanSelect({ ...preview, selectable: false })).toBe(false);
  });
});
