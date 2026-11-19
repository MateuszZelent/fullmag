import type { SceneResource } from "@/kernel/api/apiTypes";

type SceneObject = NonNullable<SceneResource["objects"]>[number];

/** Proves only the absence of any authored magnetic configuration, not capabilities of a configured stack. */
export function hasEmptyObjectMagneticModel(object: SceneObject | null | undefined): boolean {
  return object != null && object.magnetization_ref == null
    && !object.physics_stack?.length
    && !Object.keys(object.region_overrides ?? {}).length
    && !object.material_parameter_fields?.length
    && !object.absorbing_boundary
    && !(object.regions ?? []).some((region) =>
      region.texture_override != null || Boolean(region.material_overrides?.length),
    );
}
