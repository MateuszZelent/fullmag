import type {
  Viewport3DFieldRenderModel,
  Viewport3DVectorBuildReference,
} from "../viewport3dRenderModel";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";

interface Viewport3DTargetSurfaceLayerFieldModel {
  scalarColorsByMode: ReadonlyMap<string, ScalarColorBuffer | null>;
  scalarColorsByPartAndMode?: ReadonlyMap<
    string,
    ReadonlyMap<string, ScalarColorBuffer | null>
  >;
  targetPasses?: ReadonlyMap<
    string,
    {
      fieldBuffer?: { bufferId: string } | null;
      surface: {
        scalarColorMode: string | null;
        scalarColors: ScalarColorBuffer | null;
      };
    }
  >;
}

export function resolveViewport3DTargetSurfaceLayerInput({
  fieldModel,
  partId,
  scalarColorMode,
}: {
  fieldModel: Viewport3DTargetSurfaceLayerFieldModel | null;
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

export function resolveViewport3DTargetLayerRequestedSourceIdentity({
  fieldModel,
  partId,
}: {
  fieldModel: {
    targetPasses: ReadonlyMap<
      string,
      {
        fieldBuffer?: { bufferId: string } | null;
        surface: { scalarColors: ScalarColorBuffer | null };
        vectors: { buildReference: { buildKey: string } | null };
      }
    >;
  } | null;
  partId: string;
}): {
  fieldBufferId: string | null;
  scalarBufferKey: string | null;
  vectorBuildKey: string | null;
} {
  const pass = fieldModel?.targetPasses.get(partId);
  return {
    fieldBufferId: pass?.fieldBuffer?.bufferId ?? null,
    scalarBufferKey: pass?.surface.scalarColors?.buildKey ?? null,
    vectorBuildKey: pass?.vectors.buildReference?.buildKey ?? null,
  };
}
