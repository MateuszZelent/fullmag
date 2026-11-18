import { describe, expect, it } from "vitest";

import {
  CROP_OUTSIDE_REASON,
  CROP_TOO_SMALL_REASON,
  planarToolKeyAction,
  resolvePlanarCropCommit,
  resolvePlanarToolDrag,
} from "./planarToolGestures";

// 1 metre per CSS pixel keeps the arithmetic readable.
const viewport = [0, 400, 0, 200] as const;
const canvas = { width: 400, height: 200 };
const drag = (tool: "zoom-box" | "crop" | "measure" | "profile", dx: number, dy: number) =>
  resolvePlanarToolDrag({
    canvas,
    end: { u_m: 100 + dx, v_m: 100 - dy },
    endClient: [100 + dx, 100 + dy],
    frameBounds: viewport,
    start: { u_m: 100, v_m: 100 },
    startClient: [100, 100],
    tool,
    viewport,
  });

describe("planar tool gestures", () => {
  it("sends no zoom-box interaction below 4 px and one interaction above it", () => {
    expect(drag("zoom-box", 3, 50)).toEqual({ kind: "none" });
    expect(drag("zoom-box", 50, 3)).toEqual({ kind: "none" });
    const result = drag("zoom-box", 100, 50);
    expect(result).toMatchObject({ kind: "interaction" });
    if (result.kind !== "interaction") return;
    expect(result.interaction.zoom).toBeCloseTo(4, 12);
    expect(result.interaction.panU).toBeCloseTo(-50, 9);
  });

  it("keeps a crop draft only from 4 px up", () => {
    expect(drag("crop", 3, 30)).toEqual({ kind: "crop-draft", rect: null });
    expect(drag("crop", 30, 30)).toEqual({
      kind: "crop-draft",
      rect: { u_min_m: 100, u_max_m: 130, v_min_m: 70, v_max_m: 100 },
    });
  });

  it("records a ruler and a profile only for a real drag", () => {
    expect(drag("measure", 1, 1)).toEqual({ kind: "measure", segment: null });
    expect(drag("measure", 30, 40)).toMatchObject({ kind: "measure", segment: { u0_m: 100, u1_m: 130 } });
    expect(drag("profile", 1, 0)).toEqual({ kind: "none" });
    expect(drag("profile", 10, 0)).toMatchObject({ kind: "profile" });
  });

  it("clips a crop to the full frame and refuses a crop below 4 px with a reason", () => {
    const fullBounds = [0, 300, 0, 150] as const;
    expect(resolvePlanarCropCommit({
      canvas, draft: { u_min_m: 250, u_max_m: 350, v_min_m: 100, v_max_m: 190 }, fullBounds, viewport,
    })).toEqual({ disabledReason: null, rect: { u_min_m: 250, u_max_m: 300, v_min_m: 100, v_max_m: 150 } });
    expect(resolvePlanarCropCommit({
      canvas, draft: { u_min_m: 10, u_max_m: 12, v_min_m: 10, v_max_m: 50 }, fullBounds, viewport,
    })).toEqual({ disabledReason: CROP_TOO_SMALL_REASON, rect: null });
    expect(resolvePlanarCropCommit({
      canvas, draft: { u_min_m: 310, u_max_m: 390, v_min_m: 10, v_max_m: 50 }, fullBounds, viewport,
    })).toEqual({ disabledReason: CROP_OUTSIDE_REASON, rect: null });
  });

  it("maps Enter and Escape to the innermost tool state", () => {
    const rect = { u_min_m: 0, u_max_m: 1, v_min_m: 0, v_max_m: 1 };
    const base = { activeTool: "crop" as const, cropDraft: rect, measure: null, pinned: false };
    expect(planarToolKeyAction("Enter", base)).toBe("commit-crop");
    expect(planarToolKeyAction("Escape", base)).toBe("cancel-crop");
    expect(planarToolKeyAction("Escape", { ...base, activeTool: "measure", cropDraft: null, measure: { u0_m: 0, u1_m: 1, v0_m: 0, v1_m: 0 } }))
      .toBe("clear-measure");
    expect(planarToolKeyAction("Escape", { ...base, activeTool: "inspect", cropDraft: null, pinned: true })).toBe("close-pinned");
    expect(planarToolKeyAction("Escape", { ...base, activeTool: "inspect", cropDraft: null })).toBe("navigate");
    expect(planarToolKeyAction("Enter", { ...base, cropDraft: null })).toBeNull();
  });
});
