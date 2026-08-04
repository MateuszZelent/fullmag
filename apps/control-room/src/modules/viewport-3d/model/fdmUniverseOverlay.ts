import type { Viewport3DBounds } from "../viewport3dRenderModel";

/**
 * Render-only description of the portion of an FDM universe that surrounds
 * the magnetic support.  It is intentionally not an airbox mesh: the regular
 * grid remains the only FDM discretization and no mask value is interpreted
 * as air or void here.
 */
export interface FdmUniverseOutsideSupportOverlayModel {
  kind: "fdm-universe-outside-magnetic-support";
  magneticSupportBounds: Viewport3DBounds;
  universeBounds: Viewport3DBounds;
}

export function hasExplicitFdmUniverseOutsideMagneticSupportRole(
  ...configs: readonly unknown[]
): boolean {
  return configs.some((config) => {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return false;
    }
    const record = config as Record<string, unknown>;
    return (
      record.role === "universe-outside-magnetic-support" ||
      record.semantic_role === "universe-outside-magnetic-support"
    );
  });
}

export function resolveFdmUniverseOutsideSupportOverlayModel({
  magneticSupportBounds,
  universeBounds,
  semanticRole,
}: {
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
    kind: "fdm-universe-outside-magnetic-support",
    magneticSupportBounds,
    universeBounds,
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
