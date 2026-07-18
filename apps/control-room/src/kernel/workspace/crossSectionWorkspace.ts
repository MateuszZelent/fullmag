import type {
  CrossSectionPlane,
  CrossSectionQualityMetric,
  CrossSectionQualityQuery,
  CrossSectionQuery,
  SliceMeshColorScale,
  VisualizationStateResource,
  PlanarMonitorCreateRequest,
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

export interface CrossSectionDraft {
  colorScale: SliceMeshColorScale;
  edgeWidth: number;
  filterExpression: string;
  frameExtent: CrossSectionFrameExtent;
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

export type PlanarMonitorDraft = CrossSectionDraft;

export function isPlanarMonitorRevisionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 409
  );
}

export function planarMonitorCreateRequestFromDraft(
  draft: PlanarMonitorDraft,
  expectedSceneRevision: number,
  bounds: {
    max: readonly [number, number, number];
    min: readonly [number, number, number];
  },
): PlanarMonitorCreateRequest {
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

function planarFrameFromDraft(draft: PlanarMonitorDraft, positionM: number) {
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

const INITIAL_STATE: CrossSectionWorkspaceState = {
  activePlotId: null,
  draft: null,
  plots: [],
};

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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
