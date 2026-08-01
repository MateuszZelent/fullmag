import type { ScalarColorBuffer } from "../viewport3dFieldMapping";

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
  visibleShaderColors: ScalarColorBuffer | null;
  visibleVertexColors: ScalarColorBuffer | null;
}): {
  buffer: ScalarColorBuffer | null;
  pipeline: "shader" | "vertex" | null;
} {
  if (requestedPipeline === "shader") {
    if (visibleShaderColors) {
      return { buffer: visibleShaderColors, pipeline: "shader" };
    }
    if (visibleVertexColors) {
      return { buffer: visibleVertexColors, pipeline: "vertex" };
    }
  } else {
    if (visibleVertexColors) {
      return { buffer: visibleVertexColors, pipeline: "vertex" };
    }
    if (visibleShaderColors) {
      return { buffer: visibleShaderColors, pipeline: "shader" };
    }
  }
  return { buffer: null, pipeline: null };
}
