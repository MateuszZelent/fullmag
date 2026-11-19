import type { ScalarColorBuffer, ScalarRange } from "../viewport3dFieldMapping";

/** Small render-side metadata; field values and live session identity stay with their owners. */
export interface Viewport3DVisibleColorScale {
  colorMode: string;
  colorPalette: string;
  quantityId: string;
  range: ScalarRange;
}

export interface Viewport3DVisibleColorScaleReport {
  scopeKey: string;
  ownerId: string;
  pass: "surface" | "vectors";
  scale: Viewport3DVisibleColorScale | null;
  removed?: boolean;
}

export interface Viewport3DVisibleColorScales {
  scopeKey: string | null;
  passes: Partial<Record<Viewport3DVisibleColorScaleReport["pass"], {
    ownerId: string;
    scale: Viewport3DVisibleColorScale | null;
  }>>;
}

export function visibleColorScaleFromBuffer(buffer: ScalarColorBuffer | null | undefined): Viewport3DVisibleColorScale | null {
  if (!buffer?.quantityId || !buffer.colorPalette || !buffer.colorMode ||
      !["magnitude", "scalar", "x", "y", "z"].includes(buffer.colorMode) ||
      !Number.isFinite(buffer.range.min) || !Number.isFinite(buffer.range.max) || buffer.range.min > buffer.range.max) return null;
  return { quantityId: buffer.quantityId, colorMode: buffer.colorMode,
    colorPalette: buffer.colorPalette, range: { ...buffer.range } };
}

/** Fence reports by pinned result and remove only the matching owner. */
export function updateVisibleColorScales(
  current: Viewport3DVisibleColorScales,
  report: Viewport3DVisibleColorScaleReport,
): Viewport3DVisibleColorScales {
  if (current.scopeKey !== report.scopeKey) return current;
  const previous = current.passes[report.pass];
  if (report.removed) {
    if (previous?.ownerId !== report.ownerId) return current;
    const passes = { ...current.passes };
    delete passes[report.pass];
    return { ...current, passes };
  }
  if (previous?.ownerId === report.ownerId && JSON.stringify(previous.scale) === JSON.stringify(report.scale)) return current;
  const scale = report.scale ? { ...report.scale, range: { ...report.scale.range } } : null;
  return { ...current, passes: { ...current.passes, [report.pass]: { ownerId: report.ownerId, scale } } };
}

export interface Viewport3DVisibleSurfaceChoice {
  scopeKey: string | null;
  shader: boolean;
  bufferKey: string | null;
}

/** Remember only which confirmed upload is displayed; buffers remain in the upload stores. */
export function selectVisibleSurfaceChoice(
  current: Viewport3DVisibleSurfaceChoice,
  requested: Viewport3DVisibleSurfaceChoice & { enabled: boolean },
): Viewport3DVisibleSurfaceChoice {
  const next = !requested.scopeKey || !requested.enabled
    ? { scopeKey: requested.scopeKey, shader: false, bufferKey: null }
    : requested.bufferKey ? { scopeKey: requested.scopeKey, shader: requested.shader, bufferKey: requested.bufferKey }
      : current.scopeKey === requested.scopeKey ? current
        : { scopeKey: requested.scopeKey, shader: false, bufferKey: null };
  return current.scopeKey === next.scopeKey && current.shader === next.shader && current.bufferKey === next.bufferKey ? current : next;
}
