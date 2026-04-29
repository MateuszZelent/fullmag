/**
 * viewportState.ts — Canonical viewport state model.
 *
 * Separates viewport concerns into four orthogonal domains:
 *   1. Selection   — what is pointed/selected
 *   2. Isolation   — what is included in the display scope
 *   3. Visibility  — what is shown/hidden (independent of isolate)
 *   4. Presentation — how each entity is rendered and colored
 *
 * Additionally defines:
 *   - ViewportTarget  — unified selection target across FDM/FEM
 *   - DisplayStyle    — canonical render modes shared by FDM and FEM
 *   - ColorEncoding   — unified color field abstraction with capability checks
 *   - ScopeQuality    — tracks segmentation fidelity
 *   - ViewportCommand — discrete operations on the viewport
 *   - ViewportThemeTokens — centralized visual constants
 */

// ── Viewport Target ────────────────────────────────────────────────────

export type ViewportTargetKind =
  | "none"
  | "universe"
  | "magnetic-object"
  | "air-domain"
  | "interface"
  | "boundary"
  | "mesh-part"
  | "face-set"
  | "antenna";

export interface ViewportTarget {
  kind: ViewportTargetKind;
  objectId?: string;
  entityId?: string;
  faceIndices?: number[];
  label?: string;
}

export const NO_TARGET: ViewportTarget = { kind: "none" };

// ── Scope Quality ──────────────────────────────────────────────────────

export type ScopeQuality =
  | "exact"            // exact object mesh segmentation
  | "legacy-segment"   // coarse legacy segment
  | "bounds-fallback"  // bounding-box only
  | "unavailable";     // no segmentation data

// ── Selection State ────────────────────────────────────────────────────

export interface ViewportSelectionState {
  /** The primary selection target. */
  primary: ViewportTarget;
  /** Optional hovered target (for highlight). */
  hovered: ViewportTarget | null;
  /** Whether selection changes are locked (e.g. during transform). */
  locked: boolean;
}

// ── Isolation State ────────────────────────────────────────────────────

export type IsolationMode =
  | "off"            // normal context view
  | "isolate"        // show only the isolated scope
  | "focus";         // highlight focus target, dim everything else

export interface ViewportIsolationState {
  mode: IsolationMode;
  /** Targets included in the isolation scope. */
  scope: ViewportTarget[];
  /** Whether the isolation is locked (prevents auto-changes on selection). */
  locked: boolean;
  /** Quality of the isolation scope segmentation. */
  scopeQuality: ScopeQuality;
}

// ── Visibility State ───────────────────────────────────────────────────

export interface EntityVisibility {
  entityId: string;
  visible: boolean;
  /** Manual hide/show override from user. */
  userOverride: boolean;
}

export interface ViewportVisibilityState {
  /** Per-entity visibility settings. */
  entities: Map<string, EntityVisibility>;
  /** Whether to show air domain. */
  showAir: boolean;
  /** Whether to show boundary elements. */
  showBoundary: boolean;
  /** Whether to show interface elements. */
  showInterface: boolean;
}

// ── Canonical Display Style ────────────────────────────────────────────

export type DisplayStyle =
  | "surface"
  | "surface-edges"
  | "wireframe"
  | "mesh"
  | "points"
  | "glyphs"
  | "voxels";

/** Capability matrix: which display styles each backend supports. */
export const DISPLAY_STYLE_CAPABILITIES: Record<
  "fdm" | "fem",
  Record<DisplayStyle, boolean>
> = {
  fdm: {
    surface: false,
    "surface-edges": false,
    wireframe: false,
    mesh: false,
    points: false,
    glyphs: true,
    voxels: true,
  },
  fem: {
    surface: true,
    "surface-edges": true,
    wireframe: true,
    mesh: true,
    points: true,
    glyphs: false,
    voxels: false,
  },
};

// ── Color Encoding ─────────────────────────────────────────────────────

export type ColorScaleFamily =
  | "orientation"   // HSV sphere
  | "diverging"     // blue↔white↔red for signed components
  | "sequential"    // viridis-like for magnitudes
  | "diagnostic"    // green↔yellow↔red for quality metrics
  | "none";         // uniform/solid color

export type ColorField =
  | "orientation"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "quality"
  | "sicn"
  | "none";

export interface ColorEncodingSpec {
  field: ColorField;
  family: ColorScaleFamily;
  label: string;
  /** Short label for toolbar badges. */
  badge: string;
  /** Whether this field is available for the current backend. */
  available: boolean;
  /** Tooltip explaining unavailability. */
  unavailableReason?: string;
}

/** Canonical color option ordering. */
export const COLOR_OPTIONS_ORDERED: Omit<ColorEncodingSpec, "available">[] = [
  { field: "orientation", family: "orientation", label: "Orientation", badge: "ORI" },
  { field: "x",          family: "diverging",   label: "Component X",  badge: "Mx" },
  { field: "y",          family: "diverging",   label: "Component Y",  badge: "My" },
  { field: "z",          family: "diverging",   label: "Component Z",  badge: "Mz" },
  { field: "magnitude",  family: "sequential",  label: "Magnitude",    badge: "|M|" },
  { field: "quality",    family: "diagnostic",  label: "Mesh Quality", badge: "Q" },
  { field: "sicn",       family: "diagnostic",  label: "SICN",         badge: "SICN" },
  { field: "none",       family: "none",        label: "Uniform",      badge: "—" },
];

/** Color field capability per backend. */
export const COLOR_FIELD_CAPABILITIES: Record<
  "fdm" | "fem",
  Record<ColorField, boolean>
> = {
  fdm: {
    orientation: true,
    x: true,
    y: true,
    z: true,
    magnitude: false,  // not yet implemented
    quality: false,
    sicn: false,
    none: true,
  },
  fem: {
    orientation: true,
    x: true,
    y: true,
    z: true,
    magnitude: true,
    quality: true,
    sicn: true,
    none: true,
  },
};

/** Resolve available color options for a given backend. */
export function resolveColorOptions(
  backend: "fdm" | "fem",
): ColorEncodingSpec[] {
  const caps = COLOR_FIELD_CAPABILITIES[backend];
  return COLOR_OPTIONS_ORDERED.map((opt) => ({
    ...opt,
    available: caps[opt.field],
    unavailableReason: caps[opt.field]
      ? undefined
      : `${opt.label} is not available for ${backend.toUpperCase()} backend`,
  }));
}

// ── Visibility Metric (decoupled from color) ───────────────────────────

export type VisibilityMetric =
  | "magnitude"       // based on |m|
  | "active-mask"     // based on solver active mask
  | "all";            // show everything

// ── Presentation State ─────────────────────────────────────────────────

export interface ViewportPresentationState {
  /** Global display style for the primary backend. */
  displayStyle: DisplayStyle;
  /** Global color encoding. */
  colorField: ColorField;
  /** Global opacity 0–100. */
  opacity: number;
  /** Whether clipping plane is enabled. */
  clipEnabled: boolean;
  /** Clipping axis. */
  clipAxis: "x" | "y" | "z";
  /** Clipping position 0–100. */
  clipPos: number;
  /** Whether to show vector arrows/glyphs. */
  showArrows: boolean;
  /** For FDM: visibility metric (decoupled from color). */
  visibilityMetric: VisibilityMetric;
  /** For FDM: visibility threshold. */
  visibilityThreshold: number;
}

// ── Highlight Policy ───────────────────────────────────────────────────

export type HighlightPolicy =
  | "outline"
  | "shell"
  | "overlay-edges"
  | "dim-others"
  | "none";

// ── Per-Entity Presentation Override ───────────────────────────────────

export interface EntityPresentationOverride {
  displayStyle?: DisplayStyle;
  colorField?: ColorField;
  opacity?: number;
}

// ── Viewport Commands ──────────────────────────────────────────────────

export type ViewportCommand =
  | { type: "selection/set"; target: ViewportTarget }
  | { type: "selection/clear" }
  | { type: "selection/lock"; locked: boolean }
  | { type: "isolate/enter"; targets?: ViewportTarget[] }
  | { type: "isolate/exit" }
  | { type: "isolate/toggleLock" }
  | { type: "visibility/show"; entityId: string }
  | { type: "visibility/hide"; entityId: string }
  | { type: "visibility/showAll" }
  | { type: "visibility/resetHiding" }
  | { type: "camera/zoomExtentsAll" }
  | { type: "camera/zoomSelected" }
  | { type: "camera/frameSelection" }
  | { type: "camera/resetView" }
  | { type: "presentation/setStyle"; style: DisplayStyle }
  | { type: "presentation/setColor"; field: ColorField }
  | { type: "presentation/setOpacity"; opacity: number };

// ── Theme Tokens ───────────────────────────────────────────────────────

/**
 * Centralized visual constants for the viewport.
 * All hardcoded values from FDM/FEM components are extracted here.
 */
export const VIEWPORT_THEME = {
  // ── Scene ──
  backgroundColor: 0x1e1e2e,           // Catppuccin Mocha Base
  backgroundColorCSS: "#1e1e2e",

  // ── Per-role default opacity (0–100) ──
  opacity: {
    solid: 100,
    interface: 88,
    outerBoundary: 46,
    air: 28,
    dimmedMinMagnetic: 14,
    dimmedMinOther: 8,
    selectedLiftMagnetic: 96,
    selectedLiftOther: 52,
    geometryOnly: 85,
  } as const,

  // ── FDM settings defaults ──
  fdm: {
    defaultBrightness: 1.5,
    defaultVoxelOpacity: 0.5,
    defaultVoxelGap: 0.14,
    defaultVoxelThreshold: 0.08,
    defaultSampling: 1 as 1 | 2 | 4,
    defaultQuality: "high" as "low" | "high" | "ultra",
    defaultRenderMode: "voxel" as "glyph" | "voxel",
    defaultColorMode: "orientation" as "orientation" | "x" | "y" | "z",
    // Geometry parameters
    minBaseScale: 0.12,
    strengthScaleMin: 0.18,
    strengthScaleMax: 0.82,
    // Topo defaults
    defaultTopoMultiplier: 5,
  } as const,

  // ── FEM settings defaults ──
  fem: {
    defaultRenderMode: "surface" as "surface" | "surface+edges" | "wireframe" | "mesh" | "points",
    defaultColorField: "orientation" as ColorField,
    defaultClipPos: 50,
    defaultShrinkFactor: 1,
  } as const,

  // ── Color palette anchors ──
  colors: {
    compNegative: "#2f6caa",     // blue (diverging)
    compNeutral: "#f4f1ed",      // off-white
    compPositive: "#cf6256",     // red
    qualityGood: "#35b779",      // green
    qualityMid: "#fde725",       // yellow
    qualityBad: "#cf6256",       // red
    uniformSurface: "#959ba5",   // neutral gray
    selectionHighlight: "#60a5fa", // blue-400
    hoverHighlight: "#a5b4fc",     // indigo-300
  } as const,

  // ── Selection outline ──
  selection: {
    outlineColor: "#60a5fa",
    outlineWidth: 2,
    hoverOutlineColor: "#a5b4fc",
    hoverOutlineWidth: 1,
  } as const,

  // ── Camera defaults ──
  camera: {
    defaultDirection: [0, 1, 0] as [number, number, number],
    defaultUp: [0, 0, -1] as [number, number, number],
    defaultFov: 45,
    nearPlane: 0.001,
    farPlane: 10000,
  } as const,

  // ── Quality profiles mapping ──
  quality: {
    low:  { segments: 6,  useLighting: false, antialias: false },
    high: { segments: 12, useLighting: true,  antialias: true },
    ultra: { segments: 16, useLighting: true, antialias: true },
  } as const,

  // ── Slider ranges ──
  sliders: {
    brightness:       { min: 0.3,  max: 3.0,  step: 0.01 },
    voxelOpacity:     { min: 0.15, max: 0.95, step: 0.01 },
    voxelGap:         { min: 0.02, max: 0.42, step: 0.01 },
    voxelThreshold:   { min: 0,    max: 0.95, step: 0.01 },
    topoMultiplier:   { min: 0.5,  max: 50,   step: 0.1 },
    clipPos:          { min: 0,    max: 100,   step: 1 },
    opacity:          { min: 0,    max: 100,   step: 1 },
    shrinkFactor:     { min: 0.5,  max: 1.0,  step: 0.01 },
  } as const,
} as const;

// ── Default factory for per-part view state ────────────────────────────
// (Single source of truth — removes 3 duplicate definitions)

export type MeshPartRole =
  | "magnetic_object"
  | "air"
  | "outer_boundary"
  | "interface"
  | "unknown";

export interface CanonicalEntityViewState {
  visible: boolean;
  displayStyle: DisplayStyle;
  opacity: number;
  colorField: ColorField;
}

export function defaultEntityViewState(
  role: MeshPartRole,
): CanonicalEntityViewState {
  switch (role) {
    case "air":
      return {
        visible: false,
        displayStyle: "wireframe",
        opacity: VIEWPORT_THEME.opacity.air,
        colorField: "none",
      };
    case "outer_boundary":
      return {
        visible: false,
        displayStyle: "surface-edges",
        opacity: VIEWPORT_THEME.opacity.outerBoundary,
        colorField: "none",
      };
    case "interface":
      return {
        visible: true,
        displayStyle: "surface-edges",
        opacity: VIEWPORT_THEME.opacity.interface,
        colorField: "none",
      };
    case "magnetic_object":
      return {
        visible: true,
        displayStyle: "surface-edges",
        opacity: VIEWPORT_THEME.opacity.solid,
        colorField: "orientation",
      };
    default:
      return {
        visible: true,
        displayStyle: "surface-edges",
        opacity: VIEWPORT_THEME.opacity.solid,
        colorField: "none",
      };
  }
}

// ── Resolve target from tree node ──────────────────────────────────────

export function resolveTargetFromTreeNodeId(
  nodeId: string,
  objectId: string | null,
  airPartId: string | null,
): ViewportTarget {
  if (!nodeId) return NO_TARGET;

  if (nodeId === "universe-airbox" || nodeId === "universe-airbox-mesh") {
    return {
      kind: "air-domain",
      entityId: airPartId ?? undefined,
      label: "Universe Airbox",
    };
  }

  if (nodeId.startsWith("boundary-") || nodeId.startsWith("outer-boundary")) {
    return { kind: "boundary", entityId: nodeId, label: "Boundary" };
  }

  if (nodeId.startsWith("interface-")) {
    return { kind: "interface", entityId: nodeId, label: "Interface" };
  }

  if (objectId) {
    return {
      kind: "magnetic-object",
      objectId,
      label: objectId,
    };
  }

  return { kind: "universe" };
}

// ── Isolate policy ─────────────────────────────────────────────────────
// Selection does NOT auto-exit isolate unless explicitly requested.

export interface IsolatePolicy {
  /** Whether tree selection should update isolate scope. */
  selectionUpdatesIsolate: boolean;
  /** Whether tree selection should exit isolate mode. */
  selectionExitsIsolate: boolean;
}

export const DEFAULT_ISOLATE_POLICY: IsolatePolicy = {
  selectionUpdatesIsolate: false,
  selectionExitsIsolate: false,
};
