import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import type {
  DomainMetaResource,
  FieldAvailabilityResource,
  FieldCatalogResource,
  FieldAvailabilityQuery,
  FdmRegionMembershipResource,
  FieldMetaQuery,
  MeshSharedDomainManifestResource,
  MeshRegionMembershipResource,
  VisualizationStatePatch,
  VisualizationStateResource,
  QuantityCatalogResource,
} from "@/kernel/api/apiTypes";
import {
  canonicalVisualizationSceneObjectId,
  isVisualizationAirboxIdentity,
  visualizationTargetIdForSceneObject,
  type Selection,
} from "@/kernel/selection/selectionTypes";
import { resolveVisualizationTargetForMeshPart } from "@/kernel/selection/visualizationTargetResolver";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";
import {
  isAnalysisFieldQuantityId,
  fieldCatalogQuantitySupportsAirbox,
  fieldCatalogQuantitySupportsSpatialVisualization,
  isScalarSpatialQuantityId,
  quantityCatalogEntrySupportsAirbox,
  quantityCatalogEntrySupportsSpatialVisualization,
  resolveCanonicalQuantityId,
} from "@/kernel/api/quantityIds";
import {
  displayUnitItemsForSourceUnit,
  formatDisplayUnitValue,
  formatValueWithDisplayUnit,
  formatValueWithUnit,
  hasDisplayUnitOptions,
} from "@/shared/domain/physics/displayUnits";
import {
  buildAirOnlyVisualizationNodeSelection,
  visualizationNodeSelectionIndices,
} from "@/shared/domain/mesh/visualizationNodeSelection";
import {
  mergeVisualizationStateTargetOverride,
  resetAirboxVisualizationState,
  targetForFdmNativeLayer,
  visualizationStateOverrideMatchesTarget,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  renderModePatch,
  type ObjectVisualizationController,
  type SurfaceFieldProjectionMode,
  type SurfaceColorSource,
  type VisualizationGeometryScope,
  type VisualizationColorMode,
  type VisualizationRenderMode,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
  type VisualizationStoredTargetPatch,
  type ViewportTargetRenderingPreferences,
  isFdmUniverseOutsideSupportTarget,
  visualizationTargetCapabilities,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  resolveVisualizationTopologyFreshness,
  type VisualizationTopologyFreshness,
} from "@/kernel/visualization/visualizationDisplayResolution";
import {
  fdmMultilayerAirboxVisualizationVectorCapacitySource,
  fdmNativeLayerVisualizationVectorCapacitySource,
  fdmVisualizationVectorCapacitySource,
  femVisualizationVectorCapacitySource,
  resolveVisualizationVectorCapacityDescriptor,
  type VisualizationVectorCapacityDescriptor,
} from "@/kernel/visualization/visualizationVectorCapacity";
import {
  resolveTargetFieldAvailability,
  targetFieldAvailabilityIsSelectable,
  type TargetFieldAvailability,
  type TargetFieldCarrierDescriptor,
} from "@/kernel/visualization/targetFieldAvailability";
export {
  resolveTargetFieldAvailability,
  resolveTargetFieldAvailabilityMap,
  resolveTargetFieldAvailabilityFromBackend,
  targetFieldAvailabilityIsLive,
  targetFieldAvailabilityIsSelectable,
} from "@/kernel/visualization/targetFieldAvailability";
export type {
  ResolveTargetFieldAvailabilityMapOptions,
  ResolveTargetFieldAvailabilityOptions,
  TargetFieldAvailability,
  TargetFieldAvailabilityState,
  TargetFieldCarrierDescriptor,
  TargetFieldCarrierPayloadState,
} from "@/kernel/visualization/targetFieldAvailability";
export {
  resolveVisualizationRenderResolution,
} from "@/kernel/visualization/visualizationDisplayResolution";
export type { VisualizationVectorCapacityDescriptor } from "@/kernel/visualization/visualizationVectorCapacity";

/**
 * Resolve the overview's field state from target-scoped carrier evidence.
 * A ready global catalog is capability/materialization evidence only; it is
 * never sufficient to claim Live until the renderer has adopted a matching
 * carrier for the selected target.
 */
export function resolveObjectVisualizationDataState({
  backendAvailability,
  backendAvailabilityStatus,
  carrier,
  fieldCatalog,
  fieldCatalogStatus,
  quantityId,
  requiresFieldData,
  target,
}: {
  backendAvailability?: FieldAvailabilityResource | null;
  backendAvailabilityStatus?: string;
  carrier?: TargetFieldCarrierDescriptor | null;
  fieldCatalog: FieldCatalogResource | null | undefined;
  fieldCatalogStatus: string;
  quantityId: string;
  requiresFieldData: boolean;
  target: VisualizationTargetRef | null | undefined;
}): string {
  if (!target) return "Unavailable";
  if (!requiresFieldData) return "Not required";
  if (
    backendAvailabilityStatus === "loading" ||
    backendAvailabilityStatus === "idle"
  ) {
    return "Loading";
  }
  if (backendAvailabilityStatus === "error") {
    return "Unavailable";
  }
  if (backendAvailability) {
    const backendState = backendAvailability.state;
    if (backendState === "unavailable") {
      return carrier?.payloadState === "ready" ? "Stale" : "Unavailable";
    }
    if (backendState === "materializing") {
      return carrier?.payloadState === "ready" ? "Stale" : "Materializing";
    }
    if (backendState === "stale") {
      return carrier?.payloadState === "ready" ? "Stale" : "Materializing";
    }
    if (backendState === "supported") {
      return "Supported";
    }
    if (
      backendState === "ready" &&
      (fieldCatalogStatus === "loading" ||
        fieldCatalogStatus === "idle" ||
        !fieldCatalog)
    ) {
      return "Ready";
    }
  }
  if (fieldCatalogStatus === "loading" || fieldCatalogStatus === "idle") {
    return "Loading";
  }
  if (!fieldCatalog) {
    return fieldCatalogStatus === "error" ? "Unavailable" : "Loading";
  }

  const availability = resolveTargetFieldAvailability(quantityId, {
    carrier,
    fieldCatalog,
    target,
  });
  if (backendAvailability?.state === "ready") {
    if (availability.state === "adopted") return "Live";
    if (availability.state === "stale") return "Stale";
    return "Ready";
  }
  switch (availability.state) {
    case "adopted":
      return "Live";
    case "materializing":
      return "Materializing";
    case "stale":
      return "Stale";
    case "ready":
      return "Ready";
    case "supported":
      return "Supported";
    case "unavailable":
      return "Unavailable";
  }
}

/**
 * Convert an already-published viewport snapshot into the small carrier proof
 * consumed by the Inspector. This function only reads bounded debug metadata;
 * it never requests debug demand and therefore cannot start a field scan.
 */
export function targetFieldCarrierDescriptorFromDebugSnapshots({
  pass,
  quantityId,
  snapshots,
  target,
}: {
  pass: "surface" | "vector" | "any";
  quantityId: string;
  snapshots: readonly VisualizationDebugSnapshot[];
  target: VisualizationTargetRef;
}): TargetFieldCarrierDescriptor | null {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  const snapshot = [...snapshots]
    .filter((candidate) => candidate.target.id === target.id)
    .sort((left, right) => right.capturedAtMs - left.capturedAtMs)[0];
  if (!snapshot) return null;

  const carrier = snapshot.carriers.find((candidate) => {
    const payloadQuantity = candidate.payload?.quantityId;
    return (
      payloadQuantity !== undefined &&
      resolveCanonicalQuantityId(payloadQuantity) === canonicalQuantityId
    );
  });
  if (!carrier) return null;

  const payload = carrier.payload;
  const payloadState: TargetFieldCarrierDescriptor["payloadState"] = payload
    ? "ready"
    : /pending|loading|inflight/i.test(carrier.render.fieldBufferState)
      ? "pending"
      : "missing";
  const requestedFieldBufferId = carrier.render.requestedFieldBufferId;
  const requestResourceKey = carrier.request.resourceKey;
  const surfaceAdoption = carrier.render.adoption.surface;
  const vectorAdoption = carrier.render.adoption.vector;
  const surfaceAdopted = Boolean(
    payloadState === "ready" &&
      requestedFieldBufferId &&
      requestResourceKey &&
      surfaceAdoption.adoptedFieldBufferId === requestedFieldBufferId &&
      surfaceAdoption.adoptedResourceKey === requestResourceKey &&
      surfaceAdoption.adoptedScalarBufferKey,
  );
  const vectorAdopted = Boolean(
    payloadState === "ready" &&
      requestedFieldBufferId &&
      requestResourceKey &&
      carrier.render.vectors.buildKey &&
      vectorAdoption.adoptedFieldBufferId === requestedFieldBufferId &&
      vectorAdoption.adoptedResourceKey === requestResourceKey &&
      vectorAdoption.adoptedVectorBuildKey === carrier.render.vectors.buildKey &&
      vectorAdoption.adoptedVectorItemCount !== null,
  );

  return {
    adopted:
      pass === "surface"
        ? surfaceAdopted
        : pass === "vector"
          ? vectorAdopted
          : surfaceAdopted || vectorAdopted,
    carrierId: carrier.carrierId,
    fieldRevision:
      carrier.revisions.fieldRevision ??
      carrier.revisions.fieldBufferRevision ??
      null,
    generationId: carrier.revisions.domainGenerationId ?? null,
    payloadPointCount: payload?.pointCount ?? null,
    payloadState,
    quantityId: payload?.quantityId ?? canonicalQuantityId,
    scopeId: payload?.scopeId ?? null,
    scopeKind: payload?.scopeKind ?? null,
    targetIds: [target.id],
  };
}

type AppliedVisualizationBaselineTarget = {
  preferences: ViewportTargetRenderingPreferences | null;
  settings: VisualizationTargetSettings;
  target: VisualizationTargetRef;
};

/**
 * Restore the inspector's applied baseline through the session visualization
 * resource. Only explicit viewport preferences are restored locally.
 */
export function restoreVisualizationAppliedBaseline({
  baseline,
  currentOverrides,
  queuePatch,
  visualization,
}: {
  baseline: {
    overrides: VisualizationStateResource["overrides"];
    targets: readonly AppliedVisualizationBaselineTarget[];
  };
  currentOverrides: VisualizationStateResource["overrides"];
  queuePatch: (
    patch: VisualizationStatePatch,
    targetIds?: readonly string[],
  ) => void;
  visualization: Pick<
    ObjectVisualizationController,
    "clearTarget" | "patchTarget" | "patchViewportPreferences"
  >;
}): void {
  const baselineTargets = baseline.targets.map((entry) => entry.target);
  const retainedOverrides = currentOverrides.filter(
    (entry) =>
      !baselineTargets.some((baselineTarget) =>
        visualizationStateOverrideMatchesTarget(entry, baselineTarget),
      ),
  );
  queuePatch(
    {
      overrides: [...retainedOverrides, ...structuredClone(baseline.overrides)],
    },
    baseline.targets.map(({ target }) => visualizationTargetKey(target)),
  );

  for (const { preferences, target } of baseline.targets) {
    visualization.clearTarget(target);
    if (preferences) {
      visualization.patchViewportPreferences(target, preferences);
    }
  }
}

export function visualizationOverridesForTargetReset(
  currentState: Pick<VisualizationStateResource, "overrides">,
  target: VisualizationTargetRef,
): VisualizationStateResource["overrides"] {
  if (target.kind === "airbox") {
    return resetAirboxVisualizationState(currentState).overrides ?? [];
  }
  return (currentState.overrides ?? []).filter(
    (entry) => !visualizationStateOverrideMatchesTarget(entry, target),
  );
}

export const SURFACE_COLOR_SOURCE_ITEMS: Array<{
  label: string;
  value: SurfaceColorSource;
}> = [
  { value: "solid", label: "Solid (plain material)" },
  { value: "orientation", label: "HSL orientation" },
  { value: "component_x", label: "Component X" },
  { value: "component_y", label: "Component Y" },
  { value: "component_z", label: "Component Z" },
  { value: "magnitude", label: "Magnitude |m|" },
  { value: "colormap", label: "Colormap" },
];

export const SCALAR_COLOR_PALETTE_ITEMS: Array<{
  label: string;
  value: string;
}> = [
  { value: "viridis", label: "Viridis" },
  { value: "inferno", label: "Inferno" },
  { value: "magma", label: "Magma" },
  { value: "coolwarm", label: "Coolwarm" },
  { value: "jet", label: "Jet" },
];

export const SURFACE_FIELD_PROJECTION_ITEMS: Array<{
  label: string;
  value: SurfaceFieldProjectionMode;
}> = [
  { value: "raw_nodal", label: "Raw nodal" },
  { value: "surface_faces", label: "Surface faces" },
  { value: "thickness_average_z", label: "Thickness average Z" },
];

export function resolveSurfaceColorSourceItems(
  activeQuantityId: string,
): Array<{ label: string; value: SurfaceColorSource }> {
  return isScalarSpatialQuantityId(resolveCanonicalQuantityId(activeQuantityId))
    ? SURFACE_COLOR_SOURCE_ITEMS.filter((item) => item.value === "colormap")
    : SURFACE_COLOR_SOURCE_ITEMS;
}

export function normalizeScalarColorPalette(
  value: string | null | undefined,
): string {
  const candidate = typeof value === "string" ? value : "";
  return SCALAR_COLOR_PALETTE_ITEMS.some((item) => item.value === candidate)
    ? candidate
    : "viridis";
}

export function scalarColorPalettePatch(
  value: string,
): VisualizationTargetPatch {
  return {
    scalarColorPalette: normalizeScalarColorPalette(value),
  };
}

export function surfaceFieldProjectionModePatch(
  value: string,
): VisualizationTargetPatch {
  const mode = SURFACE_FIELD_PROJECTION_ITEMS.some((item) => item.value === value)
    ? (value as SurfaceFieldProjectionMode)
    : "raw_nodal";
  return {
    surfaceProjectionMode: mode,
  };
}

export function scalarColorPaletteGradientCss(
  value: string | null | undefined,
): string {
  const stops = SCALAR_COLOR_PALETTE_STOPS[normalizeScalarColorPalette(value)];
  return `linear-gradient(90deg, ${stops
    .map(
      ([red, green, blue]) =>
        `rgb(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)})`,
    )
    .join(", ")})`;
}

export function formatScalarColorbarValue(value: number): string {
  return formatDisplayUnitValue(value);
}

export function formatScalarColorbarValueWithUnit(
  value: number,
  unit: string | null | undefined,
): string {
  return formatValueWithUnit(value, unit);
}

export type ScalarColorbarDisplayUnit = string;

export function scalarColorbarDisplayUnitItems(
  unit: string | null | undefined,
): Array<{ label: string; value: ScalarColorbarDisplayUnit }> {
  return displayUnitItemsForSourceUnit(unit);
}

export function scalarColorbarSupportsDisplayUnits(
  unit: string | null | undefined,
): boolean {
  return hasDisplayUnitOptions(unit);
}

export function formatScalarColorbarValueWithDisplayUnit(
  value: number,
  sourceUnit: string | null | undefined,
  displayUnit: ScalarColorbarDisplayUnit,
): string {
  return formatValueWithDisplayUnit(value, sourceUnit, displayUnit);
}

export function surfaceColorSourceFieldMetaComponent(
  surfaceColorSource: SurfaceColorSource,
  activeQuantityId: string,
): string | null | undefined {
  if (isAnalysisFieldQuantityId(activeQuantityId)) return undefined;
  switch (surfaceColorSource) {
    case "component_x":
      return "x";
    case "component_y":
      return "y";
    case "component_z":
      return "z";
    case "magnitude":
      return "magnitude";
    case "colormap":
      return isScalarSpatialQuantityId(resolveCanonicalQuantityId(activeQuantityId))
        ? null
        : "magnitude";
    case "orientation":
    case "solid":
      return undefined;
  }
}

export function shouldShowSurfaceFieldColorbar(
  surfaceColorSource: SurfaceColorSource,
  activeQuantityId: string,
): boolean {
  return (
    surfaceColorSourceFieldMetaComponent(surfaceColorSource, activeQuantityId) !==
    undefined
  );
}

export function vectorColorModeFieldMetaComponent(
  vectorColorMode: VisualizationColorMode,
  activeQuantityId: string,
): "magnitude" | "x" | "y" | "z" | undefined {
  if (isAnalysisFieldQuantityId(activeQuantityId)) return undefined;
  switch (vectorColorMode) {
    case "x":
    case "y":
    case "z":
    case "magnitude":
      return vectorColorMode;
    case "orientation":
    case "monochrome":
      return undefined;
  }
}

export function shouldShowVectorFieldColorbar(
  vectorColorMode: VisualizationColorMode,
  activeQuantityId: string,
): boolean {
  return (
    vectorColorModeFieldMetaComponent(vectorColorMode, activeQuantityId) !==
    undefined
  );
}

export function fieldMetaScopeQueryForVisualizationTarget(
  target: VisualizationTargetRef | null | undefined,
  carrier?: RegionVisualizationCarrier | null,
  airboxFieldCarrierIdentity?: VisualizationVectorScopeIdentity | null,
): Pick<FieldMetaQuery, "owner_object_id" | "scope_id" | "scope_kind"> {
  switch (target?.kind) {
    case "object":
      return {
        scope_id: target.id.startsWith("object:")
          ? target.id.slice("object:".length)
          : target.id,
        scope_kind: "object",
      };
    case "part":
      return { scope_id: target.id, scope_kind: "part" };
    case "airbox":
      return {
        scope_id: airboxFieldCarrierIdentity?.scopeId ?? null,
        scope_kind: "airbox",
      };
    case "fdm-domain":
      // FDM-domain is a viewport-local structured-grid target.  It has no
      // FEM VisualizationState scope and must never be serialized as one.
      return { scope_id: null, scope_kind: null };
    case "fdm-native-layer": {
      const encodedLayerId = target.id.startsWith("fdm-native-layer:")
        ? target.id.slice("fdm-native-layer:".length)
        : "";
      let layerId = encodedLayerId;
      try {
        layerId = decodeURIComponent(encodedLayerId);
      } catch {
        // Keep the opaque target suffix when it is not valid URI encoding.
      }
      return {
        scope_id: layerId || null,
        scope_kind: layerId ? "layer" : null,
      };
    }
    case "region":
      if (carrier?.kind === "membership") {
        return {
          owner_object_id: carrier.objectId,
          scope_id: carrier.regionId,
          scope_kind: "region",
        };
      }
      if (carrier?.kind === "mesh-parts" && carrier.partIds.length === 1) {
        return { scope_id: carrier.partIds[0] ?? null, scope_kind: "part" };
      }
      return { scope_id: null, scope_kind: null };
    case undefined:
      return { scope_id: null, scope_kind: null };
  }
}

/**
 * Build the target-scoped availability query used by the Inspector. The
 * scope ids intentionally match the data-plane field requests: visualization
 * target prefixes are UI identities, not backend carrier ids.
 */
export function fieldAvailabilityQueryForVisualizationTarget(
  target: VisualizationTargetRef | null | undefined,
  airboxFieldCarrierIdentity?: VisualizationVectorScopeIdentity | null,
): FieldAvailabilityQuery {
  if (!target) {
    return {
      owner_object_id: null,
      scope_id: null,
      scope_kind: null,
      target_id: null,
    };
  }

  switch (target.kind) {
    case "airbox":
      return {
        owner_object_id: null,
        scope_id: airboxFieldCarrierIdentity?.scopeId ?? null,
        scope_kind: "airbox",
        target_id: target.id,
      };
    case "fdm-domain":
      return {
        owner_object_id: null,
        scope_id: null,
        scope_kind: "full",
        target_id: target.id,
      };
    case "object":
      return {
        owner_object_id: null,
        scope_id: target.id.startsWith("object:")
          ? target.id.slice("object:".length)
          : target.id,
        scope_kind: "object",
        target_id: target.id,
      };
    case "part":
      return {
        owner_object_id: null,
        scope_id: target.id.startsWith("part:")
          ? target.id.slice("part:".length)
          : target.id,
        scope_kind: "part",
        target_id: target.id,
      };
    case "fdm-native-layer": {
      const encodedLayerId = target.id.startsWith("fdm-native-layer:")
        ? target.id.slice("fdm-native-layer:".length)
        : "";
      return {
        owner_object_id: null,
        scope_id: encodedLayerId ? decodeSafe(encodedLayerId) : null,
        scope_kind: encodedLayerId ? "layer" : null,
        target_id: target.id,
      };
    }
    case "region": {
      const parsed = parseRegionVisualizationTargetId(target.id);
      return {
        owner_object_id: parsed?.objectId ?? null,
        scope_id: parsed?.regionId ?? null,
        scope_kind: parsed ? "region" : null,
        target_id: target.id,
      };
    }
  }
}

export interface VisualizationVectorScopeIdentity {
  scopeId: string | null;
  scopeKind: string | null;
}

/**
 * Return only scope identities that are unambiguous for the vector carrier.
 * FEM object/region targets may aggregate several mesh-part carriers, so they
 * intentionally remain unconstrained here.
 */
export function resolveVisualizationVectorScopeForTarget(
  target: VisualizationTargetRef | null | undefined,
  airboxFieldCarrierIdentity?: VisualizationVectorScopeIdentity | null,
): VisualizationVectorScopeIdentity {
  switch (target?.kind) {
    case "airbox":
      return airboxFieldCarrierIdentity ?? { scopeId: null, scopeKind: "airbox" };
    case "fdm-domain":
      return {
        scopeId: null,
        scopeKind: isFdmUniverseOutsideSupportTarget(target) ? "airbox" : "full",
      };
    case "fdm-native-layer": {
      const encodedLayerId = target.id.startsWith("fdm-native-layer:")
        ? target.id.slice("fdm-native-layer:".length)
        : "";
      return {
        scopeId: encodedLayerId ? decodeSafe(encodedLayerId) : null,
        scopeKind: encodedLayerId ? "layer" : null,
      };
    }
    default:
      return { scopeId: null, scopeKind: null };
  }
}

/**
 * FDM visualization is backed by the structured-grid contract, not the FEM
 * shared-domain manifest. Keep this predicate at the panel boundary so a
 * missing/empty manifest can never be mistaken for an FDM resource state.
 */
export function isFdmVisualizationTarget(
  target: VisualizationTargetRef | null | undefined,
): boolean {
  return target?.kind === "fdm-domain" || target?.kind === "fdm-native-layer";
}

export type ObjectVisualizationLane = "fdm" | "fem" | "unresolved";

export function resolveAirboxFieldCarrierIdentity({
  airboxPartIds,
  lane,
}: {
  airboxPartIds: readonly string[];
  lane: ObjectVisualizationLane;
}): VisualizationVectorScopeIdentity | null {
  if (lane === "fdm") {
    return { scopeId: "airbox", scopeKind: "airbox" };
  }
  if (lane !== "fem") return null;
  const uniquePartIds = Array.from(new Set(airboxPartIds.filter(Boolean)));
  const canonicalPartId = uniquePartIds.find((partId) => partId === "part:__air__");
  if (canonicalPartId) {
    return { scopeId: canonicalPartId, scopeKind: "airbox" };
  }
  return uniquePartIds.length === 1 && uniquePartIds[0]
    ? { scopeId: uniquePartIds[0], scopeKind: "airbox" }
    : null;
}

export function resolveObjectVisualizationLane(
  discretization: string | null | undefined,
): ObjectVisualizationLane {
  const normalized = discretization?.trim().toLowerCase();
  if (normalized === "fdm") return "fdm";
  if (normalized === "fem") return "fem";
  return "unresolved";
}

/**
 * Resolve the actual visualization target only after the session lane is
 * explicit. This prevents the initial status-loading render from treating a
 * structured-grid selection as a FEM scene object.
 */
export function resolveObjectVisualizationTargetForLane({
  fdmNativeLayers,
  lane,
  selection,
  selectionTarget,
}: {
  fdmNativeLayers?: readonly {
    layer_id: string;
    magnet_name: string;
    object_id: string;
  }[] | null;
  lane: ObjectVisualizationLane;
  selection: Selection;
  selectionTarget: VisualizationTargetRef | null;
}): VisualizationTargetRef | null {
  if (lane === "unresolved") return null;
  if (selection.ref?.type === "fdm-cell") {
    return lane === "fdm"
      ? { id: "fdm-domain", kind: "fdm-domain", label: selection.label }
      : null;
  }
  if (
    lane === "fdm" &&
    selection.ref?.type === "fdm-domain" &&
    selection.ref.scope === "region"
  ) {
    return selectionTarget?.kind === "region" ? selectionTarget : null;
  }
  if (
    lane === "fdm" &&
    selection.ref?.type === "fdm-domain" &&
    selection.ref.scope === "layer"
  ) {
    return selectionTarget?.kind === "fdm-native-layer"
      ? selectionTarget
      : null;
  }
  if (lane === "fem") {
    return selectionTarget?.kind === "fdm-domain" ? null : selectionTarget;
  }

  const objectVisualizationSelection =
    selection.kind === "object.visualization" ||
    selection.kind === "object.visualization.debug" ||
    selection.kind === "object.region.visualization" ||
    selection.kind === "object.region.visualization.debug";
  if (objectVisualizationSelection) {
    if (lane === "fdm" && selection.objectId) {
      const nativeLayer = fdmNativeLayers?.find(
        (layer) => layer.object_id === selection.objectId,
      );
      if (nativeLayer) {
        return targetForFdmNativeLayer(
          nativeLayer.layer_id,
          nativeLayer.magnet_name,
        );
      }
    }
    return selectionTarget?.kind === "fdm-domain" ? null : selectionTarget;
  }

  const publicAirboxVisualizationSelection =
    selection.kind === "airbox.visualization" ||
    selection.kind === "airbox.visualization.debug";
  if (publicAirboxVisualizationSelection) {
    return selectionTarget?.kind === "airbox" ? selectionTarget : null;
  }
  if (selection.kind !== "mesh.grid.universe-outside-support") return null;
  return selectionTarget?.kind === "airbox" ? selectionTarget : null;
}

export function resolveObjectVisualizationResourceGates({
  lane,
  target,
}: {
  lane: ObjectVisualizationLane;
  target: VisualizationTargetRef | null;
}): { fdm: boolean; fem: boolean } {
  return {
    fdm: lane === "fdm" && target !== null,
    fem:
      lane === "fem" &&
      target !== null &&
      target.kind !== "fdm-domain" &&
      target.kind !== "fdm-native-layer",
  };
}

export function isVisualizationBaselineReady({
  target,
  visualizationState,
  visualizationStateEnabled,
}: {
  target: VisualizationTargetRef | null | undefined;
  visualizationState: VisualizationStateResource | null | undefined;
  visualizationStateEnabled: boolean;
}): boolean {
  return Boolean(target) && (!visualizationStateEnabled || visualizationState != null);
}

export function canonicalVisualizationStateForBaseline(
  canonicalData: VisualizationStateResource | null | undefined,
  optimisticData: VisualizationStateResource | null | undefined,
): VisualizationStateResource | null | undefined {
  void optimisticData;
  return canonicalData;
}

export function fdmGridCellCount(
  domain: DomainMetaResource | null | undefined,
): number | null {
  if (domain?.discretization.toLowerCase() !== "fdm") return null;
  const shape = domain.grid?.shape;
  if (!shape || shape.length < 3) return null;
  const counts = shape.slice(0, 3);
  if (
    counts.some(
      (value) => !Number.isInteger(value) || value < 0,
    )
  ) {
    return null;
  }
  const cellCount = counts.reduce((total, value) => total * value, 1);
  return Number.isSafeInteger(cellCount) ? cellCount : null;
}

/** Return a bounded, explicit resource state for the FDM visualization panel. */
export function fdmVisualizationResourceNotice({
  domain,
  domainError,
  domainStatus,
  membership,
  membershipError,
  membershipStatus,
  membershipBinaryReason,
  membershipBinaryStatus,
}: {
  domain: DomainMetaResource | null | undefined;
  domainError?: Error | null;
  domainStatus: string;
  membership: FdmRegionMembershipResource | null | undefined;
  membershipError?: Error | null;
  membershipStatus: string;
  membershipBinaryReason?: string | null;
  membershipBinaryStatus?: string | null;
}): string | null {
  if (domainError || domainStatus === "error") {
    return `FDM grid descriptor could not be loaded${domainError?.message ? `: ${domainError.message}` : "."}`;
  }
  if (!domain) {
    return domainStatus === "loading"
      ? "Loading the FDM structured-grid descriptor."
      : "FDM DomainMeta is not materialized; grid rendering is unavailable.";
  }
  if (domain.discretization.toLowerCase() !== "fdm") {
    return "The selected visualization target is FDM-only, but the current domain is not FDM.";
  }
  if (!domain.grid) {
    return "FDM DomainMeta has no structured-grid descriptor.";
  }
  if (membershipError || membershipStatus === "error") {
    return `FDM cell membership could not be loaded${membershipError?.message ? `: ${membershipError.message}` : ". Grid geometry remains available."}`;
  }
  if (membershipStatus === "loading") {
    return "Loading FDM cell membership; field overlays remain revision-gated.";
  }
  if (!membership) {
    return "FDM grid geometry is available; cell membership/field overlays are not materialized.";
  }
  if (membership.freshness.toLowerCase() !== "current") {
    return "FDM cell membership is stale; grid geometry remains visible, but mask-dependent overlays are unavailable.";
  }
  const expectedCellCount = fdmGridCellCount(domain);
  if (
    expectedCellCount !== null &&
    membership.cell_count !== expectedCellCount
  ) {
    return "FDM cell membership does not match the current structured-grid descriptor.";
  }
  if (membershipBinaryStatus && membershipBinaryStatus !== "ready") {
    if (membershipBinaryReason === "request-error") {
      return "FDM membership mask could not be loaded; shaded, wireframe, and vector rendering remain unavailable.";
    }
    if (membershipBinaryReason === "not-materialized") {
      return "FDM membership mask is not materialized; re-plan or run the study to publish it before rendering fields.";
    }
    return "FDM membership mask is not ready for this grid; re-plan or run the study before rendering fields.";
  }
  return null;
}

export function resolveObjectVisualizationPanelTarget({
  part,
  sceneObjectIds,
  visualizationState,
}: {
  part: NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number];
  sceneObjectIds: ReadonlySet<string>;
  visualizationState: VisualizationStateResource | null | undefined;
}): VisualizationTargetRef {
  return resolveVisualizationTargetForMeshPart({
    part,
    sceneObjectIds,
    targetRegistry: visualizationState?.targets,
  });
}

export function queuePartVectorVisibilityPatch({
  controller,
  part,
  sceneObjectIds,
  state,
  sync,
  visible,
}: {
  controller: Pick<ObjectVisualizationController, "patchTargetPending">;
  part: NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number];
  sceneObjectIds: ReadonlySet<string>;
  state: VisualizationStateResource;
  sync: Pick<
    { queuePatch: (patch: VisualizationStatePatch) => { transactionId: string } },
    "queuePatch"
  >;
  visible: boolean;
}): VisualizationTargetRef {
  const target = resolveObjectVisualizationPanelTarget({
    part,
    sceneObjectIds,
    visualizationState: state,
  });
  return queueTargetVectorVisibilityPatch({
    controller,
    state,
    sync,
    target,
    visible,
  });
}

export function queueTargetVectorVisibilityPatch({
  controller,
  state,
  sync,
  target,
  visible,
}: {
  controller: Pick<ObjectVisualizationController, "patchTargetPending">;
  state: VisualizationStateResource;
  sync: Pick<
    { queuePatch: (patch: VisualizationStatePatch) => { transactionId: string } },
    "queuePatch"
  >;
  target: VisualizationTargetRef;
  visible: boolean;
}): VisualizationTargetRef {
  const patch = { vectorsVisible: visible } satisfies VisualizationTargetPatch;
  const receipt = sync.queuePatch({
    overrides: mergeVisualizationStateTargetOverride(
      state.overrides ?? [],
      target,
      patch,
    ),
  });
  controller.patchTargetPending(target, patch, state.revision, receipt.transactionId);
  return target;
}

export function resolveSelectedTargetVectorMeshParts({
  manifestRegions,
  meshParts,
  sceneObjectIds,
  target,
  visualizationState,
}: {
  manifestRegions: readonly MeshRegion[] | null | undefined;
  meshParts?: readonly MeshPart[] | null | undefined;
  sceneObjectIds: ReadonlySet<string>;
  target: VisualizationTargetRef | null | undefined;
  visualizationState: VisualizationStateResource | null | undefined;
}): MeshPart[] {
  if (!target || !meshParts?.length) return [];
  if (isFdmVisualizationTarget(target)) return [];

  if (target.kind === "airbox") {
    return meshParts.filter(isVisualizationAirboxIdentity);
  }

  if (target.kind === "region") {
    const carrier = resolveRegionVisualizationCarrier({
      manifestRegions,
      target,
    });
    if (carrier?.kind !== "mesh-parts") return [];
    const carrierIds = new Set(carrier.partIds);
    return meshParts.filter((part) => carrierIds.has(part.id));
  }

  return meshParts.filter((part) => {
    if (isVisualizationAirboxIdentity(part)) return false;
    const partTarget = resolveObjectVisualizationPanelTarget({
      part,
      sceneObjectIds,
      visualizationState,
    });
    return partTarget.kind === target.kind && partTarget.id === target.id;
  });
}

export function visualizationVectorSurfaceActionTargetLabel(
  target: VisualizationTargetRef,
): string {
  return `Target: ${target.id}`;
}

export function resolveSelectedTargetVectorMeshPartRows(input: {
  manifestRegions: readonly MeshRegion[] | null | undefined;
  meshParts?: readonly MeshPart[] | null | undefined;
  sceneObjectIds: ReadonlySet<string>;
  target: VisualizationTargetRef | null | undefined;
  visualizationState: VisualizationStateResource | null | undefined;
}): Array<{ actionTargetLabel: string; id: string; label: string }> {
  if (!input.target) return [];
  const actionTargetLabel = visualizationVectorSurfaceActionTargetLabel(input.target);
  return resolveSelectedTargetVectorMeshParts(input).map((part) => ({
    actionTargetLabel,
    id: part.id,
    label: input.target?.kind === "airbox" ? "Airbox" : part.label,
  }));
}

export function resolveObjectVisualizationPanelSelectionTarget({
  sceneObjectIds,
  selectedMeshPart,
  selection,
  selectionTarget,
  visualizationState,
}: {
  sceneObjectIds: ReadonlySet<string>;
  selectedMeshPart:
    | NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number]
    | null;
  selection: Selection;
  selectionTarget: VisualizationTargetRef | null;
  visualizationState: VisualizationStateResource | null | undefined;
}): VisualizationTargetRef | null {
  if (selection.ref?.type !== "mesh-part") return selectionTarget;
  if (selectedMeshPart) {
    return resolveObjectVisualizationPanelTarget({
      part: selectedMeshPart,
      sceneObjectIds,
      visualizationState,
    });
  }
  return {
    id: selection.ref.carrierPartId
      ? selection.ref.visualizationTargetId
      : selection.ref.nodeId,
    kind: "part",
    label: selection.label,
  };
}

const SCALAR_COLOR_PALETTE_STOPS: Record<string, [number, number, number][]> = {
  coolwarm: [
    [0x3b / 255, 0x4c / 255, 0xc0 / 255],
    [0xdd / 255, 0xdd / 255, 0xdd / 255],
    [0xb4 / 255, 0x04 / 255, 0x26 / 255],
  ],
  inferno: [
    [0x00 / 255, 0x00 / 255, 0x04 / 255],
    [0x42 / 255, 0x0a / 255, 0x68 / 255],
    [0x93 / 255, 0x2b / 255, 0x5d / 255],
    [0xdd / 255, 0x51 / 255, 0x3a / 255],
    [0xfc / 255, 0xff / 255, 0xa4 / 255],
  ],
  jet: [
    [0x00 / 255, 0x00 / 255, 0x7f / 255],
    [0x00 / 255, 0x7f / 255, 0xff / 255],
    [0x7f / 255, 0xff / 255, 0x7f / 255],
    [0xff / 255, 0x7f / 255, 0x00 / 255],
    [0x7f / 255, 0x00 / 255, 0x00 / 255],
  ],
  magma: [
    [0x00 / 255, 0x00 / 255, 0x04 / 255],
    [0x3b / 255, 0x0f / 255, 0x70 / 255],
    [0x8c / 255, 0x29 / 255, 0x80 / 255],
    [0xde / 255, 0x49 / 255, 0x68 / 255],
    [0xfc / 255, 0xfd / 255, 0xbf / 255],
  ],
  viridis: [
    [0x44 / 255, 0x01 / 255, 0x54 / 255],
    [0x31 / 255, 0x68 / 255, 0x8e / 255],
    [0x35 / 255, 0xb7 / 255, 0x79 / 255],
    [0xfd / 255, 0xe7 / 255, 0x25 / 255],
  ],
};

export function resolveObjectVisualizationPanelTopologyFreshness({
  manifest,
  scene,
  targetObjectId,
  targetKind,
}: {
  manifest: unknown;
  scene: unknown;
  targetObjectId?: string | null;
  targetKind: VisualizationTargetKind;
}): VisualizationTopologyFreshness | null {
  if (targetKind === "fdm-domain" || targetKind === "fdm-native-layer") {
    return null;
  }
  return scene && manifest
    ? resolveVisualizationTopologyFreshness(scene, manifest, { targetObjectId })
    : null;
}

export function shouldShowPrimitiveDisplayToggle(
  activeModuleTab: string | null | undefined,
  targetKind: VisualizationTargetKind,
  topologyFreshness: VisualizationTopologyFreshness | null,
): boolean {
  return (
    activeModuleTab === "geometry" &&
    targetKind === "object" &&
    topologyFreshness !== "current"
  );
}

export const VISUALIZATION_COLOR_MODE_ITEMS: Array<{
  label: string;
  value: VisualizationColorMode;
}> = [
  { value: "orientation", label: "HSL orientation" },
  { value: "x", label: "X component" },
  { value: "y", label: "Y component" },
  { value: "z", label: "Z component" },
  { value: "magnitude", label: "Magnitude" },
  { value: "monochrome", label: "Monochrome" },
];

type MeshPart = NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number];
type MeshRegion = NonNullable<MeshSharedDomainManifestResource["regions"]>[number];

export type RegionVisualizationCarrier =
  | {
      kind: "mesh-parts";
      objectId: string;
      partIds: readonly string[];
      regionId: string;
    }
  | {
      kind: "membership";
      objectId: string;
      syntheticPartId: string;
      regionId: string;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

export function regionVisualizationFieldWarning(
  carrier: RegionVisualizationCarrier | null | undefined,
): string | null {
  if (!carrier) return null;
  if (carrier.kind === "unavailable") {
    return `Physical field coloring for this region is unavailable: ${carrier.reason}. Region overlays are diagnostic and remain separate from field visualization.`;
  }
  if (carrier.kind === "membership") {
    return "Physical field coloring for this region is unavailable: region memberships are diagnostic until the runtime exposes a field-capable mesh-part carrier.";
  }
  if (carrier.partIds.length !== 1) {
    return "Scoped colorbar statistics for this region require exactly one mesh-part carrier. Field rendering can still use the region mesh parts, but range metadata is disabled for this target.";
  }
  return null;
}

export function regionVisualizationCarrierSupportsFieldMeta(
  carrier: RegionVisualizationCarrier | null | undefined,
): boolean {
  return carrier?.kind === "mesh-parts" && carrier.partIds.length === 1;
}

export function visualizationOverrideStateLabel({
  hasOverride,
  targetKind,
}: {
  hasOverride: boolean;
  targetKind: VisualizationTargetKind;
}): string {
  if (targetKind === "region") {
    return hasOverride ? "Overridden locally" : "Inherited from parent";
  }
  return hasOverride ? "Overridden" : "Default";
}

export function visualizationResetActionLabel(
  targetKind: VisualizationTargetKind,
): string {
  return targetKind === "region" ? "Reset to parent" : "Reset display";
}

export interface VisualizationVectorBudgetRange {
  availableNodeCount: number;
  availableAnchorCount?: number | null;
  anchorKind?: "cell" | "node" | null;
  carrierId?: string | null;
  exact: boolean;
  generation?: string | null;
  max: number | null;
  min: 0;
  revision?: string | number | null;
  step: 1;
  topologyHash?: string | null;
}

export interface VisualizationVectorBudgetValues {
  effective: number | null;
  max: number | null;
  normalizedRequested: number;
  policyCap: number;
  requested: number;
}

export type VisualizationTargetMutationState =
  | "acknowledged"
  | "idle"
  | "inflight"
  | "queued"
  | "rejected"
  | "retrying";

export interface VisualizationTargetMutationStatus {
  error: string | null;
  pending: boolean;
  retryable: boolean;
  state: VisualizationTargetMutationState;
}

/**
 * Last-good Inspector content is valid only for one rendered carrier.  A
 * transient resource refresh may reuse it; a session, topology, or carrier
 * transition must render the normal unavailable/loading state instead.
 */
export function resolveVisualizationPanelIdentityKey({
  carrierFingerprint,
  sessionIdentityKey,
  targetId,
  topologyHash,
}: {
  carrierFingerprint: string | null | undefined;
  sessionIdentityKey: string | null | undefined;
  targetId: string | null | undefined;
  topologyHash: string | null | undefined;
}): string | null {
  if (
    !carrierFingerprint ||
    !sessionIdentityKey ||
    !targetId ||
    !topologyHash
  ) {
    return null;
  }
  return [targetId, sessionIdentityKey, topologyHash, carrierFingerprint].join("\u0000");
}

/** Pending controls are independently addressable even when a PATCH batches fields. */
export function resolvePendingVisualizationFieldKeys({
  patch,
  targetId,
  transactionId,
}: {
  patch: VisualizationTargetPatch;
  targetId: string;
  transactionId: string;
}): ReadonlySet<string> {
  return new Set(
    Object.keys(patch).map(
      (fieldName) => `${targetId}\u0000${fieldName}\u0000${transactionId}`,
    ),
  );
}

interface VisualizationTargetMutationSnapshot {
  error?: Error | null;
  inflightTargetIds?: readonly string[];
  mutation?: {
    attempts?: number;
    error: string | null;
    requestId?: string | null;
    status: "inflight" | "rejected" | "retrying" | "succeeded";
    targetId: string;
  } | null;
  pendingTargetIds?: readonly string[];
  rejectedTargetIds?: readonly string[];
}

export function resolvePendingVisualizationFields({
  snapshot,
  targetIds,
}: {
  snapshot: Pick<ObjectVisualizationSnapshot, "pendingOverrides">;
  targetIds: readonly string[];
}): ReadonlySet<keyof VisualizationTargetPatch> {
  const fields = new Set<keyof VisualizationTargetPatch>();
  for (const targetId of targetIds) {
    const pending = snapshot.pendingOverrides?.[targetId];
    if (!pending) continue;
    for (const fieldName of Object.keys(pending.patch) as Array<
      keyof VisualizationStoredTargetPatch
    >) {
      const transactionId =
        pending.fieldTransactionIds?.[fieldName] ?? pending.transactionId;
      if (!transactionId) continue;
      for (const key of resolvePendingVisualizationFieldKeys({
        patch: { [fieldName]: pending.patch[fieldName] },
        targetId,
        transactionId,
      })) {
        const [, field] = key.split("\u0000");
        if (field) fields.add(field as keyof VisualizationTargetPatch);
      }
    }
  }
  return fields;
}

export function resolveVisualizationTargetMutationStatus({
  snapshot,
  targetIds,
}: {
  snapshot: VisualizationTargetMutationSnapshot;
  targetIds: readonly string[];
}): VisualizationTargetMutationStatus {
  const targetSet = new Set(targetIds);
  const intersects = (candidateIds: readonly string[] | undefined) =>
    (candidateIds ?? []).some((targetId) => targetSet.has(targetId));
  const mutation = snapshot.mutation;
  const mutationTargets = mutation && targetSet.has(mutation.targetId);
  const error = mutation?.error ?? snapshot.error?.message ?? null;

  if (intersects(snapshot.inflightTargetIds)) {
    const state = mutation?.status === "retrying" ? "retrying" : "inflight";
    return { error, pending: true, retryable: false, state };
  }
  if (intersects(snapshot.pendingTargetIds)) {
    return { error, pending: true, retryable: false, state: "queued" };
  }
  if (
    intersects(snapshot.rejectedTargetIds) ||
    (mutationTargets && mutation?.status === "rejected")
  ) {
    return { error, pending: false, retryable: true, state: "rejected" };
  }
  if (mutationTargets && mutation?.status === "succeeded") {
    return { error: null, pending: false, retryable: false, state: "acknowledged" };
  }
  return { error: null, pending: false, retryable: false, state: "idle" };
}

export interface VisualizationVectorAccounting {
  adoptedGlyphCount: number | null;
  allocatedBudget?: number | null;
  anchorKind?: "cell" | "node" | null;
  availableAnchorCount?: number | null;
  availableNodeCount: number | null;
  decodedSampleCount: number | null;
  requestedBudget?: number | null;
  status?: "ready" | "pending" | "stale" | "unavailable";
}

export function resolveVisualizationVectorAccounting({
  anchorKind,
  availableAnchorCount,
  availableNodeCount,
  capacity,
  currentComponent,
  currentGeneration,
  currentScopeId,
  currentScopeKind,
  currentTargetId,
  currentTopologyHash,
  currentVisualizationRevision,
  currentVectorBuildKey,
  expectedGeneration,
  expectedQuantityId,
  expectedScopeId,
  expectedScopeKind,
  expectedVisualizationRevision,
  expectedVectorBuildKey,
  effectiveAllocation,
  requestedBudget,
  snapshots,
}: {
  anchorKind?: "cell" | "node" | null;
  availableAnchorCount?: number | null;
  availableNodeCount?: number | null;
  capacity?: VisualizationVectorCapacityDescriptor | null;
  currentComponent?: string | null;
  currentGeneration?: string | null;
  currentScopeId?: string | null;
  currentScopeKind?: string | null;
  currentTargetId?: string | null;
  currentTopologyHash?: string | null;
  currentVisualizationRevision?: string | number | null;
  currentVectorBuildKey?: string | null;
  expectedGeneration?: string | null;
  expectedQuantityId?: string | null;
  expectedScopeId?: string | null;
  expectedScopeKind?: string | null;
  expectedVisualizationRevision?: string | number | null;
  expectedVectorBuildKey?: string | null;
  effectiveAllocation?: number | null;
  requestedBudget?: number | null;
  snapshots: readonly VisualizationDebugSnapshot[];
}): VisualizationVectorAccounting {
  if (
    capacity !== undefined ||
    availableAnchorCount !== undefined ||
    requestedBudget !== undefined ||
    effectiveAllocation !== undefined ||
    currentTargetId !== undefined
  ) {
    const resolvedTargetId = currentTargetId ?? capacity?.targetId;
    const resolvedTopologyHash = currentTopologyHash ?? capacity?.topologyHash;
    const resolvedGeneration = currentGeneration ?? capacity?.generation;
    const resolvedAvailableAnchorCount =
      availableAnchorCount !== undefined
        ? availableAnchorCount
        : capacity?.exact
          ? capacity.fullCount
          : null;
    return resolveTargetVisualizationVectorAccounting({
      anchorKind: capacity?.anchorKind ?? anchorKind ?? null,
      availableAnchorCount: resolvedAvailableAnchorCount,
      currentComponent,
      currentGeneration: resolvedGeneration,
      currentScopeId,
      currentScopeKind,
      currentTargetId: resolvedTargetId,
      currentTopologyHash: resolvedTopologyHash,
      currentVisualizationRevision,
      currentVectorBuildKey,
      expectedGeneration,
      expectedQuantityId,
      expectedScopeId,
      expectedScopeKind,
      expectedVisualizationRevision,
      expectedVectorBuildKey,
      expectedCapacityRevision: capacity?.revision,
      effectiveAllocation,
      requestedBudget,
      snapshots,
    });
  }

  const available = normalizeVectorCount(availableNodeCount);
  const snapshot = [...snapshots].sort(
    (left, right) => right.capturedAtMs - left.capturedAtMs,
  )[0];
  if (
    !snapshot ||
    available === null ||
    snapshot.disposition === "blocked"
  ) {
    return {
      adoptedGlyphCount: null,
      availableNodeCount: available,
      decodedSampleCount: null,
    };
  }

  let adoptedGlyphCount = 0;
  let decodedSampleCount = 0;
  let adoptedComplete = snapshot.carriers.length > 0;
  let decodedComplete = snapshot.carriers.length > 0;
  for (const carrier of snapshot.carriers) {
    const topologyMatches =
      !currentTopologyHash ||
      carrier.revisions.meshTopologyHash === currentTopologyHash;
    const payload = topologyMatches ? carrier.payload : null;
    if (!payload) decodedComplete = false;
    else decodedSampleCount += payload.pointCount;

    const adoption = carrier.render.adoption.vector;
    const adoptionMatches = Boolean(
      topologyMatches &&
        adoption.adoptedVectorItemCount != null &&
        carrier.render.requestedFieldBufferId &&
        carrier.request.resourceKey &&
        carrier.render.vectors.buildKey &&
        adoption.adoptedFieldBufferId === carrier.render.requestedFieldBufferId &&
        adoption.adoptedResourceKey === carrier.request.resourceKey &&
        adoption.adoptedVectorBuildKey === carrier.render.vectors.buildKey,
    );
    if (!adoptionMatches) adoptedComplete = false;
    else adoptedGlyphCount += adoption.adoptedVectorItemCount ?? 0;
  }

  if (decodedComplete && decodedSampleCount > available) {
    decodedComplete = false;
    adoptedComplete = false;
  }
  return {
    adoptedGlyphCount: adoptedComplete ? adoptedGlyphCount : null,
    availableNodeCount: available,
    decodedSampleCount: decodedComplete ? decodedSampleCount : null,
  };
}

function resolveTargetVisualizationVectorAccounting({
  anchorKind,
  availableAnchorCount,
  currentComponent,
  currentGeneration,
  currentScopeId,
  currentScopeKind,
  currentTargetId,
  currentTopologyHash,
  currentVisualizationRevision,
  currentVectorBuildKey,
  expectedGeneration,
  expectedQuantityId,
  expectedScopeId,
  expectedScopeKind,
  expectedVisualizationRevision,
  expectedVectorBuildKey,
  expectedCapacityRevision,
  effectiveAllocation,
  requestedBudget,
  snapshots,
}: {
  anchorKind: "cell" | "node" | null;
  availableAnchorCount: number | null;
  currentComponent?: string | null;
  currentGeneration?: string | null;
  currentScopeId?: string | null;
  currentScopeKind?: string | null;
  currentTargetId?: string | null;
  currentTopologyHash?: string | null;
  currentVisualizationRevision?: string | number | null;
  currentVectorBuildKey?: string | null;
  expectedGeneration?: string | null;
  expectedQuantityId?: string | null;
  expectedScopeId?: string | null;
  expectedScopeKind?: string | null;
  expectedVisualizationRevision?: string | number | null;
  expectedVectorBuildKey?: string | null;
  expectedCapacityRevision?: string | number | null;
  effectiveAllocation?: number | null;
  requestedBudget?: number | null;
  snapshots: readonly VisualizationDebugSnapshot[];
}): VisualizationVectorAccounting {
  const available = normalizeVectorCount(availableAnchorCount);
  const requested = normalizeVectorCount(requestedBudget);
  const effective = normalizeVectorCount(effectiveAllocation);
  const base: VisualizationVectorAccounting = {
    adoptedGlyphCount: null,
    allocatedBudget: effective,
    anchorKind,
    availableAnchorCount: available,
    availableNodeCount: available,
    decodedSampleCount: null,
    requestedBudget: requested,
  };
  const snapshot = [...snapshots].sort(
    (left, right) => right.capturedAtMs - left.capturedAtMs,
  )[0];
  if (!snapshot || available === null) {
    return { ...base, status: "unavailable" };
  }
  if (
    snapshot.disposition === "blocked" ||
    (currentTargetId && snapshot.target.id !== currentTargetId)
  ) {
    return { ...base, status: "stale" };
  }

  const matchingCarriers = snapshot.carriers.filter((carrier) =>
    visualizationVectorCarrierMatchesIdentity(carrier, {
      currentComponent,
      currentGeneration,
      currentScopeId,
      currentScopeKind,
      currentTopologyHash,
      currentVisualizationRevision,
      currentVectorBuildKey,
      expectedGeneration,
      expectedQuantityId,
      expectedScopeId,
      expectedScopeKind,
      expectedVisualizationRevision,
      expectedVectorBuildKey,
      expectedCapacityRevision,
      anchorKind,
    }),
  );
  if (matchingCarriers.length === 0) {
    return { ...base, status: "stale" };
  }

  let adoptedGlyphCount = 0;
  let decodedSampleCount = 0;
  let adoptedComplete = true;
  let decodedComplete = true;
  const publishedAllocations = matchingCarriers.map((carrier) =>
    normalizeVectorCount(carrier.render.vectors.segmentCount),
  );
  for (const carrier of matchingCarriers) {
    if (!carrier.payload) {
      decodedComplete = false;
    } else if (carrier.payload.pointCount > available) {
      decodedComplete = false;
      adoptedComplete = false;
    } else {
      decodedSampleCount += carrier.payload.pointCount;
    }

    const adoption = carrier.render.adoption.vector;
    const adoptionMatches = Boolean(
      adoption.adoptedVectorItemCount != null &&
        carrier.render.requestedFieldBufferId &&
        carrier.request.resourceKey &&
        carrier.render.vectors.buildKey &&
        adoption.adoptedFieldBufferId === carrier.render.requestedFieldBufferId &&
        adoption.adoptedResourceKey === carrier.request.resourceKey &&
        adoption.adoptedVectorBuildKey === carrier.render.vectors.buildKey,
    );
    if (!adoptionMatches) adoptedComplete = false;
    else adoptedGlyphCount += adoption.adoptedVectorItemCount ?? 0;
  }

  if (decodedComplete && decodedSampleCount > available) {
    decodedComplete = false;
    adoptedComplete = false;
  }
  if (adoptedComplete && adoptedGlyphCount > available) {
    adoptedComplete = false;
  }

  return {
    ...base,
    allocatedBudget: publishedAllocations.every(
      (allocation): allocation is number => allocation !== null,
    )
      ? publishedAllocations.reduce((total, allocation) => total + allocation, 0)
      : effective,
    adoptedGlyphCount: adoptedComplete ? adoptedGlyphCount : null,
    decodedSampleCount: decodedComplete ? decodedSampleCount : null,
    status:
      decodedComplete && adoptedComplete
        ? "ready"
        : decodedComplete || adoptedComplete
          ? "pending"
          : "stale",
  };
}

function visualizationVectorCarrierMatchesIdentity(
  carrier: VisualizationDebugSnapshot["carriers"][number],
  expected: {
    currentComponent?: string | null;
    currentGeneration?: string | null;
    currentScopeId?: string | null;
    currentScopeKind?: string | null;
    currentTopologyHash?: string | null;
    currentVisualizationRevision?: string | number | null;
    currentVectorBuildKey?: string | null;
    expectedGeneration?: string | null;
    expectedQuantityId?: string | null;
    expectedScopeId?: string | null;
    expectedScopeKind?: string | null;
    expectedVisualizationRevision?: string | number | null;
    expectedVectorBuildKey?: string | null;
    expectedCapacityRevision?: string | number | null;
    anchorKind: "cell" | "node" | null;
  },
): boolean {
  const payload = carrier.payload;
  const revisions = carrier.revisions;
  const expectedScopeKind =
    expected.expectedScopeKind ?? expected.currentScopeKind;
  const expectedScopeId = expected.expectedScopeId ?? expected.currentScopeId;
  const expectedGeneration =
    expected.expectedGeneration ?? expected.currentGeneration;
  const expectedVisualizationRevision =
    expected.expectedVisualizationRevision ?? expected.currentVisualizationRevision;
  const expectedVectorBuildKey =
    expected.expectedVectorBuildKey ?? expected.currentVectorBuildKey;
  // FEM node capacity revisions are mesh revisions and share the FMVP
  // topologyRevision carrier. FDM cell capacities use membership/layout
  // tokens, while FMVP uses a domain-generation/carrier revision instead.
  const capacityRevisionMatches =
    expected.expectedCapacityRevision == null ||
    expected.anchorKind !== "node" ||
    (revisions.topologyRevision != null
      ? String(revisions.topologyRevision) ===
        String(expected.expectedCapacityRevision)
      : revisions.visualizationRevision != null &&
        String(revisions.visualizationRevision) ===
          String(expected.expectedCapacityRevision));
  return (
    (!expected.expectedQuantityId ||
      payload?.quantityId === expected.expectedQuantityId) &&
    (!expected.currentComponent ||
      payload?.component === expected.currentComponent) &&
    (!expectedScopeKind || payload?.scopeKind === expectedScopeKind) &&
    (expectedScopeId === undefined ||
      expectedScopeId === null ||
      payload?.scopeId === expectedScopeId) &&
    (!expectedGeneration ||
      revisions.domainGenerationId === expectedGeneration) &&
    (!expected.currentTopologyHash ||
      revisions.meshTopologyHash === expected.currentTopologyHash) &&
    capacityRevisionMatches &&
    (expectedVisualizationRevision == null ||
      String(revisions.visualizationRevision) ===
        String(expectedVisualizationRevision)) &&
    (!expectedVectorBuildKey ||
      carrier.render.vectors.buildKey === expectedVectorBuildKey)
  );
}

function normalizeVectorCount(
  value: number | null | undefined,
): number | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.max(0, Math.floor(value));
}

export const DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP = 2_048;

export function resolveVisualizationVectorSceneCap(
  visualizationState: VisualizationStateResource | null | undefined,
): number {
  return (
    normalizeVectorCount(visualizationState?.sampling?.max_glyphs) ??
    DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP
  );
}

export function resolveVisualizationVectorEffectiveBudget({
  availableAnchorCount,
  requestedBudget,
  sceneCap = DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP,
}: {
  availableAnchorCount: number | null | undefined;
  requestedBudget: number | null | undefined;
  sceneCap?: number | null;
}): number | null {
  const available = normalizeVectorCount(availableAnchorCount);
  if (available === null) return null;
  const requested = normalizeVectorCount(requestedBudget) ?? 0;
  const cap = normalizeVectorCount(sceneCap) ?? DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP;
  return Math.min(available, requested, cap);
}

export function availableVectorAnchorCount(
  range: VisualizationVectorBudgetRange,
): number | null {
  return range.availableAnchorCount === null
    ? null
    : range.availableAnchorCount ?? range.availableNodeCount;
}

export function resolveVisualizationVectorBudgetValues({
  range,
  requestedBudget,
  sceneCap = DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP,
}: {
  range: VisualizationVectorBudgetRange;
  requestedBudget: number | null | undefined;
  sceneCap?: number | null;
}): VisualizationVectorBudgetValues {
  const requested = normalizeVectorCount(requestedBudget) ?? 0;
  const available = availableVectorAnchorCount(range);
  const policyCap = normalizeVectorCount(sceneCap) ?? DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP;
  const rangeMax = normalizeVectorCount(range.max);
  const max =
    range.exact && available !== null && rangeMax !== null
      ? Math.min(rangeMax, policyCap)
      : null;
  const normalizedRequested = max === null ? requested : Math.min(requested, max);
  return {
    effective:
      max === null
        ? null
        : resolveVisualizationVectorEffectiveBudget({
            availableAnchorCount: available,
            requestedBudget: normalizedRequested,
            sceneCap: policyCap,
          }),
    max,
    normalizedRequested,
    policyCap,
    requested,
  };
}

export function resolveVisualizationVectorCapacityForTarget({
  domain,
  fdmMembership,
  fdmNativeActiveMask,
  fdmNativeLayer,
  fdmRealizedRegionIds,
  femManifest,
  multilayerAirbox,
  target,
}: {
  domain?: DomainMetaResource | null;
  fdmMembership?: FdmRegionMembershipResource | null;
  fdmNativeActiveMask?: ArrayLike<number> | null;
  fdmNativeLayer?: {
    activeCellCount: number;
    carrierId: string;
    domainGenerationId: string | null;
    gridFingerprint: string | null;
    inactiveCellCount: number;
    revision: string | number | null;
    shape: readonly [number, number, number];
  } | null;
  fdmRealizedRegionIds?: ArrayLike<number> | null;
  femManifest?: MeshSharedDomainManifestResource | null;
  multilayerAirbox?: {
    carrierFingerprint: string | null;
    cellCount: number;
    carrierId: string;
    domainGenerationId: string | null;
    revision: string | number | null;
    shape: readonly [number, number, number];
  } | null;
  target: VisualizationTargetRef | null | undefined;
}): VisualizationVectorCapacityDescriptor | null {
  if (!target) return null;
  if (target.kind === "fdm-native-layer" && fdmNativeLayer) {
    const source = fdmNativeLayerVisualizationVectorCapacitySource({
      ...fdmNativeLayer,
      activeMask: fdmNativeActiveMask ?? null,
    });
    return source
      ? resolveVisualizationVectorCapacityDescriptor({ source, target })
      : null;
  }
  if (target.kind === "airbox" && multilayerAirbox) {
    const source = fdmMultilayerAirboxVisualizationVectorCapacitySource(
      multilayerAirbox,
    );
    return source
      ? resolveVisualizationVectorCapacityDescriptor({ source, target })
      : null;
  }
  if (domain?.discretization.toLowerCase() === "fdm") {
    const source = fdmVisualizationVectorCapacitySource({
      domain,
      membership: fdmMembership,
      realizedRegionIds: fdmRealizedRegionIds,
      revision: fdmMembership
        ? `${fdmMembership.mesh_revision}:${fdmMembership.region_membership_revision}`
        : null,
    });
    return source
      ? resolveVisualizationVectorCapacityDescriptor({ source, target })
      : null;
  }
  const source = femVisualizationVectorCapacitySource({
    manifest: femManifest,
    target,
  });
  return source
    ? resolveVisualizationVectorCapacityDescriptor({ source, target })
    : null;
}

export function resolveVisualizationVectorBudgetRange({
  capacity,
  fdmCellCount: structuredGridCellCount,
  geometryScope = "full",
  manifestRegions,
  memberships,
  meshParts,
  sceneCap = DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP,
  target,
}: {
  capacity?: VisualizationVectorCapacityDescriptor | null;
  fdmCellCount?: number | null;
  geometryScope?: VisualizationGeometryScope;
  manifestRegions?: readonly MeshRegion[] | null | undefined;
  memberships?: readonly MeshRegionMembershipResource[] | null | undefined;
  meshParts?: readonly MeshPart[] | null | undefined;
  sceneCap?: number | null;
  target: VisualizationTargetRef | null | undefined;
}): VisualizationVectorBudgetRange {
  if (capacity !== undefined) {
    if (!capacity) return unknownVisualizationVectorBudgetRange();
    const exact =
      geometryScope === "surface"
        ? capacity.surfaceExact ?? capacity.exact
        : capacity.fullExact ?? capacity.exact;
    if (!exact) return unknownVisualizationVectorBudgetRange();
    const policyCap =
      normalizeVectorCount(sceneCap) ?? DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP;
    const available = Math.max(
      0,
      Math.floor(
        geometryScope === "surface" ? capacity.surfaceCount : capacity.fullCount,
      ),
    );
    return {
      availableAnchorCount: available,
      availableNodeCount: available,
      anchorKind: capacity.anchorKind,
      carrierId: capacity.carrierId,
      exact,
      generation: capacity.generation,
      max: Math.min(available, policyCap),
      min: 0,
      revision: capacity.revision,
      step: 1,
      topologyHash: capacity.topologyHash,
    };
  }
  if (structuredGridCellCount !== null && structuredGridCellCount !== undefined) {
    const cellCount = structuredGridCellCount;
    if (
      cellCount !== null &&
      cellCount !== undefined &&
      Number.isSafeInteger(cellCount) &&
      cellCount >= 0
    ) {
      return {
        anchorKind: "cell",
        availableNodeCount: cellCount,
        exact: true,
        max: cellCount,
        min: 0,
        step: 1,
      };
    }
    return fallbackVisualizationVectorBudgetRange();
  }
  if (!target || !meshParts || meshParts.length === 0) {
    return fallbackVisualizationVectorBudgetRange();
  }

  const carrier = resolveRegionVisualizationCarrier({
    manifestRegions,
    memberships,
    target,
  });
  if (
    target.kind === "region" &&
    manifestRegions &&
    carrier?.kind !== "mesh-parts" &&
    carrier?.kind !== "membership"
  ) {
    return fallbackVisualizationVectorBudgetRange();
  }

  if (carrier?.kind === "membership") {
    const membership = memberships?.find((m) =>
      meshRegionMembershipMatchesCarrier(m, carrier),
    );
    const nodeCount = membership?.node_indices?.length ?? 0;
    if (nodeCount <= 0) {
      return fallbackVisualizationVectorBudgetRange();
    }
    return {
      anchorKind: "node",
      availableNodeCount: nodeCount,
      exact: true,
      max: nodeCount,
      min: 0,
      step: 1,
    };
  }

  const carrierPartIds =
    carrier?.kind === "mesh-parts" ? new Set(carrier.partIds) : null;
  const matchingParts = meshParts.filter((part) =>
    carrierPartIds
      ? carrierPartIds.has(part.id)
      : meshPartMatchesVisualizationTarget(part, target),
  );
  const topologyNodeCount = inferManifestTopologyNodeCount(meshParts);
  const canonicalMagneticParts = meshParts.filter(
    (part) => part.role === "magnetic_object",
  );
  const magneticParts =
    canonicalMagneticParts.length > 0
      ? canonicalMagneticParts
      : meshParts.filter(
          (part) =>
            !isVisualizationAirboxIdentity(part) &&
            part.role !== "interface" &&
            Boolean(
              part.object_id ||
                part.role === "magnetic" ||
                part.role === "object",
        ),
    );
  let exact = true;
  const selectedNodeIndices = new Set<number>();
  let unresolvedNodeCount = 0;
  matchingParts.forEach((part) => {
    if (target.kind === "airbox") {
      if (
        geometryScope === "surface" &&
        part.surface_node_indices == null
      ) {
        exact = false;
        return;
      }
      const airSelection =
        geometryScope === "surface"
          ? { nodeIndices: part.surface_node_indices ?? [] }
          : part;
      const selection = buildAirOnlyVisualizationNodeSelection({
        airSelection,
        magneticSelections: magneticParts,
        nodeCount: topologyNodeCount,
      });
      for (const nodeIndex of visualizationNodeSelectionIndices(
        selection,
        topologyNodeCount,
      )) {
        selectedNodeIndices.add(nodeIndex);
      }
      return;
    }
    const count = meshPartVectorNodeCount(
      part,
      geometryScope,
      topologyNodeCount,
    );
    if (!count.exact) exact = false;
    if (count.nodeIndices) {
      for (const nodeIndex of count.nodeIndices) {
        selectedNodeIndices.add(nodeIndex);
      }
    } else {
      unresolvedNodeCount += count.nodeCount;
    }
  });
  const max = selectedNodeIndices.size + unresolvedNodeCount;

  if (target.kind === "airbox" && geometryScope === "surface" && !exact) {
    return fallbackVisualizationVectorBudgetRange();
  }

  if (max <= 0) {
    if (target.kind === "airbox" && matchingParts.length > 0) {
      return {
        anchorKind: "node",
        availableNodeCount: 0,
        exact: true,
        max: 0,
        min: 0,
        step: 1,
      };
    }
    return fallbackVisualizationVectorBudgetRange();
  }

  return {
    anchorKind: "node",
    availableNodeCount: max,
    exact,
    max,
    min: 0,
    step: 1,
  };
}

function inferManifestTopologyNodeCount(meshParts: readonly MeshPart[]): number {
  let nodeCount = 0;
  for (const part of meshParts) {
    for (const nodeIndex of part.node_indices ?? []) {
      if (Number.isInteger(nodeIndex) && nodeIndex >= 0) {
        nodeCount = Math.max(nodeCount, nodeIndex + 1);
      }
    }
    nodeCount = Math.max(nodeCount, part.node_start + part.node_count);
  }
  return nodeCount;
}

export function resolveRegionVisualizationCarrier({
  manifestRegions,
  memberships,
  target,
}: {
  manifestRegions?: readonly MeshRegion[] | null | undefined;
  memberships?: readonly MeshRegionMembershipResource[] | null | undefined;
  target: VisualizationTargetRef | null | undefined;
}): RegionVisualizationCarrier | null {
  if (target?.kind !== "region") return null;
  const regionTarget = parseRegionVisualizationTargetId(target.id);
  if (!regionTarget) {
    return {
      kind: "unavailable",
      reason: "Region target id is not canonical.",
    };
  }

  if (manifestRegions) {
    for (const region of manifestRegions) {
      const regionId = region.source_region_candidate_id;
      if (!regionId || decodeSafe(regionId) !== regionTarget.regionId) continue;
      const objectMatch = (region.source_object_ids ?? []).some(
        (objectId) =>
          canonicalVisualizationSceneObjectId(decodeSafe(objectId)) ===
          canonicalVisualizationSceneObjectId(regionTarget.objectId),
      );
      if (!objectMatch) continue;
      const partIds = (region.mesh_part_ids ?? []).flatMap((partId) =>
        typeof partId === "string" && partId.trim() ? [partId] : [],
      );
      if (partIds.length > 0) {
        return {
          kind: "mesh-parts",
          objectId: regionTarget.objectId,
          partIds,
          regionId: regionTarget.regionId,
        };
      }
    }
  }

  if (memberships) {
    for (const membership of memberships) {
      if (!meshRegionMembershipMatchesTarget(membership, regionTarget)) continue;
      const hasElements = (membership.element_indices && membership.element_indices.length > 0) ||
                          (membership.node_indices && membership.node_indices.length > 0) ||
                          (membership.boundary_face_indices && membership.boundary_face_indices.length > 0);
      if (hasElements) {
        return {
          kind: "membership",
          objectId: regionTarget.objectId,
          syntheticPartId: `membership:${encodeURIComponent(regionTarget.objectId)}:${encodeURIComponent(regionTarget.regionId)}`,
          regionId: regionTarget.regionId,
        };
      }
    }
  }

  if (!manifestRegions) {
    return {
      kind: "unavailable",
      reason: "No mesh manifest regions are available.",
    };
  }

  return {
    kind: "unavailable",
    reason: "Region is not present in the mesh manifest or region memberships.",
  };
}

export function geometryScopeVectorBudgetPatch({
  currentRange,
  geometryScope,
  nextRange,
  sceneCap,
  settings,
}: {
  currentRange: VisualizationVectorBudgetRange;
  geometryScope: VisualizationGeometryScope;
  nextRange: VisualizationVectorBudgetRange;
  sceneCap?: number | null;
  settings: VisualizationTargetSettings;
}): VisualizationTargetPatch {
  if (geometryScope === settings.geometryScope) {
    return { geometryScope };
  }

  const currentMax = Math.max(currentRange.min, currentRange.max ?? 0);
  const nextMax = Math.max(nextRange.min, nextRange.max ?? 0);
  if (currentMax <= 0 || nextMax <= 0) {
    return { geometryScope };
  }

  const currentBudget = resolveVisualizationVectorBudgetValues({
    range: currentRange,
    requestedBudget: settings.vectorBudget,
    sceneCap,
  });
  const nextBudgetValues = resolveVisualizationVectorBudgetValues({
    range: nextRange,
    requestedBudget: settings.vectorBudget,
    sceneCap,
  });
  const currentEffectiveMax = currentBudget.max ?? currentMax;
  const nextEffectiveMax = nextBudgetValues.max ?? nextMax;
  if (nextBudgetValues.max === null) {
    return { geometryScope };
  }
  const displayedBudget = currentBudget.effective ?? 0;
  const coverage =
    currentEffectiveMax > 0 ? displayedBudget / currentEffectiveMax : 0;
  const nextBudget = Math.max(
    nextRange.min,
    Math.min(nextEffectiveMax, Math.round(nextEffectiveMax * coverage)),
  );

  return {
    geometryScope,
    vectorBudget: nextBudget,
  };
}

export function visualizationQuantityItems(
  activeQuantityId: string,
  targetKind?: VisualizationTargetKind,
  fieldCatalog?: FieldCatalogResource | null,
  quantityCatalog?: QuantityCatalogResource | null,
  targetAvailability?: ReadonlyMap<string, TargetFieldAvailability>,
): Array<{ disabled?: boolean; label: string; value: string }> {
  const capabilityItems = quantityCatalog
    ? quantityCatalog.quantities
        .filter(
          targetKind === "airbox"
            ? quantityCatalogEntrySupportsAirbox
            : quantityCatalogEntrySupportsSpatialVisualization,
        )
        .map((quantity) => ({
          label: quantity.label || quantity.id,
          value: quantity.id,
        }))
    : [];
  const fieldItems = fieldCatalog
    ? fieldCatalog.quantities
        .filter(
          (quantity) =>
            fieldCatalogQuantitySupportsSpatialVisualization(quantity) &&
            (targetKind !== "airbox" || quantity.domain === "full_domain"),
        )
        .map((quantity) => {
          const canonicalQuantityId = resolveCanonicalQuantityId(
            quantity.quantity_id,
          );
          return {
            label: quantity.label || canonicalQuantityId,
            value: quantity.quantity_id,
          };
        })
    : [];
  const baseItems = quantityCatalog
    ? mergeVisualizationQuantityItems(capabilityItems, fieldItems)
    : targetKind === "airbox"
      ? fieldItems.filter((item) =>
          fieldCatalogQuantitySupportsAirbox(fieldCatalog, item.value),
        )
      : fieldItems;
  const targetAwareItems = baseItems.map((item) => {
    const availability = targetAvailability?.get(
      resolveCanonicalQuantityId(item.value),
    );
    return availability?.state === "unavailable"
      ? { ...item, disabled: true }
      : item;
  });
  if (
    targetKind === "airbox" &&
    !fieldCatalog &&
    !quantityCatalog &&
    !targetAvailability?.size
  ) {
    return baseItems;
  }

  if (
    !activeQuantityId ||
    targetAwareItems.some(
      (item) =>
        resolveCanonicalQuantityId(item.value) ===
        resolveCanonicalQuantityId(activeQuantityId),
    )
  ) {
    return targetAwareItems;
  }

  const activeCanonicalQuantityId = resolveCanonicalQuantityId(activeQuantityId);
  const activeAvailability = targetAvailability?.get(activeCanonicalQuantityId);
  if (activeAvailability && targetFieldAvailabilityIsSelectable(activeAvailability)) {
    return [
      {
        label: activeQuantityId,
        value: activeQuantityId,
      },
      ...targetAwareItems,
    ];
  }

  return [
    {
      value: activeQuantityId,
      label: fieldCatalog || quantityCatalog
        ? `Unavailable / ${activeQuantityId}`
        : activeQuantityId,
      ...(fieldCatalog || quantityCatalog ? { disabled: true } : {}),
    },
    ...targetAwareItems,
  ];
}

function mergeVisualizationQuantityItems(
  capabilityItems: Array<{ label: string; value: string }>,
  fieldItems: Array<{ label: string; value: string }>,
): Array<{ label: string; value: string }> {
  const merged = new Map<string, { label: string; value: string }>();
  for (const item of capabilityItems) merged.set(item.value, item);
  for (const item of fieldItems) {
    if (!merged.has(item.value)) merged.set(item.value, item);
  }
  return Array.from(merged.values());
}

export function fieldCatalogQuantityAvailable(
  fieldCatalog: FieldCatalogResource | null | undefined,
  quantityId: string,
): boolean {
  if (!fieldCatalog) return true;
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  return fieldCatalog.quantities.some(
    (quantity) =>
      quantity.available &&
      resolveCanonicalQuantityId(quantity.quantity_id) === canonicalQuantityId,
  );
}

export function quantitySourcePatch(
  settings: VisualizationTargetSettings,
  quantityId: string,
): VisualizationTargetPatch {
  const activeQuantityId = resolveCanonicalQuantityId(quantityId);
  const patch: VisualizationTargetPatch = { activeQuantityId };

  if (isScalarSpatialQuantityId(activeQuantityId)) {
    if (settings.surfaceColorSource !== "colormap") {
      patch.surfaceColorSource = "colormap";
    }
    return patch;
  }

  if (settings.surfaceColorSource === "colormap") {
    patch.surfaceColorSource = surfaceColorSourceForVectorMode(
      settings.vectorColorMode,
    );
  }

  return patch;
}

export function shouldLoadObjectVisualizationFieldCatalog({
  requested,
  surfaceColorSource,
  targetActive,
  vectorsVisible = false,
}: {
  requested: boolean;
  surfaceColorSource: SurfaceColorSource | null | undefined;
  targetActive: boolean;
  vectorsVisible?: boolean;
}): boolean {
  return Boolean(
    requested &&
      targetActive &&
      (vectorsVisible ||
        (surfaceColorSource !== undefined &&
          surfaceColorSource !== null &&
          surfaceColorSource !== "solid")),
  );
}

function surfaceColorSourceForVectorMode(
  colorMode: VisualizationColorMode,
): SurfaceColorSource {
  if (colorMode === "x") return "component_x";
  if (colorMode === "y") return "component_y";
  if (colorMode === "z") return "component_z";
  if (colorMode === "magnitude") return "magnitude";
  if (colorMode === "monochrome") return "solid";
  return "orientation";
}

export function colorPickerInputValue(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : rgbToHex(255, 255, 255);
}

export function surfaceSolidColorPatch(value: string): VisualizationTargetPatch {
  return {
    shaderMonoColor: value,
    surfaceColorSource: "solid",
  };
}

export function renderModeDisplayPatch(
  renderMode: VisualizationDisplayMode,
): VisualizationTargetPatch {
  if (renderMode === "off") {
    return {
      pointsVisible: false,
      shaderVisible: false,
      wireframeVisible: false,
    };
  }
  return {
    ...renderModePatch(renderMode),
  };
}

export type VisualizationDisplayMode = VisualizationRenderMode | "off";

export function resolveVisualizationDisplayMode(
  settings: Pick<
    VisualizationTargetSettings,
    "pointsVisible" | "shaderVisible" | "wireframeVisible"
  >,
): VisualizationDisplayMode {
  if (settings.pointsVisible) return "points";
  if (settings.shaderVisible && settings.wireframeVisible) return "surface+edges";
  if (settings.shaderVisible) return "surface";
  if (settings.wireframeVisible) return "wireframe";
  return "off";
}

export function displayPassTogglePatch(
  settings: VisualizationTargetSettings,
  field: "boundsVisible" | "primitiveVisible" | "vectorsVisible",
): VisualizationTargetPatch {
  return {
    [field]: !settings[field],
  };
}

export function geometryScopeDisplayPatch(
  _settings: VisualizationTargetSettings,
  geometryScope: VisualizationTargetSettings["geometryScope"],
): VisualizationTargetPatch {
  return { geometryScope };
}

function unknownVisualizationVectorBudgetRange(): VisualizationVectorBudgetRange {
  return {
    availableAnchorCount: null,
    availableNodeCount: 0,
    anchorKind: null,
    exact: false,
    max: null,
    min: 0,
    step: 1,
  };
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function fallbackVisualizationVectorBudgetRange(): VisualizationVectorBudgetRange {
  return unknownVisualizationVectorBudgetRange();
}

function meshPartVectorNodeCount(
  part: MeshPart,
  geometryScope: VisualizationGeometryScope,
  topologyNodeCount: number,
): { exact: boolean; nodeCount: number; nodeIndices?: readonly number[] } {
  if (geometryScope !== "surface") {
    if (part.node_indices && part.node_indices.length > 0) {
      const nodeIndices = visualizationNodeSelectionIndices(
        { nodeIndices: part.node_indices },
        topologyNodeCount,
      );
      return {
        exact: true,
        nodeCount: nodeIndices.length,
        nodeIndices,
      };
    }
    const nodeIndices = visualizationNodeSelectionIndices(
      { nodeStart: part.node_start, nodeCount: part.node_count },
      topologyNodeCount,
    );
    return {
      exact: true,
      nodeCount: nodeIndices.length,
      nodeIndices,
    };
  }

  if (part.surface_node_indices && part.surface_node_indices.length > 0) {
    const nodeIndices = visualizationNodeSelectionIndices(
      { nodeIndices: part.surface_node_indices },
      topologyNodeCount,
    );
    return {
      exact: true,
      nodeCount: nodeIndices.length,
      nodeIndices,
    };
  }

  const surfaceFaces = part.surface_faces;
  if (!surfaceFaces || surfaceFaces.length === 0) {
    return { exact: false, nodeCount: part.node_count };
  }

  const nodeIndices = new Set<number>();
  for (const face of surfaceFaces) {
    for (const nodeIndex of face) {
      if (
        Number.isInteger(nodeIndex) &&
        nodeIndex >= 0 &&
        nodeIndex < topologyNodeCount
      ) {
        nodeIndices.add(nodeIndex);
      }
    }
  }

  return nodeIndices.size > 0
    ? { exact: true, nodeCount: nodeIndices.size, nodeIndices: [...nodeIndices] }
    : { exact: false, nodeCount: part.node_count };
}

function meshPartMatchesVisualizationTarget(
  part: MeshPart,
  target: VisualizationTargetRef,
): boolean {
  if (target.kind === "airbox") {
    return isVisualizationAirboxIdentity(part);
  }

  if (target.kind === "region") {
    const regionTarget = parseRegionVisualizationTargetId(target.id);
    if (!regionTarget) return false;
    const objectAliases = meshIdAliases(regionTarget.objectId);
    const objectMatch = meshIdAliases(part.object_id).size === 0
      ? true
      : aliasesIntersect(meshIdAliases(part.object_id), objectAliases);
    const regionAliases = meshIdAliases(regionTarget.regionId);
    return (
      objectMatch &&
      (aliasesIntersect(meshIdAliases(part.geometry_id), regionAliases) ||
        aliasesIntersect(meshIdAliases(part.id), regionAliases))
    );
  }

  const targetAliases = meshIdAliases(target.id);
  const partValues =
    target.kind === "part"
      ? [part.id]
      : [part.object_id, part.geometry_id, part.id];

  return partValues.some((value) => {
    for (const alias of meshIdAliases(value)) {
      if (targetAliases.has(alias)) return true;
    }
    return false;
  });
}

export function parseRegionVisualizationTargetId(
  targetId: string,
): { objectId: string; regionId: string } | null {
  const match = /^region:([^:]+):(.+)$/.exec(targetId);
  if (!match) return null;
  try {
    return {
      objectId: decodeURIComponent(match[1]),
      regionId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function meshRegionMembershipMatchesTarget(
  membership: MeshRegionMembershipResource,
  target: { objectId: string; regionId: string },
): boolean {
  return (
    membership.region_id === target.regionId &&
    canonicalVisualizationSceneObjectId(membership.owner_object_id) ===
      canonicalVisualizationSceneObjectId(target.objectId)
  );
}

function meshRegionMembershipMatchesCarrier(
  membership: MeshRegionMembershipResource,
  carrier: Extract<RegionVisualizationCarrier, { kind: "membership" }>,
): boolean {
  return meshRegionMembershipMatchesTarget(membership, {
    objectId: carrier.objectId,
    regionId: carrier.regionId,
  });
}

export function resolveObjectChildRegionVisualizationTargets({
  manifestRegions,
  objectId,
  scene,
}: {
  manifestRegions?: readonly MeshRegion[] | null | undefined;
  objectId: string | null | undefined;
  scene: unknown;
}): VisualizationTargetRef[] {
  const ownerId = typeof objectId === "string" ? objectId.trim() : "";
  if (!ownerId) return [];

  const targets: VisualizationTargetRef[] = [];
  const seen = new Set<string>();
  const pushRegion = (regionId: unknown, label: unknown) => {
    if (typeof regionId !== "string" || !regionId.trim()) return;
    const target: VisualizationTargetRef = {
      id: visualizationTargetIdForSceneObject(ownerId, regionId),
      kind: "region",
      label: typeof label === "string" && label.trim() ? label : regionId,
    };
    const key = target.id;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  const sceneRecord = isRecord(scene) ? scene : null;
  const objects = Array.isArray(sceneRecord?.objects) ? sceneRecord.objects : [];
  for (const objectValue of objects) {
    const object = isRecord(objectValue) ? objectValue : null;
    if (object?.id !== ownerId || !Array.isArray(object.regions)) continue;
    for (const regionValue of object.regions) {
      const region = isRecord(regionValue) ? regionValue : null;
      pushRegion(region?.region_id ?? region?.id, region?.name);
    }
  }

  for (const region of manifestRegions ?? []) {
    const sourceObjectMatch = (region.source_object_ids ?? []).some(
      (sourceObjectId) =>
        canonicalVisualizationSceneObjectId(decodeSafe(sourceObjectId)) ===
        canonicalVisualizationSceneObjectId(ownerId),
    );
    if (!sourceObjectMatch) continue;
    pushRegion(region.source_region_candidate_id, region.name);
  }

  return targets;
}

/** The Inspector must combine canonical backend state with only live local overlays. */
export function resolveChildRegionOverrideTargetIds({
  backendOverrides,
  childTargets,
  objectId,
  snapshot,
}: {
  backendOverrides: readonly VisualizationStateResource["overrides"][number][];
  childTargets: readonly VisualizationTargetRef[];
  objectId: string;
  snapshot: Pick<ObjectVisualizationSnapshot, "overrides"> &
    Partial<Pick<ObjectVisualizationSnapshot, "pendingOverrides">>;
}): Set<string> {
  const ids = new Set<string>();
  const canonicalOwner = canonicalVisualizationSceneObjectId(objectId);
  const isCurrentOwnerRegion = (targetId: string): boolean => {
    const parsed = parseRegionVisualizationTargetId(targetId);
    return Boolean(
      parsed &&
        canonicalVisualizationSceneObjectId(parsed.objectId) === canonicalOwner,
    );
  };

  for (const entry of backendOverrides) {
    if (entry.scope === "region" && isCurrentOwnerRegion(entry.scope_id)) {
      ids.add(entry.scope_id);
    }
  }
  for (const target of childTargets) {
    if (!isCurrentOwnerRegion(target.id)) continue;
    if (
      Boolean(snapshot.overrides[visualizationTargetKey(target)]) ||
      Boolean(snapshot.pendingOverrides?.[visualizationTargetKey(target)])
    ) {
      ids.add(target.id);
    }
  }
  for (const key of [
    ...Object.keys(snapshot.overrides),
    ...Object.keys(snapshot.pendingOverrides ?? {}),
  ]) {
    if (isCurrentOwnerRegion(key)) ids.add(key);
  }
  return ids;
}

/**
 * A reset is one replacement list. Restrict deletion by the encoded owner id
 * rather than by whichever region list happened to be loaded in this render.
 */
export function removeOwnerChildRegionVisualizationOverrides({
  objectId,
  overrides,
}: {
  objectId: string;
  overrides: readonly VisualizationStateResource["overrides"][number][];
}): VisualizationStateResource["overrides"] {
  const canonicalOwner = canonicalVisualizationSceneObjectId(objectId);
  return overrides.filter((entry) => {
    if (entry.scope !== "region") return true;
    const parsed = parseRegionVisualizationTargetId(entry.scope_id);
    return (
      !parsed ||
      canonicalVisualizationSceneObjectId(parsed.objectId) !== canonicalOwner
    );
  });
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function aliasesIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function meshIdAliases(value: string | null | undefined): Set<string> {
  const aliases = new Set<string>();
  if (!value) return aliases;

  const trimmed = value.trim();
  if (!trimmed) return aliases;
  aliases.add(trimmed);

  const withoutPartPrefix = trimmed.startsWith("part:")
    ? trimmed.slice("part:".length)
    : trimmed;
  aliases.add(withoutPartPrefix);

  const withoutGeometrySuffix = withoutPartPrefix.endsWith("_geom")
    ? withoutPartPrefix.slice(0, -"_geom".length)
    : withoutPartPrefix;
  aliases.add(withoutGeometrySuffix);
  aliases.add(`${withoutGeometrySuffix}_geom`);

  return aliases;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface VisualizationPanelField {
  id: keyof VisualizationTargetSettings;
  kind: "color" | "mode" | "number" | "toggle";
  label: string;
}

export interface VisualizationPanelSection {
  disabled: boolean;
  fields: VisualizationPanelField[];
  id:
    | "display-passes"
    | "geometry-scope"
    | "opacity"
    | "overrides"
    | "points"
    | "quantity-source"
    | "surface-coloring"
    | "vectors"
    | "wireframe";
  title: string;
}

type AirboxVisibilityDiagnosticStatus =
  | "backend-off"
  | "confirmed"
  | "display-suppressed"
  | "no-drawable-pass"
  | "render-degraded";

export interface AirboxVisibilityDiagnostic {
  details: Array<{ label: string; value: string }>;
  message: string;
  status: AirboxVisibilityDiagnosticStatus;
  title: string;
}

type AirboxVectorDiagnosticStatus =
  | "blocked"
  | "catalog-missing"
  | "confirmed"
  | "render-degraded";

export interface AirboxVectorDiagnostic {
  details: Array<{ label: string; value: string }>;
  message: string;
  status: AirboxVectorDiagnosticStatus;
  title: string;
}

function booleanLabel(value: boolean): string {
  return value ? "on" : "off";
}

function buildAirboxFieldVectorResourceKey({
  quantityId,
  sampleLimit,
}: {
  quantityId: string;
  sampleLimit: number | null;
}): string {
  const path = DATA_FIELD_VECTOR_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(quantityId),
  );
  const params = new URLSearchParams();
  params.set("component", "full");
  if (sampleLimit !== null && sampleLimit > 0) {
    params.set("max_samples", String(sampleLimit));
  }
  params.set("scope_kind", "airbox");
  return `${path}?${params.toString()}`;
}

export function buildAirboxVectorDiagnostic({
  airboxPartIds,
  displaySettings,
  fieldCatalog,
  fieldCatalogStatus,
  renderWarning,
  settings,
  vectorDomain,
}: {
  airboxPartIds: readonly string[];
  displaySettings: VisualizationTargetSettings;
  fieldCatalog: FieldCatalogResource | null | undefined;
  fieldCatalogStatus: string;
  renderWarning: string | null;
  settings: VisualizationTargetSettings;
  vectorDomain: string;
}): AirboxVectorDiagnostic {
  const quantityId = resolveCanonicalQuantityId(settings.activeQuantityId);
  const blockedVectorDomain =
    vectorDomain === "magnetic_only" ||
    vectorDomain === "object" ||
    vectorDomain === "part";
  const sampleLimit =
    settings.vectorsVisible
      ? Math.max(0, Math.floor(settings.vectorBudget))
      : null;
  const quantity = fieldCatalog?.quantities.find(
    (entry) => resolveCanonicalQuantityId(entry.quantity_id) === quantityId,
  );
  const quantityCompatible = fieldCatalogQuantitySupportsAirbox(
    fieldCatalog,
    quantityId,
  );
  const expectedResourceKey = buildAirboxFieldVectorResourceKey({
    quantityId,
    sampleLimit,
  });
  const details = [
    { label: "Quantity", value: quantityId },
    { label: "Expected resource", value: expectedResourceKey },
    { label: "Airbox parts", value: airboxPartIds.join(", ") || "none" },
    { label: "Airbox visible", value: booleanLabel(settings.visible) },
    { label: "Resolved visible", value: booleanLabel(displaySettings.visible) },
    { label: "Vectors pass", value: booleanLabel(settings.vectorsVisible) },
    {
      label: "Resolved vectors",
      value: booleanLabel(displaySettings.vectorsVisible),
    },
    { label: "Vector domain", value: vectorDomain },
    { label: "Vector budget", value: String(settings.vectorBudget) },
    { label: "Geometry scope", value: settings.geometryScope },
    { label: "Quantity compatible", value: quantityCompatible ? "yes" : "no" },
    {
      label: "Field catalog",
      value: fieldCatalog
        ? `ready (${fieldCatalog.quantities.length} quantities)`
        : fieldCatalogStatus,
    },
    {
      label: "Catalog quantity",
      value: quantity
        ? `${quantity.available ? "available" : "unavailable"} r${quantity.field_revision} ${quantity.location}`
        : "missing",
    },
  ];

  const blockedReason =
    airboxPartIds.length === 0
      ? "No airbox mesh part is present in the shared-domain manifest."
      : !settings.visible
        ? "Airbox master visibility is off."
        : !displaySettings.visible
          ? "Resolved airbox display visibility is off."
          : !settings.vectorsVisible
            ? "The airbox Vectors pass is off."
            : !displaySettings.vectorsVisible
              ? "Resolved vector visibility is off."
              : blockedVectorDomain
                ? `Global vector domain '${vectorDomain}' excludes airbox vectors.`
                : fieldCatalog && !quantity
                  ? `Quantity '${quantityId}' is missing from the field catalog.`
                  : fieldCatalog && !quantityCompatible
                    ? `Quantity '${quantityId}' is magnetic-only and cannot render on the airbox.`
                    : settings.vectorBudget <= 0
                    ? "Vector budget is zero."
                    : quantity && !quantity.available
                      ? `Quantity '${quantityId}' is present in the field catalog but unavailable.`
                      : null;

  if (blockedReason) {
    return {
      details,
      message: blockedReason,
      status: "blocked",
      title: "Airbox vectors are not scheduled",
    };
  }

  if (renderWarning) {
    return {
      details: [...details, { label: "Render constraint", value: renderWarning }],
      message: renderWarning,
      status: "render-degraded",
      title: "Airbox vector render is constrained",
    };
  }

  if (!fieldCatalog) {
    return {
      details,
      message:
        "The visible-state gates allow airbox vectors, but the inspector has not loaded a field catalog snapshot. Compare the expected resource key with the network log.",
      status: "catalog-missing",
      title: "Airbox vector status is partially known",
    };
  }

  return {
    details,
    message:
      "The visible-state gates allow airbox vectors and the requested quantity is available. If no arrows are visible, the remaining issue is below resource selection: decoded vector samples, render-model segment generation, or canvas/layer drawing.",
    status: "confirmed",
    title: "Airbox vectors should be displayed",
  };
}

export function buildAirboxVisibilityDiagnostic({
  displaySettings,
  renderWarning,
  settings,
}: {
  displaySettings: VisualizationTargetSettings;
  renderWarning: string | null;
  settings: VisualizationTargetSettings;
}): AirboxVisibilityDiagnostic {
  const hasDrawablePass =
    settings.boundsVisible ||
    settings.vectorsVisible ||
    settings.wireframeVisible;
  const details = [
    { label: "Backend master", value: settings.visible ? "on" : "off" },
    { label: "Wireframe pass", value: settings.wireframeVisible ? "on" : "off" },
    { label: "Frame pass", value: settings.boundsVisible ? "on" : "off" },
    { label: "Vectors pass", value: settings.vectorsVisible ? "on" : "off" },
    { label: "Effective display", value: displaySettings.visible ? "on" : "off" },
  ];

  if (!settings.visible) {
    return {
      details,
      message:
        "The v2 visualization resource currently read by the inspector still reports layers.airbox.visible=false. If the network log shows PATCH 200, the backend/refetch path did not retain the airbox master flag.",
      status: "backend-off",
      title: "Airbox visibility not confirmed",
    };
  }

  if (!hasDrawablePass) {
    return {
      details,
      message:
        "The airbox master flag is on, but all drawable airbox passes are off. Enable Wireframe, Frame, or Vectors to make the airbox render.",
      status: "no-drawable-pass",
      title: "Airbox has no active pass",
    };
  }

  if (renderWarning) {
    return {
      details: [...details, { label: "Render constraint", value: renderWarning }],
      message: renderWarning,
      status: "render-degraded",
      title: "Airbox render is constrained",
    };
  }

  if (!displaySettings.visible) {
    return {
      details,
      message:
        "The backend master flag is on, but the resolved display state is still off. This means the frontend display-resolution layer is suppressing the airbox after the resource update.",
      status: "display-suppressed",
      title: "Airbox display is suppressed",
    };
  }

  return {
    details,
    message:
      "The backend state now reports the airbox master flag on and at least one drawable pass is active. If the viewport still shows nothing, the remaining issue is below the Visible switch: topology, airbox geometry, camera framing, or renderer layer data.",
    status: "confirmed",
    title: "Airbox visibility confirmed",
  };
}

export function buildVisualizationPanelSections({
  effectiveSettings,
  settings,
  target,
}: {
  effectiveSettings: VisualizationTargetSettings;
  settings: VisualizationTargetSettings;
  target?: VisualizationTargetRef;
}): VisualizationPanelSection[] {
  const passDisabled = !settings.visible;
  const capabilities = target ? visualizationTargetCapabilities(target) : null;
  const isAirboxTarget = target?.kind === "airbox";
  const isFdmAirboxTarget = target ? isFdmUniverseOutsideSupportTarget(target) : false;

  if (capabilities?.supportsFieldData === false) {
    return [
      {
        disabled: passDisabled,
        fields: [
          { id: "visible", kind: "toggle", label: "Visible" },
          { id: "boundsVisible", kind: "toggle", label: "Frame" },
          { id: "boundsOpacityPercent", kind: "number", label: "Bounds opacity" },
        ],
        id: "display-passes",
        title: "Display Passes",
      },
      {
        disabled: passDisabled || !effectiveSettings.wireframeVisible,
        fields: [
          { id: "wireframeColor", kind: "color", label: "Wireframe color" },
          {
            id: "wireframeOpacityPercent",
            kind: "number",
            label: "Wireframe opacity",
          },
        ],
        id: "wireframe",
        title: "Wireframe",
      },
      {
        disabled: false,
        fields: [],
        id: "overrides",
        title: "Overrides",
      },
    ];
  }

  const sections: VisualizationPanelSection[] = [
    {
      disabled: passDisabled,
      fields: [
        { id: "visible", kind: "toggle", label: "Visible" },
        ...(capabilities?.showBoundsControl === false
          ? []
          : [
              { id: "boundsVisible", kind: "toggle", label: "Frame" },
              {
                id: "boundsOpacityPercent",
                kind: "number",
                label: "Bounds opacity",
              },
            ]),
        ...(capabilities?.supportsVectors === false
          ? []
          : [{ id: "vectorsVisible", kind: "toggle", label: "Vectors" }]),
      ] as VisualizationPanelField[],
      id: "display-passes",
      title: "Display Passes",
    },
    {
      disabled: passDisabled,
      fields: [
        { id: "activeQuantityId", kind: "mode", label: "Quantity source" },
      ],
      id: "quantity-source",
      title: "Quantity Source",
    },
  ];

  if (!isAirboxTarget && !isFdmAirboxTarget) {
    sections.push({
      disabled: passDisabled || !effectiveSettings.shaderVisible,
      fields: [
        { id: "surfaceColorSource", kind: "mode", label: "Color source" },
        { id: "shaderMonoColor", kind: "color", label: "Solid color" },
        { id: "surfaceOpacityPercent", kind: "number", label: "Surface opacity" },
      ],
      id: "surface-coloring",
      title: "Surface Coloring",
    });
  }

  if (capabilities?.supportsPoints !== false) {
    sections.push({
      disabled: passDisabled || !effectiveSettings.pointsVisible,
      fields: [
        { id: "pointColor", kind: "color", label: "Point color" },
        { id: "pointOpacityPercent", kind: "number", label: "Point opacity" },
      ],
      id: "points",
      title: "Points",
    });
  }

  sections.push({
    disabled: passDisabled || !effectiveSettings.wireframeVisible,
    fields: [
      { id: "wireframeColor", kind: "color", label: "Wireframe color" },
      {
        id: "wireframeOpacityPercent",
        kind: "number",
        label: "Wireframe opacity",
      },
    ],
    id: "wireframe",
    title: "Wireframe",
  });

  if (capabilities?.supportsVectors !== false) {
    const vectorFields: VisualizationPanelField[] = [
      { id: "vectorColorMode", kind: "mode", label: "Vector coloring" },
      { id: "vectorMonoColor", kind: "color", label: "Vector mono color" },
      { id: "vectorAlphaPercent", kind: "number", label: "Vector opacity" },
      { id: "vectorThickness", kind: "number", label: "Vector thickness" },
      { id: "vectorLengthScale", kind: "number", label: "Arrow length" },
      { id: "vectorBudget", kind: "number", label: "Arrow budget" },
      { id: "vectorCenteringEnabled", kind: "toggle", label: "Centered arrows" },
      ...(capabilities?.supportsVectorSurfaceOffset === false
        ? []
        : ([
            {
              id: "vectorSurfaceOffsetEnabled",
              kind: "toggle",
              label: "Lift above surface",
            },
            {
              id: "vectorSurfaceOffsetScale",
              kind: "number",
              label: "Extra surface gap",
            },
          ] satisfies VisualizationPanelField[])),
    ];
    if (capabilities?.showGeometryScopeControl !== false) {
      vectorFields.push({ id: "geometryScope", kind: "mode", label: "Arrow extent" });
    }
    sections.push({
      disabled: passDisabled || !effectiveSettings.vectorsVisible,
      fields: vectorFields,
      id: "vectors",
      title: "Vectors",
    });
  }

  if (capabilities?.showGeometryScopeControl !== false) {
    sections.push({
      disabled: passDisabled,
      fields: [{ id: "geometryScope", kind: "mode", label: "Geometry scope" }],
      id: "geometry-scope",
      title: "Geometry Scope",
    });
  }

  sections.push({
    disabled: false,
    fields: [],
    id: "overrides",
    title: "Overrides",
  });

  return sections;
}
