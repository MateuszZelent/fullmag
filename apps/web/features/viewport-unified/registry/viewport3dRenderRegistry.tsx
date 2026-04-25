import type { ReactNode } from "react";

export type Viewport3DRenderRoute =
  | "geometry-authoring"
  | "fem-mesh"
  | "fem-3d"
  | "fdm-3d";
export type ViewportInternalToolbarMode = "visible" | "hidden";

export interface Viewport3DRenderRouteInput {
  showGeometryAuthoringViewport: boolean;
  isFemMeshMode: boolean;
  isFem3DMode: boolean;
}

export interface Viewport3DRouteRenderers {
  renderGeometryAuthoring: () => ReactNode;
  renderFemMesh: () => ReactNode;
  renderFem3D: () => ReactNode;
  renderFdm: () => ReactNode;
}

export interface ViewportInternalToolbarModeInput {
  unifiedToolbarEnabled: boolean;
  femDiagnosticToolbarEnabled: boolean;
}

export interface ViewportInternalToolbarModes {
  femToolbarMode: ViewportInternalToolbarMode;
  vectorToolbarMode: ViewportInternalToolbarMode;
}

export function resolveViewport3DRenderRoute({
  showGeometryAuthoringViewport,
  isFemMeshMode,
  isFem3DMode,
}: Viewport3DRenderRouteInput): Viewport3DRenderRoute {
  if (showGeometryAuthoringViewport) {
    return "geometry-authoring";
  }
  if (isFemMeshMode) {
    return "fem-mesh";
  }
  if (isFem3DMode) {
    return "fem-3d";
  }
  return "fdm-3d";
}

export function renderViewport3DRoute(
  route: Viewport3DRenderRoute,
  renderers: Viewport3DRouteRenderers,
): ReactNode {
  switch (route) {
    case "geometry-authoring":
      return renderers.renderGeometryAuthoring();
    case "fem-mesh":
      return renderers.renderFemMesh();
    case "fem-3d":
      return renderers.renderFem3D();
    case "fdm-3d":
      return renderers.renderFdm();
  }
}

export function resolveViewportInternalToolbarModes({
  unifiedToolbarEnabled,
  femDiagnosticToolbarEnabled,
}: ViewportInternalToolbarModeInput): ViewportInternalToolbarModes {
  if (unifiedToolbarEnabled) {
    return {
      femToolbarMode: "hidden",
      vectorToolbarMode: "hidden",
    };
  }
  return {
    femToolbarMode: femDiagnosticToolbarEnabled ? "visible" : "hidden",
    vectorToolbarMode: "visible",
  };
}

export interface UnifiedViewport3DRendererProps
  extends Viewport3DRenderRouteInput,
    Viewport3DRouteRenderers {}

export function UnifiedViewport3DRenderer(props: UnifiedViewport3DRendererProps) {
  const route = resolveViewport3DRenderRoute(props);
  return <>{renderViewport3DRoute(route, props)}</>;
}
