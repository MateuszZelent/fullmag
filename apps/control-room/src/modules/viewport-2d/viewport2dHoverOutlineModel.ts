import type {
  Viewport2DPolygonSummary,
  Viewport2DRenderModel,
} from "./viewport2dRenderModel";

export interface Viewport2DHoverOutlineModel {
  lineCount: number;
  positions: Float32Array;
}

const OUTLINE_Z = 0.04;

export function buildViewport2DHoverOutlineModel(
  model: Pick<Viewport2DRenderModel, "positions">,
  polygon: Viewport2DPolygonSummary | null,
): Viewport2DHoverOutlineModel | null {
  if (!polygon?.visible) return null;
  const vertexCount = polygon.vertexEnd - polygon.vertexStart;
  if (vertexCount < 2) return null;

  const positions = new Float32Array(vertexCount * 6);
  for (let line = 0; line < vertexCount; line++) {
    const source = polygon.vertexStart + line;
    const target =
      line === vertexCount - 1
        ? polygon.vertexStart
        : polygon.vertexStart + line + 1;
    const offset = line * 6;
    positions[offset] = model.positions[source * 3];
    positions[offset + 1] = model.positions[source * 3 + 1];
    positions[offset + 2] = OUTLINE_Z;
    positions[offset + 3] = model.positions[target * 3];
    positions[offset + 4] = model.positions[target * 3 + 1];
    positions[offset + 5] = OUTLINE_Z;
  }

  return {
    lineCount: vertexCount,
    positions,
  };
}
