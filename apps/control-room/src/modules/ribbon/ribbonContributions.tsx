import {
  BarChart3,
  Binary,
  Box,
  Circle,
  Columns2,
  Cog,
  Cylinder,
  Disc,
  Download,
  Eye,
  FileText,
  FlaskConical,
  FunctionSquare,
  Grid3X3,
  Hand,
  Hexagon,
  Layers3,
  ListChecks,
  Magnet,
  Minus,
  Monitor,
  Move3D,
  MousePointer2,
  PanelRight,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Ruler,
  Scissors,
  Sigma,
  SkipForward,
  Sparkles,
  Square,
  Triangle,
  Zap,
} from "lucide-react";
import { createElement } from "react";

import type { RibbonMenuNode, RibbonTabContent } from "./ribbonTypes";

const I = 20; // icon size

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

export const homeTab: RibbonTabContent = {
  tabId: "home",
  groups: [
    {
      id: "project",
      title: "Project",
      subtitle: "files",
      tone: "sync",
      actions: [
        { id: "open",       icon: icon(FileText),            label: "Open",      shortcut: "Ctrl+O", disabled: true, iconColor: C.blue, menu: menu("home-open", "Project", [["New problem", "Ctrl+N"], ["Open project", "Ctrl+O"], "Open example", "Recent sessions"]) },
        { id: "vis-preset", icon: icon(Sparkles),            label: "3D Visual", disabled: true,                     iconColor: C.lavender, menu: menu("home-visual", "Visual preset", ["Publication figure", "Live control room", "Debug overlays"]) },
      ],
    },
    {
      id: "workspace",
      title: "Workspace",
      subtitle: "layout",
      tone: "selection",
      actions: [
        { id: "ws-3d",      icon: icon(Box),       label: "3D",      shortcut: "1", active: true, iconColor: C.sky, menu: radioMenu("home-workspace", "Workspace mode", "3d", [["3d", "3D viewport"], ["2d", "2D slice"], ["analysis", "Analysis"]]) },
        { id: "ws-2d",      icon: icon(Columns2),  label: "2D",      shortcut: "2",               iconColor: C.sapphire },
        { id: "ws-analyze", icon: icon(BarChart3), label: "Analyze",                               iconColor: C.yellow },
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
        { id: "run",   icon: icon(Play,        { fill: "currentColor" }), label: "Compute", shortcut: "F5", accent: true, disabled: true, iconColor: C.green, menu: [...statusMenu("home-runtime", "Runtime", "No session"), separator("home-runtime:sep"), ...radioMenu("home-target", "Execution target", "auto", [["auto", "Auto"], ["cpu", "CPU"], ["gpu", "GPU"]])] },
        { id: "pause", icon: icon(Pause,       { fill: "currentColor" }), label: "Pause",                  disabled: true, iconColor: C.yellow },
        { id: "stop",  icon: icon(Square,      { fill: "currentColor" }), label: "Stop",                   disabled: true, iconColor: C.red },
        { id: "skip",  icon: icon(SkipForward),                           label: "Skip",                   disabled: true, iconColor: C.peach },
      ],
    },
  ],
};

export const viewTab: RibbonTabContent = {
  tabId: "view",
  groups: [
    {
      id: "quantity",
      title: "Quantity",
      subtitle: "field",
      tone: "selection",
      actions: [
        { id: "quantity-m",     icon: icon(Magnet), label: "M",       active: true, iconColor: C.pink, menu: radioMenu("view-quantity", "Quantity", "m", [["m", "Magnetization M"], ["heff", "Effective field H_eff"], ["demag", "Demag field H_demag"], ["energy", "Energy density"]]) },
        { id: "quantity-heff",  icon: icon(Zap),    label: "H_eff",                 iconColor: C.yellow },
        { id: "quantity-demag", icon: icon(Sigma),  label: "H_demag",               iconColor: C.lavender },
      ],
    },
    {
      id: "display",
      title: "Display",
      subtitle: "layers",
      tone: "selection",
      actions: [
        { id: "primitive", icon: icon(Box),     label: "Primitive", iconColor: C.sky, menu: menu("view-primitive", "Primitive display", ["Objects", "Mesh shell", "Bounding boxes", "Airbox"]) },
        { id: "vectors",   icon: icon(Move3D),  label: "Vectors",   iconColor: C.peach, menu: menu("view-vectors", "Vector display", ["Arrows", "Streamlines", "Glyph density", "Color mode"]) },
        { id: "layers",    icon: icon(Layers3), label: "Layers",    iconColor: C.sapphire, menu: menu("view-layers", "Layer visibility", ["Geometry", "Mesh", "Field", "Selection", "Annotations"]) },
      ],
    },
    {
      id: "tools",
      title: "Tools",
      subtitle: "camera",
      tone: "neutral",
      actions: [
        { id: "camera",     icon: icon(Monitor),      label: "Camera",     iconColor: C.teal, menu: menu("view-camera", "Camera", ["Reset", "Fit selection", "Top", "Front", "Right", "Isometric"]) },
        { id: "selection",  icon: icon(MousePointer2), label: "Select",     iconColor: C.blue },
        { id: "ruler",      icon: icon(Ruler),         label: "Measure",    disabled: true },
        { id: "screenshot", icon: icon(Download),      label: "Screenshot", iconColor: C.green },
      ],
    },
    {
      id: "interaction",
      title: "Interaction",
      subtitle: "tools",
      tone: "neutral",
      actions: [
        { id: "orbit", icon: icon(Move3D),    label: "Orbit",                    iconColor: C.sapphire, menu: radioMenu("view-interaction", "Interaction mode", "orbit", [["orbit", "Orbit"], ["pan", "Pan"], ["select", "Select"], ["clip", "Clip plane"]]) },
        { id: "pan",   icon: icon(Hand),      label: "Pan",                      iconColor: C.yellow },
        { id: "clip",  icon: icon(Scissors),  label: "Clip",  disabled: true,    iconColor: C.red },
      ],
    },
  ],
};

export const definitionsTab: RibbonTabContent = {
  tabId: "definitions",
  groups: [
    {
      id: "model",
      title: "Definitions",
      subtitle: "symbols",
      tone: "authoring",
      actions: [
        { id: "parameters",  icon: icon(Binary),         label: "Parameters",  iconColor: C.lavender, menu: menu("definitions-parameters", "Parameters", ["Add scalar", "Add vector", "Import table", "Validate units"]) },
        { id: "functions",   icon: icon(FunctionSquare), label: "Functions",   iconColor: C.peach, menu: menu("definitions-functions", "Functions", ["Add expression", "Piecewise field", "Time function", "Spatial profile"]) },
        { id: "coordinates", icon: icon(Ruler),          label: "Coordinates", iconColor: C.teal, menu: radioMenu("definitions-coordinates", "Coordinate frame", "cartesian", [["cartesian", "Cartesian"], ["cylindrical", "Cylindrical"], ["local", "Object local"]]) },
      ],
    },
  ],
};

export const geometryTab: RibbonTabContent = {
  tabId: "geometry",
  groups: [
    {
      id: "create",
      title: "Create Shape",
      subtitle: "geometry",
      tone: "compose",
      actions: [
        { id: "add-box",       icon: icon(Box),      label: "Box",       iconColor: C.sky, menu: menu("geometry-box", "Box presets", ["Thin film", "Cuboid", "Rectangular prism", "Import dimensions"]) },
        { id: "add-cylinder",  icon: icon(Cylinder), label: "Cylinder",  iconColor: C.sky, menu: menu("geometry-cylinder", "Cylinder presets", ["Nanodot", "Pillar", "Tube", "Ring by boolean"]) },
        { id: "add-sphere",    icon: icon(Circle),   label: "Sphere",    iconColor: C.sky, menu: menu("geometry-sphere", "Sphere presets", ["Sphere", "Ellipsoid", "Hemisphere"]) },
        { id: "add-ellipsoid", icon: icon(Circle),   label: "Ellipsoid", iconColor: C.sapphire },
        { id: "add-disk",      icon: icon(Disc),     label: "Disk",      iconColor: C.sky },
        { id: "add-thin-film", icon: icon(Box),      label: "Thin Film", iconColor: C.sapphire },
        { id: "add-pillar",    icon: icon(Cylinder), label: "Pillar",    iconColor: C.sapphire },
        { id: "add-nanowire",  icon: icon(Minus),    label: "Nanowire",  iconColor: C.teal },
        { id: "add-ring",      icon: icon(Circle),   label: "Ring",      iconColor: C.teal },
        { id: "add-prism",     icon: icon(Triangle), label: "Prism",     iconColor: C.sapphire },
        { id: "add-cone",      icon: icon(Triangle), label: "Cone",      iconColor: C.sky },
      ],
    },
    {
      id: "edit",
      title: "Edit",
      subtitle: "operators",
      tone: "compose",
      actions: [
        { id: "transform", icon: icon(Move3D),   label: "Transform",                iconColor: C.peach, menu: menu("geometry-transform", "Transform", ["Move", "Rotate", "Scale", "Mirror", "Align to axis"]) },
        { id: "boolean",   icon: icon(Scissors), label: "Boolean",  disabled: true, iconColor: C.red, menu: menu("geometry-boolean", "Boolean", ["Union", "Subtract", "Intersect"]) },
      ],
    },
  ],
};

export const materialsTab: RibbonTabContent = {
  tabId: "materials",
  groups: [
    {
      id: "ferromagnet",
      title: "Ferromagnet",
      subtitle: "materials",
      tone: "authoring",
      actions: [
        { id: "mat-params", icon: icon(FlaskConical), label: "Parameters", iconColor: C.green, menu: menu("materials-params", "Material parameters", ["Ms", "Aex", "alpha", "gamma", "initial m"]) },
        { id: "mat-dmi",    icon: icon(Sparkles),     label: "Add DMI",    iconColor: C.lavender, menu: radioMenu("materials-dmi", "DMI type", "none", [["none", "None"], ["bulk", "Bulk"], ["interfacial", "Interfacial"]]) },
        { id: "mat-ku",     icon: icon(Binary),       label: "Add Ku",     iconColor: C.peach, menu: menu("materials-anisotropy", "Anisotropy", ["Uniaxial", "Cubic", "Surface anisotropy"]) },
      ],
    },
  ],
};

export const physicsTab: RibbonTabContent = {
  tabId: "physics",
  groups: [
    {
      id: "core",
      title: "Core Terms",
      subtitle: "fields",
      tone: "authoring",
      actions: [
        { id: "exchange", icon: icon(Zap),    label: "Exchange", iconColor: C.yellow, menu: menu("physics-exchange", "Exchange", ["Uniform exchange", "Region interface", "Boundary condition"]) },
        { id: "demag",    icon: icon(Sigma),  label: "Demag",    iconColor: C.lavender, menu: radioMenu("physics-demag", "Demag solver", "auto", [["auto", "Auto"], ["fft", "FDM FFT"], ["fem", "FEM magnetostatics"]]) },
        { id: "zeeman",   icon: icon(Magnet), label: "Zeeman",   iconColor: C.pink, menu: menu("physics-zeeman", "External field", ["Uniform field", "Time-dependent field", "Spatial profile"]) },
      ],
    },
    {
      id: "rf-sources",
      title: "RF Sources",
      subtitle: "drive",
      tone: "authoring",
      actions: [
        { id: "manage-rf",    icon: icon(Cog),        label: "Manage", menu: menu("physics-rf", "RF source", ["Add source", "Edit waveform", "Inspect coupling"]) },
        { id: "add-microstrip", icon: icon(Plus),     label: "Microstrip", iconColor: C.teal },
        { id: "add-cpw",      icon: icon(Plus),       label: "CPW",        iconColor: C.sapphire },
        { id: "antenna-list", icon: icon(RadioTower), label: "Antennas",   disabled: true, iconColor: C.blue },
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
        { id: "build-selected", icon: icon(RefreshCw),  label: "Build",      accent: true, iconColor: C.green, menu: [...statusMenu("mesh-build-status", "Mesh state", "Not built", "warning"), separator("mesh-build-sep"), ...menu("mesh-build", "Build scope", ["Selected object", "All objects", "Universe mesh", "Shared solver mesh"])] },
        { id: "build-all",      icon: icon(Zap),        label: "Build All",                iconColor: C.yellow, menu: menu("mesh-build-all", "Build all", ["FDM grid", "FEM shared domain", "Quality report"]) },
        { id: "mesh-stats",     icon: icon(BarChart3),  label: "Statistics",               iconColor: C.peach },
      ],
    },
    {
      id: "size",
      title: "Size",
      subtitle: "controls",
      tone: "authoring",
      actions: [
        { id: "element-size", icon: icon(Ruler),    label: "Element Size", menu: menu("mesh-size", "Size controls", ["Maximum element", "Minimum element", "Growth rate", "Curvature factor", "Narrow regions"]) },
        { id: "transitions",  icon: icon(Columns2), label: "Transitions", iconColor: C.sapphire, menu: menu("mesh-transition", "Transitions", ["Interface refinement", "Boundary layer", "Airbox grading"]) },
      ],
    },
    {
      id: "method",
      title: "Method",
      subtitle: "quality",
      tone: "authoring",
      actions: [
        { id: "mesher",  icon: icon(Hexagon),    label: "Mesher",  iconColor: C.teal, menu: radioMenu("mesh-method", "Mesher", "auto", [["auto", "Auto"], ["fdm", "FDM grid"], ["tet", "Tetrahedral"], ["external", "External import"]]) },
        { id: "quality", icon: icon(ListChecks), label: "Quality", iconColor: C.green },
      ],
    },
    {
      id: "mesh-view",
      title: "View",
      subtitle: "inspect",
      tone: "selection",
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
        { id: "add-relax",    icon: icon(Play),     label: "Relax",    iconColor: C.green, menu: menu("study-relax", "Relax stage", ["Overdamped relax", "LLG relax", "Minimizer", "Stop criteria"]) },
        { id: "add-dynamics", icon: icon(Zap),      label: "Dynamics", iconColor: C.yellow, menu: menu("study-dynamics", "Dynamics stage", ["Time integration", "Pulse response", "RF drive", "Thermal noise"]) },
        { id: "add-sweep",    icon: icon(BarChart3),label: "Sweep",    iconColor: C.peach },
      ],
    },
    {
      id: "control",
      title: "Control",
      subtitle: "runtime",
      tone: "compute",
      actions: [
        { id: "study-run",   icon: icon(Play,        { fill: "currentColor" }), label: "Compute", shortcut: "F5", accent: true, disabled: true, iconColor: C.green, menu: [...statusMenu("study-runtime", "Runtime", "Idle"), separator("study-runtime-sep"), ...radioMenu("study-exec-mode", "Execution mode", "strict", [["strict", "Strict"], ["extended", "Extended"], ["hybrid", "Hybrid"]])] },
        { id: "study-pause", icon: icon(Pause,       { fill: "currentColor" }), label: "Pause",                  disabled: true, iconColor: C.yellow },
        { id: "study-stop",  icon: icon(Square,      { fill: "currentColor" }), label: "Stop",                   disabled: true, iconColor: C.red },
        { id: "study-skip",  icon: icon(SkipForward),                           label: "Skip",                   disabled: true, iconColor: C.peach },
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
      subtitle: "results",
      tone: "selection",
      actions: [
        { id: "res-m",        icon: icon(Magnet),   label: "M",       active: true, iconColor: C.pink, menu: radioMenu("results-quantity", "Result quantity", "m", [["m", "M"], ["heff", "H_eff"], ["demag", "H_demag"], ["energy", "Energy"], ["custom", "Custom scalar"]]) },
        { id: "res-heff",     icon: icon(Zap),      label: "H_eff",                 iconColor: C.yellow },
        { id: "res-demag",    icon: icon(Sigma),    label: "H_demag",               iconColor: C.lavender },
        { id: "res-exchange", icon: icon(Zap),      label: "H_ex",                  iconColor: C.peach },
        { id: "res-energy",   icon: icon(BarChart3),label: "Energy",                iconColor: C.teal },
      ],
    },
    {
      id: "export",
      title: "Export",
      subtitle: "artifacts",
      tone: "sync",
      actions: [
        { id: "export-data",   icon: icon(Download), label: "Export", iconColor: C.green, menu: menu("results-export", "Export data", ["Field buffer", "Scalar table", "Chart image", "Publication figure"]) },
        { id: "export-script", icon: icon(FileText), label: "Script", iconColor: C.blue, menu: menu("results-script", "Script", ["Python DSL", "ProblemIR JSON", "Provenance bundle"]) },
      ],
    },
  ],
};

export const automationTab: RibbonTabContent = {
  tabId: "automation",
  groups: [
    {
      id: "sync",
      title: "Automation",
      subtitle: "round trip",
      tone: "sync",
      actions: [
        { id: "sync-script",    icon: icon(RefreshCw), label: "Sync Script",    iconColor: C.blue, menu: [...statusMenu("automation-sync-status", "Script sync", "Local only"), separator("automation-sync-sep"), ...menu("automation-sync", "Sync", ["Preview diff", "Apply to model", "Export canonical script"])] },
        { id: "export-python",  icon: icon(FileText),  label: "Export Python",  iconColor: C.peach, menu: menu("automation-python", "Python", ["Copy script", "Download .py", "Open preview"]) },
      ],
    },
  ],
};

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
