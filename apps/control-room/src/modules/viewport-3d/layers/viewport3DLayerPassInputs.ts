import type {
  Viewport3DFieldRenderModel,
  Viewport3DVectorBuildReference,
} from "../viewport3dRenderModel";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";

export function resolveViewport3DTargetSurfaceLayerInput({
  fieldModel,
  partId,
  scalarColorMode,
}: {
  fieldModel: (
    Pick<Viewport3DFieldRenderModel, "scalarColorsByMode"> &
      Partial<
        Pick<
          Viewport3DFieldRenderModel,
          "scalarColorsByPartAndMode" | "targetPasses"
        >
      >
  ) | null;
  partId: string;
  scalarColorMode: string | null;
}): {
  scalarColors: ScalarColorBuffer | null;
} {
  if (!fieldModel || !scalarColorMode) {
    return { scalarColors: null };
  }

  const targetSurface = fieldModel.targetPasses?.get(partId)?.surface ?? null;
  if (targetSurface) {
    return {
      scalarColors:
        targetSurface.scalarColorMode === scalarColorMode
          ? targetSurface.scalarColors
          : null,
    };
  }
  if (fieldModel.targetPasses && fieldModel.targetPasses.size > 0) {
    return { scalarColors: null };
  }

  return {
    scalarColors:
      fieldModel.scalarColorsByPartAndMode?.get(partId)?.get(scalarColorMode) ??
      fieldModel.scalarColorsByMode.get(scalarColorMode) ??
      null,
  };
}

export function resolveViewport3DTargetVectorLayerInput({
  fieldModel,
  partId,
}: {
  fieldModel: (
    Pick<Viewport3DFieldRenderModel, "partVectorBuilds" | "partVectorSegments"> &
      Partial<Pick<Viewport3DFieldRenderModel, "targetPasses">>
  ) | null;
  partId: string;
}): {
  buildReference: Viewport3DVectorBuildReference | null;
  segments: Float32Array | null;
} {
  if (!fieldModel) {
    return {
      buildReference: null,
      segments: null,
    };
  }

  const targetVectors = fieldModel.targetPasses?.get(partId)?.vectors ?? null;
  if (targetVectors) {
    return {
      buildReference: targetVectors.buildReference,
      segments: targetVectors.segments,
    };
  }
  if (fieldModel.targetPasses && fieldModel.targetPasses.size > 0) {
    return {
      buildReference: null,
      segments: null,
    };
  }

  return {
    buildReference: fieldModel.partVectorBuilds.get(partId) ?? null,
    segments: fieldModel.partVectorSegments.get(partId) ?? null,
  };
}
