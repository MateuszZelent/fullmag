import type { MeshSharedDomainManifestResource } from "@/kernel/api/apiTypes";
import {
  renderModePatch,
  type SurfaceColorSource,
  type VisualizationGeometryScope,
  type VisualizationColorMode,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
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
  { value: "h_eff", label: "Effective field / h_eff" },
  { value: "h_demag", label: "Demag field / h_demag" },
  { value: "h_ex", label: "Exchange field / h_ex" },
  { value: "h_ani", label: "Anisotropy field / h_ani" },
  { value: "eden_total", label: "Total energy density / eden_total" },
  { value: "eden_ex", label: "Exchange energy density / eden_ex" },
  { value: "eden_demag", label: "Demag energy density / eden_demag" },
  { value: "eden_ext", label: "Zeeman energy density / eden_ext" },
  { value: "eden_ani", label: "Anisotropy energy density / eden_ani" },
  { value: "eden_dmi", label: "DMI energy density / eden_dmi" },
];

const FALLBACK_VECTOR_BUDGET_MAX = 4096;

type MeshPart = NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number];

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
  meshParts,
  target,
}: {
  geometryScope?: VisualizationGeometryScope;
  meshParts: readonly MeshPart[] | null | undefined;
  target: VisualizationTargetRef | null | undefined;
}): VisualizationVectorBudgetRange {
  if (!target || !meshParts || meshParts.length === 0) {
    return fallbackVisualizationVectorBudgetRange();
  }

  const matchingParts = meshParts.filter((part) =>
    meshPartMatchesVisualizationTarget(part, target),
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

export function visualizationQuantityItems(
  activeQuantityId: string,
): Array<{ label: string; value: string }> {
  if (
    !activeQuantityId ||
    VISUALIZATION_QUANTITY_ITEMS.some((item) => item.value === activeQuantityId)
  ) {
    return VISUALIZATION_QUANTITY_ITEMS;
  }

  return [
    { value: activeQuantityId, label: activeQuantityId },
    ...VISUALIZATION_QUANTITY_ITEMS,
  ];
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

  return renderModePatch("surface");
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
        { id: "vectorSurfaceOffsetEnabled", kind: "toggle", label: "Surface lift" },
        { id: "vectorSurfaceOffsetScale", kind: "number", label: "Surface lift amount" },
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
