import {
  Activity,
  AlertTriangle,
  BarChart3,
  Binary,
  Blend,
  Box,
  BoxSelect,
  Camera,
  CheckCircle,
  Circle,
  Cog,
  Columns2,
  Combine,
  Cylinder,
  Disc,
  Download,
  Eye,
  FileText,
  FlaskConical,
  Focus,
  FunctionSquare,
  Grid3X3,
  Hammer,
  Hexagon,
  Layers3,
  ListChecks,
  Magnet,
  Maximize,
  Maximize2,
  Minus,
  Monitor,
  Move,
  Move3D,
  MousePointer2,
  PanelRight,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Ruler,
  Save,
  Scissors,
  Sigma,
  SkipForward,
  Sparkles,
  Square,
  Target,
  Trash2,
  Triangle,
  Upload,
  Zap,
} from "lucide-react";
import { createElement } from "react";

import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import type {
  LiveStatusResource,
  MeshActiveBuildResource,
  MeshLastSuccessfulBuildResource,
  MeshSemanticsResource,
  MeshSummaryResource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  isMagneticOnlyQuantityId,
  isScalarSpatialQuantityId,
  normalizeQuantityIdOrDefault,
  sameQuantityId,
} from "@/kernel/api/quantityIds";
import type { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import type {
  Selection,
  VisualizationMeshPartLike,
} from "@/kernel/selection/selectionTypes";
import { resolveVisualizationTargetForMeshPart } from "@/kernel/selection/visualizationTargetResolver";
import {
  AIRBOX_VISUALIZATION_TARGET,
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
  defaultSurfaceColorSourceForQuantity,
  displayLabelForVisualizationTarget,
  renderModePatch,
  resolveEffectiveVisualizationSettings,
  resolveTargetVisualization,
  resolveVisualizationTargetFromSelection,
  type ObjectVisualizationController,
  type ObjectVisualizationSnapshot,
  type SurfaceColorSource,
  type VisualizationColorMode,
  type VisualizationGeometryScope,
  type VisualizationRenderMode,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  meshPipelineStatusTone,
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";
import { allInteractionSpecs } from "@/shared/domain/physics/interactions";

import type { RibbonMenuNode, RibbonTabContent } from "./ribbonTypes";
import {
  RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND,
  RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
  RIBBON_SELECTION_FOCUS_AIRBOX_COMMAND,
  RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
  RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
  RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
  RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
  RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
  RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND,
  globalQuantityCommandInput,
  visualizationAirboxCommandInput,
  visualizationDefaultsCommandInput,
  visualizationStateCommandInput,
  visualizationTargetCommandInput,
} from "./ribbonCommands";

const I = 20; // icon size
type RibbonVisualizationApi = Pick<
  NonNullable<CommandContext["api"]>["visualization"],
  "patch"
>;
type RibbonResourceInvalidator = Pick<
  NonNullable<CommandContext["resources"]>,
  "invalidate"
>;
type ClipAxis = VisualizationStateResource["clip"]["axis"];
type SliceMeshColorScale = VisualizationStateResource["slice"]["mesh_color_scale"];
type SliceMeshQualityMetric =
  VisualizationStateResource["slice"]["mesh_quality_metric"];
type SliceRenderMode = VisualizationStateResource["slice"]["render_mode"];

function icon(Icon: typeof Play, props?: Record<string, unknown>) {
  return createElement(Icon, { size: I, ...props });
}

const C = {
  blue: "var(--fm-accent)",
  lavender: "var(--fm-stale)",
  pink: "var(--fm-stale)",
  red: "var(--fm-danger)",
  peach: "var(--fm-degraded)",
  yellow: "var(--fm-warning)",
  green: "var(--fm-success)",
  teal: "var(--fm-accent-strong)",
  sky: "var(--fm-accent)",
  sapphire: "var(--fm-accent-strong)",
} as const;

const CLIP_AXIS_ITEMS: Array<{ value: ClipAxis; label: string }> = [
  { value: "z", label: "XY plane" },
  { value: "y", label: "XZ plane" },
  { value: "x", label: "YZ plane" },
];
const SLICE_RENDER_MODE_ITEMS: Array<{ value: SliceRenderMode; label: string }> = [
  { value: "heatmap", label: "Heatmap" },
  { value: "contour", label: "Contour" },
  { value: "heatmap+contour", label: "Heatmap + contour" },
  { value: "vectors", label: "Vectors" },
  { value: "mesh-overlay", label: "Mesh overlay" },
];
const SLICE_MESH_QUALITY_ITEMS: Array<{
  value: SliceMeshQualityMetric;
  label: string;
}> = [
  { value: "skewness", label: "Skewness" },
  { value: "gamma", label: "Gamma" },
  { value: "sicn", label: "SICN" },
  { value: "volume", label: "Volume" },
  { value: "aspect_ratio", label: "Aspect ratio" },
  { value: "max_angle", label: "Max angle" },
  { value: "min_edge", label: "Min edge" },
];
const SLICE_MESH_COLOR_SCALE_ITEMS: Array<{
  value: SliceMeshColorScale;
  label: string;
}> = [
  { value: "jet", label: "Jet" },
  { value: "viridis", label: "Viridis" },
  { value: "hot", label: "Hot" },
  { value: "coolwarm", label: "Coolwarm" },
];

function menu(
  id: string,
  label: string,
  entries: Array<string | [label: string, shortcut: string]>,
): RibbonMenuNode[] {
  return [
    { type: "label", id: `${id}:label`, label },
    ...entries.map((entry, index) => {
      const [entryLabel, shortcut] = Array.isArray(entry) ? entry : [entry, ""];
      return {
        type: "item" as const,
        id: `${id}:item:${index}`,
        label: entryLabel,
        disabled: true,
        shortcut: shortcut || undefined,
      };
    }),
  ];
}

function radioMenu(
  id: string,
  label: string,
  value: string,
  entries: Array<[value: string, label: string]>,
): RibbonMenuNode[] {
  return [
    {
      type: "radio-group",
      id: `${id}:radio`,
      label,
      value,
      items: entries.map(([itemValue, itemLabel]) => ({
        value: itemValue,
        label: itemLabel,
        disabled: true,
      })),
    },
  ];
}

function statusMenu(
  id: string,
  label: string,
  value: string,
  tone: "success" | "warning" | "danger" | "neutral" = "neutral",
): RibbonMenuNode[] {
  return [{ type: "status", id, label, value, tone }];
}

function separator(id: string): RibbonMenuNode {
  return { type: "separator", id };
}

function physicsInteractionMenu(): RibbonMenuNode[] {
  return [
    { type: "label", id: "physics-interactions:label", label: "Interactions" },
    ...allInteractionSpecs().map((spec) => ({
      type: "item" as const,
      id: `physics-interactions:${spec.id}`,
      label: spec.label,
      commandId: RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
      commandInput: { interactionId: spec.id },
    })),
  ];
}

const homeTab: RibbonTabContent = {
  tabId: "home",
  groups: [
    {
      id: "project",
      title: "Project",
      subtitle: "files",
      tone: "neutral",
      actions: [
        { id: "open",       icon: icon(FileText),            label: "Open",      shortcut: "Ctrl+O", disabled: true, iconColor: C.blue, menu: menu("home-open", "Project", [["New problem", "Ctrl+N"], ["Open project", "Ctrl+O"], "Open example", "Recent sessions"]) },
        { id: "study.save-field-state", icon: icon(Save), label: "Save Field", iconColor: C.blue },
        { id: "study.load-field-state", icon: icon(Upload), label: "Load Field", iconColor: C.lavender },
        { id: "vis-preset", icon: icon(Sparkles),            label: "3D Visual", disabled: true,                     iconColor: C.lavender, menu: menu("home-visual", "Visual preset", ["Publication figure", "Live control room", "Debug overlays"]) },
      ],
    },
    {
      id: "workspace",
      title: "Workspace",
      subtitle: "layout",
      tone: "neutral",
      actions: [
        {
          id: "viewport-3d.open",
          icon: icon(Box),
          label: "3D",
          shortcut: "1",
          iconColor: "text-indigo-400",
          menu: [
            {
              type: "radio-group",
              id: "home-workspace:radio",
              label: "Workspace mode",
              value: "3d",
              items: [
                {
                  commandId: "viewport-3d.open",
                  label: "3D viewport",
                  value: "3d",
                },
                {
                  commandId: "cross-section-image.open",
                  label: "Cross-section image",
                  value: "cross-section",
                },
                {
                  commandId: "analysis-plots.open",
                  label: "Analysis",
                  value: "analysis",
                },
              ],
            },
          ],
        },
        {
          id: "home-camera-rotation",
          icon: icon(Camera),
          label: "Camera",
          iconColor: "text-sky-300",
          menu: [
            {
              type: "radio-group",
              id: "home-camera:rotation-mode",
              label: "Rotation mode",
              value: "camera",
              items: [
                {
                  commandId: "viewport-3d.rotation-camera",
                  label: "Free camera",
                  value: "camera",
                },
                {
                  commandId: "viewport-3d.rotation-object",
                  label: "Object orbit",
                  value: "object",
                },
              ],
            },
          ],
        },
        { id: "ws-2d",      icon: icon(Columns2),  label: "2D",      shortcut: "2", commandId: "cross-section-image.open", iconColor: C.sky },
        { id: "ws-analyze", icon: icon(BarChart3), label: "Analyze",               commandId: "analysis-plots.open",       iconColor: C.green },
        {
          id: "ws-panel",
          icon: icon(PanelRight),
          label: "Panel",
          shortcut: "Ctrl+B",
          menu: [
            { type: "label", id: "home-panels:label", label: "Panels" },
            {
              type: "checkbox",
              id: "home-panels:explorer",
              label: "Explorer",
              checked: true,
              commandId: "panels:explorer:toggle",
            },
            {
              type: "checkbox",
              id: "home-panels:inspector",
              label: "Inspector",
              checked: true,
              commandId: "panels:inspector:toggle",
            },
            {
              type: "checkbox",
              id: "home-panels:bottom-dock",
              label: "Bottom dock",
              checked: true,
              commandId: "panels:footer:toggle",
            },
            { type: "separator", id: "home-panels:separator" },
            {
              type: "item",
              id: "home-panels:reset-layout",
              label: "Reset layout",
              disabled: true,
            },
          ],
        },
        { id: "ws-focus",   icon: icon(Eye),       label: "Focus",   disabled: true,               iconColor: C.teal },
      ],
    },
    {
      id: "compute",
      title: "Compute",
      subtitle: "runtime",
      tone: "compute",
      actions: [
        { id: "study.run",   icon: icon(Play,        { fill: "currentColor" }), label: "Compute", shortcut: "F5", accent: true, iconColor: C.green, tooltip: "Submit the study solve command" },
        { id: "study.pause", icon: icon(Pause,       { fill: "currentColor" }), label: "Pause",                  iconColor: C.yellow },
        { id: "study.resume",icon: icon(Play,        { fill: "currentColor" }), label: "Resume",                 iconColor: C.green },
        { id: "study.discard-paused-state", icon: icon(Scissors), label: "Discard", iconColor: C.red },
        { id: "study.stop",  icon: icon(Square,      { fill: "currentColor" }), label: "Stop",                   iconColor: C.red },
        { id: "study.skip",  icon: icon(SkipForward),                           label: "Skip",                   iconColor: C.peach },
      ],
    },
  ],
};

const QUANTITY_ITEMS = [
  { value: "m",             label: "Magnetization / m" },
  { value: "H_eff",         label: "Effective field / H_eff" },
  { value: "H_demag",       label: "Demag field / H_demag" },
  { value: "H_ex",          label: "Exchange field / H_ex" },
  { value: "H_ani",         label: "Anisotropy field / H_ani" },
  { value: "H_ant",         label: "Antenna field / H_ant" },
  { value: "torque",        label: "Torque / torque" },
  { value: "eden_total",    label: "Total energy density / ε_total" },
  { value: "eden_ex",       label: "Exchange energy density / ε_ex" },
  { value: "eden_demag",    label: "Demag energy density / ε_demag" },
  { value: "eden_ext",      label: "Zeeman energy density / ε_ext" },
  { value: "eden_ani",      label: "Anisotropy energy density / ε_ani" },
  { value: "eden_dmi",      label: "DMI energy density / ε_dmi" },
  { value: "mat_ms",        label: "Saturation magnetization / M_sat" },
  { value: "mat_aex",       label: "Exchange stiffness / A_ex" },
  { value: "mat_alpha",     label: "Gilbert damping / α" },
  { value: "mat_dind",      label: "Interfacial DMI / D_ind" },
  { value: "mat_dbulk",     label: "Bulk DMI / D_bulk" },
];

function quantityItemsForVisualizationTarget(
  activeQuantityId: string,
  targetKind?: VisualizationTargetKind,
): Array<{ label: string; value: string }> {
  const baseItems =
    targetKind === "airbox"
      ? QUANTITY_ITEMS.filter((item) => !isMagneticOnlyQuantityId(item.value))
      : QUANTITY_ITEMS;
  return baseItems.some((item) => item.value === activeQuantityId)
    ? baseItems
    : [{ value: activeQuantityId, label: activeQuantityId }, ...baseItems];
}

const VECTOR_COLOR_ITEMS: Array<{
  label: string;
  value: VisualizationColorMode;
}> = [
  { value: "orientation", label: "HSL orientation" },
  { value: "magnitude",   label: "Magnitude" },
  { value: "x",           label: "X component" },
  { value: "y",           label: "Y component" },
  { value: "z",           label: "Z component" },
  { value: "monochrome",  label: "Monochrome" },
];

const SURFACE_COLOR_SOURCE_ITEMS: Array<{
  label: string;
  value: SurfaceColorSource;
}> = [
  { value: "solid", label: "Solid" },
  { value: "orientation", label: "HSL orientation" },
  { value: "component_x", label: "Component X" },
  { value: "component_y", label: "Component Y" },
  { value: "component_z", label: "Component Z" },
  { value: "magnitude", label: "Magnitude |m|" },
  { value: "colormap", label: "Colormap" },
];

const SELECTED_SURFACE_COLOR_SOURCE_ITEMS = [
  { value: "inherit", label: "Inherited" },
  ...SURFACE_COLOR_SOURCE_ITEMS,
];

const VECTOR_COMPONENT_ITEMS = [
  { value: "3D",       label: "3D vectors" },
  { value: "magnitude",label: "Magnitude |v|" },
  { value: "x",        label: "X" },
  { value: "y",        label: "Y" },
  { value: "z",        label: "Z" },
];

const MESH_RENDER_ITEMS = [
  { value: "surface",        label: "Shaded surface" },
  { value: "surface+edges",  label: "Shaded + wireframe" },
  { value: "wireframe",      label: "Wireframe" },
  { value: "points",         label: "Points (nodes)" },
];

const SELECTED_RENDER_ITEMS: Array<{
  label: string;
  value: VisualizationRenderMode;
}> = [
  { value: "surface",       label: "Shaded" },
  { value: "surface+edges", label: "Shaded + wireframe" },
  { value: "wireframe",     label: "Wireframe" },
  { value: "points",        label: "Points" },
];

const AIRBOX_EXTENT_ITEMS = [
  { value: "surface", label: "Surface" },
  { value: "full",    label: "Full" },
];

const GEOMETRY_SCOPE_ITEMS: Array<{
  label: string;
  value: VisualizationGeometryScope;
}> = [
  { value: "surface", label: "Surface only" },
  { value: "full", label: "Full volume" },
];

type FieldComponentPatch = NonNullable<VisualizationStatePatch["field_component"]>;
type VectorColorModePatch = NonNullable<
  NonNullable<VisualizationStatePatch["vector_style"]>["color_mode"]
>;
type VectorLayerDomainPatch = NonNullable<
  NonNullable<
    NonNullable<VisualizationStatePatch["layers"]>["vectors"]
  >["domain"]
>;

const viewTab: RibbonTabContent = {
  tabId: "view",
  groups: [
    // ── Group 1: Global Display (3D render defaults) ───────────────────────
    {
      id: "view-global-display",
      title: "Global Display",
      subtitle: "3D render defaults",
      tone: "neutral",
      actions: [
        {
          id: "view-3d-status",
          icon: icon(Activity),
          label: "3D Active",
          iconColor: "text-emerald-300",
          menu: [
            { type: "label",  id: "3d-status:header", label: "3D visualization", badge: "active" },
            { type: "status", id: "3d-status:reason",  label: "Status",          value: "3D visualization is rendering",  tone: "success" },
            { type: "status", id: "3d-status:detail",  label: "Detail",          value: "WebGL renderer active" },
          ],
        },
        {
          id: "view-render-quality",
          icon: icon(Monitor),
          label: "Quality",
          iconColor: "text-green-300",
          menu: [
            {
              type: "radio-group",
              id: "3d-quality:profile",
              label: "3D quality profile",
              value: "interactive",
              items: [
                {
                  commandId: "viewport-3d.profile-interactive-lite",
                  label: "Interactive Lite",
                  value: "interactive-lite",
                },
                {
                  commandId: "viewport-3d.profile-interactive",
                  label: "Interactive",
                  value: "interactive",
                },
                {
                  commandId: "viewport-3d.profile-balanced",
                  label: "Balanced",
                  value: "balanced",
                },
                {
                  commandId: "viewport-3d.profile-figure",
                  label: "Figure",
                  value: "figure",
                },
                {
                  commandId: "viewport-3d.profile-capture",
                  label: "Capture",
                  value: "capture",
                },
              ],
            },
            { type: "separator", id: "3d-quality:s0" },
            {
              type: "item",
              id: "3d-quality:capture-frame",
              label: "Capture current frame",
              commandId: "viewport-3d.capture-frame",
            },
          ],
        },
        {
          id: "view-surface",
          icon: icon(Box),
          label: "Surface",
          iconColor: "text-teal-300",
          menu: [
            { type: "label",    id: "surface:header",           label: "Surface display",        badge: "on" },
            { type: "status",   id: "surface:scope",            label: "Scope",                  value: "Global ferromagnet surface" },
            { type: "checkbox", id: "surface:visible",          label: "Surface on/off",         checked: true },
            { type: "separator",id: "surface:s0" },
            { type: "radio-group", id: "surface:mesh-display",  label: "Render mode",            value: "surface",    items: MESH_RENDER_ITEMS },
            { type: "checkbox", id: "surface:wireframe",        label: "Wireframe on/off",       checked: true },
            { type: "checkbox", id: "surface:frame",            label: "Frame on/off",           checked: false },
            { type: "checkbox", id: "surface:points",           label: "Points on/off",          checked: false },
            { type: "slider",   id: "surface:opacity",          label: "Opacity",                value: 55, min: 0, max: 100, step: 1, unit: "%" },
          ],
        },
        {
          id: "view-texture",
          icon: icon(Sparkles),
          label: "Texture",
          iconColor: "text-purple-300",
          menu: [
            { type: "label",    id: "texture:header",        label: "Surface coloring", badge: "HSL" },
            { type: "radio-group", id: "texture:source",     label: "Color source",      value: "orientation", items: SURFACE_COLOR_SOURCE_ITEMS },
            { type: "separator",id: "texture:s0" },
            { type: "status",   id: "texture:field-status",  label: "Field status",      value: "unknown" },
          ],
        },
        {
          id: "view-quantity",
          icon: icon(Sigma),
          label: "Quantity",
          iconColor: "text-sky-300",
          menu: [
            { type: "label",    id: "quantity:header",          label: "Active quantity" },
            { type: "status",   id: "quantity:current",         label: "Current", value: "m — Magnetization" },
            { type: "checkbox", id: "quantity:overlay-visible", label: "Quantity overlay on/off", checked: true },
            { type: "separator",id: "quantity:s0" },
            { type: "radio-group", id: "quantity:source",       label: "Quantity source", value: "m", items: QUANTITY_ITEMS },
            { type: "separator",id: "quantity:s1" },
            {
              type: "submenu",
              id: "quantity:colormap",
              label: "Colormap",
              nodes: [
                {
                  type: "radio-group",
                  id: "quantity:shader",
                  label: "Colormap",
                  value: "viridis",
                  items: [
                    { value: "viridis",  label: "Viridis" },
                    { value: "inferno",  label: "Inferno" },
                    { value: "magma",    label: "Magma" },
                    { value: "coolwarm", label: "Coolwarm" },
                    { value: "jet",      label: "Jet" },
                  ],
                },
                { type: "checkbox",    id: "quantity:auto-scale",         label: "Auto-scale range",       checked: true },
                { type: "separator",   id: "quantity:colormap:s0" },
                { type: "radio-group", id: "quantity:vector-coloring",    label: "Vector coloring",        value: "orientation", items: VECTOR_COLOR_ITEMS },
                { type: "color",       id: "quantity:vector-mono-color",  label: "Monochrome vector color", value: "var(--fm-accent)", disabled: true },
              ],
            },
          ],
        },
        {
          id: "view-vectors",
          icon: icon(Zap),
          label: "Vectors",
          iconColor: "text-cyan-300",
          menu: [
            { type: "label",    id: "vectors:header",   label: "Field arrows",                badge: "off" },
            { type: "checkbox", id: "vectors:visible",  label: "Show vectors / field arrows", checked: false },
            { type: "slider",   id: "vectors:density",  label: "Vector glyph budget",         value: 1200, min: 8, max: 4096, step: 8 },
            {
              type: "submenu",
              id: "vectors:placement",
              label: "Arrow placement",
              nodes: [
                { type: "checkbox", id: "vectors:centered-anchor", label: "Center arrows on mesh nodes", checked: true },
                { type: "checkbox", id: "vectors:surface-offset",  label: "Lift surface arrows",         checked: false },
              ],
            },
            { type: "radio-group", id: "vectors:component", label: "Vector component", value: "3D", items: VECTOR_COMPONENT_ITEMS },
            {
              type: "submenu",
              id: "vectors:size",
              label: "Arrow size",
              nodes: [
                { type: "slider", id: "vectors:length",    label: "Length scale", value: 1,   min: 0.2, max: 4,   step: 0.1 },
                { type: "slider", id: "vectors:thickness", label: "Thickness",    value: 1,   min: 0.2, max: 4,   step: 0.1 },
                { type: "slider", id: "vectors:alpha",     label: "Alpha",        value: 0.9, min: 0,   max: 1,   step: 0.05 },
              ],
            },
            {
              type: "radio-group",
              id: "vectors:domain",
              label: "Vector domain",
              value: "auto",
              items: [
                { value: "auto",          label: "Auto" },
                { value: "magnetic_only", label: "Magnetic objects only" },
                { value: "full_domain",   label: "Full domain" },
                { value: "airbox_only",   label: "Airbox only" },
              ],
            },
            { type: "radio-group", id: "vectors:colors",     label: "Vector colors",           value: "orientation", items: VECTOR_COLOR_ITEMS },
            { type: "color",       id: "vectors:mono-color",  label: "Monochrome vector color", value: "var(--fm-accent)", disabled: true },
          ],
        },
        {
          id: "view-airbox",
          icon: icon(Box),
          label: "Airbox",
          iconColor: "text-blue-300",
          menu: [
            { type: "label",    id: "airbox:header",  label: "Airbox display", badge: "hidden" },
            { type: "checkbox", id: "airbox:visible", label: "Airbox on/off",  checked: false },
            { type: "separator",id: "airbox:s-primitive" },
            { type: "label",    id: "airbox:primitive-section", label: "Surface", badge: "off" },
            { type: "checkbox", id: "airbox:shaded",            label: "Shaded on/off",    checked: false },
            { type: "checkbox", id: "airbox:wireframe",         label: "Wireframe on/off", checked: true },
            { type: "radio-group", id: "airbox:wireframe-scope",label: "Wireframe extent", value: "full", items: AIRBOX_EXTENT_ITEMS },
            { type: "separator",id: "airbox:s-points" },
            { type: "label",    id: "airbox:points-section",    label: "Points", badge: "off" },
            { type: "checkbox", id: "airbox:points",            label: "Points on/off",  checked: false },
            { type: "radio-group", id: "airbox:points-scope",   label: "Points extent",  value: "surface", items: AIRBOX_EXTENT_ITEMS },
            { type: "separator",id: "airbox:s-vectors" },
            { type: "label",    id: "airbox:vectors-section",   label: "Vectors", badge: "off" },
            { type: "checkbox", id: "airbox:vectors",           label: "Vectors on/off", checked: false },
            { type: "radio-group", id: "airbox:vectors-scope",  label: "Vectors extent", value: "full", items: AIRBOX_EXTENT_ITEMS },
            {
              type: "submenu",
              id: "airbox:vectors-submenu",
              label: "Airbox vectors",
              nodes: [
                { type: "slider", id: "airbox:vectors-density",   label: "Density / Every N", value: 4, min: 1, max: 64,  step: 1 },
                { type: "slider", id: "airbox:vectors-length",    label: "Length scale",       value: 1, min: 0.2, max: 4, step: 0.1 },
                { type: "slider", id: "airbox:vectors-thickness", label: "Thickness",          value: 1, min: 0.2, max: 4, step: 0.1 },
                { type: "slider", id: "airbox:vectors-alpha",     label: "Alpha",              value: 0.9, min: 0, max: 1, step: 0.05 },
              ],
            },
            {
              type: "submenu",
              id: "airbox:vector-colors",
              label: "Airbox vector colors",
              nodes: [
                { type: "radio-group", id: "airbox:vector-coloring",  label: "Vector colors",           value: "orientation", items: VECTOR_COLOR_ITEMS },
                { type: "color",       id: "airbox:vector-mono-color", label: "Monochrome vector color", value: "var(--fm-accent)", disabled: true },
              ],
            },
            { type: "separator",id: "airbox:s-visible" },
            { type: "slider",   id: "airbox:opacity",            label: "Opacity", value: 35, min: 0, max: 100, step: 1, unit: "%" },
            { type: "separator",id: "airbox:s0" },
            { type: "item",     id: "airbox:focus",  label: "Focus airbox",         disabled: true },
            { type: "item",     id: "airbox:reset",  label: "Reset airbox display" },
          ],
        },
        {
          id: "view-render-layers",
          icon: icon(Layers3),
          label: "Mesh View",
          iconColor: "text-emerald-300",
          menu: [
            { type: "radio-group", id: "layers:mesh-mode", label: "Mesh render mode", value: "surface", items: MESH_RENDER_ITEMS },
            { type: "slider",      id: "layers:opacity",   label: "Mesh opacity",     value: 100, min: 0, max: 100, step: 1, unit: "%" },
            {
              type: "submenu",
              id: "layers:trim",
              label: "3D trim",
              nodes: [
                { type: "checkbox",  id: "trim:enabled",   label: "TRIM enabled", checked: false },
                { type: "separator", id: "trim:s0" },
                { type: "label",    id: "trim:x:label",   label: "X axis", badge: "off" },
                { type: "checkbox", id: "trim:x:enabled", label: "X trim", checked: false },
                { type: "slider",   id: "trim:x:min",     label: "X min",  value: 0,   min: 0, max: 100, step: 1, unit: "%", disabled: true },
                { type: "slider",   id: "trim:x:max",     label: "X max",  value: 100, min: 0, max: 100, step: 1, unit: "%", disabled: true },
                { type: "item",     id: "trim:x:reset",   label: "Reset X" },
                { type: "separator",id: "trim:x:sep" },
                { type: "label",    id: "trim:y:label",   label: "Y axis", badge: "off" },
                { type: "checkbox", id: "trim:y:enabled", label: "Y trim", checked: false },
                { type: "slider",   id: "trim:y:min",     label: "Y min",  value: 0,   min: 0, max: 100, step: 1, unit: "%", disabled: true },
                { type: "slider",   id: "trim:y:max",     label: "Y max",  value: 100, min: 0, max: 100, step: 1, unit: "%", disabled: true },
                { type: "item",     id: "trim:y:reset",   label: "Reset Y" },
                { type: "separator",id: "trim:y:sep" },
                { type: "label",    id: "trim:z:label",   label: "Z axis", badge: "off" },
                { type: "checkbox", id: "trim:z:enabled", label: "Z trim", checked: false },
                { type: "slider",   id: "trim:z:min",     label: "Z min",  value: 0,   min: 0, max: 100, step: 1, unit: "%", disabled: true },
                { type: "slider",   id: "trim:z:max",     label: "Z max",  value: 100, min: 0, max: 100, step: 1, unit: "%", disabled: true },
                { type: "item",     id: "trim:z:reset",   label: "Reset Z" },
                { type: "separator",id: "trim:s1" },
                { type: "item",     id: "trim:reset-all", label: "Reset all" },
              ],
            },
          ],
        },
      ],
    },

    // ── Group 2: Orientation widgets ───────────────────────────────────────
    {
      id: "view-orientation-tools",
      title: "Orientation",
      subtitle: "3D box and HSL",
      tone: "neutral",
      actions: [
        {
          id: "viewport-3d.toggle-viewcube",
          icon: icon(Box),
          label: "3D Box",
          iconColor: "text-sky-300",
        },
        {
          id: "view-hsl-reference",
          icon: icon(Target),
          label: "HSL Sphere",
          iconColor: "text-fuchsia-300",
          menu: [
            {
              type: "radio-group",
              id: "orientation:hsl-reference",
              label: "Visibility",
              value: "auto",
              items: [
                {
                  commandId: "viewport-3d.hsl-reference-auto",
                  label: "Auto",
                  value: "auto",
                },
                {
                  commandId: "viewport-3d.hsl-reference-on",
                  label: "On",
                  value: "on",
                },
                {
                  commandId: "viewport-3d.hsl-reference-off",
                  label: "Off",
                  value: "off",
                },
              ],
            },
          ],
        },
      ],
    },

    // ── Group 3: Cross-Section ──────────────────────────────────────────────
    {
      id: "view-slice-2d",
      title: "Cross-Section",
      subtitle: "image tabs",
      tone: "neutral",
      actions: [
        {
          id: RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND,
          icon: icon(Scissors),
          label: "2D Cross",
          iconColor: "text-orange-300",
          tooltip: "Create 2D cross-section draft",
        },
        {
          id: "cross-section-image.open",
          icon: icon(Triangle),
          label: "Image",
          iconColor: "text-sky-300",
          tooltip: "Open generated cross-section image",
        },
        {
          id: "analysis-plots.open",
          icon: icon(BarChart3),
          label: "Analysis",
          iconColor: "text-amber-300",
          tooltip: "Open analysis plots",
        },
      ],
    },

    // ── Group 4: Selected Display (per-object overrides) ───────────────────
    {
      id: "view-selected-display",
      title: "Selected Display",
      subtitle: "Per object",
      tone: "selection",
      actions: [
        {
          id: "view-selected-texture",
          icon: icon(Sparkles),
          label: "Coloring",
          iconColor: "text-teal-300",
          disabled: true,
          menu: [
            { type: "label",    id: "selected-texture:header", label: "Selected coloring", badge: "inherit" },
            { type: "status",   id: "selected-texture:state",  label: "Global coloring",   value: "Enabled" },
            { type: "checkbox", id: "selected-texture:visible",label: "Surface on/off",   checked: true, disabled: true },
          ],
        },
        {
          id: "view-selected-render",
          icon: icon(BoxSelect),
          label: "Render",
          iconColor: "text-amber-300",
          disabled: true,
          menu: [
            { type: "label",    id: "selected:header",      label: "Selected object", badge: "none" },
            { type: "status",   id: "selected:state",       label: "State",           value: "No selection" },
            {
              type: "radio-group",
              id: "selected:render-mode",
              label: "Render mode",
              value: "inherit",
              disabled: true,
              items: [
                { value: "inherit",       label: "Inherit global" },
                { value: "surface",       label: "Shaded" },
                { value: "wireframe",     label: "Wireframe" },
                { value: "surface+edges", label: "Shaded + wireframe" },
                { value: "points",        label: "Points" },
              ],
            },
            { type: "item", id: "selected:clear", label: "Clear per-object overrides", disabled: true },
          ],
        },
        {
          id: "view-selected-clip",
          icon: icon(Scissors),
          label: "Clip",
          iconColor: "text-orange-300",
          disabled: true,
          menu: [
            { type: "label",  id: "selected-clip:header",  label: "Selected clip", badge: "planned" },
            { type: "status", id: "selected-clip:runtime", label: "Runtime",       value: "Runtime supports one active clip axis", tone: "warning" },
          ],
        },
        {
          id: "view-selected-opacity",
          icon: icon(Blend),
          label: "Opacity",
          iconColor: "text-lime-300",
          disabled: true,
          menu: [
            { type: "slider", id: "selected-opacity:slider", label: "Opacity", value: 100, min: 0, max: 100, step: 1, unit: "%", disabled: true },
            { type: "item", id: "selected-opacity:100", label: "100%" },
            { type: "item", id: "selected-opacity:70",  label: "70%" },
            { type: "item", id: "selected-opacity:35",  label: "35%" },
            { type: "item", id: "selected-opacity:15",  label: "Ghost 15%" },
          ],
        },
      ],
    },

    // ── Group 5: Manipulate (camera/gizmo/transform) ───────────────────────
    {
      id: "view-manipulate",
      title: "Manipulate",
      subtitle: "Camera and gizmo",
      tone: "authoring",
      actions: [
        {
          id: "view-control-mode",
          icon: icon(MousePointer2),
          label: "Control",
          iconColor: "text-violet-300",
          menu: [
            {
              type: "radio-group",
              id: "control:mode",
              label: "Control mode",
              value: "camera",
              items: [
                { value: "camera",     label: "Camera navigation" },
                { value: "select",     label: "Select object",    disabled: true },
                { value: "manipulate", label: "Manipulate selected", disabled: true },
              ],
            },
          ],
        },
        {
          id: "viewport-3d.inspect-toggle",
          icon: icon(Target),
          label: "Inspect",
          iconColor: "text-emerald-300",
          tooltip: "Inspect displayed field values under the cursor",
        },
        {
          id: "view-transform-gizmo",
          icon: icon(Move3D),
          label: "Gizmo",
          iconColor: "text-fuchsia-300",
          menu: [
            {
              type: "radio-group",
              id: "gizmo:scope",
              label: "Scope",
              value: "camera",
              items: [
                { value: "object",  label: "Object transform",  disabled: true },
                { value: "texture", label: "Texture transform", disabled: true },
                { value: "camera",  label: "Camera only / no gizmo" },
              ],
            },
            {
              type: "radio-group",
              id: "gizmo:tool",
              label: "Tool",
              value: "move",
              items: [
                { value: "move",   label: "Move / Translate" },
                { value: "rotate", label: "Rotate" },
                { value: "scale",  label: "Scale" },
              ],
            },
            { type: "separator", id: "gizmo:s0" },
            { type: "item", id: "gizmo:focus", label: "Focus selected", disabled: true },
          ],
        },
      ],
    },

    // ── Group 6: Snapshot / Export ─────────────────────────────────────────
    {
      id: "view-snapshot-export",
      title: "Snapshot / Export",
      subtitle: "Output",
      tone: "sync",
      actions: [
        {
          id: "view-snapshot",
          icon: icon(Camera),
          label: "Snapshot",
          iconColor: "text-rose-300",
          menu: [
            { type: "item", id: "snapshot:current",     label: "Capture current viewport" },
            { type: "item", id: "snapshot:transparent", label: "Capture transparent background", disabled: true },
            { type: "item", id: "snapshot:overlays",    label: "Capture with overlays" },
            { type: "item", id: "snapshot:no-overlays", label: "Capture without overlays", disabled: true },
          ],
        },
        {
          id: "view-export",
          icon: icon(Download),
          label: "Export",
          iconColor: "text-teal-300",
          menu: [
            { type: "item", id: "export:image",  label: "Export viewport image" },
            { type: "item", id: "export:state",  label: "Export viewport state" },
            { type: "item", id: "export:preset", label: "Save as visualization preset" },
          ],
        },
      ],
    },

    // ── Group 7: Display (mode, camera, panels, axes) ──────────────────────
    {
      id: "view-display",
      title: "Display",
      subtitle: "Mode, camera, panels",
      tone: "neutral",
      actions: [
        {
          id: "view-mode-menu",
          icon: icon(Monitor),
          label: "Mode",
          iconColor: "text-indigo-300",
          menu: [
            {
              type: "radio-group",
              id: "view-mode:radio",
              label: "Viewport mode",
              value: "3D",
              items: [
                { value: "3D",      label: "3D" },
                { value: "2D",      label: "2D" },
                { value: "Mesh",    label: "Mesh" },
                { value: "Analyze", label: "Analyze / Results" },
              ],
            },
            { type: "item", id: "view-mode:preset", label: "Create 3D visualization preset" },
          ],
        },
        {
          id: "view-camera",
          icon: icon(Camera),
          label: "Camera",
          iconColor: "text-sky-300",
          menu: [
            { type: "item", id: "camera:parameters", label: "Camera parameters", commandId: "viewport-3d.open-camera-dialog" },
            { type: "item", id: "camera:focus",     label: "Focus selected",  disabled: true },
            { type: "item", id: "camera:frame-all", label: "Frame all",       disabled: true },
            { type: "item", id: "camera:trackball", label: "Trackball navigation", disabled: true },
            { type: "item", id: "camera:orbit",     label: "Orbit navigation",     disabled: true },
          ],
        },
        {
          id: "view-projection",
          icon: icon(Maximize2),
          label: "Ortho",
          iconColor: "text-violet-300",
          tooltip: "Toggle perspective / orthographic projection",
        },
        {
          id: "view-object-context",
          icon: icon(Layers3),
          label: "Context",
          iconColor: "text-cyan-300",
          disabled: true,
        },
        {
          id: "view-object-isolate",
          icon: icon(BoxSelect),
          label: "Isolate",
          iconColor: "text-amber-300",
          disabled: true,
        },
        {
          id: "view-panels",
          icon: icon(PanelRight),
          label: "Panels",
          menu: [
            { type: "label",    id: "panels:label",              label: "Panel visibility" },
            { type: "checkbox", id: "panels:explorer:toggle",    label: "Explorer",    checked: true },
            { type: "checkbox", id: "panels:inspector:toggle",   label: "Inspector",   checked: true },
            { type: "checkbox", id: "panels:footer:toggle",      label: "Footer",      checked: true },
            { type: "separator", id: "panels:sep1" },
            { type: "checkbox", id: "panels:legend",            label: "Legend",       checked: false },
            { type: "checkbox", id: "panels:scene-info",        label: "Scene info",   checked: false, disabled: true },
            { type: "checkbox", id: "panels:diagnostics",       label: "Diagnostics",  checked: false, disabled: true },
          ],
        },
        {
          id: "view-dimension-frame",
          icon: icon(Ruler),
          label: "Frame",
          iconColor: "text-emerald-300",
          menu: [
            {
              type: "radio-group",
              id: "axes:scope",
              label: "Axes scope",
              value: "universe",
              items: [
                { value: "universe", label: "Universe scale" },
                { value: "object",   label: "Object scale" },
              ],
            },
            { type: "checkbox", id: "axes:wireframe", label: "Dimension frame", checked: false },
          ],
        },
        {
          id: "view-topography",
          icon: icon(Sparkles),
          label: "Topography",
          iconColor: "text-amber-300",
          disabled: true,
          menu: [
            { type: "label",  id: "topography:header", label: "Topography",  badge: "FDM only" },
            { type: "status", id: "topography:status", label: "Status",      value: "Unavailable for FEM explicit topology" },
          ],
        },
      ],
    },
  ],
};

const definitionsTab: RibbonTabContent = {
  tabId: "definitions",
  groups: [
    {
      id: "definitions-model",
      title: "Definitions",
      tone: "neutral",
      actions: [
        { id: "definitions-parameters",  icon: icon(Binary),         label: "Parameters",  disabled: true, iconColor: "text-muted-foreground", menu: menu("definitions-parameters", "Parameters", ["Add scalar", "Add vector", "Import table"]) },
        { id: "definitions-functions",   icon: icon(FunctionSquare), label: "Functions",   disabled: true, iconColor: "text-muted-foreground" },
        { id: "definitions-coordinates", icon: icon(Ruler),          label: "Coordinates", disabled: true, iconColor: "text-muted-foreground" },
      ],
    },
  ],
};

const geometryTab: RibbonTabContent = {
  tabId: "geometry",
  groups: [
    // ── Create Object / Shape ─────────────────────────────────────────────
    {
      id: "builder-create",
      title: "Create Object / Shape",
      subtitle: "Parametric primitives",
      tone: "authoring",
      actions: [
        { id: "geometry.add-box",          icon: icon(Box),      label: "Box",            iconColor: "text-emerald-400", splitButton: true, menu: menu("geometry-box", "Box primitive", ["Block", "Thin film", "Cuboid from bounds"]) },
        { id: "geometry.add-cylinder",     icon: icon(Cylinder), label: "Cylinder",       iconColor: "text-cyan-400" },
        { id: "geometry.add-sphere",       icon: icon(Circle),   label: "Sphere",         iconColor: "text-violet-400" },
        { id: "geometry.add-microstrip-antenna", icon: icon(RadioTower), label: "Microstrip", iconColor: "text-rose-300" },
        { id: "builder-add-ellipsoid",     icon: icon(Circle),   label: "Ellipsoid",      disabled: true, iconColor: "text-purple-300" },
        { id: "builder-add-disk",          icon: icon(Disc),     label: "Disk",           disabled: true, iconColor: "text-sky-400" },
        { id: "builder-add-thin_film",     icon: icon(Box),      label: "Thin Film",      disabled: true, iconColor: "text-lime-300" },
        { id: "builder-add-pillar",        icon: icon(Cylinder), label: "Pillar",         disabled: true, iconColor: "text-fuchsia-300" },
        { id: "builder-add-nanowire",      icon: icon(Minus),    label: "Nanowire",       disabled: true, iconColor: "text-rose-300" },
        { id: "builder-add-ring",          icon: icon(Circle),   label: "Ring",           disabled: true, iconColor: "text-amber-300" },
        { id: "builder-add-triangular_prism", icon: icon(Triangle), label: "Tri. Prism",  disabled: true, iconColor: "text-orange-300" },
        { id: "builder-add-cone",          icon: icon(Triangle), label: "Cone",           disabled: true, iconColor: "text-yellow-300" },
        { id: "builder-add-capsule",       icon: icon(Disc),     label: "Capsule",        disabled: true, iconColor: "text-teal-300" },
        { id: "builder-add-tube",          icon: icon(Circle),   label: "Tube",           disabled: true, iconColor: "text-blue-300" },
        { id: "builder-add-wedge",         icon: icon(Box),      label: "Wedge",          disabled: true, iconColor: "text-stone-300" },
        { id: "builder-add-polygon_prism", icon: icon(Circle),   label: "Polygon Prism",  disabled: true, iconColor: "text-indigo-300" },
      ],
    },
    // ── Boolean ──────────────────────────────────────────────────────────
    {
      id: "builder-boolean",
      title: "Boolean",
      subtitle: "Compose object geometry",
      tone: "authoring",
      actions: [
        { id: "builder-boolean-union",     icon: icon(Combine), label: "Union",     disabled: true, iconColor: "text-emerald-400" },
        { id: "builder-boolean-subtract",  icon: icon(Minus),   label: "Subtract",  disabled: true, iconColor: "text-amber-400" },
        { id: "builder-boolean-intersect", icon: icon(Plus),    label: "Intersect", disabled: true, iconColor: "text-slate-400" },
      ],
    },
    // ── Transform ────────────────────────────────────────────────────────
    {
      id: "builder-transform",
      title: "Transform",
      subtitle: "Move / Rotate / Scale",
      tone: "authoring",
      actions: [
        { id: "builder-tool-move",   icon: icon(Move),      label: "Move",   shortcut: "W", disabled: true, iconColor: "text-red-400" },
        { id: "builder-tool-rotate", icon: icon(RotateCcw), label: "Rotate", shortcut: "E", disabled: true, iconColor: "text-green-400" },
        { id: "builder-tool-scale",  icon: icon(Maximize2), label: "Scale",  shortcut: "R", disabled: true, iconColor: "text-blue-400" },
      ],
    },
    // ── Viewport ─────────────────────────────────────────────────────────
    {
      id: "builder-viewport-mode",
      title: "Viewport",
      subtitle: "Interaction mode",
      tone: "neutral",
      actions: [
        { id: "builder-mode-camera",     icon: icon(Camera),       label: "Camera",     shortcut: "Q", disabled: true, iconColor: "text-slate-300" },
        { id: "builder-mode-manipulate", icon: icon(MousePointer2),label: "Manipulate",               disabled: true, iconColor: "text-orange-400" },
        { id: "builder-toggle-snap",     icon: icon(Magnet),       label: "Snap",       shortcut: "G", disabled: true, iconColor: "text-slate-400" },
      ],
    },
    // ── Lifecycle ────────────────────────────────────────────────────────
    {
      id: "builder-lifecycle",
      title: "Lifecycle",
      subtitle: "Build & validate",
      tone: "neutral",
      actions: [
        { id: "builder-build-geometry", icon: icon(Hammer),      label: "Geometry Synced", disabled: true, iconColor: "text-emerald-400" },
        { id: "geometry.commit-object-draft", icon: icon(Save),  label: "Apply Draft",                  iconColor: "text-emerald-400" },
        { id: "mesh.build-selected",    icon: icon(Grid3X3),     label: "Build FEM Mesh",               iconColor: "text-amber-400" },
        { id: "builder-validate",       icon: icon(CheckCircle), label: "Validate",      disabled: true, iconColor: "text-emerald-400" },
      ],
    },
    // ── Focus ────────────────────────────────────────────────────────────
    {
      id: "builder-focus",
      title: "Focus",
      subtitle: "Camera commands",
      tone: "neutral",
      actions: [
        { id: "geometry.focus-primitive", icon: icon(Focus), label: "Focus Selected", shortcut: "F",       iconColor: "text-slate-300" },
        { id: "builder-frame-all",      icon: icon(Maximize),label: "Frame All",      shortcut: "Shift+F", commandId: "viewport-3d.fit", iconColor: "text-slate-300" },
        { id: "builder-show-universe",  icon: icon(Eye),     label: "Show Universe",                       disabled: true, iconColor: "text-cyan-400" },
      ],
    },
  ],
};

const materialsTab: RibbonTabContent = {
  tabId: "materials",
  groups: [
    {
      id: "materials-core",
      title: "Ferromagnet",
      subtitle: "materials",
      tone: "authoring",
      actions: [
        { id: "mat-params", icon: icon(FlaskConical), label: "Parameters", disabled: true, iconColor: "text-emerald-400", menu: menu("materials-params", "Material parameters", ["Ms", "Aex", "alpha", "gamma", "initial m"]) },
        { id: "mat-dmi",    icon: icon(Sparkles),     label: "Add DMI",    disabled: true, iconColor: "text-violet-400", menu: radioMenu("materials-dmi", "DMI type", "none", [["none", "None"], ["bulk", "Bulk"], ["interfacial", "Interfacial"]]) },
        { id: "mat-ku",     icon: icon(Binary),       label: "Add Ku",     disabled: true, iconColor: "text-rose-400",   menu: menu("materials-anisotropy", "Anisotropy", ["Uniaxial", "Cubic", "Surface anisotropy"]) },
      ],
    },
    {
      id: "materials-magnetization",
      title: "Magnetic Texture",
      subtitle: "initial state",
      tone: "authoring",
      actions: [
        { id: "mat-texture-inspector", icon: icon(Eye),      label: "Inspector",    disabled: true, iconColor: "text-sky-400",     menu: menu("mat-texture-inspector", "Texture inspector", ["View texture", "Texture history", "Reset texture"]) },
        { id: "magnetization-texture.assign-uniform", icon: icon(Magnet), label: "Uniform", iconColor: "text-amber-400" },
        { id: "magnetization-texture.assign-random-seeded", icon: icon(Sparkles), label: "Random", iconColor: "text-emerald-400" },
        { id: "magnetization-texture.assign-vortex", icon: icon(Circle), label: "Vortex", iconColor: "text-cyan-400" },
        { id: "mat-texture-bloch-sky", icon: icon(Disc),     label: "Bloch Sky",    iconColor: "text-violet-400", disabled: true },
        { id: "mat-texture-neel-sky",  icon: icon(Disc),     label: "Néel Sky",     iconColor: "text-purple-300", disabled: true },
      ],
    },
    {
      id: "materials-transform",
      title: "Texture Transform",
      subtitle: "orientation",
      tone: "neutral",
      actions: [
        {
          id: "mat-transform-scope",
          icon: icon(Target),
          label: "Scope",
          disabled: true,
          iconColor: "text-sky-400",
          menu: [
            {
              type: "radio-group",
              id: "mat-transform:scope",
              label: "Transform scope",
              value: "object",
              items: [
                { value: "object",  label: "Object transform" },
                { value: "texture", label: "Texture transform" },
                { value: "camera",  label: "Camera" },
              ],
            },
          ],
        },
        {
          id: "mat-transform-tool",
          icon: icon(Move3D),
          label: "Tool",
          disabled: true,
          iconColor: "text-fuchsia-300",
          menu: [
            {
              type: "radio-group",
              id: "mat-transform:tool",
              label: "Transform tool",
              value: "move",
              items: [
                { value: "move",   label: "Move / Translate" },
                { value: "rotate", label: "Rotate" },
                { value: "scale",  label: "Scale",  disabled: true },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const physicsTab: RibbonTabContent = {
  tabId: "physics",
  groups: [
    {
      id: "physics-core",
      title: "Core Terms",
      subtitle: "interactions",
      tone: "neutral",
      actions: [
        { id: "physics-interactions", icon: icon(Magnet), label: "Interactions", iconColor: "text-violet-400", menu: physicsInteractionMenu() },
        { id: "physics-global", icon: icon(Cog),    label: "Global Physics", disabled: true, iconColor: "text-muted-foreground" },
      ],
    },
    {
      id: "physics-add",
      title: "Optional Terms",
      subtitle: "add physics",
      tone: "compose",
      actions: [
        { id: "physics-add-dmi", icon: icon(Sparkles), label: "DMI",         disabled: true, iconColor: "text-cyan-400",  menu: radioMenu("physics-dmi-type", "DMI type", "bulk", [["bulk", "Bulk DMI"], ["interfacial", "Interfacial DMI"]]) },
        { id: "physics-add-ku",  icon: icon(Binary),   label: "Uniaxial Ku", disabled: true, iconColor: "text-rose-400" },
      ],
    },
    {
      id: "physics-drive",
      title: "Drive / STT",
      subtitle: "excitation",
      actions: [
        { id: "physics-oersted",      icon: icon(RadioTower),  label: "Oersted",     iconColor: "text-amber-400",   disabled: true },
        { id: "physics-spin-torque",  icon: icon(Zap),         label: "Spin Torque", iconColor: "text-emerald-400", disabled: true },
        { id: "physics-thermal",      icon: icon(FlaskConical),label: "Thermal",     iconColor: "text-orange-400",  disabled: true },
      ],
    },
    {
      id: "rf-sources",
      title: "RF / Antennas",
      subtitle: "sources",
      actions: [
        { id: "manage-rf",      icon: icon(RadioTower), label: "RF Sources",  disabled: true, iconColor: "text-cyan-400",    menu: menu("physics-rf", "RF source", ["Add microstrip", "Add CPW", "List sources"]) },
        { id: "add-microstrip", icon: icon(Plus),       label: "Microstrip",  commandId: "geometry.add-microstrip-antenna", iconColor: "text-teal-400" },
        { id: "add-cpw",        icon: icon(Plus),       label: "CPW",         disabled: true, iconColor: "text-sky-400" },
      ],
    },
  ],
};

const meshTab: RibbonTabContent = {
  tabId: "mesh",
  groups: [
    {
      id: "build",
      title: "Build",
      subtitle: "mesh",
      tone: "compute",
      actions: [
        { id: "mesh.build-selected", icon: icon(RefreshCw),  label: "Build",      accent: true, splitButton: true, iconColor: C.green, menu: [...statusMenu("mesh-build-status", "Mesh state", "Not built", "warning"), separator("mesh-build-sep"), ...menu("mesh-build", "Build scope", ["Selected object", "All objects", "Universe mesh", "Shared solver mesh"])] },
        { id: "mesh.build-shared-domain", icon: icon(Zap),   label: "Build All",  splitButton: true, iconColor: C.yellow, menu: menu("mesh-build-all", "Build all", ["FDM grid", "FEM shared domain", "Quality report"]) },
        { id: "mesh-stats",     icon: icon(BarChart3),  label: "Statistics",               iconColor: C.peach },
      ],
    },
    {
      id: "size",
      title: "Size",
      subtitle: "controls",
      tone: "neutral",
      actions: [
        { id: "element-size", icon: icon(Ruler),    label: "Element Size", menu: menu("mesh-size", "Size controls", ["Maximum element", "Minimum element", "Growth rate", "Curvature factor", "Narrow regions"]) },
        { id: "transitions",  icon: icon(Columns2), label: "Transitions", disabled: true, iconColor: C.sapphire, menu: menu("mesh-transition", "Transitions", ["Interface refinement", "Boundary layer", "Element grading"]) },
      ],
    },
    {
      id: "method",
      title: "Method",
      subtitle: "quality",
      tone: "neutral",
      actions: [
        { id: "mesher",  icon: icon(Hexagon),    label: "Mesher",  disabled: true, iconColor: C.teal, menu: radioMenu("mesh-method", "Mesher", "auto", [["auto", "Auto"], ["fdm", "FDM grid"], ["tet", "Tetrahedral"], ["external", "External import"]]) },
        { id: "quality", icon: icon(ListChecks), label: "Quality", iconColor: C.green },
      ],
    },
    {
      id: "mesh-view",
      title: "View",
      subtitle: "inspect",
      tone: "neutral",
      actions: [
        { id: "mesh-inspector", icon: icon(Eye),       label: "Inspector", iconColor: C.blue, menu: menu("mesh-inspector", "Inspect", ["Element quality", "Subdomains", "Interfaces", "Airbox", "Build log"]) },
        { id: "mesh-3d",        icon: icon(Grid3X3),   label: "3D View",   commandId: "viewport-3d.open", iconColor: C.sky },
        { id: "mesh-pipeline",  icon: icon(ListChecks),label: "Pipeline",  iconColor: C.lavender },
      ],
    },
  ],
};

const studyTab: RibbonTabContent = {
  tabId: "study",
  groups: [
    {
      id: "navigate",
      title: "Study",
      subtitle: "setup",
      tone: "authoring",
      actions: [
        { id: "study-overview", icon: icon(Cog),        label: "Overview", commandId: "study.open-overview", menu: menu("study-overview", "Study", ["Execution intent", "Backend request", "Stage pipeline", "Provenance"]) },
        { id: "study-stages",   icon: icon(ListChecks), label: "Stages",   commandId: "study.open-stages", iconColor: C.blue },
      ],
    },
    {
      id: "add-stage",
      title: "Add Stage",
      subtitle: "pipeline",
      tone: "authoring",
      actions: [
        { id: "study.add-relax-stage", icon: icon(Play), label: "Relax", iconColor: "text-emerald-400", menu: menu("study-relax",  "Relax stage",      ["Overdamped relax", "LLG relax", "Minimizer", "Stop criteria"]) },
        { id: "study.add-run-stage",   icon: icon(Zap),  label: "Run",   iconColor: "text-yellow-400",  menu: menu("study-run-stage", "Run stage",  ["Time integration", "Pulse response", "RF drive", "Thermal noise"]) },
        { id: "study.add-hysteresis-stage", icon: icon(BarChart3), label: "Hysteresis", iconColor: "text-pink-400" },
        { id: "study.add-eigenmodes-stage", icon: icon(Sigma), label: "Eigenmodes", iconColor: "text-violet-400" },
        { id: "study.add-frequency-response-stage", icon: icon(Activity), label: "Frequency", iconColor: "text-sky-400" },
        { id: "study.add-save-state-stage", icon: icon(Save), label: "Save State", iconColor: "text-lime-300" },
      ],
    },
    {
      id: "study-composite",
      title: "Composite",
      subtitle: "multi-stage",
      tone: "compose",
      actions: [
        { id: "study-sweep-relax",    icon: icon(BarChart3), label: "Sweep+Relax",   disabled: true, iconColor: "text-violet-400" },
        { id: "study-sweep-snap",     icon: icon(Camera),    label: "Sweep+Snap",    disabled: true, iconColor: "text-sky-400" },
        { id: "study-relax-run",      icon: icon(Play),      label: "Relax→Run",     disabled: true, iconColor: "text-emerald-400" },
        { id: "study-relax-eigen",    icon: icon(Sigma),     label: "Relax→Eigen",   iconColor: "text-amber-400",  disabled: true },
        { id: "study-param-sweep",    icon: icon(BarChart3), label: "Param Sweep",   disabled: true, iconColor: "text-cyan-400" },
        { id: "study-current-sweep",  icon: icon(Zap),       label: "Current Sweep", disabled: true, iconColor: "text-yellow-400" },
      ],
    },
    {
      id: "study-selection",
      title: "Selection",
      subtitle: "manage stages",
      tone: "selection",
      actions: [
        { id: "study-duplicate", icon: icon(Columns2), label: "Duplicate",      iconColor: "text-sky-400",     disabled: true },
        { id: "study.remove-selected-stage", icon: icon(Trash2), label: "Remove", iconColor: "text-red-400" },
        { id: "study-toggle",    icon: icon(Eye),      label: "Enable/Disable", iconColor: "text-amber-400",   disabled: true },
      ],
    },
    {
      id: "builder-sync",
      title: "Sync",
      subtitle: "script",
      tone: "sync",
      actions: [
        { id: "study-sync", icon: icon(RefreshCw), label: "Sync Script", disabled: true, iconColor: "text-emerald-400", menu: [...statusMenu("study-sync-status", "Script sync", "Local only"), separator("study-sync-sep"), ...menu("study-sync", "Sync", ["Review diff", "Apply to model", "Export canonical script"])] },
      ],
    },
    {
      id: "control",
      title: "Control",
      subtitle: "runtime",
      tone: "compute",
      actions: [
        { id: "study.compute-fields", icon: icon(Activity), label: "Compute Fields", iconColor: C.sapphire, tooltip: "Evaluate active fields for the current magnetization" },
        { id: "study.compute-energies", icon: icon(Sigma), label: "Compute Energies", iconColor: C.lavender, tooltip: "Evaluate current energies without changing magnetization" },
        { id: "study.run",   icon: icon(Play,        { fill: "currentColor" }), label: "Compute", shortcut: "F5", accent: true, iconColor: C.green, tooltip: "Submit the study solve command" },
        { id: "study.pause", icon: icon(Pause,       { fill: "currentColor" }), label: "Pause",                  iconColor: C.yellow },
        { id: "study.resume",icon: icon(Play,        { fill: "currentColor" }), label: "Resume",                 iconColor: C.green },
        { id: "study.save-checkpoint", icon: icon(Save), label: "Save Checkpoint", iconColor: C.blue },
        { id: "study.restore-checkpoint", icon: icon(RotateCcw), label: "Restore", iconColor: C.lavender },
        { id: "study.import-state", icon: icon(Upload), label: "Import State", iconColor: C.lavender },
        { id: "study.export-state", icon: icon(Download), label: "Export State", iconColor: C.sapphire },
        { id: "study.discard-paused-state", icon: icon(Scissors), label: "Discard", iconColor: C.red },
        { id: "study.stop",  icon: icon(Square,      { fill: "currentColor" }), label: "Stop",                   iconColor: C.red },
        { id: "study.skip",  icon: icon(SkipForward),                           label: "Skip",                   iconColor: C.peach },
      ],
    },
  ],
};

const resultsTab: RibbonTabContent = {
  tabId: "results",
  groups: [
    {
      id: "quantity",
      title: "Quantity",
      subtitle: "resources",
      tone: "neutral",
      actions: [
        { id: "res-m",          icon: icon(Magnet),    label: "M",         active: true, iconColor: "text-pink-400",    menu: radioMenu("results-quantity", "Result quantity", "m", [["m", "Magnetization / m"], ["H_eff", "H_eff"], ["H_demag", "H_demag"], ["H_ex", "H_ex"], ["H_ani", "H_ani"], ["H_ant", "H_ant"], ["torque", "torque"], ["eden_total", "ε_total"], ["eden_ex", "ε_ex"], ["eden_demag", "ε_demag"], ["eden_ext", "ε_ext"], ["eden_ani", "ε_ani"], ["eden_dmi", "ε_dmi"], ["mat_ms", "M_sat"], ["mat_aex", "A_ex"], ["mat_alpha", "α"], ["mat_dind", "D_ind"], ["mat_dbulk", "D_bulk"]]) },
        { id: "res-heff",       icon: icon(Zap),       label: "H_eff",                   iconColor: "text-yellow-400" },
        { id: "res-demag",      icon: icon(Sigma),     label: "H_demag",                 iconColor: "text-violet-300" },
        { id: "res-exchange",   icon: icon(Zap),       label: "H_ex",                    iconColor: "text-amber-400" },
        { id: "res-anis",       icon: icon(Target),    label: "H_anis",                  iconColor: "text-rose-400" },
        { id: "res-torque",     icon: icon(Activity),  label: "Torque",                  iconColor: "text-cyan-300" },
        { id: "res-energy",     icon: icon(BarChart3), label: "Energy",                  iconColor: "text-teal-400" },
      ],
    },
    {
      id: "plot-tools",
      title: "Plot",
      subtitle: "charts",
      tone: "neutral",
      actions: [
        { id: "results-chart",    icon: icon(BarChart3), label: "Chart",    disabled: true, iconColor: "text-emerald-400", menu: menu("results-chart",   "Chart",    ["Magnetization vs time", "Energy vs time", "Spectrum", "Dispersion", "Mode map"]) },
        { id: "results-snapshot", icon: icon(Camera),    label: "Snapshot", disabled: true, iconColor: "text-violet-400" },
      ],
    },
    {
      id: "results-export",
      title: "Export",
      subtitle: "artifacts",
      tone: "sync",
      actions: [
        { id: "export-vtk",   icon: icon(Download), label: "VTK",   commandId: "study.save-vtk", iconColor: "text-blue-400",    menu: menu("results-export", "Export data", ["Field buffer", "Scalar table", "VTK file"]) },
        { id: "export-state",icon: icon(Save),      label: "State", commandId: "study.export-state", iconColor: "text-emerald-400" },
      ],
    },
    {
      id: "analyze",
      title: "Analyze",
      subtitle: "post-process",
      tone: "compose",
      actions: [
        { id: "results-spectrum",     icon: icon(BarChart3), label: "Spectrum",      disabled: true, iconColor: "text-violet-400" },
        { id: "results-vortex-add",   icon: icon(Circle),    label: "Vortex",        disabled: true, iconColor: "text-cyan-400" },
        { id: "results-add-spectrum", icon: icon(Plus),      label: "Add Spectrum",  disabled: true, iconColor: "text-violet-400" },
        { id: "results-dispersion",   icon: icon(BarChart3), label: "Add Dispersion",disabled: true, iconColor: "text-sky-400" },
        { id: "results-modes",        icon: icon(Sigma),     label: "Add Modes",     disabled: true, iconColor: "text-teal-400" },
      ],
    },
    {
      id: "results-vortex",
      title: "Time Domain",
      subtitle: "traces",
      actions: [
        { id: "add-time-traces",icon: icon(BarChart3),  label: "Add Time Traces",  disabled: true, iconColor: "text-rose-400" },
        { id: "add-fft",        icon: icon(FunctionSquare), label: "Add FFT / PSD", disabled: true, iconColor: "text-violet-400" },
        { id: "add-trajectory", icon: icon(Move3D),     label: "Add Trajectory",   disabled: true, iconColor: "text-fuchsia-300" },
        { id: "add-orbit",      icon: icon(Circle),     label: "Add Orbit",         disabled: true, iconColor: "text-sky-400" },
      ],
    },
    {
      id: "results-workspaces",
      title: "Workspaces",
      subtitle: "tables",
      actions: [
        { id: "add-quantity-ws", icon: icon(Plus), label: "Add Quantity", disabled: true, iconColor: "text-teal-400" },
        { id: "add-table-ws",    icon: icon(ListChecks), label: "Add Table",    disabled: true, iconColor: "text-sky-400" },
      ],
    },
  ],
};

const automationTab: RibbonTabContent = {
  tabId: "automation",
  groups: [
    {
      id: "automation-sync",
      title: "Automation",
      subtitle: "round trip",
      tone: "sync",
      actions: [
        { id: "automation-sync-script", icon: icon(RefreshCw), label: "Sync Script", disabled: true, iconColor: "text-emerald-400", menu: [...statusMenu("automation-sync-status", "Script sync", "Local only"), separator("automation-sync-sep"), ...menu("automation-sync", "Sync", ["Review diff", "Apply to model", "Export canonical script"])] },
      ],
    },
  ],
};

type RibbonSessionStatus = {
  resources: Pick<
    LiveStatusResource["resources"],
    "field_revision" | "fields_revision"
  >;
};

export interface RibbonBuildContext {
  api?: { visualization: RibbonVisualizationApi };
  commandContext?: CommandContext;
  commands?: CommandRegistry;
  meshBuildCurrent?: MeshActiveBuildResource | null;
  meshBuildLatest?: MeshLastSuccessfulBuildResource | null;
  meshSemantics?: MeshSemanticsResource | null;
  meshSummary?: MeshSummaryResource | null;
  resources?: RibbonResourceInvalidator;
  selection: Selection;
  sessionStatus?: RibbonSessionStatus | null;
  sceneObjectIds?: ReadonlySet<string>;
  selectedMeshPart?: VisualizationMeshPartLike | null;
  visualization: ObjectVisualizationController;
  visualizationSnapshot: ObjectVisualizationSnapshot;
  visualizationState?: VisualizationStateResource | null;
}

export function resolveRibbonVisualizationTarget({
  sceneObjectIds = new Set(),
  selectedMeshPart,
  selection,
  visualizationState,
}: Pick<
  RibbonBuildContext,
  "sceneObjectIds" | "selectedMeshPart" | "selection" | "visualizationState"
>): VisualizationTargetRef | null {
  if (selection.ref?.type === "mesh-part" && selectedMeshPart) {
    return resolveVisualizationTargetForMeshPart({
      part: selectedMeshPart,
      sceneObjectIds,
      targetRegistry: visualizationState?.targets,
    });
  }

  if (selection.ref?.type === "mesh-part") {
    return {
      id: selection.ref.nodeId,
      kind: "part",
      label: selection.label,
    };
  }

  return resolveVisualizationTargetFromSelection(selection);
}

function resultsQuantityCommandInput(quantityId: string) {
  return globalQuantityCommandInput(quantityId);
}

function buildResultsQuantityGroup(
  group: RibbonTabContent["groups"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  const activeQuantityId = normalizeQuantityIdOrDefault(
    context.visualizationState?.quantity?.active_quantity_id ??
      context.visualizationState?.active_quantity_id,
  );
  const resultQuantityIds = new Map([
    ["res-m", "m"],
    ["res-heff", "H_eff"],
    ["res-demag", "H_demag"],
    ["res-exchange", "H_ex"],
    ["res-anis", "H_ani"],
    ["res-torque", "torque"],
    ["res-energy", "eden_total"],
  ]);

  return {
    ...group,
    actions: group.actions.map((action) => {
      const quantityId = resultQuantityIds.get(action.id);
      if (!quantityId) return action;
      return {
        ...action,
        active: sameQuantityId(activeQuantityId, quantityId),
        commandId: action.menu
          ? action.commandId
          : RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
        commandInput: action.menu
          ? action.commandInput
          : resultsQuantityCommandInput(quantityId),
        menu: action.menu?.map((node) =>
          node.type === "radio-group" && node.id === "results-quantity:radio"
            ? {
                ...node,
                value: activeQuantityId,
                commandId: RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
                commandInput: (value: string) =>
                  resultsQuantityCommandInput(value),
              }
            : node,
        ),
      };
    }),
  };
}

/** All tab content, indexed by tabId for O(1) lookup. */
export const ALL_TAB_CONTENT: Record<string, RibbonTabContent> = {
  home: homeTab,
  view: viewTab,
  definitions: definitionsTab,
  geometry: geometryTab,
  materials: materialsTab,
  physics: physicsTab,
  mesh: meshTab,
  study: studyTab,
  results: resultsTab,
  automation: automationTab,
};

export function buildRibbonTabContent(
  tabId: string,
  context?: RibbonBuildContext,
): RibbonTabContent | undefined {
  const content = ALL_TAB_CONTENT[tabId];
  if (!content) return undefined;
  let resolvedContent = content;

  if (tabId === "home" && context) {
    resolvedContent = {
      ...content,
      groups: content.groups.map((group) =>
        group.id === "workspace"
          ? buildHomeWorkspaceGroup(group, context)
          : group,
      ),
    };
  }

  if (tabId === "view" && context) {
    resolvedContent = {
      ...content,
      groups: content.groups.map((group) =>
        group.id === "view-global-display"
          ? buildViewGlobalDisplayGroup(group, context)
          : group.id === "view-orientation-tools"
            ? buildViewOrientationGroup(group, context)
          : group.id === "view-manipulate"
            ? buildViewManipulateGroup(group, context)
          : group.id === "view-slice-2d"
            ? buildViewSlice2DGroup(group, context)
          : group.id === "view-display"
            ? buildViewDisplayGroup(group, context)
          : group.id === "view-selected-display"
            ? buildSelectedVisualizationGroup(context)
            : group,
      ),
    };
  }

  if (tabId === "results" && context) {
    resolvedContent = {
      ...content,
      groups: content.groups.map((group) =>
        group.id === "quantity" ? buildResultsQuantityGroup(group, context) : group,
      ),
    };
  }

  if (tabId === "mesh" && context) {
    resolvedContent = buildMeshTabContent(content, context);
  }

  return context?.commands
    ? applyCommandState(resolvedContent, context)
    : resolvedContent;
}

function buildHomeWorkspaceGroup(
  group: RibbonTabContent["groups"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  return {
    ...group,
    actions: group.actions.map((action) =>
      action.id === "home-camera-rotation"
        ? buildCameraRotationModeAction(context)
        : action.id === "viewport-3d.open"
          ? {
              ...action,
              menu: action.menu?.map((node) =>
                node.type === "radio-group" && node.id === "home-workspace:radio"
                  ? {
                      ...node,
                      value: activeViewportMainModuleValue(context),
                    }
                  : node,
              ),
            }
        : action,
    ),
  };
}

function activeViewportMainModuleValue(context: RibbonBuildContext): string {
  const activeModuleId =
    context.commandContext?.layout?.get().activeViewportMainModuleId;
  if (activeModuleId === "cross-section-image") return "cross-section";
  if (activeModuleId === "analysis-plots") return "analysis";
  return "3d";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function meshBuildStatus(context: RibbonBuildContext): {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  const current = context.meshBuildCurrent;
  const activeStatus = resolveMeshBuildStatusLabel(
    asRecord(current?.active_build),
    normalizeMeshPipelineStatus(current?.mesh_pipeline_status),
  );
  if (activeStatus !== "idle") {
    return {
      label: activeStatus,
      tone: meshPipelineStatusTone(activeStatus),
    };
  }
  if (current?.last_build_error || context.meshBuildLatest?.last_build_error) {
    return { label: "failed", tone: "danger" };
  }
  if (context.meshBuildLatest?.last_success) {
    return { label: "ready", tone: "success" };
  }
  return { label: "not built", tone: "warning" };
}

function buildMeshTabContent(
  content: RibbonTabContent,
  context: RibbonBuildContext,
): RibbonTabContent {
  const status = meshBuildStatus(context);
  const summary = asRecord(context.meshSummary?.mesh_summary);
  const solverMesh = context.meshSemantics?.solver_mesh;
  const nodeCount = summary?.node_count;
  const elementCount = summary?.element_count;
  const objectPolicyCount = context.meshSemantics?.object_configs?.length ?? 0;

  return {
    ...content,
    groups: content.groups.map((group) => {
      if (group.id === "build") {
        return {
          ...group,
          subtitle: status.label,
          actions: group.actions.map((action) => {
            if (action.id === "mesh.build-selected") {
              return {
                ...action,
                active: status.label === "building" || status.label === "running",
                menu: [
                  {
                    type: "label",
                    id: "mesh-build-status:header",
                    label: "Mesh build",
                    badge: status.label,
                  },
                  {
                    type: "status",
                    id: "mesh-build-status:state",
                    label: "State",
                    value: status.label,
                    tone: status.tone,
                  },
                  {
                    type: "status",
                    id: "mesh-build-status:nodes",
                    label: "Nodes",
                    value: String(nodeCount ?? "unknown"),
                  },
                  {
                    type: "status",
                    id: "mesh-build-status:elements",
                    label: "Elements",
                    value: String(elementCount ?? "unknown"),
                  },
                  separator("mesh-build-status:sep"),
                  {
                    type: "item",
                    id: "mesh.build-selected:item",
                    label: "Build selected object mesh",
                    commandId: "mesh.build-selected",
                    shortcut: "Ctrl+B",
                  },
                  {
                    type: "item",
                    id: "mesh.build-shared-domain:item",
                    label: "Build shared-domain solver mesh",
                    commandId: "mesh.build-shared-domain",
                  },
                  separator("mesh-build-nav:sep"),
                  {
                    type: "item",
                    id: "mesh.open-builds:item",
                    label: "Open build pipeline",
                    commandId: "mesh.open-builds",
                  },
                ],
              };
            }
            if (action.id === "mesh-stats") {
              return {
                ...action,
                id: "mesh.open-overview",
                menu: [
                  {
                    type: "status",
                    id: "mesh-stats:mesh",
                    label: "Solver mesh",
                    value: solverMesh?.mesh_name ?? "not built",
                    tone: solverMesh ? "success" : "warning",
                  },
                  {
                    type: "status",
                    id: "mesh-stats:policies",
                    label: "Object policies",
                    value: String(objectPolicyCount),
                  },
                  {
                    type: "item",
                    id: "mesh.open-overview:item",
                    label: "Open mesh overview",
                    commandId: "mesh.open-overview",
                  },
                ],
              };
            }
            return action;
          }),
        };
      }
      if (group.id === "size") {
        return {
          ...group,
          actions: group.actions.map((action) =>
            action.id === "element-size"
              ? {
                  ...action,
                  id: "mesh.open-size-fields",
                  menu: [
                    {
                      type: "label",
                      id: "mesh-size:header",
                      label: "Size semantics",
                      badge: "resource-first",
                    },
                    {
                      type: "item",
                      id: "mesh.open-size-fields:item",
                      label: "Open realized size fields",
                      commandId: "mesh.open-size-fields",
                    },
                    {
                      type: "item",
                      id: "mesh.open-overview:size",
                      label: "Open mesh semantics",
                      commandId: "mesh.open-overview",
                    },
                  ],
                }
              : action,
          ),
        };
      }
      if (group.id === "method") {
        return {
          ...group,
          actions: group.actions.map((action) =>
            action.id === "quality"
              ? {
                  ...action,
                  id: "mesh.open-quality",
                  menu: [
                    {
                      type: "status",
                      id: "mesh-quality:status",
                      label: "Quality",
                      value: status.label,
                      tone: status.tone,
                    },
                    {
                      type: "item",
                      id: "mesh.open-quality:item",
                      label: "Open quality gates",
                      commandId: "mesh.open-quality",
                    },
                  ],
                }
              : action,
          ),
        };
      }
      if (group.id === "mesh-view") {
        return {
          ...group,
          actions: group.actions.map((action) => {
            if (action.id === "mesh-inspector") {
              return {
                ...action,
                id: "mesh.open-overview",
                menu: [
                  {
                    type: "item",
                    id: "mesh.open-shared-domain:item",
                    label: "Shared-domain mesh",
                    commandId: "mesh.open-shared-domain",
                  },
                  {
                    type: "item",
                    id: "mesh.open-regions:item",
                    label: "Regions and mesh parts",
                    commandId: "mesh.open-regions",
                  },
                  {
                    type: "item",
                    id: "mesh.open-quality:item",
                    label: "Quality gates",
                    commandId: "mesh.open-quality",
                  },
                ],
              };
            }
            if (action.id === "mesh-pipeline") {
              return {
                ...action,
                id: "mesh.open-builds",
              };
            }
            return action;
          }),
        };
      }
      return group;
    }),
  };
}

function applyCommandState(
  content: RibbonTabContent,
  context: RibbonBuildContext,
): RibbonTabContent {
  const commandContext = ribbonCommandContext(context);

  return {
    ...content,
    groups: content.groups.map((group) => ({
      ...group,
      actions: group.actions.map((action) => {
        const cmdId = action.commandId ?? action.id;
        const command = context.commands?.get(cmdId);
        const commandRequired = !action.menu?.length || Boolean(action.splitButton);
        const disabledByMissingCommand = commandRequired && !command;
        const disabledByCommand = command
          ? !context.commands?.isEnabled(cmdId, commandContext)
          : false;
        const disabledReason = disabledByMissingCommand
          ? `Command unavailable: ${action.label}`
          : disabledByCommand
            ? command?.disabledReason?.(commandContext) ??
              `Command unavailable: ${action.label}`
            : null;
        const activeResource = command?.activeResource?.(commandContext) ?? null;

        return {
          ...action,
          active:
            action.active ??
            (command ? context.commands?.isActive(cmdId, commandContext) : false),
          activeCommandId:
            activeResource?.kind === "command"
              ? activeResource.commandId
              : action.activeCommandId,
          disabled: action.disabled || disabledByMissingCommand || disabledByCommand,
          menu: action.menu?.map((node) =>
            applyCommandStateToMenuNode(node, context, commandContext),
          ),
          tooltip: disabledReason ?? action.tooltip,
        };
      }),
    })),
  };
}

function isCommandDisabled(
  commandId: string | undefined,
  context: RibbonBuildContext,
  commandContext: CommandContext,
): boolean {
  if (!commandId || !context.commands?.get(commandId)) return false;
  return !context.commands.isEnabled(commandId, commandContext);
}

function shouldDisableMissingCommand(
  commandId: string,
  context: RibbonBuildContext,
): boolean {
  return Boolean(context.commands && !context.commands.get(commandId));
}

function ribbonCommandContext(context: RibbonBuildContext): CommandContext {
  const base = context.commandContext ?? { source: "ribbon" as const };
  const resourceData = context.visualizationState
    ? {
        [VISUALIZATION_STATE_PATH]: context.visualizationState,
        ...base.resourceData,
      }
    : base.resourceData;
  const selectionController = base.selection as
    | { get?: () => Selection; set?: (...args: unknown[]) => void }
    | undefined;
  const selection = {
    get:
      typeof selectionController?.get === "function"
        ? () => selectionController.get?.() ?? context.selection
        : () => context.selection,
    set:
      typeof selectionController?.set === "function"
        ? (...args: unknown[]) => selectionController.set?.(...args)
        : () => undefined,
  } as unknown as CommandContext["selection"];

  return {
    ...base,
    api: (base.api ?? context.api) as CommandContext["api"],
    resourceData,
    resources: (base.resources ?? context.resources) as CommandContext["resources"],
    selection,
    visualization: base.visualization ?? context.visualization,
    visualizationTarget:
      base.visualizationTarget ?? resolveRibbonVisualizationTarget(context),
  };
}

function applyCommandStateToMenuNode(
  node: RibbonMenuNode,
  context: RibbonBuildContext,
  commandContext: CommandContext,
): RibbonMenuNode {
  if (node.type === "checkbox") {
    const cmdId = node.commandId ?? node.id;
    const command = context.commands?.get(cmdId);
    const disabledByMissingCommand = shouldDisableMissingCommand(cmdId, context);
    const disabledByCommand = isCommandDisabled(cmdId, context, commandContext);

    if (command) {
      return {
        ...node,
        checked: command.isActive
          ? context.commands?.isActive(cmdId, commandContext) ?? node.checked
          : node.checked,
        disabled: node.disabled || disabledByMissingCommand || disabledByCommand,
      };
    }

    return {
      ...node,
      disabled: node.disabled || disabledByMissingCommand || disabledByCommand,
    };
  }

  if (node.type === "item") {
    const cmdId = node.commandId ?? node.id;
    const disabledByMissingCommand = shouldDisableMissingCommand(cmdId, context);
    const disabledByCommand = isCommandDisabled(cmdId, context, commandContext);

    return {
      ...node,
      disabled: node.disabled || disabledByMissingCommand || disabledByCommand,
    };
  }

  if (node.type === "radio-group") {
    return {
      ...node,
      items: node.items.map((item) => ({
        ...item,
        disabled:
          item.disabled ||
          shouldDisableMissingCommand(
            item.commandId ?? node.commandId ?? node.id,
            context,
          ) ||
          isCommandDisabled(
            item.commandId ?? node.commandId ?? node.id,
            context,
            commandContext,
          ),
      })),
    };
  }

  if (node.type === "submenu") {
    return {
      ...node,
      nodes: node.nodes.map((child) =>
        applyCommandStateToMenuNode(child, context, commandContext),
      ),
    };
  }

  if (node.type === "slider") {
    const cmdId = node.commandId ?? node.id;
    const disabledByCommand = isCommandDisabled(
      cmdId,
      context,
      commandContext,
    );
    return {
      ...node,
      disabled:
        node.disabled ||
        shouldDisableMissingCommand(cmdId, context) ||
        disabledByCommand,
    };
  }

  if (node.type === "color") {
    const cmdId = node.commandId ?? node.id;
    const disabledByCommand = isCommandDisabled(
      cmdId,
      context,
      commandContext,
    );
    return {
      ...node,
      disabled:
        node.disabled ||
        shouldDisableMissingCommand(cmdId, context) ||
        disabledByCommand,
    };
  }

  if (node.type === "text") {
    const cmdId = node.commandId ?? node.id;
    const disabledByCommand = isCommandDisabled(
      cmdId,
      context,
      commandContext,
    );
    return {
      ...node,
      disabled:
        node.disabled ||
        shouldDisableMissingCommand(cmdId, context) ||
        disabledByCommand,
    };
  }

  return node;
}

function buildViewGlobalDisplayGroup(
  group: RibbonTabContent["groups"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  return {
    ...group,
    actions: group.actions.map((action) => {
      if (action.id === "view-surface") return buildSurfaceAction(context);
      if (action.id === "view-texture") return buildTextureAction(context);
      if (action.id === "view-quantity") return buildQuantityAction(context);
      if (action.id === "view-vectors") return buildVectorsAction(context);
      if (action.id === "view-airbox") return buildAirboxAction(context);
      if (action.id === "view-render-quality") return buildRenderQualityAction(context);
      if (action.id === "view-render-layers") return buildMeshViewAction(context);
      return action;
    }),
  };
}

function buildRenderQualityAction({
  commandContext = { source: "ribbon" },
  commands,
}: RibbonBuildContext): RibbonTabContent["groups"][number]["actions"][number] {
  const profile =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.profile-interactive-lite", "interactive-lite"],
      ["viewport-3d.profile-interactive", "interactive"],
      ["viewport-3d.profile-balanced", "balanced"],
      ["viewport-3d.profile-figure", "figure"],
      ["viewport-3d.profile-capture", "capture"],
    ]) ?? "interactive";

  return {
    id: "view-render-quality",
    icon: icon(Monitor),
    label: "Quality",
    active: profile !== "interactive",
    iconColor: "text-green-300",
    menu: [
      {
        type: "radio-group",
        id: "3d-quality:profile",
        label: "3D quality profile",
        value: profile,
        items: [
          {
            commandId: "viewport-3d.profile-interactive-lite",
            label: "Interactive Lite",
            value: "interactive-lite",
          },
          {
            commandId: "viewport-3d.profile-interactive",
            label: "Interactive",
            value: "interactive",
          },
          {
            commandId: "viewport-3d.profile-balanced",
            label: "Balanced",
            value: "balanced",
          },
          {
            commandId: "viewport-3d.profile-figure",
            label: "Figure",
            value: "figure",
          },
          {
            commandId: "viewport-3d.profile-capture",
            label: "Capture",
            value: "capture",
          },
        ],
      },
      { type: "separator", id: "3d-quality:s0" },
      {
        type: "item",
        id: "3d-quality:capture-frame",
        label: "Capture current frame",
        commandId: "viewport-3d.capture-frame",
      },
    ],
  };
}

function buildViewOrientationGroup(
  group: RibbonTabContent["groups"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  return {
    ...group,
    actions: group.actions.map((action) =>
      action.id === "view-hsl-reference"
        ? buildHslReferenceAction(context)
        : action,
    ),
  };
}

function buildViewSlice2DGroup(
  group: RibbonTabContent["groups"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  return {
    ...group,
    actions: group.actions.map((action) =>
      action.id === "view-slice-plane"
        ? buildSlicePlaneAction(action, context)
      : action.id === "view-slice-layers"
        ? buildSliceLayersAction(action, context)
      : action.id === "view-slice-quality"
        ? buildSliceQualityAction(action, context)
        : action,
    ),
  };
}

function buildSlicePlaneAction(
  action: RibbonTabContent["groups"][number]["actions"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const slice = context.visualizationState?.slice;
  return {
    ...action,
    active: Boolean(slice),
    disabled: !context.api,
    menu: [
      {
        type: "label",
        id: "slice:plane:header",
        label: "Slice plane",
        badge: slice?.axis.toUpperCase() ?? "XY",
      },
      {
        type: "radio-group",
        id: "slice:plane:axis",
        label: "Plane",
        value: slice?.axis ?? "z",
        items: CLIP_AXIS_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (axis: string) =>
          visualizationStateCommandInput({
            slice: { axis: axis as ClipAxis },
          }),
      },
      {
        type: "radio-group",
        id: "slice:plane:mode",
        label: "Mode",
        value: slice?.render_mode ?? "heatmap",
        items: SLICE_RENDER_MODE_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (renderMode: string) =>
          visualizationStateCommandInput({
            slice: { render_mode: renderMode as SliceRenderMode },
          }),
      },
      {
        type: "slider",
        id: "slice:plane:position",
        label: "Position",
        value: Math.min(100, Math.max(0, slice?.position_percent ?? 50)),
        min: 0,
        max: 100,
        step: 0.5,
        unit: "%",
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (positionPercent: number) =>
          visualizationStateCommandInput({
            slice: { position_percent: positionPercent },
          }),
      },
    ],
  };
}

function buildSliceLayersAction(
  action: RibbonTabContent["groups"][number]["actions"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const slice = context.visualizationState?.slice;
  return {
    ...action,
    active: Boolean(slice?.show_mesh || slice?.show_quantity || slice?.show_vectors),
    disabled: !context.api,
    menu: [
      {
        type: "checkbox",
        id: "slice:mesh:wireframe",
        label: "Mesh wireframe",
        checked: slice?.show_mesh ?? false,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (showMesh: boolean) =>
          visualizationStateCommandInput({
            slice: { show_mesh: showMesh },
          }),
      },
      {
        type: "checkbox",
        id: "slice:layers:quantity",
        label: "Quantity overlay",
        checked: slice?.show_quantity ?? true,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (showQuantity: boolean) =>
          visualizationStateCommandInput({
            slice: { show_quantity: showQuantity },
          }),
      },
      {
        type: "checkbox",
        id: "slice:layers:auto-contrast",
        label: "Auto-scale range",
        checked: slice?.auto_contrast ?? true,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (autoContrast: boolean) =>
          visualizationStateCommandInput({
            slice: { auto_contrast: autoContrast },
          }),
      },
    ],
  };
}

function buildSliceQualityAction(
  action: RibbonTabContent["groups"][number]["actions"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const slice = context.visualizationState?.slice;
  return {
    ...action,
    active: Boolean(slice),
    disabled: !context.api,
    menu: [
      {
        type: "radio-group",
        id: "slice:quality:metric",
        label: "Quality metric",
        value: slice?.mesh_quality_metric ?? "skewness",
        items: SLICE_MESH_QUALITY_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (metric: string) =>
          visualizationStateCommandInput({
            slice: { mesh_quality_metric: metric as SliceMeshQualityMetric },
          }),
      },
      {
        type: "radio-group",
        id: "slice:quality:color-scale",
        label: "Color scale",
        value: slice?.mesh_color_scale ?? "jet",
        items: SLICE_MESH_COLOR_SCALE_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (colorScale: string) =>
          visualizationStateCommandInput({
            slice: { mesh_color_scale: colorScale as SliceMeshColorScale },
          }),
      },
      {
        type: "text",
        id: "slice:quality:filter",
        label: "Element filter",
        value: slice?.mesh_filter_expression ?? "",
        placeholder: "quality < 0.3",
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (filterExpression: string) =>
          visualizationStateCommandInput({
            slice: { mesh_filter_expression: filterExpression },
          }),
      },
      {
        type: "slider",
        id: "slice:quality:shrink",
        label: "Shrink",
        value: Math.min(1, Math.max(0.5, slice?.mesh_shrink_factor ?? 1)),
        min: 0.5,
        max: 1,
        step: 0.05,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (shrinkFactor: number) =>
          visualizationStateCommandInput({
            slice: { mesh_shrink_factor: shrinkFactor },
          }),
      },
    ],
  };
}

function buildViewManipulateGroup(
  group: RibbonTabContent["groups"][number],
  { commandContext = { source: "ribbon" }, commands }: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  return {
    ...group,
    actions: group.actions.map((action) =>
      action.id === "viewport-3d.inspect-toggle"
        ? {
            ...action,
            active: Boolean(
              commands?.isActive("viewport-3d.inspect-toggle", commandContext),
            ),
          }
        : action,
    ),
  };
}

function buildViewDisplayGroup(
  group: RibbonTabContent["groups"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  return {
    ...group,
    actions: group.actions.map((action) =>
      action.id === "view-camera"
        ? buildViewCameraAction(context)
      : action.id === "view-dimension-frame"
        ? buildDimensionFrameAction(context)
      : action.id === "view-topography"
        ? buildTopographyAction(context)
        : action,
    ),
  };
}

function buildHslReferenceAction({
  commandContext = { source: "ribbon" },
  commands,
}: RibbonBuildContext): RibbonTabContent["groups"][number]["actions"][number] {
  const hslReferenceValue =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.hsl-reference-auto", "auto"],
      ["viewport-3d.hsl-reference-on", "on"],
      ["viewport-3d.hsl-reference-off", "off"],
    ]) ?? "auto";

  return {
    id: "view-hsl-reference",
    icon: icon(Target),
    label: "HSL Sphere",
    active: hslReferenceValue !== "off",
    iconColor: "text-fuchsia-300",
    menu: [
      {
        type: "radio-group",
        id: "orientation:hsl-reference",
        label: "Visibility",
        value: hslReferenceValue,
        items: [
          {
            commandId: "viewport-3d.hsl-reference-auto",
            label: "Auto",
            value: "auto",
          },
          {
            commandId: "viewport-3d.hsl-reference-on",
            label: "On",
            value: "on",
          },
          {
            commandId: "viewport-3d.hsl-reference-off",
            label: "Off",
            value: "off",
          },
        ],
      },
    ],
  };
}

function buildCameraRotationModeAction({
  commandContext = { source: "ribbon" },
  commands,
}: RibbonBuildContext): RibbonTabContent["groups"][number]["actions"][number] {
  const rotationMode =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.rotation-camera", "camera"],
      ["viewport-3d.rotation-object", "object"],
    ]) ?? "object";

  return {
    id: "home-camera-rotation",
    icon: icon(Camera),
    label: "Camera",
    active: rotationMode === "camera",
    iconColor: "text-sky-300",
    menu: [
      {
        type: "radio-group",
        id: "home-camera:rotation-mode",
        label: "Rotation mode",
        value: rotationMode,
        items: [
          {
            commandId: "viewport-3d.rotation-camera",
            label: "Free camera",
            value: "camera",
          },
          {
            commandId: "viewport-3d.rotation-object",
            label: "Object orbit",
            value: "object",
          },
        ],
      },
    ],
  };
}

function buildViewCameraAction({
  commandContext = { source: "ribbon" },
  commands,
}: RibbonBuildContext): RibbonTabContent["groups"][number]["actions"][number] {
  const rotationMode =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.rotation-camera", "camera"],
      ["viewport-3d.rotation-object", "object"],
    ]) ?? "object";

  return {
    id: "view-camera",
    icon: icon(Camera),
    label: "Camera",
    active: rotationMode === "camera",
    iconColor: "text-sky-300",
    menu: [
      {
        type: "item",
        id: "camera:parameters",
        label: "Camera parameters",
        commandId: "viewport-3d.open-camera-dialog",
      },
      {
        type: "radio-group",
        id: "view-camera:rotation-mode",
        label: "Rotation mode",
        value: rotationMode,
        items: [
          {
            commandId: "viewport-3d.rotation-camera",
            label: "Camera center",
            value: "camera",
          },
          {
            commandId: "viewport-3d.rotation-object",
            label: "Object target",
            value: "object",
          },
        ],
      },
      { type: "separator", id: "camera:rotation-separator" },
      { type: "item", id: "camera:focus", label: "Focus selected", disabled: true },
      { type: "item", id: "camera:frame-all", label: "Frame all", disabled: true },
    ],
  };
}

function buildTopographyAction({
  commandContext = { source: "ribbon" },
  commands,
}: RibbonBuildContext): RibbonTabContent["groups"][number]["actions"][number] {
  const enabled = Boolean(
    commands?.isActive("viewport-3d.fdm-topography-toggle", commandContext),
  );
  const component =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.fdm-topography-component-z", "z"],
      ["viewport-3d.fdm-topography-component-magnitude", "magnitude"],
      ["viewport-3d.fdm-topography-component-x", "x"],
      ["viewport-3d.fdm-topography-component-y", "y"],
    ]) ?? "z";

  return {
    id: "view-topography",
    icon: icon(Sparkles),
    label: "Topography",
    active: enabled,
    iconColor: "text-amber-300",
    menu: [
      { type: "label", id: "topography:header", label: "Topography", badge: "FDM" },
      {
        type: "checkbox",
        id: "topography:enabled",
        label: "Voxel topography",
        checked: enabled,
        commandId: "viewport-3d.fdm-topography-toggle",
      },
      {
        type: "slider",
        id: "topography:amplitude",
        label: "Amplitude",
        value: 0,
        min: -16,
        max: 16,
        step: 0.25,
        unit: "cells",
        commandId: "viewport-3d.fdm-topography-amplitude",
        commandInput: (value: number) => value,
      },
      {
        type: "radio-group",
        id: "topography:component",
        label: "Component",
        value: component,
        items: [
          {
            commandId: "viewport-3d.fdm-topography-component-z",
            label: "Z",
            value: "z",
          },
          {
            commandId: "viewport-3d.fdm-topography-component-magnitude",
            label: "Magnitude",
            value: "magnitude",
          },
          {
            commandId: "viewport-3d.fdm-topography-component-x",
            label: "X",
            value: "x",
          },
          {
            commandId: "viewport-3d.fdm-topography-component-y",
            label: "Y",
            value: "y",
          },
        ],
      },
    ],
  };
}

function activeCommandValue(
  commands: CommandRegistry | undefined,
  commandContext: CommandContext,
  candidates: Array<[commandId: string, value: string]>,
): string | null {
  return candidates.find(([commandId]) =>
    commands?.isActive(commandId, commandContext),
  )?.[1] ?? null;
}

function quantityLabel(quantityId: string): string {
  return (
    QUANTITY_ITEMS.find((item) => item.value === quantityId)?.label ??
    quantityId
  );
}

function surfaceColorSourceLabel(source: SurfaceColorSource): string {
  return (
    SURFACE_COLOR_SOURCE_ITEMS.find((item) => item.value === source)?.label ??
    source
  );
}

function surfaceFieldStatus(
  source: SurfaceColorSource,
  status: RibbonSessionStatus | null | undefined,
): {
  tone: "success" | "warning" | "danger" | "neutral";
  value: string;
} {
  if (source === "solid") {
    return { tone: "neutral", value: "not required" };
  }
  const revision = Math.max(
    typeof status?.resources.field_revision === "number"
      ? status.resources.field_revision
      : 0,
    typeof status?.resources.fields_revision === "number"
      ? status.resources.fields_revision
      : 0,
  );
  if (revision > 0) {
    return { tone: "success", value: `available r${revision}` };
  }
  return status
    ? { tone: "warning", value: "none" }
    : { tone: "neutral", value: "unknown" };
}

function buildSurfaceAction(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const settings = context.visualization.getDefaultSettings("object");
  const effectiveSettings = resolveEffectiveVisualizationSettings(settings);
  const passControlsDisabled = !settings.visible;

  return {
    id: "view-surface",
    icon: icon(Box),
    label: "Surface",
    iconColor: "text-teal-300",
    menu: [
      {
        type: "label",
        id: "surface:header",
        label: "Surface display",
        badge: effectiveSettings.shaderVisible ? "on" : "off",
      },
      {
        type: "status",
        id: "surface:scope",
        label: "Scope",
        value: "Global ferromagnet surface",
      },
      {
        type: "checkbox",
        id: "surface:visible",
        label: "Surface on/off",
        checked: effectiveSettings.shaderVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationDefaultsCommandInput({ shaderVisible: checked }),
      },
      { type: "separator", id: "surface:s0" },
      {
        type: "radio-group",
        id: "surface:mesh-display",
        label: "Render mode",
        value: settings.renderMode,
        items: MESH_RENDER_ITEMS,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (value: string) =>
          visualizationDefaultsCommandInput(
            renderModePatch(value as VisualizationRenderMode),
          ),
      },
      {
        type: "checkbox",
        id: "surface:wireframe",
        label: "Wireframe on/off",
        checked: effectiveSettings.wireframeVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationDefaultsCommandInput({ wireframeVisible: checked }),
      },
      {
        type: "checkbox",
        id: "surface:frame",
        label: "Frame on/off",
        checked: effectiveSettings.boundsVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationDefaultsCommandInput({ boundsVisible: checked }),
      },
      {
        type: "checkbox",
        id: "surface:points",
        label: "Points on/off",
        checked: effectiveSettings.pointsVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationDefaultsCommandInput({ pointsVisible: checked }),
      },
      {
        type: "slider",
        id: "surface:opacity",
        label: "Opacity",
        value: settings.opacityPercent,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (value: number) =>
          visualizationDefaultsCommandInput({ opacityPercent: value }),
      },
    ],
  };
}

function buildTextureAction(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const settings = context.visualization.getDefaultSettings("object");
  const fieldStatus = surfaceFieldStatus(
    settings.surfaceColorSource,
    context.sessionStatus,
  );
  const patch = (patchValue: VisualizationTargetPatch) =>
    visualizationDefaultsCommandInput(patchValue);

  return {
    id: "view-texture",
    icon: icon(Sparkles),
    label: "Texture",
    active: settings.surfaceColorSource !== "solid",
    iconColor: "text-purple-300",
    menu: [
      {
        type: "label",
        id: "texture:header",
        label: "Surface coloring",
        badge: surfaceColorSourceLabel(settings.surfaceColorSource),
      },
      {
        type: "radio-group",
        id: "texture:source",
        label: "Color source",
        value: settings.surfaceColorSource,
        items: SURFACE_COLOR_SOURCE_ITEMS,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (value: string) =>
          patch({ surfaceColorSource: value as SurfaceColorSource }),
      },
      { type: "separator", id: "texture:s0" },
      {
        type: "status",
        id: "texture:field-status",
        label: "Field status",
        tone: fieldStatus.tone,
        value: fieldStatus.value,
      },
    ],
  };
}

function buildQuantityAction(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const state = context.visualizationState;
  const activeQuantityId = normalizeQuantityIdOrDefault(
    state?.quantity?.active_quantity_id ?? state?.active_quantity_id,
  );
  const targetQuantityOverrideCount =
    state?.overrides?.filter((entry) => {
      const quantityId = entry.quantity?.active_quantity_id;
      return Boolean(quantityId && !sameQuantityId(quantityId, activeQuantityId));
    }).length ?? 0;
  const hasMixedTargetQuantities = targetQuantityOverrideCount > 0;
  const overlayVisible = state?.layers?.quantity_overlay?.visible ?? true;
  const autoContrast = state?.quantity?.auto_contrast ?? state?.auto_contrast ?? true;
  const colormap = state?.quantity?.colormap ?? state?.colormap ?? "viridis";
  const vectorColorMode =
    state?.vector_style?.color_mode ?? "orientation";
  return {
    id: "view-quantity",
    icon: icon(hasMixedTargetQuantities ? AlertTriangle : Sigma),
    label: "Quantity",
    iconColor: hasMixedTargetQuantities ? "text-amber-300" : "text-sky-300",
    disabled: !context.api,
    menu: [
      { type: "label", id: "quantity:header", label: "Active quantity" },
      {
        type: "status",
        id: "quantity:current",
        label: "Current",
        value: quantityLabel(activeQuantityId),
      },
      ...(hasMixedTargetQuantities
        ? [
            {
              type: "status" as const,
              id: "quantity:mixed-targets",
              label: "Target quantities",
              tone: "warning" as const,
              value: `${targetQuantityOverrideCount} target override${
                targetQuantityOverrideCount === 1 ? "" : "s"
              }`,
            },
          ]
        : []),
      {
        type: "checkbox",
        id: "quantity:overlay-visible",
        label: "Quantity overlay on/off",
        checked: overlayVisible,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationStateCommandInput({
            layers: { quantity_overlay: { visible: checked } },
          }),
      },
      { type: "separator", id: "quantity:s0" },
      {
        type: "radio-group",
        id: "quantity:source",
        label: "Quantity source",
        value: activeQuantityId,
        items: QUANTITY_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
        commandInput: (value: string) =>
          globalQuantityCommandInput(
            value,
            hasMixedTargetQuantities,
            hasMixedTargetQuantities,
            targetQuantityOverrideCount,
          ),
      },
      { type: "separator", id: "quantity:s1" },
      {
        type: "submenu",
        id: "quantity:colormap",
        label: "Colormap",
        disabled: !context.api,
        nodes: [
          {
            type: "radio-group",
            id: "quantity:shader",
            label: "Colormap",
            value: colormap,
            items: [
              { value: "viridis", label: "Viridis" },
              { value: "inferno", label: "Inferno" },
              { value: "magma", label: "Magma" },
              { value: "coolwarm", label: "Coolwarm" },
              { value: "jet", label: "Jet" },
            ],
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: string) =>
              visualizationStateCommandInput({
                colormap: value,
                quantity: { colormap: value },
              }),
          },
          {
            type: "checkbox",
            id: "quantity:auto-scale",
            label: "Auto-scale range",
            checked: autoContrast,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (checked: boolean) =>
              visualizationStateCommandInput({
                auto_contrast: checked,
                quantity: { auto_contrast: checked },
              }),
          },
          { type: "separator", id: "quantity:colormap:s0" },
          {
            type: "radio-group",
            id: "quantity:vector-coloring",
            label: "Vector coloring",
            value: vectorColorMode,
            items: VECTOR_COLOR_ITEMS,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: string) =>
              visualizationStateCommandInput({
                vector_style: { color_mode: value as VectorColorModePatch },
              }),
          },
          {
            type: "color",
            id: "quantity:vector-mono-color",
            label: "Monochrome vector color",
            value: state?.vector_style?.mono_color ?? "var(--fm-accent)",
            disabled: true,
          },
        ],
      },
    ],
  };
}

function buildVectorsAction(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const state = context.visualizationState;
  const vectorLayer = state?.layers?.vectors;
  const vectorStyle = state?.vector_style;
  const objectVectorSettings = context.visualization.getDefaultSettings("object");
  const objectVectorScope =
    context.visualizationSnapshot.defaults.object?.geometryScope ?? "full";
  const visible = vectorLayer?.visible ?? state?.vector_glyphs ?? false;
  const density =
    state?.sampling?.max_glyphs ??
    vectorLayer?.density ??
    state?.vector_density ??
    1200;
  const component = state?.field_component ?? state?.quantity?.field_component ?? "3D";

  return {
    id: "view-vectors",
    icon: icon(Zap),
    label: "Vectors",
    iconColor: "text-cyan-300",
    disabled: !context.api,
    menu: [
      {
        type: "label",
        id: "vectors:header",
        label: "Field arrows",
        badge: visible ? "on" : "off",
      },
      {
        type: "checkbox",
        id: "vectors:visible",
        label: "Show vectors / field arrows",
        checked: visible,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationStateCommandInput({
            layers: { vectors: { visible: checked } },
            vector_glyphs: checked,
          }),
      },
      {
        type: "slider",
        id: "vectors:density",
        label: "Vector glyph budget",
        value: density,
        min: 8,
        max: 4096,
        step: 8,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (value: number) =>
          visualizationStateCommandInput({
            layers: { vectors: { density: value } },
            sampling: { max_glyphs: value },
            vector_density: value,
          }),
      },
      {
        type: "radio-group",
        id: "vectors:geometry-scope",
        label: "Arrow extent",
        value: objectVectorScope,
        items: GEOMETRY_SCOPE_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (value: string) =>
          visualizationDefaultsCommandInput({
            geometryScope: value as VisualizationGeometryScope,
          }),
      },
      {
        type: "submenu",
        id: "vectors:placement",
        label: "Arrow placement",
        disabled: !context.api,
        nodes: [
          {
            type: "checkbox",
            id: "vectors:centered-anchor",
            label: "Center arrows on mesh nodes",
            checked: objectVectorSettings.vectorCenteringEnabled,
            commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
            commandInput: (checked: boolean) =>
              visualizationDefaultsCommandInput({
                vectorCenteringEnabled: checked,
              }),
          },
          {
            type: "checkbox",
            id: "vectors:surface-offset",
            label: "Lift surface arrows",
            checked: objectVectorSettings.vectorSurfaceOffsetEnabled,
            commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
            commandInput: (checked: boolean) =>
              visualizationDefaultsCommandInput({
                vectorSurfaceOffsetEnabled: checked,
              }),
          },
          {
            type: "slider",
            id: "vectors:surface-offset-scale",
            label: "Surface lift amount",
            value: objectVectorSettings.vectorSurfaceOffsetScale,
            min: 0.01,
            max: 1,
            step: 0.01,
            disabled: !context.api || !objectVectorSettings.vectorSurfaceOffsetEnabled,
            commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
            commandInput: (value: number) =>
              visualizationDefaultsCommandInput({
                vectorSurfaceOffsetScale: value,
              }),
          },
        ],
      },
      {
        type: "radio-group",
        id: "vectors:component",
        label: "Vector component",
        value: component,
        items: VECTOR_COMPONENT_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (value: string) =>
          visualizationStateCommandInput(
            value === "3D"
              ? {
                  field_component: null,
                  quantity: { field_component: null },
                }
              : {
                  field_component: value as FieldComponentPatch,
                  quantity: { field_component: value as FieldComponentPatch },
                },
          ),
      },
      {
        type: "submenu",
        id: "vectors:size",
        label: "Arrow size",
        disabled: !context.api,
        nodes: [
          {
            type: "slider",
            id: "vectors:length",
            label: "Length scale",
            value: vectorStyle?.length_scale ?? 1,
            min: 0.2,
            max: 4,
            step: 0.1,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: number) =>
              visualizationStateCommandInput({
                vector_style: { length_scale: value },
              }),
          },
          {
            type: "slider",
            id: "vectors:thickness",
            label: "Thickness",
            value: vectorStyle?.thickness ?? 1,
            min: 0.2,
            max: 4,
            step: 0.1,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: number) =>
              visualizationStateCommandInput({
                vector_style: { thickness: value },
              }),
          },
          {
            type: "slider",
            id: "vectors:alpha",
            label: "Alpha",
            value: vectorStyle?.alpha ?? 0.9,
            min: 0,
            max: 1,
            step: 0.05,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: number) =>
              visualizationStateCommandInput({
                vector_style: { alpha: value },
              }),
          },
        ],
      },
      {
        type: "radio-group",
        id: "vectors:domain",
        label: "Vector domain",
        value: vectorLayer?.domain ?? "auto",
        items: [
          { value: "auto", label: "Auto" },
          { value: "magnetic_only", label: "Magnetic objects only" },
          { value: "full_domain", label: "Full domain" },
          { value: "airbox_only", label: "Airbox only" },
        ],
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (value: string) =>
          visualizationStateCommandInput({
            layers: { vectors: { domain: value as VectorLayerDomainPatch } },
          }),
      },
      {
        type: "radio-group",
        id: "vectors:colors",
        label: "Vector colors",
        value: vectorStyle?.color_mode ?? "orientation",
        items: VECTOR_COLOR_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (value: string) =>
          visualizationStateCommandInput({
            vector_style: { color_mode: value as VectorColorModePatch },
          }),
      },
      {
        type: "color",
        id: "vectors:mono-color",
        label: "Monochrome vector color",
        value: vectorStyle?.mono_color ?? "var(--fm-accent)",
        disabled: true,
      },
    ],
  };
}

function buildMeshViewAction(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const layers = context.visualizationState?.layers;
  const meshMode = resolveMeshRenderMode({
    pointsVisible: layers?.points?.visible ?? false,
    shaderVisible: layers?.surface?.visible ?? true,
    wireframeVisible: layers?.wireframe?.visible ?? false,
  });
  const opacityPercent = layerOpacityPercent(
    layers?.surface?.opacity ??
      layers?.wireframe?.opacity ??
      layers?.points?.opacity ??
      1,
  );
  return {
    id: "view-render-layers",
    icon: icon(Layers3),
    label: "Mesh View",
    iconColor: "text-emerald-300",
    disabled: !context.api,
    menu: [
      {
        type: "radio-group",
        id: "layers:mesh-mode",
        label: "Mesh render mode",
        value: meshMode,
        items: MESH_RENDER_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (value: string) =>
          visualizationStateCommandInput(
            meshRenderModeVisualizationPatch(value as VisualizationRenderMode),
          ),
      },
      {
        type: "slider",
        id: "layers:opacity",
        label: "Mesh opacity",
        value: opacityPercent,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (value: number) => {
          const opacity = percentToLayerOpacity(value);
          return visualizationStateCommandInput({
            layers: {
              points: { opacity },
              surface: { opacity },
              wireframe: { opacity },
            },
          });
        },
      },
      {
        type: "submenu",
        id: "layers:trim",
        label: "3D trim",
        nodes: [
          { type: "checkbox", id: "trim:enabled", label: "TRIM enabled", checked: false },
          { type: "separator", id: "trim:s0" },
          { type: "label", id: "trim:x:label", label: "X axis", badge: "off" },
          { type: "checkbox", id: "trim:x:enabled", label: "X trim", checked: false },
          { type: "slider", id: "trim:x:min", label: "X min", value: 0, min: 0, max: 100, step: 1, unit: "%", disabled: true },
          { type: "slider", id: "trim:x:max", label: "X max", value: 100, min: 0, max: 100, step: 1, unit: "%", disabled: true },
          { type: "item", id: "trim:x:reset", label: "Reset X" },
          { type: "separator", id: "trim:x:sep" },
          { type: "label", id: "trim:y:label", label: "Y axis", badge: "off" },
          { type: "checkbox", id: "trim:y:enabled", label: "Y trim", checked: false },
          { type: "slider", id: "trim:y:min", label: "Y min", value: 0, min: 0, max: 100, step: 1, unit: "%", disabled: true },
          { type: "slider", id: "trim:y:max", label: "Y max", value: 100, min: 0, max: 100, step: 1, unit: "%", disabled: true },
          { type: "item", id: "trim:y:reset", label: "Reset Y" },
          { type: "separator", id: "trim:y:sep" },
          { type: "label", id: "trim:z:label", label: "Z axis", badge: "off" },
          { type: "checkbox", id: "trim:z:enabled", label: "Z trim", checked: false },
          { type: "slider", id: "trim:z:min", label: "Z min", value: 0, min: 0, max: 100, step: 1, unit: "%", disabled: true },
          { type: "slider", id: "trim:z:max", label: "Z max", value: 100, min: 0, max: 100, step: 1, unit: "%", disabled: true },
          { type: "item", id: "trim:z:reset", label: "Reset Z" },
          { type: "separator", id: "trim:s1" },
          { type: "item", id: "trim:reset-all", label: "Reset all" },
        ],
      },
    ],
  };
}

function meshRenderModeVisualizationPatch(
  renderMode: VisualizationRenderMode,
): VisualizationStatePatch {
  const patch = renderModePatch(renderMode);
  return {
    layers: {
      points: { visible: patch.pointsVisible ?? false },
      surface: { visible: patch.shaderVisible ?? false },
      wireframe: { visible: patch.wireframeVisible ?? false },
    },
  };
}

function resolveMeshRenderMode({
  pointsVisible,
  shaderVisible,
  wireframeVisible,
}: {
  pointsVisible: boolean;
  shaderVisible: boolean;
  wireframeVisible: boolean;
}): VisualizationRenderMode {
  if (pointsVisible && !shaderVisible && !wireframeVisible) return "points";
  if (!shaderVisible && wireframeVisible) return "wireframe";
  if (shaderVisible && wireframeVisible) return "surface+edges";
  return "surface";
}

function buildClipAction(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const clip = context.visualizationState?.clip ?? {
    axis: "z" as ClipAxis,
    enabled: false,
    flipped: false,
    position_percent: 50,
  };

  return {
    id: "view-selected-clip",
    icon: icon(Scissors),
    label: "Clip",
    active: clip.enabled,
    iconColor: "text-orange-300",
    disabled: !context.api,
    menu: [
      {
        type: "label",
        id: "selected-clip:header",
        label: "Global clip",
        badge: clip.enabled ? "on" : "off",
      },
      {
        type: "checkbox",
        id: "selected-clip:enabled",
        label: "Clip on/off",
        checked: clip.enabled,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (enabled: boolean) =>
          visualizationStateCommandInput({ clip: { enabled } }),
      },
      {
        type: "radio-group",
        id: "selected-clip:axis",
        label: "Plane",
        value: clip.axis,
        items: CLIP_AXIS_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (axis: string) =>
          visualizationStateCommandInput({
            clip: { axis: axis as ClipAxis, enabled: true },
          }),
      },
      {
        type: "slider",
        id: "selected-clip:position",
        label: "Position",
        value: Math.min(100, Math.max(0, clip.position_percent)),
        min: 0,
        max: 100,
        step: 0.5,
        unit: "%",
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (positionPercent: number) =>
          visualizationStateCommandInput({
            clip: {
              enabled: true,
              position_percent: positionPercent,
            },
          }),
      },
      {
        type: "checkbox",
        id: "selected-clip:flipped",
        label: "Flip clipped side",
        checked: clip.flipped,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (flipped: boolean) =>
          visualizationStateCommandInput({
            clip: { enabled: true, flipped },
          }),
      },
      { type: "separator", id: "selected-clip:presets-separator" },
      {
        type: "item",
        id: "selected-clip:mid-xy",
        label: "Mid XY",
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: visualizationStateCommandInput({
          clip: { axis: "z", enabled: true, position_percent: 50 },
        }),
      },
      {
        type: "item",
        id: "selected-clip:mid-xz",
        label: "Mid XZ",
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: visualizationStateCommandInput({
          clip: { axis: "y", enabled: true, position_percent: 50 },
        }),
      },
      {
        type: "item",
        id: "selected-clip:mid-yz",
        label: "Mid YZ",
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: visualizationStateCommandInput({
          clip: { axis: "x", enabled: true, position_percent: 50 },
        }),
      },
    ],
  };
}

function layerOpacityPercent(opacity: number): number {
  return Math.round(percentToLayerOpacity(opacity * 100) * 100);
}

function percentToLayerOpacity(percent: number): number {
  return Math.max(0, Math.min(1, percent / 100));
}

function buildAirboxAction(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number]["actions"][number] {
  const { commandContext, visualizationSnapshot } = context;
  const vectorLayer = context.visualizationState?.layers?.airbox?.vectors;
  const vectorStyle = context.visualizationState?.vector_style;
  const targetVisualization = resolveTargetVisualization({
    snapshot: visualizationSnapshot,
    target: AIRBOX_VISUALIZATION_TARGET,
    visualizationState: context.visualizationState,
  });
  const settings = targetVisualization.settings;
  const effectiveSettings = targetVisualization.effectiveSettings;
  const passControlsDisabled = !settings.visible;

  return {
    id: "view-airbox",
    icon: icon(Box),
    label: "Airbox",
    iconColor: "text-blue-300",
    disabled: false,
    menu: [
      {
        type: "label",
        id: "airbox:header",
        label: "Airbox display",
        badge: settings.visible ? "visible" : "hidden",
      },
      {
        type: "checkbox",
        id: "airbox:visible",
        label: "Airbox on/off",
        checked: settings.visible,
        disabled: false,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (checked: boolean) => visualizationAirboxCommandInput({ visible: checked }),
      },
      { type: "separator", id: "airbox:s-primitive" },
      {
        type: "label",
        id: "airbox:primitive-section",
        label: "Surface",
        badge: effectiveSettings.shaderVisible ? "on" : "off",
      },
      {
        type: "checkbox",
        id: "airbox:shaded",
        label: "Shaded on/off",
        checked: effectiveSettings.shaderVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationAirboxCommandInput({ shaderVisible: checked }),
      },
      {
        type: "checkbox",
        id: "airbox:wireframe",
        label: "Wireframe on/off",
        checked: effectiveSettings.wireframeVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationAirboxCommandInput({ wireframeVisible: checked }),
      },
      {
        type: "checkbox",
        id: "airbox:frame",
        label: "Frame on/off",
        checked: effectiveSettings.boundsVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationAirboxCommandInput({ boundsVisible: checked }),
      },
      {
        type: "radio-group",
        id: "airbox:wireframe-scope",
        label: "Wireframe extent",
        value: settings.geometryScope,
        items: GEOMETRY_SCOPE_ITEMS,
        disabled: passControlsDisabled || !effectiveSettings.wireframeVisible,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (value: string) =>
          visualizationAirboxCommandInput({
            geometryScope: value as VisualizationGeometryScope,
          }),
      },
      { type: "separator", id: "airbox:s-points" },
      {
        type: "label",
        id: "airbox:points-section",
        label: "Points",
        badge: effectiveSettings.pointsVisible ? "on" : "off",
      },
      {
        type: "checkbox",
        id: "airbox:points",
        label: "Points on/off",
        checked: effectiveSettings.pointsVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationAirboxCommandInput({ pointsVisible: checked }),
      },
      {
        type: "radio-group",
        id: "airbox:points-scope",
        label: "Points extent",
        value: "surface",
        items: AIRBOX_EXTENT_ITEMS,
        disabled: true,
      },
      { type: "separator", id: "airbox:s-vectors" },
      {
        type: "label",
        id: "airbox:vectors-section",
        label: "Vectors",
        badge: effectiveSettings.vectorsVisible ? "on" : "off",
      },
      {
        type: "checkbox",
        id: "airbox:vectors",
        label: "Vectors on/off",
        checked: effectiveSettings.vectorsVisible,
        disabled: passControlsDisabled,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationAirboxCommandInput({ vectorsVisible: checked }),
      },
      {
        type: "radio-group",
        id: "airbox:vectors-scope",
        label: "Vectors extent",
        value: settings.geometryScope,
        items: GEOMETRY_SCOPE_ITEMS,
        disabled: passControlsDisabled || !effectiveSettings.vectorsVisible,
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (value: string) =>
          visualizationAirboxCommandInput({
            geometryScope: value as VisualizationGeometryScope,
          }),
      },
      {
        type: "submenu",
        id: "airbox:vectors-submenu",
        label: "Airbox vectors",
        nodes: [
          {
            type: "slider",
            id: "airbox:vectors-density",
            label: "Density / Every N",
            value: vectorLayer?.density ?? 128,
            min: 8,
            max: 4096,
            step: 8,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: number) =>
              visualizationStateCommandInput({
                layers: {
                  airbox: {
                    vectors: {
                      density: value,
                      domain: "airbox_only",
                    },
                  },
                },
              }),
          },
          {
            type: "slider",
            id: "airbox:vectors-length",
            label: "Length scale",
            value: settings.vectorLengthScale,
            min: 0.2,
            max: 4,
            step: 0.1,
            commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
            commandInput: (value: number) =>
              visualizationAirboxCommandInput({ vectorLengthScale: value }),
          },
          {
            type: "slider",
            id: "airbox:vectors-thickness",
            label: "Thickness",
            value: settings.vectorThickness,
            min: 0.2,
            max: 4,
            step: 0.1,
            commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
            commandInput: (value: number) =>
              visualizationAirboxCommandInput({ vectorThickness: value }),
          },
          {
            type: "slider",
            id: "airbox:vectors-alpha",
            label: "Alpha",
            value: vectorStyle?.alpha ?? 0.9,
            min: 0,
            max: 1,
            step: 0.05,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: number) =>
              visualizationStateCommandInput({
                vector_style: { alpha: value },
              }),
          },
        ],
      },
      {
        type: "submenu",
        id: "airbox:vector-colors",
        label: "Airbox vector colors",
        nodes: [
          {
            type: "radio-group",
            id: "airbox:vector-coloring",
            label: "Vector colors",
            value: vectorStyle?.color_mode ?? "orientation",
            items: VECTOR_COLOR_ITEMS,
            commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
            commandInput: (value: string) =>
              visualizationStateCommandInput({
                vector_style: { color_mode: value as VectorColorModePatch },
              }),
          },
          {
            type: "color",
            id: "airbox:vector-mono-color",
            label: "Monochrome vector color",
            value: vectorStyle?.mono_color ?? "var(--fm-accent)",
            disabled: true,
          },
        ],
      },
      { type: "separator", id: "airbox:s-visible" },
      {
        type: "slider",
        id: "airbox:opacity",
        label: "Opacity",
        value: settings.opacityPercent,
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        commandId: RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
        commandInput: (value: number) =>
          visualizationAirboxCommandInput({ opacityPercent: value }),
      },
      { type: "separator", id: "airbox:s0" },
      {
        type: "item",
        id: "airbox:focus",
        label: "Focus airbox",
        disabled: !commandContext?.selection,
        commandId: RIBBON_SELECTION_FOCUS_AIRBOX_COMMAND,
      },
      {
        type: "item",
        id: "airbox:reset",
        label: "Reset airbox display",
        commandId: RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND,
      },
    ],
  };
}

function buildDimensionFrameAction({
  commandContext = { source: "ribbon" },
  commands,
  visualization,
}: RibbonBuildContext): RibbonTabContent["groups"][number]["actions"][number] {
  const objectSettings = visualization.getDefaultSettings("object");
  const partSettings = visualization.getDefaultSettings("part");
  const objectFrameVisible =
    objectSettings.boundsVisible && partSettings.boundsVisible;
  const dimensionMode =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.dimension-frame-floor", "floor"],
      ["viewport-3d.dimension-frame-cage", "cage"],
      ["viewport-3d.dimension-frame-off", "off"],
    ]) ?? "floor";
  const gridDensity =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.dimension-density-auto", "auto"],
      ["viewport-3d.dimension-density-coarse", "coarse"],
      ["viewport-3d.dimension-density-fine", "fine"],
    ]) ?? "auto";
  const scaleUnit =
    activeCommandValue(commands, commandContext, [
      ["viewport-3d.scale-unit-auto", "auto"],
      ["viewport-3d.scale-unit-nm", "nm"],
      ["viewport-3d.scale-unit-um", "um"],
      ["viewport-3d.scale-unit-mm", "mm"],
      ["viewport-3d.scale-unit-m", "m"],
    ]) ?? "auto";
  const scaleLabelsVisible = commands?.get("viewport-3d.scale-labels-toggle")
    ? commands.isActive("viewport-3d.scale-labels-toggle", commandContext)
    : true;

  return {
    id: "view-dimension-frame",
    icon: icon(Ruler),
    label: "Frame",
    active: dimensionMode !== "off" || objectFrameVisible,
    iconColor: "text-emerald-300",
    menu: [
      {
        type: "radio-group",
        id: "frame:dimension-mode",
        label: "Dimension grid",
        value: dimensionMode,
        items: [
          {
            commandId: "viewport-3d.dimension-frame-floor",
            value: "floor",
            label: "Floor",
          },
          {
            commandId: "viewport-3d.dimension-frame-cage",
            value: "cage",
            label: "Floor + vertical",
          },
          {
            commandId: "viewport-3d.dimension-frame-off",
            value: "off",
            label: "Off",
          },
        ],
      },
      {
        type: "radio-group",
        id: "frame:grid-density",
        label: "Grid density",
        value: gridDensity,
        items: [
          {
            commandId: "viewport-3d.dimension-density-auto",
            value: "auto",
            label: "Auto",
          },
          {
            commandId: "viewport-3d.dimension-density-coarse",
            value: "coarse",
            label: "Coarse",
          },
          {
            commandId: "viewport-3d.dimension-density-fine",
            value: "fine",
            label: "Fine",
          },
        ],
      },
      {
        type: "checkbox",
        id: "frame:scale-labels",
        label: "Scale labels",
        checked: scaleLabelsVisible,
        commandId: "viewport-3d.scale-labels-toggle",
      },
      {
        type: "radio-group",
        id: "frame:scale-unit",
        label: "Scale unit",
        value: scaleUnit,
        items: [
          {
            commandId: "viewport-3d.scale-unit-auto",
            value: "auto",
            label: "Auto",
          },
          {
            commandId: "viewport-3d.scale-unit-nm",
            value: "nm",
            label: "nm",
          },
          {
            commandId: "viewport-3d.scale-unit-um",
            value: "um",
            label: "um",
          },
          {
            commandId: "viewport-3d.scale-unit-mm",
            value: "mm",
            label: "mm",
          },
          {
            commandId: "viewport-3d.scale-unit-m",
            value: "m",
            label: "m",
          },
        ],
      },
      { type: "separator", id: "frame:display-separator" },
      {
        type: "checkbox",
        id: "frame:object-bounds",
        label: "Object frame",
        checked: objectFrameVisible,
        disabled: false,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (checked: boolean) =>
          visualizationDefaultsCommandInput({ boundsVisible: checked }),
      },
    ],
  };
}

function buildSelectedVisualizationGroup(
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  const { selection, visualizationSnapshot } = context;
  const target = resolveRibbonVisualizationTarget(context);
  const inheritedRegionSettings =
    target?.kind === "region" && selection.objectId
      ? resolveTargetVisualization({
          snapshot: visualizationSnapshot,
          target: {
            id: selection.objectId,
            kind: "object",
            label: selection.label ?? selection.objectId,
          },
          visualizationState: context.visualizationState,
        }).settings
      : undefined;
  const targetVisualization = target
    ? resolveTargetVisualization({
        inheritedSettings: inheritedRegionSettings,
        snapshot: visualizationSnapshot,
        target,
        visualizationState: context.visualizationState,
      })
    : null;
  const settings = targetVisualization?.settings ?? null;
  const effectiveSettings = targetVisualization?.effectiveSettings ?? null;
  const passControlsDisabled = !settings?.visible;
  const enabled = Boolean(target && settings);
  const targetLabel = target
    ? displayLabelForVisualizationTarget(target)
    : "No selection";
  const targetBadge = target?.kind ?? "none";
  const targetDefaults =
    target?.kind === "airbox"
      ? DEFAULT_AIRBOX_VISUALIZATION
      : DEFAULT_OBJECT_VISUALIZATION;
  const targetOverride = targetVisualization?.override ?? null;
  const hasSurfaceColorOverride = Boolean(
    targetOverride &&
      ("surfaceColorSource" in targetOverride ||
        "shaderColorMode" in targetOverride),
  );
  const selectedSurfaceColorSource = hasSurfaceColorOverride
    ? settings?.surfaceColorSource ?? targetDefaults.surfaceColorSource
    : "inherit";
  const selectedFieldStatus = surfaceFieldStatus(
    settings?.surfaceColorSource ?? targetDefaults.surfaceColorSource,
    context.sessionStatus,
  );
  const selectedQuantityId = normalizeQuantityIdOrDefault(
    settings?.activeQuantityId ??
      context.visualizationState?.quantity?.active_quantity_id ??
      context.visualizationState?.active_quantity_id,
  );
  const selectedQuantityItems = quantityItemsForVisualizationTarget(
    selectedQuantityId,
    target?.kind,
  );
  const targetQuantityPatch = (value: string): VisualizationTargetPatch => {
    const activeQuantityId = normalizeQuantityIdOrDefault(value);
    const surfaceColorSource = defaultSurfaceColorSourceForQuantity(
      activeQuantityId,
      settings?.vectorColorMode ?? targetDefaults.vectorColorMode,
    );
    return {
      activeQuantityId,
      ...(isScalarSpatialQuantityId(activeQuantityId) ||
      settings?.surfaceColorSource === "colormap"
        ? { surfaceColorSource }
        : {}),
    };
  };
  const selectedVectorScope =
    targetVisualization?.override?.geometryScope ??
    (target
      ? visualizationSnapshot.defaults[target.kind]?.geometryScope
      : undefined) ??
    "full";
  const revision = targetVisualization?.revision ?? `${visualizationSnapshot.version}`;

  return {
    id: "view-selected-display",
    title: "Selected Display",
    subtitle: "Per object",
    tone: "selection",
    actions: [
      {
        id: "view-selected-texture",
        icon: icon(Sparkles),
        label: "Coloring",
        iconColor: "text-teal-300",
        disabled: !enabled,
        menu: [
          {
            type: "label",
            id: "selected-texture:header",
            label: "Selected coloring",
            badge: targetBadge,
          },
          {
            type: "status",
            id: "selected-texture:state",
            label: "Target",
            value: targetLabel,
          },
          {
            type: "radio-group",
            id: "selected-texture:quantity",
            label: "Quantity source",
            value: selectedQuantityId,
            items: selectedQuantityItems,
            disabled: !enabled || !target,
            commandId: RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
            commandInput: (value: string) =>
              target
                ? visualizationTargetCommandInput(target, targetQuantityPatch(value))
                : value,
          },
          {
            type: "checkbox",
            id: "selected-texture:visible",
            label: "Surface on/off",
            checked: effectiveSettings?.shaderVisible ?? false,
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-surface-visible",
            commandInput: (checked: boolean) => checked,
          },
          {
            type: "radio-group",
            id: "selected-texture:surface-coloring",
            label: "Color source",
            value: selectedSurfaceColorSource,
            items: SELECTED_SURFACE_COLOR_SOURCE_ITEMS,
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.shaderVisible,
            commandId: "visualization.target.set-surface-color-source",
            commandInput: (value: unknown) => value,
          },
          {
            type: "color",
            id: "selected-texture:solid-color",
            label: "Solid color",
            value: settings?.shaderMonoColor ?? targetDefaults.shaderMonoColor,
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.shaderVisible,
            commandId: "visualization.target.set-shader-mono-color",
            commandInput: (value: unknown) => value,
          },
          {
            type: "status",
            id: "selected-texture:field-status",
            label: "Field status",
            tone: selectedFieldStatus.tone,
            value: selectedFieldStatus.value,
          },
          { type: "separator", id: "selected-texture:vectors-separator" },
          {
            type: "checkbox",
            id: "selected-texture:vectors",
            label: "Vectors on/off",
            checked: effectiveSettings?.vectorsVisible ?? false,
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-vectors-visible",
            commandInput: (checked: boolean) => checked,
          },
          {
            type: "radio-group",
            id: "selected-texture:vector-scope",
            label: "Vector extent",
            value: selectedVectorScope,
            items: GEOMETRY_SCOPE_ITEMS.map((item) => ({
              ...item,
            })),
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.vectorsVisible,
            commandId: "visualization.target.set-geometry-scope",
            commandInput: (value: unknown) => value,
          },
          {
            type: "radio-group",
            id: "selected-texture:vector-coloring",
            label: "Vector coloring",
            value: settings?.vectorColorMode ?? "orientation",
            items: VECTOR_COLOR_ITEMS.map((item) => ({
              ...item,
            })),
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.vectorsVisible,
            commandId: "visualization.target.set-vector-color-mode",
            commandInput: (value: unknown) => value,
          },
          {
            type: "color",
            id: "selected-texture:vector-mono-color",
            label: "Vector mono color",
            value: settings?.vectorMonoColor ?? targetDefaults.vectorMonoColor,
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.vectorsVisible,
            commandId: "visualization.target.set-vector-mono-color",
            commandInput: (value: unknown) => value,
          },
          {
            type: "slider",
            id: "selected-texture:vector-alpha",
            label: "Vector alpha",
            value: settings?.vectorAlphaPercent ?? 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.vectorsVisible,
            commandId: "visualization.target.set-vector-alpha-percent",
            commandInput: (value: unknown) => value,
          },
          {
            type: "slider",
            id: "selected-texture:vector-thickness",
            label: "Vector thickness",
            value: settings?.vectorThickness ?? 1,
            min: 0.1,
            max: 8,
            step: 0.1,
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.vectorsVisible,
            commandId: "visualization.target.set-vector-thickness",
            commandInput: (value: unknown) => value,
          },
        ],
      },
      {
        id: "view-selected-render",
        icon: icon(BoxSelect),
        label: "Render",
        iconColor: "text-amber-300",
        disabled: !enabled,
        menu: [
          {
            type: "label",
            id: "selected:header",
            label: "Selected object",
            badge: targetBadge,
          },
          {
            type: "status",
            id: "selected:state",
            label: "Target",
            value: `${targetLabel} r${revision}`,
            tone: enabled ? "success" : "warning",
          },
          {
            type: "checkbox",
            id: "selected:visible",
            label: "Target visible",
            checked: settings?.visible ?? false,
            disabled: !enabled,
            commandId: "visualization.target.set-visible",
            commandInput: (checked: boolean) => checked,
          },
          {
            type: "radio-group",
            id: "selected:render-mode",
            label: "Render mode",
            value: settings?.renderMode ?? "surface",
            disabled: !enabled || passControlsDisabled,
            items: SELECTED_RENDER_ITEMS.map((item) => ({
              ...item,
            })),
            commandId: "visualization.target.set-render-mode",
            commandInput: (value: unknown) => value,
          },
          {
            type: "radio-group",
            id: "selected:geometry-scope",
            label: "Geometry scope",
            value: settings?.geometryScope ?? "full",
            disabled: !enabled || passControlsDisabled,
            items: GEOMETRY_SCOPE_ITEMS.map((item) => ({
              ...item,
            })),
            commandId: "visualization.target.set-geometry-scope",
            commandInput: (value: unknown) => value,
          },
          {
            type: "checkbox",
            id: "selected:wireframe",
            label: "Wireframe on/off",
            checked: effectiveSettings?.wireframeVisible ?? false,
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-wireframe-visible",
            commandInput: (checked: boolean) => checked,
          },
          {
            type: "color",
            id: "selected:wireframe-color",
            label: "Wireframe color",
            value: settings?.wireframeColor ?? targetDefaults.wireframeColor,
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.wireframeVisible,
            commandId: "visualization.target.set-wireframe-color",
            commandInput: (value: unknown) => value,
          },
          {
            type: "slider",
            id: "selected:wireframe-opacity",
            label: "Wireframe opacity",
            value: settings?.wireframeOpacityPercent ?? 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.wireframeVisible,
            commandId: "visualization.target.set-wireframe-opacity-percent",
            commandInput: (value: unknown) => value,
          },
          {
            type: "checkbox",
            id: "selected:frame",
            label: "Frame on/off",
            checked: effectiveSettings?.boundsVisible ?? false,
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-bounds-visible",
            commandInput: (checked: boolean) => checked,
          },
          {
            type: "checkbox",
            id: "selected:points",
            label: "Points on/off",
            checked: effectiveSettings?.pointsVisible ?? false,
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-points-visible",
            commandInput: (checked: boolean) => checked,
          },
          {
            type: "color",
            id: "selected:point-color",
            label: "Point color",
            value: settings?.pointColor ?? targetDefaults.pointColor,
            disabled:
              !enabled ||
              passControlsDisabled ||
              !effectiveSettings?.pointsVisible,
            commandId: "visualization.target.set-point-color",
            commandInput: (value: unknown) => value,
          },
          {
            type: "item",
            id: "selected:clear",
            label: "Clear per-object overrides",
            disabled: !enabled,
            commandId: "visualization.target.clear-overrides",
          },
        ],
      },
      buildClipAction(context),
      {
        id: "view-selected-opacity",
        icon: icon(Blend),
        label: "Opacity",
        iconColor: "text-lime-300",
        disabled: !enabled || passControlsDisabled,
        menu: [
          {
            type: "slider",
            id: "selected-opacity:slider",
            label: "Opacity",
            value: settings?.opacityPercent ?? 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: (value: unknown) => value,
          },
          {
            type: "item",
            id: "selected-opacity:100",
            label: "100%",
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 100,
          },
          {
            type: "item",
            id: "selected-opacity:70",
            label: "70%",
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 70,
          },
          {
            type: "item",
            id: "selected-opacity:35",
            label: "35%",
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 35,
          },
          {
            type: "item",
            id: "selected-opacity:15",
            label: "Ghost 15%",
            disabled: !enabled || passControlsDisabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 15,
          },
        ],
      },
    ],
  };
}
