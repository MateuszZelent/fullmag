/**
 * Layer D: Viewport Core Store
 *
 * Zustand store owning all transient viewport UI state that was previously
 * scattered across ViewportContextValue + ModelContextValue.
 *
 * Render components subscribe to narrow selectors, so a camera change
 * won't re-render the sidebar and vice versa.
 */

import { create } from "zustand";
import type { SetStateAction } from "react";
import type { InteractionMode, ViewportHoverTarget } from "../interaction/interactionMode.types";
import type { ViewportMode, VectorComponent, SlicePlane, FemDockTab, ViewportScope, ObjectViewMode } from "../../../components/runs/control-room/shared";
import type { VisibleSubmeshSnapshot } from "../../../components/runs/control-room/submeshSnapshot";
import type {
  ClipAxis,
  FemArrowColorMode,
  FemColorField,
  FemFerromagnetVisibilityMode,
  FemVectorDomainFilter,
  MeshSelectionSnapshot,
  RenderMode,
} from "@/components/preview/FemMeshView3D";
import type { MeshEntityViewStateMap } from "@/lib/session/types";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

/* ── Camera Profile ── */
export interface CameraProfile {
  preset: "perspective" | "ortho-top" | "ortho-front" | "ortho-right" | "isometric";
  fov: number;
  distance: number;
  target: [number, number, number];
}

const DEFAULT_CAMERA: CameraProfile = {
  preset: "perspective",
  fov: 50,
  distance: 4,
  target: [0, 0, 0],
};

const AIRBOX_DISABLED_BY_DEFAULT =
  FRONTEND_DIAGNOSTIC_FLAGS.femViewport.airboxDisabledByDefault;

/* ── Store State ── */
export interface ViewportCoreState {
  /* Interaction */
  interactionMode: InteractionMode;
  hoverTarget: ViewportHoverTarget | null;
  isDragging: boolean;
  gizmoActiveAxis: "x" | "y" | "z" | null;

  /* Camera */
  camera: CameraProfile;

  /* View modes (migrated from ViewportContextValue) */
  viewMode: ViewportMode;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
  selectedQuantity: string;

  /* Console / Sidebar chrome */
  consoleCollapsed: boolean;
  sidebarCollapsed: boolean;

  /* FEM render settings (migrated from ModelContextValue) */
  meshRenderMode: RenderMode;
  meshOpacity: number;
  meshClipEnabled: boolean;
  meshClipAxis: ClipAxis;
  meshClipPos: number;
  meshShowArrows: boolean;
  femArrowColorMode: FemArrowColorMode;
  femArrowMonoColor: string;
  femArrowAlpha: number;
  femArrowLengthScale: number;
  femArrowThickness: number;
  femVectorDomainFilter: FemVectorDomainFilter;
  femFerromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  femColorField: FemColorField;
  femMagnetization3DActive: boolean;
  femDockTab: FemDockTab;

  /* Viewport scope / focus */
  cameraFitRequestSeed: number;
  viewportScope: ViewportScope;
  objectViewMode: ObjectViewMode;
  activeTransformScope: "object" | "texture" | null;
  meshEntityViewState: MeshEntityViewStateMap;
  visibleSubmeshSnapshot: VisibleSubmeshSnapshot | null;
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;

  /* Air mesh visibility */
  airMeshVisible: boolean;
  airMeshOpacity: number;

  /* Mesh selection */
  meshSelection: MeshSelectionSnapshot;
}

export interface ViewportCoreActions {
  /* Interaction */
  setInteractionMode: (mode: InteractionMode) => void;
  setHoverTarget: (target: ViewportHoverTarget | null) => void;
  setDragging: (v: boolean) => void;
  setGizmoActiveAxis: (axis: "x" | "y" | "z" | null) => void;

  /* Camera */
  setCameraPreset: (preset: CameraProfile["preset"]) => void;
  setCameraProfile: (partial: Partial<CameraProfile>) => void;

  /* View modes */
  setViewMode: (mode: SetStateAction<ViewportMode>) => void;
  setComponent: (c: SetStateAction<VectorComponent>) => void;
  setPlane: (p: SetStateAction<SlicePlane>) => void;
  setSliceIndex: (i: SetStateAction<number>) => void;
  setSelectedQuantity: (v: SetStateAction<string>) => void;

  /* Chrome */
  setConsoleCollapsed: (v: SetStateAction<boolean>) => void;
  setSidebarCollapsed: (v: SetStateAction<boolean>) => void;

  /* FEM render */
  setMeshRenderMode: (v: RenderMode) => void;
  setMeshOpacity: (v: number) => void;
  setMeshClipEnabled: (v: boolean) => void;
  setMeshClipAxis: (v: ClipAxis) => void;
  setMeshClipPos: (v: number) => void;
  setMeshShowArrows: (v: boolean) => void;
  setFemArrowColorMode: (v: FemArrowColorMode) => void;
  setFemArrowMonoColor: (v: string) => void;
  setFemArrowAlpha: (v: number) => void;
  setFemArrowLengthScale: (v: number) => void;
  setFemArrowThickness: (v: number) => void;
  setFemVectorDomainFilter: (v: FemVectorDomainFilter) => void;
  setFemFerromagnetVisibilityMode: (v: FemFerromagnetVisibilityMode) => void;
  setFemColorField: (v: FemColorField) => void;
  setFemMagnetization3DActive: (v: boolean) => void;
  setFemDockTab: (v: SetStateAction<FemDockTab>) => void;

  /* Scope / selection */
  setCameraFitRequestSeed: (v: SetStateAction<number>) => void;
  setViewportScope: (v: ViewportScope) => void;
  setObjectViewMode: (v: SetStateAction<ObjectViewMode>) => void;
  setActiveTransformScope: (v: SetStateAction<"object" | "texture" | null>) => void;
  setMeshEntityViewState: (v: SetStateAction<MeshEntityViewStateMap>) => void;
  setVisibleSubmeshSnapshot: (v: SetStateAction<VisibleSubmeshSnapshot | null>) => void;
  setSelectedSidebarNodeId: (v: string | null) => void;
  setSelectedObjectId: (v: string | null) => void;
  setSelectedEntityId: (v: string | null) => void;
  setFocusedEntityId: (v: string | null) => void;

  /* Air mesh */
  setAirMeshVisible: (v: boolean) => void;
  setAirMeshOpacity: (v: number) => void;

  /* Mesh selection */
  setMeshSelection: (v: MeshSelectionSnapshot) => void;

  /* Bulk reset (session change) */
  resetViewport: () => void;
}

type ViewportStore = ViewportCoreState & ViewportCoreActions;

const INITIAL_STATE: ViewportCoreState = {
  interactionMode: "camera-navigate",
  hoverTarget: null,
  isDragging: false,
  gizmoActiveAxis: null,
  camera: DEFAULT_CAMERA,
  viewMode: "3D",
  component: "magnitude",
  plane: "xy",
  sliceIndex: 0,
  selectedQuantity: "m",
  consoleCollapsed: false,
  sidebarCollapsed: false,
  meshRenderMode: "surface",
  meshOpacity: 85,
  meshClipEnabled: false,
  meshClipAxis: "x",
  meshClipPos: 50,
  meshShowArrows: false,
  femArrowColorMode: "orientation",
  femArrowMonoColor: "#ffffff",
  femArrowAlpha: 1,
  femArrowLengthScale: 1,
  femArrowThickness: 1,
  femVectorDomainFilter: "auto",
  femFerromagnetVisibilityMode: "hide",
  femColorField: "orientation",
  femMagnetization3DActive: false,
  femDockTab: "mesh",
  cameraFitRequestSeed: 0,
  viewportScope: "universe",
  objectViewMode: "context",
  activeTransformScope: null,
  meshEntityViewState: {},
  visibleSubmeshSnapshot: null,
  selectedSidebarNodeId: null,
  selectedObjectId: null,
  selectedEntityId: null,
  focusedEntityId: null,
  airMeshVisible: !AIRBOX_DISABLED_BY_DEFAULT,
  airMeshOpacity: 20,
  meshSelection: { selectedFaceIndices: [], primaryFaceIndex: null },
};

function resolveSetStateAction<T>(value: SetStateAction<T>, previous: T): T {
  return typeof value === "function"
    ? (value as (prev: T) => T)(previous)
    : value;
}

export const useViewportStore = create<ViewportStore>()((set) => ({
  ...INITIAL_STATE,

  /* Interaction */
  setInteractionMode: (mode) => set({ interactionMode: mode }),
  setHoverTarget: (target) => set({ hoverTarget: target }),
  setDragging: (v) => set({ isDragging: v }),
  setGizmoActiveAxis: (axis) => set({ gizmoActiveAxis: axis }),

  /* Camera */
  setCameraPreset: (preset) =>
    set((s) => ({ camera: { ...s.camera, preset } })),
  setCameraProfile: (partial) =>
    set((s) => ({ camera: { ...s.camera, ...partial } })),

  /* View modes */
  setViewMode: (mode) =>
    set((s) => ({ viewMode: resolveSetStateAction(mode, s.viewMode) })),
  setComponent: (c) =>
    set((s) => ({ component: resolveSetStateAction(c, s.component) })),
  setPlane: (p) =>
    set((s) => ({ plane: resolveSetStateAction(p, s.plane) })),
  setSliceIndex: (i) =>
    set((s) => ({ sliceIndex: resolveSetStateAction(i, s.sliceIndex) })),
  setSelectedQuantity: (v) =>
    set((s) => ({ selectedQuantity: resolveSetStateAction(v, s.selectedQuantity) })),

  /* Chrome */
  setConsoleCollapsed: (v) =>
    set((s) => ({ consoleCollapsed: resolveSetStateAction(v, s.consoleCollapsed) })),
  setSidebarCollapsed: (v) =>
    set((s) => ({ sidebarCollapsed: resolveSetStateAction(v, s.sidebarCollapsed) })),

  /* FEM render */
  setMeshRenderMode: (v) => set({ meshRenderMode: v }),
  setMeshOpacity: (v) => set({ meshOpacity: v }),
  setMeshClipEnabled: (v) => set({ meshClipEnabled: v }),
  setMeshClipAxis: (v) => set({ meshClipAxis: v }),
  setMeshClipPos: (v) => set({ meshClipPos: v }),
  setMeshShowArrows: (v) => set({ meshShowArrows: v }),
  setFemArrowColorMode: (v) => set({ femArrowColorMode: v }),
  setFemArrowMonoColor: (v) => set({ femArrowMonoColor: v }),
  setFemArrowAlpha: (v) => set({ femArrowAlpha: v }),
  setFemArrowLengthScale: (v) => set({ femArrowLengthScale: v }),
  setFemArrowThickness: (v) => set({ femArrowThickness: v }),
  setFemVectorDomainFilter: (v) => set({ femVectorDomainFilter: v }),
  setFemFerromagnetVisibilityMode: (v) => set({ femFerromagnetVisibilityMode: v }),
  setFemColorField: (v) => set({ femColorField: v }),
  setFemMagnetization3DActive: (v) => set({ femMagnetization3DActive: v }),
  setFemDockTab: (v) =>
    set((s) => ({ femDockTab: resolveSetStateAction(v, s.femDockTab) })),

  /* Scope / selection */
  setCameraFitRequestSeed: (v) =>
    set((s) => ({
      cameraFitRequestSeed: resolveSetStateAction(v, s.cameraFitRequestSeed),
    })),
  setViewportScope: (v) => set({ viewportScope: v }),
  setObjectViewMode: (v) =>
    set((s) => ({ objectViewMode: resolveSetStateAction(v, s.objectViewMode) })),
  setActiveTransformScope: (v) =>
    set((s) => ({
      activeTransformScope: resolveSetStateAction(v, s.activeTransformScope),
    })),
  setMeshEntityViewState: (v) =>
    set((s) => ({
      meshEntityViewState: resolveSetStateAction(v, s.meshEntityViewState),
    })),
  setVisibleSubmeshSnapshot: (v) =>
    set((s) => ({
      visibleSubmeshSnapshot: resolveSetStateAction(v, s.visibleSubmeshSnapshot),
    })),
  setSelectedSidebarNodeId: (v) => set({ selectedSidebarNodeId: v }),
  setSelectedObjectId: (v) => set({ selectedObjectId: v }),
  setSelectedEntityId: (v) => set({ selectedEntityId: v }),
  setFocusedEntityId: (v) => set({ focusedEntityId: v }),

  /* Air mesh */
  setAirMeshVisible: (v) => set({ airMeshVisible: v }),
  setAirMeshOpacity: (v) => set({ airMeshOpacity: v }),

  /* Mesh selection */
  setMeshSelection: (v) => set({ meshSelection: v }),

  /* Bulk reset */
  resetViewport: () => set(INITIAL_STATE),
}));

/* ── Narrow selectors ── */
export const selectInteraction = (s: ViewportStore) => ({
  interactionMode: s.interactionMode,
  hoverTarget: s.hoverTarget,
  isDragging: s.isDragging,
  gizmoActiveAxis: s.gizmoActiveAxis,
});
export const selectCamera = (s: ViewportStore) => s.camera;
export const selectViewMode = (s: ViewportStore) => s.viewMode;
export const selectFemRenderSettings = (s: ViewportStore) => ({
  meshRenderMode: s.meshRenderMode,
  meshOpacity: s.meshOpacity,
  meshClipEnabled: s.meshClipEnabled,
  meshClipAxis: s.meshClipAxis,
  meshClipPos: s.meshClipPos,
  meshShowArrows: s.meshShowArrows,
  femArrowColorMode: s.femArrowColorMode,
  femArrowMonoColor: s.femArrowMonoColor,
  femArrowAlpha: s.femArrowAlpha,
  femArrowLengthScale: s.femArrowLengthScale,
  femArrowThickness: s.femArrowThickness,
  femVectorDomainFilter: s.femVectorDomainFilter,
  femFerromagnetVisibilityMode: s.femFerromagnetVisibilityMode,
  femColorField: s.femColorField,
  femMagnetization3DActive: s.femMagnetization3DActive,
});
export const selectViewportScope = (s: ViewportStore) => ({
  viewportScope: s.viewportScope,
  objectViewMode: s.objectViewMode,
  cameraFitRequestSeed: s.cameraFitRequestSeed,
  selectedObjectId: s.selectedObjectId,
  selectedEntityId: s.selectedEntityId,
  focusedEntityId: s.focusedEntityId,
  meshEntityViewState: s.meshEntityViewState,
  visibleSubmeshSnapshot: s.visibleSubmeshSnapshot,
});
