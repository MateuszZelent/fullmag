import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type { DomainPresentation } from "@/shared/domain/mesh/domainPresentation";

export const FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET = {
  id: "fdm-universe-outside-support",
  kind: "fdm-domain",
  label: "Airbox",
} as const;

/**
 * Render-only description of the portion of an FDM universe that surrounds
 * the magnetic support.  It is intentionally not an airbox mesh: the regular
 * grid remains the only FDM discretization and no mask value is interpreted
 * as air or void here.
 */
export interface FdmUniverseOutsideSupportOverlayModel {
  kind: "fdm-universe-outside-magnetic-support";
  legend: {
    magneticSupport: string;
    outsideSupport: string;
  };
  magneticSupportBounds: Viewport3DBounds;
  /** Counts are exact only after the canonical FMRM artifact is available. */
  activeCellCount: number | null;
  inactiveCellCount: number | null;
  target: typeof FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET;
  universeBounds: Viewport3DBounds;
}

export function resolveFdmUniverseOutsideSupportOverlayModel({
  activeCellCount,
  inactiveCellCount,
  magneticSupportBounds,
  universeBounds,
  semanticRole,
}: {
  activeCellCount: number | null;
  inactiveCellCount: number | null;
  magneticSupportBounds: Viewport3DBounds | null;
  universeBounds: Viewport3DBounds | null;
  semanticRole: "universe-outside-magnetic-support" | null | undefined;
}): FdmUniverseOutsideSupportOverlayModel | null {
  if (
    semanticRole !== "universe-outside-magnetic-support" ||
    !magneticSupportBounds ||
    !universeBounds ||
    !boundsStrictlyContain(universeBounds, magneticSupportBounds)
  ) {
    return null;
  }

  return {
    activeCellCount,
    inactiveCellCount,
    kind: "fdm-universe-outside-magnetic-support",
    legend: {
      magneticSupport:
        activeCellCount === null
          ? "Magnetic support · authored bounds"
          : `Magnetic support · ${activeCellCount.toLocaleString("en-US")} active cells`,
      outsideSupport:
        inactiveCellCount === null
          ? "Airbox · membership pending"
          : `Airbox · ${inactiveCellCount.toLocaleString("en-US")} inactive cells`,
    },
    magneticSupportBounds,
    target: FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
    universeBounds,
  };
}

export function resolveFdmUniverseOutsideSupportOverlayFromPresentation(
  presentation: DomainPresentation | null,
): FdmUniverseOutsideSupportOverlayModel | null {
  const support =
    presentation?.discretization === "fdm"
      ? presentation.magneticSupport
      : null;
  const authoredRole =
    presentation?.discretization === "fdm"
      ? presentation.universeOutsideMagneticSupport
      : null;
  const magneticSupportBounds = toViewportBounds(
    support?.bounds ?? authoredRole?.magneticSupportBounds ?? null,
  );
  // Prefer the backend-declared role envelope when it is present.  The
  // generic domain bounds can describe the realized grid, while the explicit
  // role is the authoritative universe extent for an FDM grid with multiple
  // magnetic objects/regions.  This remains an AABB diagnostic overlay; no
  // FEM airbox topology or inactive-cell field is inferred here.
  const universeBounds = presentation
    ? toViewportBounds(
        presentation.universeOutsideMagneticSupport?.bounds ??
          presentation.bounds,
      )
    : null;
  if (
    !presentation ||
    presentation.discretization !== "fdm" ||
    !magneticSupportBounds ||
    !universeBounds
  ) {
    return null;
  }
  if (presentation.resourceStatus === "realized") {
    if (!support || support.inactiveCellCount === 0) return null;
    return resolveFdmUniverseOutsideSupportOverlayModel({
      activeCellCount: support.activeCellCount,
      inactiveCellCount: support.inactiveCellCount,
      magneticSupportBounds,
      semanticRole: "universe-outside-magnetic-support",
      universeBounds,
    });
  }
  if (
    authoredRole?.reason !== "authored-universe-exceeds-magnetic-support" ||
    !authoredRole.magneticSupportBounds
  ) {
    return null;
  }
  return resolveFdmUniverseOutsideSupportOverlayModel({
    activeCellCount: null,
    inactiveCellCount: null,
    magneticSupportBounds,
    semanticRole: "universe-outside-magnetic-support",
    universeBounds,
  });
}

function toViewportBounds(bounds: {
  max: readonly number[];
  min: readonly number[];
} | null): Viewport3DBounds | null {
  if (!bounds) return null;
  const { max, min } = bounds;
  if (
    max.length !== 3 ||
    min.length !== 3 ||
    !max.every(Number.isFinite) ||
    !min.every(Number.isFinite)
  ) {
    return null;
  }
  const size: [number, number, number] = [
    max[0]! - min[0]!,
    max[1]! - min[1]!,
    max[2]! - min[2]!,
  ];
  if (size.some((value) => value < 0)) return null;
  return {
    center: [
      (min[0]! + max[0]!) / 2,
      (min[1]! + max[1]!) / 2,
      (min[2]! + max[2]!) / 2,
    ],
    radius: Math.hypot(...size) / 2,
    size,
  };
}

function boundsStrictlyContain(
  outer: Viewport3DBounds,
  inner: Viewport3DBounds,
): boolean {
  const epsilon = Math.max(outer.radius, inner.radius, 1e-12) * 1e-12;
  let hasStrictExtension = false;
  for (let axis = 0; axis < 3; axis += 1) {
    const outerMin = outer.center[axis] - outer.size[axis] / 2;
    const outerMax = outer.center[axis] + outer.size[axis] / 2;
    const innerMin = inner.center[axis] - inner.size[axis] / 2;
    const innerMax = inner.center[axis] + inner.size[axis] / 2;
    if (outerMin > innerMin + epsilon || outerMax < innerMax - epsilon) {
      return false;
    }
    if (outerMin < innerMin - epsilon || outerMax > innerMax + epsilon) {
      hasStrictExtension = true;
    }
  }
  return hasStrictExtension;
}
