import type {
  PlanarCursorUv,
  PlanarToolId,
  PlanarUvRect,
  PlanarUvSegment,
} from "@/kernel/visualization/planarToolStore";

import type { PlanarInteraction } from "../renderer/planarInteraction";
import {
  MIN_TOOL_DRAG_PX,
  clipUvRect,
  interactionForUvRect,
  normalizeUvRect,
  uvRectLargeEnough,
} from "./planarToolGeometry";

type UvBounds = readonly [number, number, number, number];
type CanvasSize = { width: number; height: number };

/** Canvas tools that turn a primary-button drag into a shape (plan §2.3). */
export type PlanarDragTool = Extract<PlanarToolId, "zoom-box" | "crop" | "measure" | "profile">;

export function isPlanarDragTool(tool: PlanarToolId): tool is PlanarDragTool {
  return tool === "zoom-box" || tool === "crop" || tool === "measure" || tool === "profile";
}

/** Result of releasing a tool drag; the surface applies it. */
export type PlanarToolDragResult =
  | { kind: "none" }
  | { kind: "interaction"; interaction: PlanarInteraction }
  | { kind: "crop-draft"; rect: PlanarUvRect | null }
  | { kind: "measure"; segment: PlanarUvSegment | null }
  | { kind: "profile"; segment: PlanarUvSegment };

function dragDistancePx(startClient: readonly [number, number], endClient: readonly [number, number]): number {
  return Math.hypot(endClient[0] - startClient[0], endClient[1] - startClient[1]);
}

/**
 * Resolves a released drag of a canvas tool. A box shorter than
 * `MIN_TOOL_DRAG_PX` on either side does nothing: zoom-box keeps its tool and
 * sends no patch, crop drops the draft, a ruler or profile needs that length.
 */
export function resolvePlanarToolDrag(input: {
  tool: PlanarDragTool;
  start: PlanarCursorUv;
  end: PlanarCursorUv;
  startClient: readonly [number, number];
  endClient: readonly [number, number];
  frameBounds: UvBounds;
  viewport: UvBounds;
  canvas: CanvasSize;
}): PlanarToolDragResult {
  const rect = normalizeUvRect(input.start, input.end);
  const segment = {
    u0_m: input.start.u_m,
    u1_m: input.end.u_m,
    v0_m: input.start.v_m,
    v1_m: input.end.v_m,
  };
  const longEnough = dragDistancePx(input.startClient, input.endClient) >= MIN_TOOL_DRAG_PX;
  switch (input.tool) {
    case "zoom-box":
      return uvRectLargeEnough(rect, input.viewport, input.canvas)
        ? { interaction: interactionForUvRect(rect, input.frameBounds, input.canvas), kind: "interaction" }
        : { kind: "none" };
    case "crop":
      return { kind: "crop-draft", rect: uvRectLargeEnough(rect, input.viewport, input.canvas) ? rect : null };
    case "measure":
      return { kind: "measure", segment: longEnough ? segment : null };
    case "profile":
      return longEnough ? { kind: "profile", segment } : { kind: "none" };
  }
}

export const CROP_TOO_SMALL_REASON = `Draw a crop of at least ${MIN_TOOL_DRAG_PX} px on each side.`;
export const CROP_OUTSIDE_REASON = "The crop does not overlap the sampled plane.";

/** The rectangle a commit sends (clipped to the full frame) or why it cannot. */
export function resolvePlanarCropCommit(input: {
  draft: PlanarUvRect | null;
  fullBounds: UvBounds;
  viewport: UvBounds;
  canvas: CanvasSize;
}): { rect: PlanarUvRect | null; disabledReason: string | null } {
  if (!input.draft) return { disabledReason: "Draw a crop rectangle first.", rect: null };
  if (!uvRectLargeEnough(input.draft, input.viewport, input.canvas)) {
    return { disabledReason: CROP_TOO_SMALL_REASON, rect: null };
  }
  const rect = clipUvRect(input.draft, input.fullBounds);
  if (!rect) return { disabledReason: CROP_OUTSIDE_REASON, rect: null };
  // Clipping can shrink a side below the screen minimum.
  if (!uvRectLargeEnough(rect, input.viewport, input.canvas)) {
    return { disabledReason: CROP_TOO_SMALL_REASON, rect: null };
  }
  return { disabledReason: null, rect };
}

export type PlanarToolKeyAction =
  | "commit-crop"
  | "cancel-crop"
  | "clear-measure"
  | "close-pinned"
  | "navigate"
  | null;

/**
 * Enter and Escape on the canvas: Enter commits a crop draft; Escape undoes
 * the innermost tool state first (draft, ruler, pinned readout) and only then
 * returns to the navigate tool.
 */
export function planarToolKeyAction(
  key: string,
  state: { activeTool: PlanarToolId; cropDraft: PlanarUvRect | null; measure: PlanarUvSegment | null; pinned: boolean },
): PlanarToolKeyAction {
  if (key === "Enter") return state.activeTool === "crop" && state.cropDraft ? "commit-crop" : null;
  if (key !== "Escape") return null;
  if (state.cropDraft) return "cancel-crop";
  if (state.activeTool === "measure" && state.measure) return "clear-measure";
  if (state.activeTool === "inspect" && state.pinned) return "close-pinned";
  return "navigate";
}
