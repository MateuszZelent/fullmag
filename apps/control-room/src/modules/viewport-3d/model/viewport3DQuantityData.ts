import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DFieldRenderModel, Viewport3DTargetFieldBufferSource } from "../viewport3dRenderModel";

type FieldSamples = { quantityId: string; pointCount: number; values: ArrayLike<number> };

/** Capability entries and overlay intent are not evidence of field samples. */
export function hasViewport3DQuantityData(quantityId: string, {
  fieldModel,
  fieldVectors = [],
  fieldBuffers = [],
  scalarColors = [],
}: {
  fieldModel?: Viewport3DFieldRenderModel | null;
  fieldVectors?: readonly (FieldSamples | null | undefined)[];
  fieldBuffers?: readonly (Viewport3DTargetFieldBufferSource | null | undefined)[];
  scalarColors?: readonly (ScalarColorBuffer | null | undefined)[];
}): boolean {
  if (!quantityId) return false;
  const hasSamples = (field: FieldSamples | null | undefined) =>
    field?.quantityId === quantityId && field.pointCount > 0 && field.values.length > 0;
  const hasColors = (colors: ScalarColorBuffer | null | undefined) =>
    colors?.quantityId === quantityId && Boolean(colors.colors.length || colors.scalarValues?.length || colors.vectorValues?.length || colors.complexRealValues?.length);
  if (fieldVectors.some(hasSamples) || fieldBuffers.some(hasSamples) || scalarColors.some(hasColors)) return true;
  if (!fieldModel) return false;
  const data = fieldModel.quantityData;
  if (data?.quantityId === quantityId && data.pointCount > 0 && data.valueCount > 0) return true;
  if (hasColors(fieldModel.scalarColors)) return true;
  for (const pass of fieldModel.targetPasses.values()) {
    if (hasSamples(pass.fieldBuffer) || hasColors(pass.surface.scalarColors)) return true;
  }
  for (const colors of fieldModel.scalarColorsByMode.values()) if (hasColors(colors)) return true;
  for (const modes of fieldModel.scalarColorsByPartAndMode.values()) {
    for (const colors of modes.values()) if (hasColors(colors)) return true;
  }
  return false;
}
