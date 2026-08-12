import {
  FileText,
  Save,
  Upload,
  Sparkles,
  Box,
  Camera,
  Columns2,
  Monitor,
  PanelRight,
  Play,
  Pause,
  SkipForward,
  Square,
  Scissors,
  BarChart3,
  Eye,
  Sigma,
  Zap,
  Layers3,
  Target,
  Ruler,
  MousePointer2,
  Move3D,
  Download,
  Triangle,
  BoxSelect,
  Activity,
  Blend,
  Maximize2,
} from "lucide-react";

import type { RibbonTabContent } from "./ribbonTypes";
import {
  icon,
  C,
  menu,
} from "./ribbonCommon";

import { fieldCatalogQuantitySupportsAirbox } from "@/kernel/api/quantityIds";
import { RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND } from "./ribbonCommands";

import type {
  FieldCatalogResource,
  VisualizationStatePatch,
} from "@/kernel/api/apiTypes";

import type {
  SurfaceColorSource,
  VisualizationColorMode,
  VisualizationGeometryScope,
  VisualizationRenderMode,
  VisualizationTargetKind,
} from "@/kernel/visualization/ObjectVisualizationController";

export type FieldComponentPatch = NonNullable<VisualizationStatePatch["field_component"]>;
export type VectorColorModePatch = NonNullable<
  NonNullable<VisualizationStatePatch["vector_style"]>["color_mode"]
>;
export type VectorLayerDomainPatch = NonNullable<
  NonNullable<
    NonNullable<VisualizationStatePatch["layers"]>["vectors"]
  >["domain"]
>;

export const QUANTITY_ITEMS = [
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

export function quantityItemsForVisualizationTarget(
  activeQuantityId: string,
  targetKind?: VisualizationTargetKind,
  fieldCatalog?: FieldCatalogResource | null,
): Array<{ label: string; value: string }> {
  const baseItems =
    targetKind === "airbox"
      ? QUANTITY_ITEMS.filter((item) =>
          fieldCatalogQuantitySupportsAirbox(fieldCatalog, item.value),
        )
      : QUANTITY_ITEMS;
  if (targetKind === "airbox" && !fieldCatalog) return baseItems;
  return baseItems.some((item) => item.value === activeQuantityId)
    ? baseItems
    : [{ value: activeQuantityId, label: activeQuantityId }, ...baseItems];
}

export const VECTOR_COLOR_ITEMS: Array<{
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

export const SURFACE_COLOR_SOURCE_ITEMS: Array<{
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

export const SELECTED_SURFACE_COLOR_SOURCE_ITEMS = [
  { value: "inherit", label: "Inherited" },
  ...SURFACE_COLOR_SOURCE_ITEMS,
];

export const VECTOR_COMPONENT_ITEMS = [
  { value: "3D",       label: "3D vectors" },
  { value: "magnitude",label: "Magnitude |v|" },
  { value: "x",        label: "X" },
  { value: "y",        label: "Y" },
  { value: "z",        label: "Z" },
];

export const MESH_RENDER_ITEMS = [
  { value: "surface",        label: "Shaded surface" },
  { value: "surface+edges",  label: "Shaded + wireframe" },
  { value: "wireframe",      label: "Wireframe" },
  { value: "points",         label: "Points (nodes)" },
];

export const SELECTED_RENDER_ITEMS: Array<{
  label: string;
  value: VisualizationRenderMode;
}> = [
  { value: "surface",       label: "Shaded" },
  { value: "surface+edges", label: "Shaded + wireframe" },
  { value: "wireframe",     label: "Wireframe" },
  { value: "points",        label: "Points" },
];

export const AIRBOX_EXTENT_ITEMS = [
  { value: "surface", label: "Surface" },
  { value: "full",    label: "Full" },
];

export const GEOMETRY_SCOPE_ITEMS: Array<{
  label: string;
  value: VisualizationGeometryScope;
}> = [
  { value: "surface", label: "Surface only" },
  { value: "full", label: "Full volume" },
];

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
          splitButton: true,
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
                  commandId: "field-map.open",
                  label: "2D field map",
                  value: "field-map",
                },
                {
                  commandId: "analysis-plots.open",
                  label: "Analysis",
                  value: "analysis",
                },
                {
                  commandId: "live-charts.open",
                  label: "Live Charts",
                  value: "live-charts",
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
        { id: "ws-2d",      icon: icon(Columns2),  label: "2D",      shortcut: "2", commandId: "field-map.open", iconColor: C.sky },
        { id: "ws-live-charts", icon: icon(Activity), label: "Live Charts", commandId: "live-charts.open", iconColor: C.blue },
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

    // ── Group 3: Planar field map ───────────────────────────────────────────
    {
      id: "view-slice-2d",
      title: "2D View",
      subtitle: "planar monitor",
      tone: "neutral",
      actions: [
        {
          id: RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND,
          icon: icon(Scissors),
          label: "Monitor",
          iconColor: "text-orange-300",
          tooltip: "Create a planar monitor draft",
        },
        {
          id: "field-map.open",
          icon: icon(Triangle),
          label: "Open",
          iconColor: "text-sky-300",
          tooltip: "Open the active monitor in 2D View",
        },
        {
          id: "field-map.export-png",
          icon: icon(Download),
          label: "Export",
          iconColor: "text-amber-300",
          tooltip: "Export the current 2D field map",
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
              items: SELECTED_RENDER_ITEMS,
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
