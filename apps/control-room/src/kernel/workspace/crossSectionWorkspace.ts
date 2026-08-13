import type {
  CrossSectionPlane,
  CrossSectionQualityMetric,
  CrossSectionQualityQuery,
  CrossSectionQuery,
  SliceMeshColorScale,
  VisualizationStateResource,
  PlanarMonitorCreateRequest,
  PlanarMonitorDuplicateRequest,
} from "@/kernel/api/apiTypes";

type ClipAxis = VisualizationStateResource["clip"]["axis"];

export type CrossSectionFrameExtent =
  | "custom"
  | "magnetic_domain"
  | "object_bounds"
  | "universe";

interface CrossSectionPlotRenderOptions {
  colorScale: SliceMeshColorScale;
  edgeWidth: number;
  frameRotationDegrees: number;
  filterExpression: string;
  shrinkFactor: number;
  wireframeVisible: boolean;
}

export type PlanarMonitor = PlanarMonitorCreateRequest["monitor"];
export type PlanarMonitorTarget = PlanarMonitor["target"];
export type PlanarMonitorOperator = PlanarMonitor["operator"];
export type PlanarLengthUnit = "m" | "mm" | "um" | "nm";

export interface PlanarMonitorDraft {
  monitor: PlanarMonitor;
  ui: {
    displayLengthUnit: PlanarLengthUnit;
  };
}

/**
 * A user entrypoint may supply intent, but never a partial monitor payload.
 * This keeps the ribbon, command palette, Explorer, Inspector and clip
 * conversion on the same canonical authoring path.
 */
export interface PlanarMonitorCreateIntent {
  operator?: PlanarMonitorOperator;
  preset?: "xy" | "xz" | "yz";
  source: "clip" | "explorer" | "inspector" | "palette" | "ribbon";
  target?: PlanarMonitorTarget;
}

export interface PlanarMonitorDraftCreationOptions {
  bounds?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
  intent?: PlanarMonitorCreateIntent;
  visualizationState?: VisualizationStateResource | null;
}

export interface CrossSectionDraft {
  colorScale: SliceMeshColorScale;
  edgeWidth: number;
  frameExtent: CrossSectionFrameExtent;
  filterExpression: string;
  id: "draft";
  includeWireframe: boolean;
  metric: CrossSectionQualityMetric;
  name: string;
  plane: CrossSectionPlane;
  positionPercent: number;
  rotationDegrees: number;
  shrinkFactor: number;
}

export interface CrossSectionPlot {
  frameExtent: CrossSectionFrameExtent;
  id: string;
  metric: CrossSectionQualityMetric;
  name: string;
  plane: CrossSectionPlane;
  positionPercent: number;
  qualityQuery: CrossSectionQualityQuery;
  query: Required<CrossSectionQuery>;
  renderOptions: CrossSectionPlotRenderOptions;
  rotationDegrees: number;
}

export interface CrossSectionFramePreview {
  axis: ClipAxis;
  positionPercent: number;
  rotationDegrees: number;
}

export function isPlanarMonitorRevisionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 409 &&
    "code" in error &&
    error.code === "scene_revision_conflict"
  );
}

export function planarMonitorCreateRequestFromDraft(
  draft: PlanarMonitorDraft | CrossSectionDraft,
  expectedSceneRevision: number,
  bounds?: {
    max: readonly [number, number, number];
    min: readonly [number, number, number];
  },
): PlanarMonitorCreateRequest {
  if ("monitor" in draft) {
    return {
      expected_scene_revision: expectedSceneRevision,
      monitor: structuredClone(draft.monitor),
    };
  }
  if (!bounds) {
    throw new Error("Compatibility axis draft requires domain bounds.");
  }
  const axis = crossSectionAxisFromPlane(draft.plane);
  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const positionM =
    bounds.min[axisIndex] +
    (draft.positionPercent / 100) *
      (bounds.max[axisIndex] - bounds.min[axisIndex]);
  const frame = planarFrameFromDraft(draft, positionM);
  const idBase =
    draft.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "planar_monitor";
  return {
    expected_scene_revision: expectedSceneRevision,
    monitor: {
      frame,
      id: `${idBase}_${expectedSceneRevision + 1}`,
      name: draft.name,
      operator: { kind: "plane_sample" },
      target: {
        kind: draft.frameExtent === "universe" ? "domain" : "magnetic_domain",
      },
    },
  } as PlanarMonitorCreateRequest;
}

export function planarMonitorDraftFromMonitor(
  monitor: PlanarMonitor,
  displayLengthUnit: PlanarLengthUnit = "nm",
): PlanarMonitorDraft {
  return {
    monitor: structuredClone(monitor),
    ui: {
      displayLengthUnit,
    },
  };
}

export function planarMonitorIdentityForCreate(
  requestedName: string,
  monitors: readonly PlanarMonitor[],
): { id: string; name: string } {
  const baseName = requestedName.trim() || "Planar monitor";
  const baseId = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "planar_monitor";
  let suffix = 1;
  let id = baseId;
  let name = baseName;
  while (monitors.some((monitor) => monitor.id === id || monitor.name === name)) {
    suffix += 1;
    id = `${baseId}_${suffix}`;
    name = `${baseName} ${suffix}`;
  }
  return { id, name };
}

export function planarMonitorDuplicateRequest(
  monitor: PlanarMonitor,
  expectedSceneRevision: number,
  monitors: readonly PlanarMonitor[],
): PlanarMonitorDuplicateRequest {
  const baseId = `${monitor.id}_copy`;
  const baseName = `${monitor.name} copy`;
  let suffix = 1;
  let newId = baseId;
  let newName = baseName;
  while (monitors.some((entry) => entry.id === newId || entry.name === newName)) {
    suffix += 1;
    newId = `${baseId}_${suffix}`;
    newName = `${baseName} ${suffix}`;
  }
  return {
    expected_scene_revision: expectedSceneRevision,
    new_id: newId,
    new_name: newName,
  };
}

const LENGTH_UNIT_METRES: Record<PlanarLengthUnit, number> = {
  m: 1,
  mm: 1e-3,
  um: 1e-6,
  nm: 1e-9,
};

export function convertLength(
  value: number,
  from: PlanarLengthUnit,
  to: PlanarLengthUnit,
): number {
  return (value * LENGTH_UNIT_METRES[from]) / LENGTH_UNIT_METRES[to];
}

export function planarMonitorValidationErrors(
  monitor: PlanarMonitor,
): string[] {
  const errors: string[] = [];
  if (!monitor.id.trim()) errors.push("Monitor ID is required.");
  if (!monitor.name.trim()) errors.push("Monitor name is required.");
  if (monitor.target.kind === "object" && !monitor.target.object_id.trim()) {
    errors.push("Object target requires an object ID.");
  }
  if (monitor.target.kind === "region") {
    if (!monitor.target.object_id.trim()) {
      errors.push("Region target requires an object ID.");
    }
    if (!monitor.target.region_id.trim()) {
      errors.push("Region target requires a region ID.");
    }
  }
  const { frame } = monitor;
  if (!isUnitVector(frame.normal)) {
    errors.push("Frame normal must be a finite unit vector.");
  }
  if (!isUnitVector(frame.u_axis)) {
    errors.push("Frame u axis must be a finite unit vector.");
  }
  if (!isUnitVector(frame.v_axis)) {
    errors.push("Frame v axis must be a finite unit vector.");
  }
  if (
    !frame.origin_m.every(Number.isFinite) ||
    !frame.normal.every(Number.isFinite) ||
    !frame.u_axis.every(Number.isFinite) ||
    !frame.v_axis.every(Number.isFinite)
  ) {
    errors.push("Frame values must be finite.");
  }
  if (Math.abs(dot(frame.normal, frame.u_axis)) > 1e-12) {
    errors.push("Frame normal and u axis must be orthogonal.");
  }
  if (Math.abs(dot(frame.normal, frame.v_axis)) > 1e-12) {
    errors.push("Frame normal and v axis must be orthogonal.");
  }
  if (Math.abs(dot(frame.u_axis, frame.v_axis)) > 1e-12) {
    errors.push("Frame u and v axes must be orthogonal.");
  }
  const handed = cross(frame.u_axis, frame.v_axis);
  if (dot(handed, frame.normal) < 1 - 1e-12) {
    errors.push("Frame basis must be right-handed.");
  }
  if (frame.normalization_version !== "planar_frame_v1") {
    errors.push("Unsupported frame normalization version.");
  }
  if (frame.extent.kind === "explicit") {
    const values = [
      frame.extent.u_min_m,
      frame.extent.u_max_m,
      frame.extent.v_min_m,
      frame.extent.v_max_m,
    ];
    if (!values.every(Number.isFinite)) {
      errors.push("Explicit extent values must be finite.");
    }
    if (frame.extent.u_min_m >= frame.extent.u_max_m) {
      errors.push("Explicit u extent minimum must be smaller than maximum.");
    }
    if (frame.extent.v_min_m >= frame.extent.v_max_m) {
      errors.push("Explicit v extent minimum must be smaller than maximum.");
    }
  } else if (
    !Number.isFinite(frame.extent.padding_m) ||
    frame.extent.padding_m < 0
  ) {
    errors.push("Extent padding must be finite and non-negative.");
  }
  if (
    monitor.operator.kind === "slab_average" &&
    (!Number.isFinite(monitor.operator.thickness_m) ||
      monitor.operator.thickness_m <= 0)
  ) {
    errors.push("Slab thickness must be finite and greater than zero.");
  }
  if (
    monitor.operator.kind === "depth_projection" &&
    monitor.operator.empty_policy === "include_air_as_zero" &&
    monitor.operator.reduction !== "mean_occupied"
  ) {
    errors.push("include_air_as_zero is valid only for mean_occupied.");
  }
  if (monitor.operator.kind === "surface_projection") {
    const boundary = monitor.operator.boundary;
    if (boundary.kind === "region_boundary" && !boundary.region_id.trim()) {
      errors.push("Region boundary requires a region ID.");
    }
    if (boundary.kind === "named_surface" && !boundary.surface_id.trim()) {
      errors.push("Named surface requires a surface ID.");
    }
  }
  return errors;
}

function isUnitVector(value: number[]): boolean {
  return value.length === 3 && value.every(Number.isFinite) && Math.abs(Math.sqrt(dot(value, value)) - 1) <= 1e-12;
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function cross(left: number[], right: number[]): number[] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function planarFrameFromDraft(draft: CrossSectionDraft, positionM: number) {
  const preset = draft.plane;
  const base =
    preset === "xy"
      ? {
          normal: [0, 0, 1],
          origin: [0, 0, positionM],
          u: [1, 0, 0],
          v: [0, 1, 0],
        }
      : preset === "xz"
        ? {
            normal: [0, -1, 0],
            origin: [0, positionM, 0],
            u: [1, 0, 0],
            v: [0, 0, 1],
          }
        : {
            normal: [1, 0, 0],
            origin: [positionM, 0, 0],
            u: [0, 1, 0],
            v: [0, 0, 1],
          };
  const radians = (draft.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotate = (left: number[], right: number[], sign: number) =>
    left.map(
      (value, index) =>
        cosine * value + sign * sine * (right[index] ?? 0),
    );
  return {
    extent: {
      kind:
        draft.frameExtent === "universe"
          ? "universe"
          : draft.frameExtent === "magnetic_domain"
            ? "magnetic_domain"
            : "target_bounds",
      padding_m: 0,
    },
    normal: base.normal,
    normalization_version: "planar_frame_v1",
    origin_m: base.origin,
    preset,
    u_axis: rotate(base.u, base.v, 1),
    v_axis: rotate(base.v, base.u, -1),
  };
}

export interface CrossSectionWorkspaceState {
  activePlotId: string | null;
  draft: CrossSectionDraft | null;
  planarMonitorDraft: PlanarMonitorDraft | null;
  plots: readonly CrossSectionPlot[];
}

type CrossSectionWorkspaceListener = () => void;

const DEFAULT_DRAFT: CrossSectionDraft = {
  colorScale: "jet",
  edgeWidth: 1.5,
  filterExpression: "",
  frameExtent: "universe",
  id: "draft",
  includeWireframe: true,
  metric: "skewness",
  name: "Draft Cross-Section",
  plane: "xy",
  positionPercent: 50,
  rotationDegrees: 0,
  shrinkFactor: 1,
};

const DEFAULT_PLANAR_MONITOR: PlanarMonitor = {
  id: "planar_monitor_1",
  name: "Midplane",
  target: { kind: "domain" },
  frame: {
    origin_m: [0, 0, 0],
    u_axis: [1, 0, 0],
    v_axis: [0, 1, 0],
    normal: [0, 0, 1],
    preset: "xy",
    normalization_version: "planar_frame_v1",
    extent: { kind: "universe", padding_m: 0 },
  },
  operator: { kind: "plane_sample" },
};

const INITIAL_STATE: CrossSectionWorkspaceState = {
  activePlotId: null,
  draft: null,
  planarMonitorDraft: null,
  plots: [],
};

export function getCrossSectionWorkspaceServerSnapshot(): CrossSectionWorkspaceState {
  return INITIAL_STATE;
}

const PLANE_BY_AXIS: Record<ClipAxis, CrossSectionPlane> = {
  x: "yz",
  y: "xz",
  z: "xy",
};

const AXIS_BY_PLANE: Record<CrossSectionPlane, ClipAxis> = {
  xy: "z",
  xz: "y",
  yz: "x",
};

let plotSequence = 0;

class CrossSectionWorkspaceStore {
  private readonly listeners = new Set<CrossSectionWorkspaceListener>();
  private state: CrossSectionWorkspaceState = INITIAL_STATE;

  getSnapshot = (): CrossSectionWorkspaceState => this.state;

  subscribe = (listener: CrossSectionWorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setState(nextState: CrossSectionWorkspaceState): void {
    if (this.state === nextState) return;
    this.state = nextState;
    this.notify();
  }

  reset(): void {
    plotSequence = 0;
    this.setState(INITIAL_STATE);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const crossSectionWorkspaceStore = new CrossSectionWorkspaceStore();

export function beginPlanarMonitorDraft(
  visualizationState?: VisualizationStateResource | null,
  bounds?: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  intent?: PlanarMonitorCreateIntent,
): PlanarMonitorDraft {
  const draft = createPlanarMonitorDraft({ bounds, intent, visualizationState });
  const state = crossSectionWorkspaceStore.getSnapshot();
  crossSectionWorkspaceStore.setState({
    ...state,
    planarMonitorDraft: draft,
  });
  return draft;
}

export function createPlanarMonitorDraft({
  bounds,
  intent,
  visualizationState,
}: PlanarMonitorDraftCreationOptions = {}): PlanarMonitorDraft {
  const slice = visualizationState?.slice;
  const source = visualizationState?.clip.enabled
    ? visualizationState.clip
    : slice;
  const preset = intent?.preset ?? (source ? PLANE_BY_AXIS[source.axis] : "xy");
  const axis = crossSectionAxisFromPlane(preset);
  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const positionPercent = source?.position_percent ?? 50;
  const positionM = bounds
    ? bounds.min[axisIndex] + positionPercent / 100 * (bounds.max[axisIndex] - bounds.min[axisIndex])
    : 0;
  const frame = planarPresetFrame(preset, positionM, DEFAULT_PLANAR_MONITOR.frame.extent);
  if (visualizationState?.clip.enabled && visualizationState.clip.flipped) {
    frame.normal = frame.normal.map((value) => value === 0 ? 0 : -value) as typeof frame.normal;
    frame.v_axis = frame.v_axis.map((value) => value === 0 ? 0 : -value) as typeof frame.v_axis;
  }
  return {
    monitor: {
      ...structuredClone(DEFAULT_PLANAR_MONITOR),
      frame,
      ...(intent?.operator ? { operator: structuredClone(intent.operator) } : {}),
      ...(intent?.target ? { target: structuredClone(intent.target) } : {}),
    },
    ui: {
      displayLengthUnit: "nm",
    },
  };
}

export function updatePlanarMonitorDraft(
  patch: Partial<PlanarMonitorDraft>,
): PlanarMonitorDraft | null {
  const state = crossSectionWorkspaceStore.getSnapshot();
  if (!state.planarMonitorDraft) return null;
  const draft = sanitizePlanarMonitorDraft({
    monitor: patch.monitor ?? state.planarMonitorDraft.monitor,
    ui: patch.ui ?? state.planarMonitorDraft.ui,
  });
  crossSectionWorkspaceStore.setState({
    ...state,
    planarMonitorDraft: draft,
  });
  return draft;
}

export function discardPlanarMonitorDraft(): void {
  const state = crossSectionWorkspaceStore.getSnapshot();
  if (!state.planarMonitorDraft) return;
  crossSectionWorkspaceStore.setState({
    ...state,
    planarMonitorDraft: null,
  });
}

export function beginCrossSectionDraft(
  visualizationState?: VisualizationStateResource | null,
): CrossSectionDraft {
  const draft = draftFromVisualizationState(visualizationState);
  const state = crossSectionWorkspaceStore.getSnapshot();
  crossSectionWorkspaceStore.setState({
    ...state,
    draft,
  });
  return draft;
}

export function beginCrossSectionDraftFromPlot(
  plotId: string,
): CrossSectionDraft | null {
  const state = crossSectionWorkspaceStore.getSnapshot();
  const plot = state.plots.find((entry) => entry.id === plotId) ?? null;
  if (!plot) return null;

  const draft = draftFromPlot(plot, nextPlotName());
  crossSectionWorkspaceStore.setState({
    ...state,
    draft,
  });
  return draft;
}

export function updateCrossSectionDraft(
  patch: Partial<CrossSectionDraft>,
): CrossSectionDraft | null {
  const state = crossSectionWorkspaceStore.getSnapshot();
  if (!state.draft) return null;

  const draft = sanitizeDraft({
    ...state.draft,
    ...patch,
    id: "draft",
  });
  crossSectionWorkspaceStore.setState({
    ...state,
    draft,
  });
  return draft;
}

export function discardCrossSectionDraft(): void {
  const state = crossSectionWorkspaceStore.getSnapshot();
  if (!state.draft) return;
  crossSectionWorkspaceStore.setState({ ...state, draft: null });
}

export function commitCrossSectionDraft(): CrossSectionPlot | null {
  const state = crossSectionWorkspaceStore.getSnapshot();
  if (!state.draft) return null;

  const plot = plotFromDraft(state.draft);
  crossSectionWorkspaceStore.setState({
    activePlotId: plot.id,
    draft: null,
    planarMonitorDraft: state.planarMonitorDraft,
    plots: [...state.plots, plot],
  });
  return plot;
}

export function updateCrossSectionPlot(
  plotId: string,
  patch: Partial<CrossSectionDraft>,
): CrossSectionPlot | null {
  const state = crossSectionWorkspaceStore.getSnapshot();
  const plotIndex = state.plots.findIndex((entry) => entry.id === plotId);
  if (plotIndex < 0) return null;

  const currentPlot = state.plots[plotIndex];
  const draft = sanitizeDraft({
    ...draftFromPlot(currentPlot, currentPlot.name),
    ...patch,
    id: "draft",
  });
  const updatedPlot = plotFromDraft(draft, {
    fallbackName: currentPlot.name,
    id: currentPlot.id,
  });
  crossSectionWorkspaceStore.setState({
    ...state,
    plots: state.plots.map((entry) =>
      entry.id === plotId ? updatedPlot : entry,
    ),
  });
  return updatedPlot;
}

export function selectCrossSectionPlot(plotId: string): CrossSectionPlot | null {
  const state = crossSectionWorkspaceStore.getSnapshot();
  const plot = state.plots.find((entry) => entry.id === plotId) ?? null;
  if (!plot) return null;
  crossSectionWorkspaceStore.setState({
    ...state,
    activePlotId: plot.id,
  });
  return plot;
}

export function activeCrossSectionPlot(
  state: CrossSectionWorkspaceState,
): CrossSectionPlot | null {
  return (
    state.plots.find((plot) => plot.id === state.activePlotId) ??
    state.plots.at(-1) ??
    null
  );
}

export function activeCrossSectionFrameRotationDegrees(
  state: CrossSectionWorkspaceState,
): number {
  if (state.planarMonitorDraft) return 0;
  if (state.draft) return state.draft.rotationDegrees;
  return activeCrossSectionPlot(state)?.rotationDegrees ?? 0;
}

export function activeCrossSectionFramePreview(
  state: CrossSectionWorkspaceState,
): CrossSectionFramePreview | null {
  const source = state.draft ?? activeCrossSectionPlot(state);
  if (!source) return null;
  return {
    axis: crossSectionAxisFromPlane(source.plane),
    positionPercent: source.positionPercent,
    rotationDegrees: source.rotationDegrees,
  };
}

export function crossSectionFramePreviewEquals(
  previous: CrossSectionFramePreview | null,
  next: CrossSectionFramePreview | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.axis === next.axis &&
    previous.positionPercent === next.positionPercent &&
    previous.rotationDegrees === next.rotationDegrees
  );
}

export function crossSectionFramePreviewToClip(
  preview: CrossSectionFramePreview | null,
): VisualizationStateResource["clip"] | null {
  if (!preview) return null;
  return {
    axis: preview.axis,
    enabled: true,
    flipped: false,
    position_percent: preview.positionPercent,
  };
}

function crossSectionAxisFromPlane(plane: CrossSectionPlane): ClipAxis {
  return AXIS_BY_PLANE[plane];
}

export function resetCrossSectionWorkspaceForTests(): void {
  crossSectionWorkspaceStore.reset();
}

function draftFromVisualizationState(
  visualizationState?: VisualizationStateResource | null,
): CrossSectionDraft {
  const slice = visualizationState?.slice;
  const source = visualizationState?.clip.enabled
    ? visualizationState.clip
    : slice;
  const plane = source ? PLANE_BY_AXIS[source.axis] : DEFAULT_DRAFT.plane;
  return sanitizeDraft({
    ...DEFAULT_DRAFT,
    colorScale: slice?.mesh_color_scale ?? DEFAULT_DRAFT.colorScale,
    filterExpression:
      slice?.mesh_filter_expression ?? DEFAULT_DRAFT.filterExpression,
    includeWireframe: slice?.show_mesh ?? DEFAULT_DRAFT.includeWireframe,
    metric: slice?.mesh_quality_metric ?? DEFAULT_DRAFT.metric,
    plane,
    positionPercent:
      source?.position_percent ?? DEFAULT_DRAFT.positionPercent,
    name: nextPlotName(),
    shrinkFactor: slice?.mesh_shrink_factor ?? DEFAULT_DRAFT.shrinkFactor,
  });
}

function draftFromPlot(
  plot: CrossSectionPlot,
  name: string,
): CrossSectionDraft {
  return sanitizeDraft({
    colorScale: plot.renderOptions.colorScale,
    edgeWidth: plot.renderOptions.edgeWidth,
    filterExpression: plot.renderOptions.filterExpression,
    frameExtent: plot.frameExtent,
    id: "draft",
    includeWireframe: plot.renderOptions.wireframeVisible,
    metric: plot.metric,
    name,
    plane: plot.plane,
    positionPercent: plot.positionPercent,
    rotationDegrees: plot.rotationDegrees,
    shrinkFactor: plot.renderOptions.shrinkFactor,
  });
}

function plotFromDraft(
  draft: CrossSectionDraft,
  existing?: { fallbackName: string; id: string },
): CrossSectionPlot {
  const id = existing?.id ?? `plot-${++plotSequence}`;
  const name = draft.name.trim() || existing?.fallbackName || `Plot ${plotSequence}`;
  const query: Required<CrossSectionQuery> = {
    includePolygons: true,
    includeWireframe: draft.includeWireframe,
    plane: draft.plane,
    positionPercent: draft.positionPercent,
  };
  return {
    frameExtent: draft.frameExtent,
    id,
    metric: draft.metric,
    name,
    plane: draft.plane,
    positionPercent: draft.positionPercent,
    qualityQuery: {
      metric: draft.metric,
      plane: draft.plane,
      positionPercent: draft.positionPercent,
    },
    query,
    renderOptions: {
      colorScale: draft.colorScale,
      edgeWidth: draft.edgeWidth,
      frameRotationDegrees: draft.rotationDegrees,
      filterExpression: draft.filterExpression,
      shrinkFactor: draft.shrinkFactor,
      wireframeVisible: draft.includeWireframe,
    },
    rotationDegrees: draft.rotationDegrees,
  };
}

function nextPlotName(): string {
  return `Plot ${plotSequence + 1}`;
}

function sanitizeDraft(draft: CrossSectionDraft): CrossSectionDraft {
  return {
    ...draft,
    filterExpression: draft.filterExpression.trim(),
    name: draft.name,
    positionPercent: clamp(draft.positionPercent, 0, 100),
    rotationDegrees: clamp(draft.rotationDegrees, -180, 180),
    shrinkFactor: clamp(draft.shrinkFactor, 0.5, 1),
  };
}

function sanitizePlanarMonitorDraft(
  draft: PlanarMonitorDraft,
): PlanarMonitorDraft {
  return {
    monitor: structuredClone(draft.monitor),
    ui: {
      ...draft.ui,
    },
  };
}

function planarPresetFrame(
  preset: CrossSectionPlane,
  positionM: number,
  extent: PlanarMonitor["frame"]["extent"],
): PlanarMonitor["frame"] {
  const basis =
    preset === "xy"
      ? { normal: [0, 0, 1], origin_m: [0, 0, positionM], u_axis: [1, 0, 0], v_axis: [0, 1, 0] }
      : preset === "xz"
        ? { normal: [0, -1, 0], origin_m: [0, positionM, 0], u_axis: [1, 0, 0], v_axis: [0, 0, 1] }
        : { normal: [1, 0, 0], origin_m: [positionM, 0, 0], u_axis: [0, 1, 0], v_axis: [0, 0, 1] };
  return {
    ...basis,
    extent: structuredClone(extent),
    normalization_version: "planar_frame_v1",
    preset,
  } as PlanarMonitor["frame"];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
