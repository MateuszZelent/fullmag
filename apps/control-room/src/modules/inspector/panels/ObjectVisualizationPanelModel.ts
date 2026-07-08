import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import type {
  FieldCatalogResource,
  FieldMetaQuery,
  MeshSharedDomainManifestResource,
  MeshRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import {
  canonicalVisualizationSceneObjectId,
  visualizationObjectIdForMeshPartLike,
  visualizationTargetIdForSceneObject,
} from "@/kernel/selection/selectionTypes";
import {
  isAnalysisFieldQuantityId,
  isMagneticOnlyQuantityId,
  isScalarSpatialQuantityId,
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
  renderModePatch,
  surfaceColorSourceToColorMode,
  type SurfaceFieldProjectionMode,
  type SurfaceColorSource,
  type VisualizationGeometryScope,
  type VisualizationColorMode,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  resolveVisualizationTopologyFreshness,
  type VisualizationTopologyFreshness,
} from "@/kernel/visualization/visualizationDisplayResolution";
export {
  resolveVisualizationRenderResolution,
} from "@/kernel/visualization/visualizationDisplayResolution";

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

export function fieldMetaScopeQueryForVisualizationTarget(
  target: VisualizationTargetRef | null | undefined,
  carrier?: RegionVisualizationCarrier | null,
): Pick<FieldMetaQuery, "scope_id" | "scope_kind"> {
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
      return { scope_id: null, scope_kind: "airbox" };
    case "region":
      if (carrier?.kind === "mesh-parts" && carrier.partIds.length === 1) {
        return { scope_id: carrier.partIds[0] ?? null, scope_kind: "part" };
      }
      return { scope_id: null, scope_kind: null };
    case undefined:
      return { scope_id: null, scope_kind: null };
  }
}

export function objectVisualizationTargetForMeshPart(
  part: NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number],
): VisualizationTargetRef {
  const objectId = visualizationObjectIdForMeshPartLike(part);
  return objectId
    ? {
        id: visualizationTargetIdForSceneObject(objectId),
        kind: "object",
        label: part.label,
      }
    : {
        id: part.id,
        kind: "part",
        label: part.label,
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
  targetKind,
}: {
  manifest: unknown;
  scene: unknown;
  targetKind: VisualizationTargetKind;
}): VisualizationTopologyFreshness | null {
  if (targetKind === "region") {
    return null;
  }
  return scene && manifest
    ? resolveVisualizationTopologyFreshness(scene, manifest)
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

export const VISUALIZATION_QUANTITY_ITEMS: Array<{
  label: string;
  value: string;
}> = [
  { value: "m", label: "Magnetization / m" },
  { value: "H_eff", label: "Effective field / H_eff" },
  { value: "H_demag", label: "Demag field / H_demag" },
  { value: "H_ex", label: "Exchange field / H_ex" },
  { value: "H_ani", label: "Anisotropy field / H_ani" },
  { value: "torque", label: "Torque / torque" },
  { value: "eden_total", label: "Total energy density / eden_total" },
  { value: "eden_ex", label: "Exchange energy density / eden_ex" },
  { value: "eden_demag", label: "Demag energy density / eden_demag" },
  { value: "eden_ext", label: "Zeeman energy density / eden_ext" },
  { value: "eden_ani", label: "Anisotropy energy density / eden_ani" },
  { value: "eden_dmi", label: "DMI energy density / eden_dmi" },
  { value: "mat_ms", label: "Saturation magnetization / mat_ms" },
  { value: "mat_aex", label: "Exchange stiffness / mat_aex" },
  { value: "mat_alpha", label: "Gilbert damping / mat_alpha" },
  { value: "mat_dind", label: "Interfacial DMI / mat_dind" },
  { value: "mat_dbulk", label: "Bulk DMI / mat_dbulk" },
];

const FALLBACK_VECTOR_BUDGET_MAX = 4096;

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
  exact: boolean;
  max: number;
  min: 0;
  step: 1;
}

export interface VisualizationVectorBudgetDiagnostic {
  availableNodeCount: number;
  displayedGlyphCount: number;
  exact: boolean;
  requestedBudget: number;
}

export function resolveVisualizationVectorBudgetRange({
  geometryScope = "full",
  manifestRegions,
  memberships,
  meshParts,
  target,
}: {
  geometryScope?: VisualizationGeometryScope;
  manifestRegions?: readonly MeshRegion[] | null | undefined;
  memberships?: readonly MeshRegionMembershipResource[] | null | undefined;
  meshParts: readonly MeshPart[] | null | undefined;
  target: VisualizationTargetRef | null | undefined;
}): VisualizationVectorBudgetRange {
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
    const regionId = carrier.regionId;
    const membership = memberships?.find((m) => m.region_id === regionId);
    const nodeCount = membership?.node_indices?.length ?? 0;
    if (nodeCount <= 0) {
      return fallbackVisualizationVectorBudgetRange();
    }
    return {
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
  let exact = true;
  const max = matchingParts.reduce((total, part) => {
    const count = meshPartVectorNodeCount(part, geometryScope);
    if (!count.exact) exact = false;
    return total + count.nodeCount;
  }, 0);

  if (max <= 0) {
    return fallbackVisualizationVectorBudgetRange();
  }

  return {
    availableNodeCount: max,
    exact,
    max,
    min: 0,
    step: 1,
  };
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
      if (membership.region_id === regionTarget.regionId) {
        const hasElements = (membership.element_indices && membership.element_indices.length > 0) ||
                            (membership.node_indices && membership.node_indices.length > 0) ||
                            (membership.boundary_face_indices && membership.boundary_face_indices.length > 0);
        if (hasElements) {
          return {
            kind: "membership",
            objectId: regionTarget.objectId,
            syntheticPartId: `membership:${encodeURIComponent(regionTarget.regionId)}`,
            regionId: regionTarget.regionId,
          };
        }
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

export function buildVisualizationVectorBudgetDiagnostic({
  requestedBudget,
  vectorBudgetRange,
}: {
  requestedBudget: number;
  vectorBudgetRange: VisualizationVectorBudgetRange;
}): VisualizationVectorBudgetDiagnostic {
  const safeBudget = Math.max(0, Math.floor(requestedBudget));
  const availableNodeCount = Math.max(0, vectorBudgetRange.availableNodeCount);
  return {
    availableNodeCount,
    displayedGlyphCount: Math.min(safeBudget, availableNodeCount),
    exact: vectorBudgetRange.exact,
    requestedBudget: safeBudget,
  };
}

export function geometryScopeVectorBudgetPatch({
  currentRange,
  geometryScope,
  nextRange,
  settings,
}: {
  currentRange: VisualizationVectorBudgetRange;
  geometryScope: VisualizationGeometryScope;
  nextRange: VisualizationVectorBudgetRange;
  settings: VisualizationTargetSettings;
}): VisualizationTargetPatch {
  if (geometryScope === settings.geometryScope) {
    return { geometryScope };
  }

  const currentMax = Math.max(currentRange.min, currentRange.max);
  const nextMax = Math.max(nextRange.min, nextRange.max);
  if (currentMax <= 0 || nextMax <= 0) {
    return { geometryScope };
  }

  const displayedBudget = Math.max(
    currentRange.min,
    Math.min(currentMax, Math.floor(settings.vectorBudget)),
  );
  const coverage = displayedBudget / currentMax;
  const nextBudget = Math.max(
    nextRange.min,
    Math.min(nextMax, Math.round(nextMax * coverage)),
  );

  return {
    geometryScope,
    vectorBudget: nextBudget,
  };
}

export function visualizationQuantityItems(
  activeQuantityId: string,
  targetKind?: VisualizationTargetKind,
): Array<{ label: string; value: string }> {
  let baseItems = VISUALIZATION_QUANTITY_ITEMS;
  if (targetKind === "airbox") {
    baseItems = VISUALIZATION_QUANTITY_ITEMS.filter(
      (item) => !isMagneticOnlyQuantityId(item.value),
    );
  }

  if (
    !activeQuantityId ||
    baseItems.some((item) => item.value === activeQuantityId)
  ) {
    return baseItems;
  }

  return [
    { value: activeQuantityId, label: activeQuantityId },
    ...baseItems,
  ];
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

export function surfaceDisplayPassPatch(
  settings: VisualizationTargetSettings,
): VisualizationTargetPatch {
  if (
    settings.shaderVisible &&
    !settings.wireframeVisible &&
    !settings.pointsVisible
  ) {
    return { shaderVisible: false };
  }

  return {
    ...renderModePatch("surface"),
    visible: true,
  };
}

export function renderModeDisplayPatch(
  renderMode: VisualizationTargetSettings["renderMode"],
): VisualizationTargetPatch {
  return {
    ...renderModePatch(renderMode),
    visible: true,
  };
}

export function displayPassTogglePatch(
  settings: VisualizationTargetSettings,
  field:
    | "boundsVisible"
    | "pointsVisible"
    | "primitiveVisible"
    | "vectorsVisible"
    | "wireframeVisible",
): VisualizationTargetPatch {
  const nextVisible = !settings[field];
  return {
    [field]: nextVisible,
    ...(nextVisible ? { visible: true } : {}),
  };
}

export function geometryScopeDisplayPatch(
  settings: VisualizationTargetSettings,
  geometryScope: VisualizationTargetSettings["geometryScope"],
): VisualizationTargetPatch {
  if (geometryScope !== "full") {
    return { geometryScope };
  }

  if (settings.wireframeVisible || settings.pointsVisible) {
    return { geometryScope };
  }

  return {
    ...renderModePatch("surface+edges"),
    geometryScope,
    visible: true,
  };
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function fallbackVisualizationVectorBudgetRange(): VisualizationVectorBudgetRange {
  return {
    availableNodeCount: FALLBACK_VECTOR_BUDGET_MAX,
    exact: false,
    max: FALLBACK_VECTOR_BUDGET_MAX,
    min: 0,
    step: 1,
  };
}

function meshPartVectorNodeCount(
  part: MeshPart,
  geometryScope: VisualizationGeometryScope,
): { exact: boolean; nodeCount: number } {
  if (geometryScope !== "surface") {
    return { exact: true, nodeCount: part.node_count };
  }

  const surfaceFaces = part.surface_faces;
  if (!surfaceFaces || surfaceFaces.length === 0) {
    return { exact: false, nodeCount: part.node_count };
  }

  const nodeIndices = new Set<number>();
  for (const face of surfaceFaces) {
    for (const nodeIndex of face) {
      if (Number.isInteger(nodeIndex) && nodeIndex >= 0) {
        nodeIndices.add(nodeIndex);
      }
    }
  }

  return nodeIndices.size > 0
    ? { exact: true, nodeCount: nodeIndices.size }
    : { exact: false, nodeCount: part.node_count };
}

function meshPartMatchesVisualizationTarget(
  part: MeshPart,
  target: VisualizationTargetRef,
): boolean {
  if (target.kind === "airbox") {
    return part.role === "air" || part.role === "airbox";
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
  const quantityCompatible = !isMagneticOnlyQuantityId(quantityId);
  const blockedVectorDomain =
    vectorDomain === "magnetic_only" ||
    vectorDomain === "object" ||
    vectorDomain === "part";
  const surfaceColorMode =
    quantityCompatible && settings.visible && settings.shaderVisible
      ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
      : null;
  const sampleLimit =
    settings.vectorsVisible && !surfaceColorMode
      ? Math.max(0, Math.floor(settings.vectorBudget))
      : null;
  const quantity = fieldCatalog?.quantities.find(
    (entry) => resolveCanonicalQuantityId(entry.quantity_id) === quantityId,
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
                : !quantityCompatible
                  ? `Quantity '${quantityId}' is magnetic-only and cannot render on the airbox.`
                  : settings.vectorBudget <= 0
                    ? "Vector budget is zero."
                    : quantity && !quantity.available
                      ? `Quantity '${quantityId}' is present in the field catalog but unavailable.`
                      : fieldCatalog && !quantity
                        ? `Quantity '${quantityId}' is missing from the field catalog.`
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
    settings.pointsVisible ||
    settings.shaderVisible ||
    settings.vectorsVisible ||
    settings.wireframeVisible;
  const details = [
    { label: "Backend master", value: settings.visible ? "on" : "off" },
    { label: "Surface pass", value: settings.shaderVisible ? "on" : "off" },
    { label: "Wireframe pass", value: settings.wireframeVisible ? "on" : "off" },
    { label: "Frame pass", value: settings.boundsVisible ? "on" : "off" },
    { label: "Points pass", value: settings.pointsVisible ? "on" : "off" },
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
        "The airbox master flag is on, but all drawable airbox passes are off. Enable Wireframe, Frame, Surface, Points, or Vectors to make the airbox render.",
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
}: {
  effectiveSettings: VisualizationTargetSettings;
  settings: VisualizationTargetSettings;
}): VisualizationPanelSection[] {
  const passDisabled = !settings.visible;

  return [
    {
      disabled: false,
      fields: [
        { id: "visible", kind: "toggle", label: "Visible" },
        { id: "shaderVisible", kind: "toggle", label: "Surface" },
        { id: "wireframeVisible", kind: "toggle", label: "Wireframe" },
        { id: "boundsVisible", kind: "toggle", label: "Frame" },
        { id: "pointsVisible", kind: "toggle", label: "Points" },
        { id: "vectorsVisible", kind: "toggle", label: "Vectors" },
      ],
      id: "display-passes",
      title: "Display Passes",
    },
    {
      disabled: false,
      fields: [
        { id: "activeQuantityId", kind: "mode", label: "Quantity source" },
      ],
      id: "quantity-source",
      title: "Quantity Source",
    },
    {
      disabled: passDisabled || !effectiveSettings.shaderVisible,
      fields: [
        { id: "surfaceColorSource", kind: "mode", label: "Color source" },
        { id: "shaderMonoColor", kind: "color", label: "Solid color" },
      ],
      id: "surface-coloring",
      title: "Surface Coloring",
    },
    {
      disabled: passDisabled || !effectiveSettings.pointsVisible,
      fields: [{ id: "pointColor", kind: "color", label: "Point color" }],
      id: "points",
      title: "Points",
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
      disabled: passDisabled || !effectiveSettings.vectorsVisible,
      fields: [
        { id: "vectorColorMode", kind: "mode", label: "Vector coloring" },
        { id: "vectorMonoColor", kind: "color", label: "Vector mono color" },
        { id: "vectorAlphaPercent", kind: "number", label: "Vector alpha" },
        { id: "vectorThickness", kind: "number", label: "Vector thickness" },
        { id: "vectorLengthScale", kind: "number", label: "Arrow length" },
        { id: "vectorBudget", kind: "number", label: "Arrow budget" },
        { id: "vectorCenteringEnabled", kind: "toggle", label: "Centered arrows" },
        { id: "vectorSurfaceOffsetEnabled", kind: "toggle", label: "Lift above surface" },
        { id: "vectorSurfaceOffsetScale", kind: "number", label: "Extra surface gap" },
        { id: "geometryScope", kind: "mode", label: "Arrow extent" },
      ],
      id: "vectors",
      title: "Vectors",
    },
    {
      disabled: passDisabled,
      fields: [{ id: "geometryScope", kind: "mode", label: "Geometry scope" }],
      id: "geometry-scope",
      title: "Geometry Scope",
    },
    {
      disabled: false,
      fields: [{ id: "opacityPercent", kind: "number", label: "Opacity" }],
      id: "opacity",
      title: "Opacity",
    },
    {
      disabled: false,
      fields: [],
      id: "overrides",
      title: "Overrides",
    },
  ];
}
