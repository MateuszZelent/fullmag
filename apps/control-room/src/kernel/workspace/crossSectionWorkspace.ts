import type {
  CrossSectionPlane,
  CrossSectionQualityMetric,
  CrossSectionQualityQuery,
  CrossSectionQuery,
  SliceMeshColorScale,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";

type ClipAxis = VisualizationStateResource["clip"]["axis"];

export type CrossSectionFrameExtent =
  | "custom"
  | "magnetic_domain"
  | "object_bounds"
  | "universe";

export interface CrossSectionPlotRenderOptions {
  colorScale: SliceMeshColorScale;
  frameRotationDegrees: number;
  filterExpression: string;
  shrinkFactor: number;
  wireframeVisible: boolean;
}

export interface CrossSectionDraft {
  colorScale: SliceMeshColorScale;
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

export interface CrossSectionWorkspaceState {
  activePlotId: string | null;
  draft: CrossSectionDraft | null;
  plots: readonly CrossSectionPlot[];
}

type CrossSectionWorkspaceListener = () => void;

const DEFAULT_DRAFT: CrossSectionDraft = {
  colorScale: "jet",
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

export function crossSectionAxisFromPlane(
  plane: CrossSectionPlane,
): ClipAxis {
  return AXIS_BY_PLANE[plane];
}

export function crossSectionVisualizationPatchFromDraft(
  draft: CrossSectionDraft,
): VisualizationStatePatch {
  const axis = crossSectionAxisFromPlane(draft.plane);
  return {
    clip: {
      axis,
      enabled: true,
      position_percent: draft.positionPercent,
    },
    slice: {
      axis,
      mesh_color_scale: draft.colorScale,
      mesh_filter_expression: draft.filterExpression,
      mesh_quality_metric: draft.metric,
      mesh_shrink_factor: draft.shrinkFactor,
      position_percent: draft.positionPercent,
      show_mesh: draft.includeWireframe,
    },
  };
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
    shrinkFactor: slice?.mesh_shrink_factor ?? DEFAULT_DRAFT.shrinkFactor,
  });
}

function plotFromDraft(draft: CrossSectionDraft): CrossSectionPlot {
  const id = `plot-${++plotSequence}`;
  const name = draft.name.trim() || `Plot ${plotSequence}`;
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
      frameRotationDegrees: draft.rotationDegrees,
      filterExpression: draft.filterExpression,
      shrinkFactor: draft.shrinkFactor,
      wireframeVisible: draft.includeWireframe,
    },
    rotationDegrees: draft.rotationDegrees,
  };
}

function sanitizeDraft(draft: CrossSectionDraft): CrossSectionDraft {
  return {
    ...draft,
    filterExpression: draft.filterExpression.trim(),
    name: draft.name.trim() || DEFAULT_DRAFT.name,
    positionPercent: clamp(draft.positionPercent, 0, 100),
    rotationDegrees: clamp(draft.rotationDegrees, -180, 180),
    shrinkFactor: clamp(draft.shrinkFactor, 0.5, 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
