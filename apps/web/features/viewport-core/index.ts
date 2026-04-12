export { useViewportStore, selectInteraction, selectCamera, selectViewMode, selectFemRenderSettings, selectViewportScope } from "./state/useViewportStore";
export type { ViewportCoreState, ViewportCoreActions, CameraProfile } from "./state/useViewportStore";
export type { InteractionMode, InteractionState, ViewportHoverTarget } from "./interaction/interactionMode.types";
export { routeInput } from "./interaction/inputRouter";
export type { InputEvent, InputRouterResult } from "./interaction/inputRouter";

// View registry (Layer 8)
export { VIEW_REGISTRY, resolveActiveView, findViewById } from "./registry/viewRegistry";
export type { ViewKind, ViewRegistryEntry, WorkspaceViewContext } from "./registry/viewRegistry";

// Viewport router (Layer 8)
export { ViewportRouter, useResolvedView } from "./routing/ViewportRouter";
export type { ViewportRouterProps } from "./routing/ViewportRouter";

// Bridge types (Layer 8)
export type {
  ViewportSelectionBridgeState,
  ViewportSelectionBridgeActions,
  ViewportOverlayDescriptor,
  ViewportOverlayBridgeState,
  ViewportDiagnosticFlags,
  ViewHostProps,
} from "./routing/viewportBridgeTypes";
