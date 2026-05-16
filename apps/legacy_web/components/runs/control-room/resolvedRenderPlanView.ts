import {
  defaultMeshEntityViewState,
  type FemMeshPart,
  type MeshEntityViewState,
  type MeshEntityViewStateMap,
} from "@/lib/session/types";
import type { ViewportMeshRenderMode } from "@/components/shell/ribbon/command-registry";

import {
  airboxDisplayStateFromRenderMode,
  type AirboxDisplayState,
} from "./airboxDisplay";
import { bestPresetFromPasses, legacyRenderModeFromPasses } from "./meshDisplayState";
import type { ResolvedRenderPlan } from "./visualizationStateSync";

interface ResolveAirboxDisplayStateFromRenderPlanArgs {
  plan: ResolvedRenderPlan | null | undefined;
  representativePart: FemMeshPart | null | undefined;
  meshEntityViewState: MeshEntityViewStateMap;
}

export function resolveAirboxDisplayStateFromRenderPlan({
  plan,
  representativePart,
  meshEntityViewState,
}: ResolveAirboxDisplayStateFromRenderPlanArgs): AirboxDisplayState {
  const current = representativePart
    ? meshEntityViewState[representativePart.id]
    : undefined;
  const partDefaults = representativePart
    ? defaultMeshEntityViewState(representativePart)
    : undefined;
  const fallbackMode: ViewportMeshRenderMode =
    current?.renderMode ?? partDefaults?.renderMode ?? "wireframe";
  const modeDefaults = airboxDisplayStateFromRenderMode(fallbackMode);
  const airbox = plan?.layers.airbox;

  const surface =
    airbox?.surface ?? current?.renderPasses?.surface ?? modeDefaults.surface;
  const wireframe =
    airbox?.wireframe ?? current?.renderPasses?.wireframe ?? modeDefaults.wireframe;
  const points =
    airbox?.points ?? current?.renderPasses?.points ?? modeDefaults.points;
  const geometryVisible =
    airbox
      ? airbox.visible && (surface || wireframe || points)
      : current?.geometryVisible ?? modeDefaults.geometryVisible;

  const renderMode = geometryVisible
    ? bestPresetFromPasses({
        surface,
        surfaceEdges: wireframe,
        volumeEdges: false,
        points,
      })
    : modeDefaults.renderMode;

  return {
    geometryVisible,
    surface,
    wireframe,
    points,
    vectorsVisible: airbox?.vectors ?? false,
    renderMode,
    wireframeScope:
      current?.wireframeScope ??
      partDefaults?.wireframeScope ??
      modeDefaults.wireframeScope,
    pointsScope:
      current?.pointsScope ?? partDefaults?.pointsScope ?? modeDefaults.pointsScope,
    vectorsScope:
      current?.vectorsScope ?? partDefaults?.vectorsScope ?? modeDefaults.vectorsScope,
  };
}

export function resolveEffectiveFemMeshEntityViewStateFromRenderPlan({
  plan,
  meshParts,
  meshEntityViewState,
  fallbackMeshRenderMode,
  fallbackMeshOpacity,
  fallbackSelectedQuantity,
}: {
  plan: ResolvedRenderPlan | null | undefined;
  meshParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  fallbackMeshRenderMode: MeshEntityViewState["renderMode"];
  fallbackMeshOpacity: number;
  fallbackSelectedQuantity: string;
}): MeshEntityViewStateMap {
  if (!plan || meshParts.length === 0) {
    return meshEntityViewState;
  }

  const next: MeshEntityViewStateMap = { ...meshEntityViewState };
  const globalPasses = {
    surface: plan.layers.passes.surface,
    surfaceEdges: plan.layers.passes.wireframe,
    volumeEdges: plan.layers.passes.volumeMesh,
    points: plan.layers.passes.points,
  };
  const airboxPasses = {
    surface: plan.layers.airbox.surface,
    surfaceEdges: plan.layers.airbox.wireframe,
    volumeEdges: false,
    points: plan.layers.airbox.points,
  };
  const globalRenderMode = legacyRenderModeFromPasses(globalPasses);
  const airboxRenderMode = legacyRenderModeFromPasses(airboxPasses);
  const globalGeometryVisible =
    globalPasses.surface ||
    globalPasses.surfaceEdges ||
    globalPasses.volumeEdges ||
    globalPasses.points;
  const airboxGeometryVisible =
    plan.layers.airbox.visible &&
    (airboxPasses.surface || airboxPasses.surfaceEdges || airboxPasses.points);

  for (const part of meshParts) {
    const current = next[part.id] ?? defaultMeshEntityViewState(part);
    const airboxScoped = part.role === "air" || part.role === "outer_boundary";
    const hasExplicitState = Object.prototype.hasOwnProperty.call(next, part.id);
    const baseRenderMode = hasExplicitState
      ? current.renderMode
      : fallbackMeshRenderMode;
    const renderMode = airboxScoped
      ? airboxRenderMode
      : hasExplicitState
        ? baseRenderMode
        : globalRenderMode;
    const renderPasses = airboxScoped
      ? {
          surface: airboxPasses.surface,
          wireframe: airboxPasses.surfaceEdges,
          volumeMesh: airboxPasses.volumeEdges,
          points: airboxPasses.points,
        }
      : hasExplicitState
        ? current.renderPasses
        : {
            surface: globalPasses.surface,
            wireframe: globalPasses.surfaceEdges,
            volumeMesh: globalPasses.volumeEdges,
            points: globalPasses.points,
          };

    next[part.id] = {
      ...current,
      renderMode,
      renderPasses,
      geometryVisible: airboxScoped
        ? airboxGeometryVisible
        : hasExplicitState
          ? current.geometryVisible
          : globalGeometryVisible,
      opacity: airboxScoped
        ? plan.layers.airbox.opacityPercent
        : hasExplicitState
          ? current.opacity
          : plan.layers.meshOpacityPercent ?? fallbackMeshOpacity,
      colorField:
        part.role === "magnetic_object"
          ? plan.layers.femLayers.showQuantity
            ? current.colorField
            : plan.layers.femLayers.showMagneticTexture
              ? fallbackSelectedQuantity === "m"
                ? "orientation"
                : "none"
              : "none"
          : "none",
    };
  }

  return next;
}
