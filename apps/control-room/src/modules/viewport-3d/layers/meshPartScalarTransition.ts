import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DScalarColorUploadResult } from "../hooks/useViewport3DScalarColorUpload";

export interface MeshPartCommittedScalarColorState {
  readonly buffer: ScalarColorBuffer | null;
  readonly fresh: boolean;
  readonly pipeline: "shader" | "vertex" | null;
}

function normalizeScalarUploadInput(
  input:
    | Viewport3DScalarColorUploadResult
    | ScalarColorBuffer
    | null
    | undefined,
): Viewport3DScalarColorUploadResult {
  if (!input) {
    return { buffer: null, fresh: false };
  }
  if ("buffer" in input && typeof input.fresh === "boolean") {
    return input;
  }
  return { buffer: input as ScalarColorBuffer, fresh: true };
}

export function buildMeshPartScalarColorRetentionKey(input: {
  mode: string;
  partId: string;
  projection: string;
  quantityId: string;
  scalarColorPalette: string | null | undefined;
  topologyRevision: number | string | null;
  vertexCount: number;
}): string {
  const {
    mode,
    partId,
    projection,
    quantityId,
    scalarColorPalette,
    topologyRevision,
    vertexCount,
  } = input;
  return [
    "field",
    `part=${partId}`,
    `mode=${mode}`,
    `quantity=${quantityId}`,
    `palette=${scalarColorPalette ?? "none"}`,
    `projection=${projection}`,
    `topology=${topologyRevision ?? "none"}`,
    `vertices=${vertexCount}`,
  ].join("|");
}

export function resolveMeshPartCommittedScalarColorState({
  requestedPipeline,
  visibleShaderColors,
  visibleVertexColors,
}: {
  requestedPipeline: "shader" | "vertex";
  visibleShaderColors:
    | Viewport3DScalarColorUploadResult
    | ScalarColorBuffer
    | null
    | undefined;
  visibleVertexColors:
    | Viewport3DScalarColorUploadResult
    | ScalarColorBuffer
    | null
    | undefined;
}): MeshPartCommittedScalarColorState {
  const shader = normalizeScalarUploadInput(visibleShaderColors);
  const vertex = normalizeScalarUploadInput(visibleVertexColors);

  if (requestedPipeline === "shader") {
    if (shader.buffer) {
      return { buffer: shader.buffer, fresh: shader.fresh, pipeline: "shader" };
    }
    if (vertex.buffer) {
      return { buffer: vertex.buffer, fresh: vertex.fresh, pipeline: "vertex" };
    }
  } else {
    if (vertex.buffer) {
      return { buffer: vertex.buffer, fresh: vertex.fresh, pipeline: "vertex" };
    }
    if (shader.buffer) {
      return { buffer: shader.buffer, fresh: shader.fresh, pipeline: "shader" };
    }
  }
  return { buffer: null, fresh: false, pipeline: null };
}
