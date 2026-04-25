import { useCallback, useEffect } from "react";
import { PREVIEW_MAX_POINTS_DEFAULT } from "./vectorDensityBudget";
import { SUPPORTED_ARROW_COLOR_FIELDS } from "./femGeometryUtils";
import type {
  ArrowSamplingMode,
  ClipAxis,
  FemArrowColorMode,
  FemColorField,
  FemFerromagnetVisibilityMode,
  FemVectorDomainFilter,
  RenderMode,
} from "./femMeshTypes";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";
import { useFemViewportStore } from "./useFemViewportStore";
import type { FemViewportOverlayPopover } from "./FemViewportTypes";

type CameraProjection = "perspective" | "orthographic";
type NavigationMode = "trackball" | "cad";
type OverlayPopover = FemViewportOverlayPopover;

interface UseFemViewportModelArgs {
  colorField: FemColorField;
  controlledRenderMode?: RenderMode;
  controlledOpacity?: number;
  controlledClipEnabled?: boolean;
  controlledClipAxis?: ClipAxis;
  controlledClipPos?: number;
  controlledClipFlip?: boolean;
  controlledShowArrowsRequested?: boolean;
  controlledArrowColorMode?: FemArrowColorMode;
  controlledArrowMonoColor?: string;
  controlledArrowAlpha?: number;
  controlledArrowLengthScale?: number;
  controlledArrowThickness?: number;
  controlledVectorDomainFilter?: FemVectorDomainFilter;
  controlledFerromagnetVisibilityMode?: FemFerromagnetVisibilityMode;
  controlledShrinkFactor?: number;
  controlledLegendOpen?: boolean;
  previewMaxPoints?: number;
  onPreviewMaxPointsChange?: (maxPoints: number) => void;
  onLegendOpenChange?: (value: boolean) => void;
}

export interface FemViewportModel {
  renderMode: RenderMode;
  opacity: number;
  clipEnabled: boolean;
  clipAxis: ClipAxis;
  clipPos: number;
  clipFlip: boolean;
  showArrowsRequested: boolean;
  arrowColorMode: FemArrowColorMode;
  arrowMonoColor: string;
  arrowAlpha: number;
  arrowLengthScale: number;
  arrowThickness: number;
  arrowSamplingMode: ArrowSamplingMode;
  vectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  resolvedPreviewMaxPoints: number;
  shrinkFactor: number;
  cameraProjection: CameraProjection;
  navigationMode: NavigationMode;
  legendOpen: boolean;
  labeledMode: boolean;
  openPopover: OverlayPopover;
  qualityProfile: ViewportQualityProfileId;
  interactionActive: boolean;
  captureActive: boolean;
  captureOverlayHidden: boolean;
  textureGizmoDragging: boolean;
  sampledArrowCount: number | undefined;
  setInternalRenderMode: React.Dispatch<React.SetStateAction<RenderMode>>;
  setInternalOpacity: React.Dispatch<React.SetStateAction<number>>;
  setInternalArrowColorMode: React.Dispatch<React.SetStateAction<FemArrowColorMode>>;
  setInternalArrowMonoColor: React.Dispatch<React.SetStateAction<string>>;
  setInternalArrowAlpha: React.Dispatch<React.SetStateAction<number>>;
  setInternalArrowLengthScale: React.Dispatch<React.SetStateAction<number>>;
  setInternalArrowThickness: React.Dispatch<React.SetStateAction<number>>;
  setInternalArrowSamplingMode: React.Dispatch<React.SetStateAction<ArrowSamplingMode>>;
  setInternalClipEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setInternalClipAxis: React.Dispatch<React.SetStateAction<ClipAxis>>;
  setInternalClipPos: React.Dispatch<React.SetStateAction<number>>;
  setInternalClipFlip: React.Dispatch<React.SetStateAction<boolean>>;
  setInternalShowArrows: React.Dispatch<React.SetStateAction<boolean>>;
  setInternalVectorDomainFilter: React.Dispatch<React.SetStateAction<FemVectorDomainFilter>>;
  setInternalFerromagnetVisibilityMode: React.Dispatch<React.SetStateAction<FemFerromagnetVisibilityMode>>;
  setInternalPreviewMaxPoints: React.Dispatch<React.SetStateAction<number>>;
  setInternalShrinkFactor: React.Dispatch<React.SetStateAction<number>>;
  setCameraProjection: React.Dispatch<React.SetStateAction<CameraProjection>>;
  setNavigationMode: React.Dispatch<React.SetStateAction<NavigationMode>>;
  setLegendOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setLabeledMode: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenPopover: React.Dispatch<React.SetStateAction<OverlayPopover>>;
  setQualityProfile: React.Dispatch<React.SetStateAction<ViewportQualityProfileId>>;
  setInteractionActive: React.Dispatch<React.SetStateAction<boolean>>;
  setTextureGizmoDragging: React.Dispatch<React.SetStateAction<boolean>>;
  setSampledArrowCount: React.Dispatch<React.SetStateAction<number | undefined>>;
  setCaptureActive: React.Dispatch<React.SetStateAction<boolean>>;
  setCaptureOverlayHidden: React.Dispatch<React.SetStateAction<boolean>>;
  updateSharedPreviewMaxPoints: (nextMaxPoints: number) => void;
}

export function useFemViewportModel({
  colorField,
  controlledRenderMode,
  controlledOpacity,
  controlledClipEnabled,
  controlledClipAxis,
  controlledClipPos,
  controlledClipFlip,
  controlledShowArrowsRequested,
  controlledArrowColorMode,
  controlledArrowMonoColor,
  controlledArrowAlpha,
  controlledArrowLengthScale,
  controlledArrowThickness,
  controlledVectorDomainFilter,
  controlledFerromagnetVisibilityMode,
  controlledShrinkFactor,
  controlledLegendOpen,
  previewMaxPoints,
  onPreviewMaxPointsChange,
  onLegendOpenChange,
}: UseFemViewportModelArgs): FemViewportModel {
  const initialArrowColorMode =
    SUPPORTED_ARROW_COLOR_FIELDS.has(colorField as FemArrowColorMode)
      ? (colorField as FemArrowColorMode)
      : "orientation";
  const { state, dispatch } = useFemViewportStore({
    view: {
      renderMode: "surface",
      opacity: 100,
      arrowColorMode: initialArrowColorMode,
      arrowMonoColor: "#00c2ff",
      arrowAlpha: 1,
      arrowLengthScale: 1,
      arrowThickness: 1,
      arrowSamplingMode: "auto",
      vectorDomainFilter: "auto",
      ferromagnetVisibilityMode: "hide",
      previewMaxPoints: PREVIEW_MAX_POINTS_DEFAULT,
      shrinkFactor: 1,
      projection: "perspective",
      navigation: "cad",
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
      surfaceColorField: colorField,
      arrowColorField: initialArrowColorMode,
    },
  });

  const renderMode = controlledRenderMode ?? state.view.renderMode;
  const opacity = controlledOpacity ?? state.view.opacity;
  const clipEnabled = controlledClipEnabled ?? state.view.clip.enabled;
  const clipAxis = controlledClipAxis ?? state.view.clip.axis;
  const clipPos = controlledClipPos ?? state.view.clip.position;
  const clipFlip = controlledClipFlip ?? state.view.clip.flip;
  const showArrowsRequested = controlledShowArrowsRequested ?? state.view.arrowsVisible;
  const arrowColorMode = controlledArrowColorMode ?? state.view.arrowColorMode;
  const arrowMonoColor = controlledArrowMonoColor ?? state.view.arrowMonoColor;
  const arrowAlpha = controlledArrowAlpha ?? state.view.arrowAlpha;
  const arrowLengthScale = controlledArrowLengthScale ?? state.view.arrowLengthScale;
  const arrowThickness = controlledArrowThickness ?? state.view.arrowThickness;
  const arrowSamplingMode = state.view.arrowSamplingMode;
  const vectorDomainFilter = controlledVectorDomainFilter ?? state.view.vectorDomainFilter;
  const ferromagnetVisibilityMode =
    controlledFerromagnetVisibilityMode ?? state.view.ferromagnetVisibilityMode;
  const resolvedPreviewMaxPoints = previewMaxPoints ?? state.view.previewMaxPoints;
  const shrinkFactor = controlledShrinkFactor ?? state.view.shrinkFactor;
  const cameraProjection = state.view.projection;
  const navigationMode = state.view.navigation;
  const legendOpen = controlledLegendOpen ?? state.view.legendOpen;
  const labeledMode = state.view.labeledMode;
  const openPopover = state.view.openPopover;
  const qualityProfile = state.view.qualityProfile;
  const interactionActive = state.runtime.interactionActive;
  const textureGizmoDragging = state.runtime.textureGizmoDragging;
  const sampledArrowCount = state.runtime.sampledArrowCount;
  const captureActive = state.runtime.captureActive;
  const captureOverlayHidden = state.runtime.captureOverlayHidden;

  const makeSetter = useCallback(<T,>(
    computeNext: (prev: T, next: React.SetStateAction<T>) => T,
    dispatchValue: (value: T) => void,
    getCurrent: () => T,
  ): React.Dispatch<React.SetStateAction<T>> => {
    return (next) => {
      const value = computeNext(getCurrent(), next);
      dispatchValue(value);
    };
  }, []);

  const setInternalRenderMode = makeSetter<RenderMode>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setRenderMode", value }),
    () => state.view.renderMode,
  );
  const setInternalOpacity = makeSetter<number>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setOpacity", value }),
    () => state.view.opacity,
  );
  const setInternalArrowColorMode = makeSetter<FemArrowColorMode>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setArrowColorMode", value }),
    () => state.view.arrowColorMode,
  );
  const setInternalArrowMonoColor = makeSetter<string>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setArrowMonoColor", value }),
    () => state.view.arrowMonoColor,
  );
  const setInternalArrowAlpha = makeSetter<number>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setArrowAlpha", value }),
    () => state.view.arrowAlpha,
  );
  const setInternalArrowLengthScale = makeSetter<number>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setArrowLengthScale", value }),
    () => state.view.arrowLengthScale,
  );
  const setInternalArrowThickness = makeSetter<number>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setArrowThickness", value }),
    () => state.view.arrowThickness,
  );
  const setInternalArrowSamplingMode = makeSetter<ArrowSamplingMode>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setArrowSamplingMode", value }),
    () => state.view.arrowSamplingMode,
  );
  const setInternalClipEnabled = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setClipEnabled", value }),
    () => state.view.clip.enabled,
  );
  const setInternalClipAxis = makeSetter<ClipAxis>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setClipAxis", value }),
    () => state.view.clip.axis,
  );
  const setInternalClipPos = makeSetter<number>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setClipPosition", value }),
    () => state.view.clip.position,
  );
  const setInternalClipFlip = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setClipFlip", value }),
    () => state.view.clip.flip,
  );
  const setInternalShowArrows = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setArrowsVisible", value }),
    () => state.view.arrowsVisible,
  );
  const setInternalVectorDomainFilter = makeSetter<FemVectorDomainFilter>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setVectorDomainFilter", value }),
    () => state.view.vectorDomainFilter,
  );
  const setInternalFerromagnetVisibilityMode = makeSetter<FemFerromagnetVisibilityMode>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setFerromagnetVisibilityMode", value }),
    () => state.view.ferromagnetVisibilityMode,
  );
  const setInternalPreviewMaxPoints = makeSetter<number>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setPreviewMaxPoints", value }),
    () => state.view.previewMaxPoints,
  );
  const setInternalShrinkFactor = makeSetter<number>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setShrinkFactor", value }),
    () => state.view.shrinkFactor,
  );
  const setCameraProjection = makeSetter<CameraProjection>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setProjection", value }),
    () => state.view.projection,
  );
  const setNavigationMode = makeSetter<NavigationMode>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setNavigation", value }),
    () => state.view.navigation,
  );
  const setLegendOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((next) => {
    const previous = controlledLegendOpen ?? state.view.legendOpen;
    const value = typeof next === "function" ? next(previous) : next;
    if (controlledLegendOpen !== undefined && onLegendOpenChange) {
      onLegendOpenChange(value);
      return;
    }
    dispatch({ type: "setLegendOpen", value });
  }, [controlledLegendOpen, dispatch, onLegendOpenChange, state.view.legendOpen]);
  const setLabeledMode = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setLabeledMode", value }),
    () => state.view.labeledMode,
  );
  const setOpenPopover = makeSetter<OverlayPopover>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setOpenPopover", value }),
    () => state.view.openPopover,
  );
  const setQualityProfile = makeSetter<ViewportQualityProfileId>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setQualityProfile", value }),
    () => state.view.qualityProfile,
  );
  const setInteractionActive = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setInteractionActive", value }),
    () => state.runtime.interactionActive,
  );
  const setTextureGizmoDragging = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setTextureGizmoDragging", value }),
    () => state.runtime.textureGizmoDragging,
  );
  const setSampledArrowCount = makeSetter<number | undefined>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setSampledArrowCount", value }),
    () => state.runtime.sampledArrowCount,
  );
  const setCaptureActive = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setCaptureActive", value }),
    () => state.runtime.captureActive,
  );
  const setCaptureOverlayHidden = makeSetter<boolean>(
    (prev, next) => (typeof next === "function" ? next(prev) : next),
    (value) => dispatch({ type: "setCaptureOverlayHidden", value }),
    () => state.runtime.captureOverlayHidden,
  );

  const updateSharedPreviewMaxPoints = useCallback((nextMaxPoints: number) => {
    if (onPreviewMaxPointsChange) {
      onPreviewMaxPointsChange(nextMaxPoints);
      return;
    }
    dispatch({ type: "setPreviewMaxPoints", value: nextMaxPoints });
  }, [dispatch, onPreviewMaxPointsChange]);

  useEffect(() => {
    if (controlledArrowColorMode != null) {
      return;
    }
    const next =
      SUPPORTED_ARROW_COLOR_FIELDS.has(colorField as FemArrowColorMode)
        ? (colorField as FemArrowColorMode)
        : "orientation";
    dispatch({ type: "setArrowColorMode", value: next });
    dispatch({ type: "setToolbarArrowColorField", value: next });
  }, [colorField, controlledArrowColorMode, dispatch]);

  useEffect(() => {
    dispatch({ type: "setSurfaceColorField", value: colorField });
  }, [colorField, dispatch]);

  return {
    renderMode,
    opacity,
    clipEnabled,
    clipAxis,
    clipPos,
    clipFlip,
    showArrowsRequested,
    arrowColorMode,
    arrowMonoColor,
    arrowAlpha,
    arrowLengthScale,
    arrowThickness,
    arrowSamplingMode,
    vectorDomainFilter,
    ferromagnetVisibilityMode,
    resolvedPreviewMaxPoints,
    shrinkFactor,
    cameraProjection,
    navigationMode,
    legendOpen,
    labeledMode,
    openPopover,
    qualityProfile,
    interactionActive,
    captureActive,
    captureOverlayHidden,
    textureGizmoDragging,
    sampledArrowCount,
    setInternalRenderMode,
    setInternalOpacity,
    setInternalArrowColorMode,
    setInternalArrowMonoColor,
    setInternalArrowAlpha,
    setInternalArrowLengthScale,
    setInternalArrowThickness,
    setInternalArrowSamplingMode,
    setInternalClipEnabled,
    setInternalClipAxis,
    setInternalClipPos,
    setInternalClipFlip,
    setInternalShowArrows,
    setInternalVectorDomainFilter,
    setInternalFerromagnetVisibilityMode,
    setInternalPreviewMaxPoints,
    setInternalShrinkFactor,
    setCameraProjection,
    setNavigationMode,
    setLegendOpen,
    setLabeledMode,
    setOpenPopover,
    setQualityProfile,
    setInteractionActive,
    setTextureGizmoDragging,
    setSampledArrowCount,
    setCaptureActive,
    setCaptureOverlayHidden,
    updateSharedPreviewMaxPoints,
  };
}
