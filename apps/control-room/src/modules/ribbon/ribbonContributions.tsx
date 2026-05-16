import {
  Activity,
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
import type { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  AIRBOX_VISUALIZATION_TARGET,
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
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
  type VisualizationTargetPatch,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  meshPipelineStatusTone,
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";
import { allInteractionSpecs } from "@/shared/domain/physics/interactions";

import type { RibbonMenuNode, RibbonTabContent } from "./ribbonTypes";
import {
  RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
  RIBBON_SELECTION_FOCUS_AIRBOX_COMMAND,
  RIBBON_VISUALIZATION_PATCH_AIRBOX_COMMAND,
  RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
  RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
  RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND,
  visualizationAirboxCommandInput,
  visualizationDefaultsCommandInput,
  visualizationStateCommandInput,
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

export const homeTab: RibbonTabContent = {
  tabId: "home",
  groups: [
    {
      id: "project",
      title: "Project",
      subtitle: "files",
      tone: "neutral",
      actions: [
        { id: "open",       icon: icon(FileText),            label: "Open",      shortcut: "Ctrl+O", disabled: true, iconColor: C.blue, menu: menu("home-open", "Project", [["New problem", "Ctrl+N"], ["Open project", "Ctrl+O"], "Open example", "Recent sessions"]) },
        { id: "vis-preset", icon: icon(Sparkles),            label: "3D Visual", disabled: true,                     iconColor: C.lavender, menu: menu("home-visual", "Visual preset", ["Publication figure", "Live control room", "Debug overlays"]) },
      ],
    },
    {
      id: "workspace",
      title: "Workspace",
      subtitle: "layout",
      tone: "neutral",
      actions: [
        { id: "ws-3d",      icon: icon(Box),       label: "3D",      shortcut: "1", active: true, iconColor: "text-indigo-400", menu: radioMenu("home-workspace", "Workspace mode", "3d", [["3d", "3D viewport"], ["2d", "2D slice"], ["analysis", "Analysis"]]) },
        { id: "ws-2d",      icon: icon(Columns2),  label: "2D",      shortcut: "2",               iconColor: C.sky },
        { id: "ws-analyze", icon: icon(BarChart3), label: "Analyze",                               iconColor: C.green },
        { id: "ws-panel",   icon: icon(PanelRight),label: "Panel",   shortcut: "Ctrl+B", menu: menu("home-panels", "Panels", ["Explorer", "Inspector", "Bottom dock", "Reset layout"]) },
        { id: "ws-focus",   icon: icon(Eye),       label: "Focus",   disabled: true,               iconColor: C.teal },
      ],
    },
    {
      id: "compute",
      title: "Compute",
      subtitle: "runtime",
      tone: "compute",
      actions: [
        { id: "run",   icon: icon(Play,        { fill: "currentColor" }), label: "Compute", shortcut: "F5", accent: true, disabled: true, splitButton: true, iconColor: "text-cyan-400", menu: [...statusMenu("home-runtime", "Runtime", "No session"), separator("home-runtime:sep"), ...radioMenu("home-target", "Execution target", "auto", [["auto", "Auto"], ["cpu", "CPU"], ["gpu", "GPU"]])] },
        { id: "pause", icon: icon(Pause,       { fill: "currentColor" }), label: "Pause",                  disabled: true, iconColor: C.yellow },
        { id: "stop",  icon: icon(Square,      { fill: "currentColor" }), label: "Stop",                   disabled: true, iconColor: C.red },
        { id: "skip",  icon: icon(SkipForward),                           label: "Skip",                   disabled: true, iconColor: C.peach },
      ],
    },
  ],
};

const QUANTITY_ITEMS = [
  { value: "m",             label: "Magnetization / m" },
  { value: "H_eff",         label: "Effective field / H_eff" },
  { value: "H_demag",       label: "Demag field / H_demag" },
  { value: "H_ex",          label: "Exchange field / H_ex" },
  { value: "H_anis",        label: "Anisotropy field / H_anis" },
  { value: "energy_density",label: "Energy density" },
];

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

export const viewTab: RibbonTabContent = {
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

    // ── Group 3: 2D Slice ──────────────────────────────────────────────────
    {
      id: "view-slice-2d",
      title: "2D Slice",
      subtitle: "2D controls",
      tone: "neutral",
      actions: [
        {
          id: "view-slice-quantity",
          icon: icon(Sigma),
          label: "Quantity",
          iconColor: "text-sky-300",
          menu: [
            { type: "label",   id: "slice:quantity:header",    label: "Slice quantity", badge: "m" },
            { type: "radio-group", id: "slice:quantity:source", label: "Quantity source", value: "m", items: QUANTITY_ITEMS },
            { type: "radio-group", id: "slice:quantity:component", label: "Component", value: "magnitude",
              items: [
                { value: "magnitude", label: "Magnitude |v|" },
                { value: "x",         label: "X" },
                { value: "y",         label: "Y" },
                { value: "z",         label: "Z" },
              ],
            },
            { type: "checkbox", id: "slice:quantity:overlay",    label: "Quantity overlay", checked: true },
            { type: "checkbox", id: "slice:quantity:auto-scale", label: "Auto-scale range", checked: true },
          ],
        },
        {
          id: "view-slice-vectors",
          icon: icon(Zap),
          label: "Vectors",
          iconColor: "text-cyan-300",
          menu: [
            { type: "checkbox",    id: "slice:vectors:visible",       label: "Show vectors",            checked: false },
            { type: "slider",      id: "slice:vectors:density",       label: "Every N",                 value: 4, min: 1, max: 64, step: 1 },
            { type: "radio-group", id: "slice:vectors:colors",        label: "Vector coloring",         value: "orientation", items: VECTOR_COLOR_ITEMS },
            { type: "color",       id: "slice:vectors:mono-color",    label: "Monochrome vector color", value: "var(--fm-accent)", disabled: true },
          ],
        },
        {
          id: "view-slice-airbox",
          icon: icon(Box),
          label: "Airbox",
          iconColor: "text-fuchsia-300",
          menu: [
            { type: "label",    id: "slice:airbox:header",  label: "2D airbox", badge: "hidden" },
            { type: "checkbox", id: "slice:airbox:visible", label: "Airbox on/off", checked: false },
            {
              type: "radio-group",
              id: "slice:airbox:render-mode",
              label: "Airbox render",
              value: "wireframe",
              items: [
                { value: "surface",       label: "Shaded",         disabled: true },
                { value: "wireframe",     label: "Wireframe" },
                { value: "surface+edges", label: "Shaded + wireframe", disabled: true },
                { value: "points",        label: "Points",         disabled: true },
              ],
            },
            { type: "checkbox", id: "slice:airbox:vectors", label: "Vectors", checked: false, disabled: true },
          ],
        },
        {
          id: "view-slice-layers",
          icon: icon(Layers3),
          label: "Layers",
          iconColor: "text-emerald-300",
          menu: [
            { type: "checkbox",  id: "slice:mesh:primitives",  label: "Primitives",       checked: true,  disabled: true },
            { type: "checkbox",  id: "slice:mesh:wireframe",   label: "Mesh wireframe",   checked: false },
            { type: "checkbox",  id: "slice:layers:quantity",  label: "Quantity overlay", checked: true },
            { type: "separator", id: "slice:mesh:s0" },
            {
              type: "radio-group",
              id: "slice:layers:render-mode",
              label: "Slice render",
              value: "heatmap",
              items: [
                { value: "heatmap",         label: "Heatmap" },
                { value: "contour",         label: "Contour",           disabled: true },
                { value: "heatmap+contour", label: "Heatmap + contour", disabled: true },
                { value: "vectors",         label: "Vectors" },
                { value: "mesh-overlay",    label: "Mesh overlay" },
              ],
            },
            {
              type: "radio-group",
              id: "slice:mesh:render-mode",
              label: "Mesh render mode",
              value: "surface",
              disabled: true,
              items: [
                { value: "surface",       label: "Shaded" },
                { value: "wireframe",     label: "Wireframe" },
                { value: "surface+edges", label: "Shaded + wireframe" },
                { value: "points",        label: "Points" },
              ],
            },
          ],
        },
        {
          id: "view-slice-plane",
          icon: icon(Scissors),
          label: "Plane",
          iconColor: "text-orange-300",
          menu: [
            {
              type: "radio-group",
              id: "slice:plane:axis",
              label: "Axis",
              value: "z",
              items: [
                { value: "x", label: "X normal / YZ" },
                { value: "y", label: "Y normal / XZ" },
                { value: "z", label: "Z normal / XY" },
              ],
            },
            {
              type: "radio-group",
              id: "slice:plane:mode",
              label: "Mode",
              value: "single",
              items: [
                { value: "single",     label: "Single" },
                { value: "slab",       label: "Slab",       disabled: true },
                { value: "all_layers", label: "All layers" },
              ],
            },
            {
              type: "radio-group",
              id: "slice:plane:projection-component",
              label: "Component",
              value: "magnitude",
              disabled: true,
              items: [
                { value: "magnitude", label: "Magnitude |v|" },
                { value: "x",         label: "X" },
                { value: "y",         label: "Y" },
                { value: "z",         label: "Z" },
              ],
            },
            {
              type: "radio-group",
              id: "slice:plane:projection-reduction",
              label: "Projection",
              value: "mean_occupied",
              disabled: true,
              items: [
                { value: "mean_occupied",      label: "Mean occupied" },
                { value: "area_weighted_mean", label: "Area weighted mean" },
                { value: "sum",                label: "Sum" },
                { value: "thickness_integral", label: "Thickness integral" },
                { value: "min",                label: "Min" },
                { value: "max",                label: "Max" },
                { value: "rms",                label: "RMS" },
                { value: "stddev",             label: "Std dev" },
                { value: "abs_max",            label: "Abs max" },
              ],
            },
            { type: "checkbox", id: "slice:plane:projection-air-zero",   label: "Air as zero", checked: false,  disabled: true },
            { type: "slider",   id: "slice:plane:projection-samples",    label: "Samples",     value: 20,  min: 4,  max: 100, step: 1,  disabled: true },
            { type: "slider",   id: "slice:plane:projection-resolution", label: "Resolution",  value: 128, min: 32, max: 384, step: 16, unit: " px", disabled: true },
            { type: "slider",   id: "slice:plane:position",              label: "Position",    value: 50,  min: 0,  max: 100, step: 0.5, unit: "%" },
          ],
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

export const definitionsTab: RibbonTabContent = {
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

export const geometryTab: RibbonTabContent = {
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
        { id: "builder-add-ellipsoid",     icon: icon(Circle),   label: "Ellipsoid",      iconColor: "text-purple-300" },
        { id: "builder-add-disk",          icon: icon(Disc),     label: "Disk",           iconColor: "text-sky-400" },
        { id: "builder-add-thin_film",     icon: icon(Box),      label: "Thin Film",      iconColor: "text-lime-300" },
        { id: "builder-add-pillar",        icon: icon(Cylinder), label: "Pillar",         iconColor: "text-fuchsia-300" },
        { id: "builder-add-nanowire",      icon: icon(Minus),    label: "Nanowire",       iconColor: "text-rose-300" },
        { id: "builder-add-ring",          icon: icon(Circle),   label: "Ring",           iconColor: "text-amber-300" },
        { id: "builder-add-triangular_prism", icon: icon(Triangle), label: "Tri. Prism",  iconColor: "text-orange-300" },
        { id: "builder-add-cone",          icon: icon(Triangle), label: "Cone",           iconColor: "text-yellow-300" },
        { id: "builder-add-capsule",       icon: icon(Disc),     label: "Capsule",        iconColor: "text-teal-300" },
        { id: "builder-add-tube",          icon: icon(Circle),   label: "Tube",           iconColor: "text-blue-300" },
        { id: "builder-add-wedge",         icon: icon(Box),      label: "Wedge",          iconColor: "text-stone-300" },
        { id: "builder-add-polygon_prism", icon: icon(Circle),   label: "Polygon Prism",  iconColor: "text-indigo-300" },
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
        { id: "builder-tool-move",   icon: icon(Move),      label: "Move",   shortcut: "W", iconColor: "text-red-400" },
        { id: "builder-tool-rotate", icon: icon(RotateCcw), label: "Rotate", shortcut: "E", iconColor: "text-green-400" },
        { id: "builder-tool-scale",  icon: icon(Maximize2), label: "Scale",  shortcut: "R", iconColor: "text-blue-400" },
      ],
    },
    // ── Viewport ─────────────────────────────────────────────────────────
    {
      id: "builder-viewport-mode",
      title: "Viewport",
      subtitle: "Interaction mode",
      tone: "neutral",
      actions: [
        { id: "builder-mode-camera",     icon: icon(Camera),       label: "Camera",     shortcut: "Q", iconColor: "text-slate-300" },
        { id: "builder-mode-manipulate", icon: icon(MousePointer2),label: "Manipulate",               iconColor: "text-orange-400" },
        { id: "builder-toggle-snap",     icon: icon(Magnet),       label: "Snap",       shortcut: "G", iconColor: "text-slate-400" },
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
        { id: "builder-validate",       icon: icon(CheckCircle), label: "Validate",                     iconColor: "text-emerald-400" },
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
        { id: "builder-frame-all",      icon: icon(Maximize),label: "Frame All",      shortcut: "Shift+F", iconColor: "text-slate-300" },
        { id: "builder-show-universe",  icon: icon(Eye),     label: "Show Universe",                       iconColor: "text-cyan-400" },
      ],
    },
  ],
};

export const materialsTab: RibbonTabContent = {
  tabId: "materials",
  groups: [
    {
      id: "materials-core",
      title: "Ferromagnet",
      subtitle: "materials",
      tone: "authoring",
      actions: [
        { id: "mat-params", icon: icon(FlaskConical), label: "Parameters", iconColor: "text-emerald-400", menu: menu("materials-params", "Material parameters", ["Ms", "Aex", "alpha", "gamma", "initial m"]) },
        { id: "mat-dmi",    icon: icon(Sparkles),     label: "Add DMI",    iconColor: "text-violet-400", menu: radioMenu("materials-dmi", "DMI type", "none", [["none", "None"], ["bulk", "Bulk"], ["interfacial", "Interfacial"]]) },
        { id: "mat-ku",     icon: icon(Binary),       label: "Add Ku",     iconColor: "text-rose-400",   menu: menu("materials-anisotropy", "Anisotropy", ["Uniaxial", "Cubic", "Surface anisotropy"]) },
      ],
    },
    {
      id: "materials-magnetization",
      title: "Magnetic Texture",
      subtitle: "initial state",
      tone: "authoring",
      actions: [
        { id: "mat-texture-inspector", icon: icon(Eye),      label: "Inspector",    iconColor: "text-sky-400",     menu: menu("mat-texture-inspector", "Texture inspector", ["View texture", "Texture history", "Reset texture"]) },
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

export const physicsTab: RibbonTabContent = {
  tabId: "physics",
  groups: [
    {
      id: "physics-core",
      title: "Core Terms",
      subtitle: "interactions",
      tone: "neutral",
      actions: [
        { id: "physics-interactions", icon: icon(Magnet), label: "Interactions", iconColor: "text-violet-400", menu: physicsInteractionMenu() },
        { id: "physics-global", icon: icon(Cog),    label: "Global Physics", iconColor: "text-muted-foreground" },
      ],
    },
    {
      id: "physics-add",
      title: "Optional Terms",
      subtitle: "add physics",
      tone: "compose",
      actions: [
        { id: "physics-add-dmi", icon: icon(Sparkles), label: "DMI",         iconColor: "text-cyan-400",  menu: radioMenu("physics-dmi-type", "DMI type", "bulk", [["bulk", "Bulk DMI"], ["interfacial", "Interfacial DMI"]]) },
        { id: "physics-add-ku",  icon: icon(Binary),   label: "Uniaxial Ku", iconColor: "text-rose-400" },
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
        { id: "manage-rf",      icon: icon(RadioTower), label: "RF Sources",  iconColor: "text-cyan-400",    menu: menu("physics-rf", "RF source", ["Add microstrip", "Add CPW", "List sources"]) },
        { id: "add-microstrip", icon: icon(Plus),       label: "Microstrip",  iconColor: "text-teal-400" },
        { id: "add-cpw",        icon: icon(Plus),       label: "CPW",         iconColor: "text-sky-400" },
      ],
    },
  ],
};

export const meshTab: RibbonTabContent = {
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
        { id: "transitions",  icon: icon(Columns2), label: "Transitions", iconColor: C.sapphire, menu: menu("mesh-transition", "Transitions", ["Interface refinement", "Boundary layer", "Airbox grading"]) },
      ],
    },
    {
      id: "method",
      title: "Method",
      subtitle: "quality",
      tone: "neutral",
      actions: [
        { id: "mesher",  icon: icon(Hexagon),    label: "Mesher",  iconColor: C.teal, menu: radioMenu("mesh-method", "Mesher", "auto", [["auto", "Auto"], ["fdm", "FDM grid"], ["tet", "Tetrahedral"], ["external", "External import"]]) },
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
        { id: "mesh-3d",        icon: icon(Grid3X3),   label: "3D View",   iconColor: C.sky },
        { id: "mesh-pipeline",  icon: icon(ListChecks),label: "Pipeline",  iconColor: C.lavender },
      ],
    },
  ],
};

export const studyTab: RibbonTabContent = {
  tabId: "study",
  groups: [
    {
      id: "navigate",
      title: "Study",
      subtitle: "setup",
      tone: "authoring",
      actions: [
        { id: "study-overview", icon: icon(Cog),        label: "Overview", menu: menu("study-overview", "Study", ["Execution intent", "Backend request", "Stage pipeline", "Provenance"]) },
        { id: "study-stages",   icon: icon(ListChecks), label: "Stages",   iconColor: C.blue },
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
        { id: "add-eigensolve", icon: icon(Sigma),    label: "Eigensolve", iconColor: "text-violet-400",  disabled: true },
      ],
    },
    {
      id: "study-composite",
      title: "Composite",
      subtitle: "multi-stage",
      tone: "compose",
      actions: [
        { id: "study-hysteresis",     icon: icon(BarChart3), label: "Hysteresis",    iconColor: "text-pink-400" },
        { id: "study-sweep-relax",    icon: icon(BarChart3), label: "Sweep+Relax",   iconColor: "text-violet-400" },
        { id: "study-sweep-snap",     icon: icon(Camera),    label: "Sweep+Snap",    iconColor: "text-sky-400" },
        { id: "study-relax-run",      icon: icon(Play),      label: "Relax→Run",     iconColor: "text-emerald-400" },
        { id: "study-relax-eigen",    icon: icon(Sigma),     label: "Relax→Eigen",   iconColor: "text-amber-400",  disabled: true },
        { id: "study-param-sweep",    icon: icon(BarChart3), label: "Param Sweep",   iconColor: "text-cyan-400" },
        { id: "study-current-sweep",  icon: icon(Zap),       label: "Current Sweep", iconColor: "text-yellow-400" },
      ],
    },
    {
      id: "study-selection",
      title: "Selection",
      subtitle: "manage stages",
      tone: "selection",
      actions: [
        { id: "study-duplicate", icon: icon(Columns2), label: "Duplicate",      iconColor: "text-sky-400",     disabled: true },
        { id: "study-toggle",    icon: icon(Eye),      label: "Enable/Disable", iconColor: "text-amber-400",   disabled: true },
      ],
    },
    {
      id: "builder-sync",
      title: "Sync",
      subtitle: "script",
      tone: "sync",
      actions: [
        { id: "study-sync", icon: icon(RefreshCw), label: "Sync Script", iconColor: "text-emerald-400", menu: [...statusMenu("study-sync-status", "Script sync", "Local only"), separator("study-sync-sep"), ...menu("study-sync", "Sync", ["Review diff", "Apply to model", "Export canonical script"])] },
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
        { id: "study.run",   icon: icon(Play,        { fill: "currentColor" }), label: "Compute", shortcut: "F5", accent: true, splitButton: true, iconColor: C.green, menu: [...statusMenu("study-runtime", "Runtime", "Idle"), separator("study-runtime-sep"), ...radioMenu("study-exec-mode", "Execution mode", "strict", [["strict", "Strict"], ["extended", "Extended"], ["hybrid", "Hybrid"]])] },
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

export const resultsTab: RibbonTabContent = {
  tabId: "results",
  groups: [
    {
      id: "quantity",
      title: "Quantity",
      subtitle: "resources",
      tone: "neutral",
      actions: [
        { id: "res-m",          icon: icon(Magnet),    label: "M",         active: true, iconColor: "text-pink-400",    menu: radioMenu("results-quantity", "Result quantity", "m", [["m", "Magnetization / m"], ["H_eff", "H_eff"], ["H_demag", "H_demag"], ["H_ex", "H_ex"], ["H_anis", "H_anis"], ["energy_density", "Energy density"]]) },
        { id: "res-heff",       icon: icon(Zap),       label: "H_eff",                   iconColor: "text-yellow-400" },
        { id: "res-demag",      icon: icon(Sigma),     label: "H_demag",                 iconColor: "text-violet-300" },
        { id: "res-exchange",   icon: icon(Zap),       label: "H_ex",                    iconColor: "text-amber-400" },
        { id: "res-anis",       icon: icon(Target),    label: "H_anis",                  iconColor: "text-rose-400" },
        { id: "res-energy",     icon: icon(BarChart3), label: "Energy",                  iconColor: "text-teal-400" },
      ],
    },
    {
      id: "plot-tools",
      title: "Plot",
      subtitle: "charts",
      tone: "neutral",
      actions: [
        { id: "results-chart",    icon: icon(BarChart3), label: "Chart",    iconColor: "text-emerald-400", menu: menu("results-chart",   "Chart",    ["Magnetization vs time", "Energy vs time", "Spectrum", "Dispersion", "Mode map"]) },
        { id: "results-snapshot", icon: icon(Camera),    label: "Snapshot", iconColor: "text-violet-400" },
      ],
    },
    {
      id: "results-export",
      title: "Export",
      subtitle: "artifacts",
      tone: "sync",
      actions: [
        { id: "export-vtk",   icon: icon(Download), label: "VTK",   iconColor: "text-blue-400",    menu: menu("results-export", "Export data", ["Field buffer", "Scalar table", "VTK file"]) },
        { id: "export-state",icon: icon(Save),      label: "State",  iconColor: "text-emerald-400" },
      ],
    },
    {
      id: "analyze",
      title: "Analyze",
      subtitle: "post-process",
      tone: "compose",
      actions: [
        { id: "results-spectrum",     icon: icon(BarChart3), label: "Spectrum",      iconColor: "text-violet-400" },
        { id: "results-vortex-add",   icon: icon(Circle),    label: "Vortex",        iconColor: "text-cyan-400" },
        { id: "results-add-spectrum", icon: icon(Plus),      label: "Add Spectrum",  iconColor: "text-violet-400" },
        { id: "results-dispersion",   icon: icon(BarChart3), label: "Add Dispersion",iconColor: "text-sky-400" },
        { id: "results-modes",        icon: icon(Sigma),     label: "Add Modes",     iconColor: "text-teal-400" },
      ],
    },
    {
      id: "results-vortex",
      title: "Time Domain",
      subtitle: "traces",
      actions: [
        { id: "add-time-traces",icon: icon(BarChart3),  label: "Add Time Traces",  iconColor: "text-rose-400" },
        { id: "add-fft",        icon: icon(FunctionSquare), label: "Add FFT / PSD", iconColor: "text-violet-400" },
        { id: "add-trajectory", icon: icon(Move3D),     label: "Add Trajectory",   iconColor: "text-fuchsia-300" },
        { id: "add-orbit",      icon: icon(Circle),     label: "Add Orbit",         iconColor: "text-sky-400" },
      ],
    },
    {
      id: "results-workspaces",
      title: "Workspaces",
      subtitle: "tables",
      actions: [
        { id: "add-quantity-ws", icon: icon(Plus), label: "Add Quantity", iconColor: "text-teal-400" },
        { id: "add-table-ws",    icon: icon(ListChecks), label: "Add Table", iconColor: "text-sky-400" },
      ],
    },
  ],
};

export const automationTab: RibbonTabContent = {
  tabId: "automation",
  groups: [
    {
      id: "automation-sync",
      title: "Automation",
      subtitle: "round trip",
      tone: "sync",
      actions: [
        { id: "automation-sync-script", icon: icon(RefreshCw), label: "Sync Script", iconColor: "text-emerald-400", menu: [...statusMenu("automation-sync-status", "Script sync", "Local only"), separator("automation-sync-sep"), ...menu("automation-sync", "Sync", ["Review diff", "Apply to model", "Export canonical script"])] },
      ],
    },
  ],
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
  sessionStatus?: LiveStatusResource | null;
  visualization: ObjectVisualizationController;
  visualizationSnapshot: ObjectVisualizationSnapshot;
  visualizationState?: VisualizationStateResource | null;
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

  if (tabId === "view" && context) {
    resolvedContent = {
      ...content,
      groups: content.groups.map((group) =>
        group.id === "view-global-display"
          ? buildViewGlobalDisplayGroup(group, context)
          : group.id === "view-orientation-tools"
            ? buildViewOrientationGroup(group, context)
          : group.id === "view-display"
            ? buildViewDisplayGroup(group, context)
          : group.id === "view-selected-display"
            ? buildSelectedVisualizationGroup(context)
            : group,
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
        const command = context.commands?.get(action.id);
        const disabledByCommand = command
          ? !context.commands?.isEnabled(action.id, commandContext)
          : false;
        const disabledReason = disabledByCommand
          ? command?.disabledReason?.(commandContext) ?? `Command unavailable: ${action.label}`
          : null;
        const activeResource = command?.activeResource?.(commandContext) ?? null;

        return {
          ...action,
          active:
            action.active ??
            (command ? context.commands?.isActive(action.id, commandContext) : false),
          activeCommandId:
            activeResource?.kind === "command"
              ? activeResource.commandId
              : action.activeCommandId,
          disabled: action.disabled || disabledByCommand,
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
    const disabledByCommand = isCommandDisabled(node.commandId, context, commandContext);

    if (command) {
      return {
        ...node,
        checked: command.isActive
          ? context.commands?.isActive(cmdId, commandContext) ?? node.checked
          : node.checked,
        disabled: node.disabled || disabledByCommand,
      };
    }

    return {
      ...node,
      disabled: node.disabled || disabledByCommand,
    };
  }

  if (node.type === "item") {
    const disabledByCommand = isCommandDisabled(node.commandId, context, commandContext);

    return {
      ...node,
      disabled: node.disabled || disabledByCommand,
    };
  }

  if (node.type === "radio-group") {
    return {
      ...node,
      items: node.items.map((item) => ({
        ...item,
        disabled:
          item.disabled ||
          isCommandDisabled(item.commandId, context, commandContext),
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

  if (node.type === "slider" && node.commandId && context.commands?.get(node.commandId)) {
    const disabledByCommand = isCommandDisabled(
      node.commandId,
      context,
      commandContext,
    );
    return {
      ...node,
      disabled: node.disabled || disabledByCommand,
    };
  }

  if (node.type === "color" && node.commandId && context.commands?.get(node.commandId)) {
    const disabledByCommand = isCommandDisabled(
      node.commandId,
      context,
      commandContext,
    );
    return {
      ...node,
      disabled: node.disabled || disabledByCommand,
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

function buildViewDisplayGroup(
  group: RibbonTabContent["groups"][number],
  context: RibbonBuildContext,
): RibbonTabContent["groups"][number] {
  return {
    ...group,
    actions: group.actions.map((action) =>
      action.id === "view-dimension-frame"
        ? buildDimensionFrameAction(context)
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
  status: LiveStatusResource | null | undefined,
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
  const activeQuantityId =
    state?.quantity?.active_quantity_id ?? state?.active_quantity_id ?? "m";
  const overlayVisible = state?.layers?.quantity_overlay?.visible ?? true;
  const autoContrast = state?.quantity?.auto_contrast ?? state?.auto_contrast ?? true;
  const colormap = state?.quantity?.colormap ?? state?.colormap ?? "viridis";
  const vectorColorMode =
    state?.vector_style?.color_mode ?? "orientation";
  return {
    id: "view-quantity",
    icon: icon(Sigma),
    label: "Quantity",
    iconColor: "text-sky-300",
    disabled: !context.api,
    menu: [
      { type: "label", id: "quantity:header", label: "Active quantity" },
      {
        type: "status",
        id: "quantity:current",
        label: "Current",
        value: quantityLabel(activeQuantityId),
      },
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
        commandId: RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
        commandInput: (value: string) =>
          visualizationStateCommandInput({
            active_quantity_id: value,
            quantity: { active_quantity_id: value },
          }),
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
        value: objectVectorSettings.geometryScope,
        items: GEOMETRY_SCOPE_ITEMS,
        disabled: !context.api,
        commandId: RIBBON_VISUALIZATION_PATCH_DEFAULTS_COMMAND,
        commandInput: (value: string) =>
          visualizationDefaultsCommandInput({
            geometryScope: value as VisualizationGeometryScope,
          }),
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
            id: "airbox:vectors-thickness",
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
  visualization,
}: RibbonBuildContext): RibbonTabContent["groups"][number]["actions"][number] {
  const objectSettings = visualization.getDefaultSettings("object");
  const partSettings = visualization.getDefaultSettings("part");
  const objectFrameVisible =
    objectSettings.boundsVisible && partSettings.boundsVisible;

  return {
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
          { value: "object", label: "Object scale" },
        ],
      },
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
  const target = resolveVisualizationTargetFromSelection(selection);
  const targetVisualization = target
    ? resolveTargetVisualization({
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
            value: settings?.geometryScope ?? "full",
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
            type: "item",
            id: "selected:clear",
            label: "Clear per-object overrides",
            disabled: !enabled,
            commandId: "visualization.target.clear-overrides",
          },
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
        disabled: !enabled,
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
            disabled: !enabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: (value: unknown) => value,
          },
          {
            type: "item",
            id: "selected-opacity:100",
            label: "100%",
            disabled: !enabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 100,
          },
          {
            type: "item",
            id: "selected-opacity:70",
            label: "70%",
            disabled: !enabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 70,
          },
          {
            type: "item",
            id: "selected-opacity:35",
            label: "35%",
            disabled: !enabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 35,
          },
          {
            type: "item",
            id: "selected-opacity:15",
            label: "Ghost 15%",
            disabled: !enabled,
            commandId: "visualization.target.set-opacity-percent",
            commandInput: 15,
          },
        ],
      },
    ],
  };
}
