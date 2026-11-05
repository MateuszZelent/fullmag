import type { PlanarFieldOverlayState, VisualizationStateResource } from "@/kernel/api/apiTypes";
import { DIRECTION_COLORMAP } from "@/shared/visualization/directionColor";

type Planar = NonNullable<VisualizationStateResource["planar"]>;

export type PlanarTargetFieldProfile = PlanarFieldOverlayState;
type PlanarObjectFieldProfile = PlanarTargetFieldProfile & { view_scope: { kind: "object"; scope_id: string } };

export type PlanarTargetFieldProfilePatch = Partial<
  Omit<PlanarTargetFieldProfile, "id" | "view_scope">
>;

export type PlanarTargetFieldQuantityOption = {
  id: string;
  label: string;
  unit: string;
  vector: boolean;
  components: readonly {
    value: string;
    label: string;
    outputKind?: "scalar" | "vector";
  }[];
};

export function planarTargetFieldProfileId(scopeId: string): string {
  return `object:${scopeId}`;
}

export function createPlanarTargetFieldProfile(
  scopeId: string,
  vectorStyle: Planar["vector_style"],
): PlanarObjectFieldProfile {
  return {
    id: planarTargetFieldProfileId(scopeId),
    quantity_id: "m",
    component: "magnitude",
    view_scope: { kind: "object", scope_id: scopeId },
    colormap: DIRECTION_COLORMAP,
    range: { mode: "auto", min: null, max: null },
    raster_opacity: 1,
    raster_visible: true,
    vectors_visible: false,
    vector_style: { ...vectorStyle },
  };
}

export function findPlanarTargetFieldProfile(
  profiles: readonly PlanarTargetFieldProfile[] | null | undefined,
  scopeId: string,
): PlanarObjectFieldProfile | undefined {
  const id = planarTargetFieldProfileId(scopeId);
  return profiles?.find((profile): profile is PlanarObjectFieldProfile =>
    profile.id === id &&
    profile.view_scope.kind === "object" &&
    profile.view_scope.scope_id === scopeId,
  );
}

/** Replaces only the profile for this object and leaves the rest untouched. */
export function upsertPlanarTargetFieldProfile(
  profiles: readonly PlanarTargetFieldProfile[] | null | undefined,
  next: PlanarTargetFieldProfile,
): PlanarTargetFieldProfile[] | null {
  const current = profiles ?? [];
  const index = current.findIndex((profile) => profile.id === next.id);
  if (index < 0 && current.length >= 4) return null;
  if (index < 0) return [...current, next];
  return current.map((profile, entryIndex) => entryIndex === index ? next : profile);
}

export function patchPlanarTargetFieldProfile(
  profiles: readonly PlanarTargetFieldProfile[],
  id: string,
  patch: PlanarTargetFieldProfilePatch,
): PlanarTargetFieldProfile[] {
  return profiles.map((profile) => profile.id === id
    ? { ...profile, ...patch, id: profile.id, view_scope: profile.view_scope }
    : profile);
}

export function removePlanarTargetFieldProfile(
  profiles: readonly PlanarTargetFieldProfile[],
  id: string,
): PlanarTargetFieldProfile[] {
  return profiles.filter((profile) => profile.id !== id);
}

export function planarAirboxEnablePatch(
  planar: Planar,
  quantities: readonly PlanarTargetFieldQuantityOption[],
): Partial<Planar> {
  const airboxQuantities = quantities.filter((quantity) => quantity.id !== "m");
  const currentQuantity = airboxQuantities.find((quantity) => quantity.id === planar.quantity_id);
  const nextQuantity = currentQuantity
    ?? airboxQuantities.find((quantity) => quantity.id === "H_demag")
    ?? airboxQuantities[0];
  const component = currentQuantity?.components.some(
    (option) => option.value === planar.component,
  )
    ? planar.component
    : nextQuantity?.components.find((option) => option.value === "frobenius")?.value
      ?? nextQuantity?.components.find((option) => option.value === "magnitude")?.value
      ?? nextQuantity?.components[0]?.value
      ?? "magnitude";

  return {
    visible: true,
    source: { kind: "default" },
    view_scope: { kind: "airbox" },
    quantity_id: nextQuantity?.id ?? "H_demag",
    component: component as Planar["component"],
    layers: { ...planar.layers, raster: true },
  };
}
