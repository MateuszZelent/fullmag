import type {
  Viewport3DClipAxis,
  Viewport3DComponent,
  Viewport3DInteractionMode,
  Viewport3DNavigationProfile,
  Viewport3DObjectViewMode,
  Viewport3DProjectionMode,
  Viewport3DRenderMode,
  Viewport3DToolbarState,
} from "./viewport3dContracts";

const DEFAULT_TOOLBAR_STATE: Viewport3DToolbarState = {
  rowA: {
    quantity: null,
    component: "3D",
    everyN: 1,
    colormap: "viridis",
    autoScale: true,
    showPrimitives: true,
    showMesh: false,
    showQuantity: true,
    renderMode: "shaded",
    opacity: 100,
    clipEnabled: false,
    clipAxis: "z",
    clipPosition: 50,
    clipFlip: 1,
  },
  rowB: {
    interactionMode: "camera",
    snapEnabled: false,
    objectView: "context",
    vectorsVisible: true,
    legendVisible: true,
    partExplorerVisible: false,
    projection: "perspective",
    navProfile: "trackball",
  },
  popovers: {
    color: false,
    display: false,
    vectors: false,
    voxel: false,
    topography: false,
    clip: false,
    camera: false,
    panels: false,
    info: false,
    rotationDebug: false,
    liveRenderDebug: false,
    snapSettings: false,
  },
  controlStates: {},
};

export type Viewport3DToolbarAction =
  | { type: "setQuantity"; value: string | null }
  | { type: "setComponent"; value: Viewport3DComponent }
  | { type: "setEveryN"; value: number }
  | { type: "setColormap"; value: string }
  | { type: "setAutoScale"; value: boolean }
  | { type: "setLayerVisibility"; layer: "primitives" | "mesh" | "quantity"; value: boolean }
  | { type: "setRenderMode"; value: Viewport3DRenderMode }
  | { type: "setOpacity"; value: number }
  | { type: "setClipEnabled"; value: boolean }
  | { type: "setClipAxis"; value: Viewport3DClipAxis }
  | { type: "setClipPosition"; value: number }
  | { type: "flipClip" }
  | { type: "setInteractionMode"; value: Viewport3DInteractionMode }
  | { type: "setSnapEnabled"; value: boolean }
  | { type: "setObjectView"; value: Viewport3DObjectViewMode }
  | { type: "setVectorsVisible"; value: boolean }
  | { type: "setLegendVisible"; value: boolean }
  | { type: "setPartExplorerVisible"; value: boolean }
  | { type: "setProjection"; value: Viewport3DProjectionMode }
  | { type: "setNavigationProfile"; value: Viewport3DNavigationProfile }
  | { type: "togglePopover"; key: keyof Viewport3DToolbarState["popovers"] }
  | { type: "setPopover"; key: keyof Viewport3DToolbarState["popovers"]; value: boolean }
  | { type: "replace"; value: Viewport3DToolbarState };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface Viewport3DToolbarStateOverrides {
  rowA?: Partial<Viewport3DToolbarState["rowA"]>;
  rowB?: Partial<Viewport3DToolbarState["rowB"]>;
  popovers?: Partial<Viewport3DToolbarState["popovers"]>;
  controlStates?: Partial<Viewport3DToolbarState["controlStates"]>;
}

export function createViewport3DToolbarState(
  overrides?: Viewport3DToolbarStateOverrides,
): Viewport3DToolbarState {
  if (!overrides) {
    return DEFAULT_TOOLBAR_STATE;
  }
  return {
    rowA: { ...DEFAULT_TOOLBAR_STATE.rowA, ...(overrides.rowA ?? {}) },
    rowB: { ...DEFAULT_TOOLBAR_STATE.rowB, ...(overrides.rowB ?? {}) },
    popovers: { ...DEFAULT_TOOLBAR_STATE.popovers, ...(overrides.popovers ?? {}) },
    controlStates: { ...DEFAULT_TOOLBAR_STATE.controlStates, ...(overrides.controlStates ?? {}) },
  };
}

export function viewport3dToolbarReducer(
  state: Viewport3DToolbarState,
  action: Viewport3DToolbarAction,
): Viewport3DToolbarState {
  switch (action.type) {
    case "setQuantity":
      return { ...state, rowA: { ...state.rowA, quantity: action.value } };
    case "setComponent":
      return { ...state, rowA: { ...state.rowA, component: action.value } };
    case "setEveryN":
      return {
        ...state,
        rowA: { ...state.rowA, everyN: Math.max(1, Math.round(action.value)) },
      };
    case "setColormap":
      return { ...state, rowA: { ...state.rowA, colormap: action.value } };
    case "setAutoScale":
      return { ...state, rowA: { ...state.rowA, autoScale: action.value } };
    case "setLayerVisibility":
      if (action.layer === "primitives") {
        return {
          ...state,
          rowA: { ...state.rowA, showPrimitives: action.value },
        };
      }
      if (action.layer === "mesh") {
        return {
          ...state,
          rowA: { ...state.rowA, showMesh: action.value },
        };
      }
      return {
        ...state,
        rowA: { ...state.rowA, showQuantity: action.value },
      };
    case "setRenderMode":
      return { ...state, rowA: { ...state.rowA, renderMode: action.value } };
    case "setOpacity":
      return {
        ...state,
        rowA: { ...state.rowA, opacity: clamp(action.value, 0, 100) },
      };
    case "setClipEnabled":
      return { ...state, rowA: { ...state.rowA, clipEnabled: action.value } };
    case "setClipAxis":
      return { ...state, rowA: { ...state.rowA, clipAxis: action.value } };
    case "setClipPosition":
      return {
        ...state,
        rowA: { ...state.rowA, clipPosition: clamp(action.value, 0, 100) },
      };
    case "flipClip":
      return {
        ...state,
        rowA: { ...state.rowA, clipFlip: state.rowA.clipFlip === 1 ? -1 : 1 },
      };
    case "setInteractionMode":
      return { ...state, rowB: { ...state.rowB, interactionMode: action.value } };
    case "setSnapEnabled":
      return { ...state, rowB: { ...state.rowB, snapEnabled: action.value } };
    case "setObjectView":
      return { ...state, rowB: { ...state.rowB, objectView: action.value } };
    case "setVectorsVisible":
      return { ...state, rowB: { ...state.rowB, vectorsVisible: action.value } };
    case "setLegendVisible":
      return { ...state, rowB: { ...state.rowB, legendVisible: action.value } };
    case "setPartExplorerVisible":
      return { ...state, rowB: { ...state.rowB, partExplorerVisible: action.value } };
    case "setProjection":
      return { ...state, rowB: { ...state.rowB, projection: action.value } };
    case "setNavigationProfile":
      return { ...state, rowB: { ...state.rowB, navProfile: action.value } };
    case "togglePopover":
      return {
        ...state,
        popovers: {
          ...state.popovers,
          [action.key]: !state.popovers[action.key],
        },
      };
    case "setPopover":
      return {
        ...state,
        popovers: {
          ...state.popovers,
          [action.key]: action.value,
        },
      };
    case "replace":
      return action.value;
    default:
      return state;
  }
}
