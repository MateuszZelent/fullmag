"use client";

import { useMemo, useReducer } from "react";
import { PREVIEW_MAX_POINTS_DEFAULT } from "./vectorDensityBudget";
import type {
  FemViewportNavigation,
  FemViewportOverlayPopover,
  FemViewportProjection,
  FemViewportStoreState,
} from "./FemViewportTypes";
import type {
  ClipAxis,
  FemArrowColorMode,
  FemColorField,
  FemFerromagnetVisibilityMode,
  FemVectorDomainFilter,
  RenderMode,
} from "./femMeshTypes";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";

export type FemViewportStoreAction =
  | { type: "setRenderMode"; value: RenderMode }
  | { type: "setOpacity"; value: number }
  | { type: "setArrowColorMode"; value: FemArrowColorMode }
  | { type: "setArrowMonoColor"; value: string }
  | { type: "setArrowAlpha"; value: number }
  | { type: "setArrowLengthScale"; value: number }
  | { type: "setArrowThickness"; value: number }
  | { type: "setVectorDomainFilter"; value: FemVectorDomainFilter }
  | { type: "setFerromagnetVisibilityMode"; value: FemFerromagnetVisibilityMode }
  | { type: "setPreviewMaxPoints"; value: number }
  | { type: "setShrinkFactor"; value: number }
  | { type: "setProjection"; value: FemViewportProjection }
  | { type: "setNavigation"; value: FemViewportNavigation }
  | { type: "setClipEnabled"; value: boolean }
  | { type: "setClipAxis"; value: ClipAxis }
  | { type: "setClipPosition"; value: number }
  | { type: "setClipFlip"; value: boolean }
  | { type: "setArrowsVisible"; value: boolean }
  | { type: "setQualityProfile"; value: ViewportQualityProfileId }
  | { type: "setPartExplorerOpen"; value: boolean }
  | { type: "setLegendOpen"; value: boolean }
  | { type: "setLabeledMode"; value: boolean }
  | { type: "setOpenPopover"; value: FemViewportOverlayPopover }
  | { type: "setInteractionActive"; value: boolean }
  | { type: "setTextureGizmoDragging"; value: boolean }
  | { type: "setSampledArrowCount"; value: number | undefined }
  | { type: "setCaptureActive"; value: boolean }
  | { type: "setCaptureOverlayHidden"; value: boolean }
  | { type: "setSurfaceColorField"; value: FemColorField }
  | { type: "setToolbarArrowColorField"; value: FemArrowColorMode }
  | { type: "setSelectedFaces"; value: number[] }
  | { type: "setHoveredFaceIndex"; value: number | null }
  | { type: "resetSelection" };

export const INITIAL_FEM_VIEWPORT_STORE_STATE: FemViewportStoreState = {
  view: {
    renderMode: "surface",
    opacity: 100,
    arrowColorMode: "orientation",
    arrowMonoColor: "#00c2ff",
    arrowAlpha: 1,
    arrowLengthScale: 1,
    arrowThickness: 1,
    vectorDomainFilter: "auto",
    ferromagnetVisibilityMode: "hide",
    previewMaxPoints: PREVIEW_MAX_POINTS_DEFAULT,
    shrinkFactor: 1,
    projection: "perspective",
    navigation: "trackball",
    clip: {
      enabled: false,
      axis: "x",
      position: 50,
      flip: false,
    },
    arrowsVisible: false,
    qualityProfile: "interactive",
    legendOpen: false,
    labeledMode: false,
    openPopover: null,
  },
  panels: {
    partExplorerOpen: true,
  },
  runtime: {
    interactionActive: false,
    textureGizmoDragging: false,
    sampledArrowCount: undefined,
    captureActive: false,
    captureOverlayHidden: false,
  },
  toolbar: {
    surfaceColorField: "orientation",
    arrowColorField: "orientation",
  },
  selection: {
    selectedFaceIndices: [],
    hoveredFaceIndex: null,
  },
};

export function femViewportStoreReducer(
  state: FemViewportStoreState,
  action: FemViewportStoreAction,
): FemViewportStoreState {
  switch (action.type) {
    case "setRenderMode":
      return { ...state, view: { ...state.view, renderMode: action.value } };
    case "setOpacity":
      return { ...state, view: { ...state.view, opacity: action.value } };
    case "setArrowColorMode":
      return { ...state, view: { ...state.view, arrowColorMode: action.value } };
    case "setArrowMonoColor":
      return { ...state, view: { ...state.view, arrowMonoColor: action.value } };
    case "setArrowAlpha":
      return { ...state, view: { ...state.view, arrowAlpha: action.value } };
    case "setArrowLengthScale":
      return { ...state, view: { ...state.view, arrowLengthScale: action.value } };
    case "setArrowThickness":
      return { ...state, view: { ...state.view, arrowThickness: action.value } };
    case "setVectorDomainFilter":
      return { ...state, view: { ...state.view, vectorDomainFilter: action.value } };
    case "setFerromagnetVisibilityMode":
      return { ...state, view: { ...state.view, ferromagnetVisibilityMode: action.value } };
    case "setPreviewMaxPoints":
      return { ...state, view: { ...state.view, previewMaxPoints: action.value } };
    case "setShrinkFactor":
      return { ...state, view: { ...state.view, shrinkFactor: action.value } };
    case "setProjection":
      return { ...state, view: { ...state.view, projection: action.value } };
    case "setNavigation":
      return { ...state, view: { ...state.view, navigation: action.value } };
    case "setClipEnabled":
      return { ...state, view: { ...state.view, clip: { ...state.view.clip, enabled: action.value } } };
    case "setClipAxis":
      return { ...state, view: { ...state.view, clip: { ...state.view.clip, axis: action.value } } };
    case "setClipPosition":
      return { ...state, view: { ...state.view, clip: { ...state.view.clip, position: action.value } } };
    case "setClipFlip":
      return { ...state, view: { ...state.view, clip: { ...state.view.clip, flip: action.value } } };
    case "setArrowsVisible":
      return { ...state, view: { ...state.view, arrowsVisible: action.value } };
    case "setQualityProfile":
      return { ...state, view: { ...state.view, qualityProfile: action.value } };
    case "setPartExplorerOpen":
      return { ...state, panels: { ...state.panels, partExplorerOpen: action.value } };
    case "setLegendOpen":
      return { ...state, view: { ...state.view, legendOpen: action.value } };
    case "setLabeledMode":
      return { ...state, view: { ...state.view, labeledMode: action.value } };
    case "setOpenPopover":
      return { ...state, view: { ...state.view, openPopover: action.value } };
    case "setInteractionActive":
      return { ...state, runtime: { ...state.runtime, interactionActive: action.value } };
    case "setTextureGizmoDragging":
      return { ...state, runtime: { ...state.runtime, textureGizmoDragging: action.value } };
    case "setSampledArrowCount":
      return { ...state, runtime: { ...state.runtime, sampledArrowCount: action.value } };
    case "setCaptureActive":
      return { ...state, runtime: { ...state.runtime, captureActive: action.value } };
    case "setCaptureOverlayHidden":
      return { ...state, runtime: { ...state.runtime, captureOverlayHidden: action.value } };
    case "setSurfaceColorField":
      return { ...state, toolbar: { ...state.toolbar, surfaceColorField: action.value } };
    case "setToolbarArrowColorField":
      return { ...state, toolbar: { ...state.toolbar, arrowColorField: action.value } };
    case "setSelectedFaces":
      return { ...state, selection: { ...state.selection, selectedFaceIndices: action.value } };
    case "setHoveredFaceIndex":
      return { ...state, selection: { ...state.selection, hoveredFaceIndex: action.value } };
    case "resetSelection":
      return { ...state, selection: { selectedFaceIndices: [], hoveredFaceIndex: null } };
    default:
      return state;
  }
}

export function useFemViewportStore(initial?: Partial<FemViewportStoreState>) {
  const hydrated = useMemo<FemViewportStoreState>(() => {
    if (!initial) {
      return INITIAL_FEM_VIEWPORT_STORE_STATE;
    }
    return {
      view: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.view,
        ...(initial.view ?? {}),
        clip: {
          ...INITIAL_FEM_VIEWPORT_STORE_STATE.view.clip,
          ...(initial.view?.clip ?? {}),
        },
      },
      panels: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.panels,
        ...(initial.panels ?? {}),
      },
      runtime: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.runtime,
        ...(initial.runtime ?? {}),
      },
      toolbar: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.toolbar,
        ...(initial.toolbar ?? {}),
      },
      selection: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.selection,
        ...(initial.selection ?? {}),
      },
    };
  }, [initial]);

  const [state, dispatch] = useReducer(femViewportStoreReducer, hydrated);
  return { state, dispatch };
}
