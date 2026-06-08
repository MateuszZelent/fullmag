export type RegionCapabilityGateId =
  | "regions.conformal_or_projected_boundary"
  | "regions.material_override"
  | "regions.mesh_policy"
  | "regions.realized_materialization";

interface RegionCapabilityPresentation {
  label: string;
}

const REGION_CAPABILITY_PRESENTATION: Record<
  RegionCapabilityGateId,
  RegionCapabilityPresentation
> = {
  "regions.conformal_or_projected_boundary": {
    label: "Region realization support",
  },
  "regions.material_override": {
    label: "Regional material realization",
  },
  "regions.mesh_policy": {
    label: "Mesh policy support",
  },
  "regions.realized_materialization": {
    label: "Region materialization support",
  },
};

export function isRegionCapabilityGateId(
  value: string | null | undefined,
): value is RegionCapabilityGateId {
  return (
    value === "regions.conformal_or_projected_boundary" ||
    value === "regions.material_override" ||
    value === "regions.mesh_policy" ||
    value === "regions.realized_materialization"
  );
}

export function regionCapabilityLabel(
  gate: string | null | undefined,
): string {
  return isRegionCapabilityGateId(gate)
    ? REGION_CAPABILITY_PRESENTATION[gate].label
    : gate ?? "Backend capability";
}

export function regionRuntimeBlockerPrefix(
  gate: string | null | undefined,
): string {
  return isRegionCapabilityGateId(gate)
    ? `${REGION_CAPABILITY_PRESENTATION[gate].label} blocker`
    : "Region-owned runtime blocker";
}
