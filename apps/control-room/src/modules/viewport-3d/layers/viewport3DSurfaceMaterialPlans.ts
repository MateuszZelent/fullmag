import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";

type PrimitiveSurfaceMaterialProfile = Pick<
  Viewport3DMaterialProfile,
  "primitivePreview" | "uniformGeometry"
>;

export type PrimitiveObjectSurfaceMaterialPlan =
  | {
      castShadow: false;
      kind: "basic" | "lambert";
      receiveShadow: false;
      toneMapped: boolean;
    }
  | {
      castShadow: boolean;
      kind: "standard";
      metalness: number;
      receiveShadow: boolean;
      roughness: number;
      toneMapped: boolean;
    }
  | {
      castShadow: false;
      kind: "matcap";
      receiveShadow: false;
    };

export function resolvePrimitiveObjectSurfaceMaterialPlan({
  hasAntennaMatcap,
  materialProfile,
}: {
  hasAntennaMatcap: boolean;
  materialProfile: PrimitiveSurfaceMaterialProfile;
}): PrimitiveObjectSurfaceMaterialPlan {
  if (hasAntennaMatcap) {
    return { castShadow: false, kind: "matcap", receiveShadow: false };
  }

  if (materialProfile.uniformGeometry.pbr && materialProfile.uniformGeometry.lit) {
    const shadows = materialProfile.uniformGeometry.shadows;
    return {
      castShadow: shadows,
      kind: "standard",
      metalness: materialProfile.uniformGeometry.metalness,
      receiveShadow: shadows,
      roughness: materialProfile.uniformGeometry.roughness,
      toneMapped: materialProfile.uniformGeometry.toneMapped,
    };
  }

  if (materialProfile.uniformGeometry.lit) {
    return {
      castShadow: false,
      kind: "lambert",
      receiveShadow: false,
      toneMapped: materialProfile.primitivePreview.toneMapped,
    };
  }

  return {
    castShadow: false,
    kind: "basic",
    receiveShadow: false,
    toneMapped: materialProfile.primitivePreview.toneMapped,
  };
}

type MeshPartSurfaceMaterialProfile = Pick<
  Viewport3DMaterialProfile,
  "magneticSurface" | "uniformGeometry"
>;

export type MeshPartSurfaceMaterialPlan =
  | {
      castShadow: false;
      kind: "scalar-shader";
      receiveShadow: false;
    }
  | {
      castShadow: false;
      kind: "basic" | "lambert";
      receiveShadow: false;
      toneMapped: boolean;
    }
  | {
      castShadow: boolean;
      kind: "standard";
      metalness: number;
      receiveShadow: boolean;
      roughness: number;
      toneMapped: boolean;
    };

export function resolveMeshPartSurfaceMaterialPlan({
  hasScalarShaderMaterial,
  hasUploadedVertexScalarColors,
  materialProfile,
}: {
  hasScalarShaderMaterial: boolean;
  hasUploadedVertexScalarColors: boolean;
  materialProfile: MeshPartSurfaceMaterialProfile;
}): MeshPartSurfaceMaterialPlan {
  if (hasScalarShaderMaterial) {
    return { castShadow: false, kind: "scalar-shader", receiveShadow: false };
  }

  if (hasUploadedVertexScalarColors) {
    return {
      castShadow: false,
      kind: "basic",
      receiveShadow: false,
      toneMapped: materialProfile.magneticSurface.toneMapped,
    };
  }

  if (materialProfile.uniformGeometry.pbr && materialProfile.uniformGeometry.lit) {
    const shadows = materialProfile.uniformGeometry.shadows;
    return {
      castShadow: shadows,
      kind: "standard",
      metalness: materialProfile.uniformGeometry.metalness,
      receiveShadow: shadows,
      roughness: materialProfile.uniformGeometry.roughness,
      toneMapped: materialProfile.uniformGeometry.toneMapped,
    };
  }

  if (materialProfile.uniformGeometry.lit) {
    return {
      castShadow: false,
      kind: "lambert",
      receiveShadow: false,
      toneMapped: materialProfile.magneticSurface.toneMapped,
    };
  }

  return {
    castShadow: false,
    kind: "basic",
    receiveShadow: false,
    toneMapped: materialProfile.magneticSurface.toneMapped,
  };
}

type FdmCuboidSurfaceMaterialProfile = Pick<
  Viewport3DMaterialProfile,
  "magneticSurface" | "uniformGeometry"
>;

export type FdmCuboidSurfaceMaterialPlan =
  | {
      castShadow: false;
      kind: "basic" | "lambert";
      receiveShadow: false;
      toneMapped: boolean;
      vertexColors: boolean;
    }
  | {
      castShadow: boolean;
      kind: "standard";
      metalness: number;
      receiveShadow: boolean;
      roughness: number;
      toneMapped: boolean;
      vertexColors: false;
    };

export function resolveFdmCuboidSurfaceMaterialPlan(
  materialProfile: FdmCuboidSurfaceMaterialProfile,
  usesInstanceColors: boolean,
): FdmCuboidSurfaceMaterialPlan {
  if (usesInstanceColors) {
    return {
      castShadow: false,
      kind: "basic",
      receiveShadow: false,
      toneMapped: materialProfile.magneticSurface.toneMapped,
      vertexColors: true,
    };
  }

  if (materialProfile.uniformGeometry.pbr && materialProfile.uniformGeometry.lit) {
    const shadows = materialProfile.uniformGeometry.shadows;
    return {
      castShadow: shadows,
      kind: "standard",
      metalness: materialProfile.uniformGeometry.metalness,
      receiveShadow: shadows,
      roughness: materialProfile.uniformGeometry.roughness,
      toneMapped: materialProfile.uniformGeometry.toneMapped,
      vertexColors: false,
    };
  }

  if (materialProfile.uniformGeometry.lit) {
    return {
      castShadow: false,
      kind: "lambert",
      receiveShadow: false,
      toneMapped: materialProfile.magneticSurface.toneMapped,
      vertexColors: false,
    };
  }

  return {
    castShadow: false,
    kind: "basic",
    receiveShadow: false,
    toneMapped: materialProfile.magneticSurface.toneMapped,
    vertexColors: false,
  };
}
