import type { AirboxDisplayPatch } from "@/components/shell/ribbon/command-registry";
import type { FemMeshPart, MeshEntityViewStateMap } from "@/lib/session/types";
import { defaultMeshEntityViewState } from "@/lib/session/types";
import type { VisualizationStatePatch } from "@/src/api/types";
import {
  airboxDisplayStateFromRenderMode,
  resolveAirboxDisplayState,
} from "./airboxDisplay";

type FemVectorDomainFilter = "auto" | "magnetic_only" | "full_domain" | "airbox_only";
type FemFerromagnetVisibilityMode = "hide" | "ghost";

export interface AirboxVectorRestoreState {
  active: boolean;
  vectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
}

export interface AirboxDisplayTransaction {
  displayPatch: VisualizationStatePatch | null;
  meshEntityViewState: MeshEntityViewStateMap;
  meshEntityViewStateChanged: boolean;
  vectorRestoreState: AirboxVectorRestoreState | null;
}

export function reduceAirboxDisplayTransaction(args: {
  patch: AirboxDisplayPatch;
  airboxParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  vectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  vectorRestoreState: AirboxVectorRestoreState | null;
}): AirboxDisplayTransaction {
  const {
    patch,
    airboxParts,
    meshEntityViewState,
    vectorDomainFilter,
    ferromagnetVisibilityMode,
  } = args;
  let displayPatch: VisualizationStatePatch | null = null;
  let vectorRestoreState = args.vectorRestoreState;

  if (typeof patch.vectors === "boolean") {
    if (patch.vectors) {
      vectorRestoreState = vectorRestoreState?.active
        ? vectorRestoreState
        : {
            active: true,
            vectorDomainFilter,
            ferromagnetVisibilityMode,
          };
      displayPatch = mergeVisualizationPatch(displayPatch, {
        layers: {
          airbox: {
            visible: true,
            vectors: {
              visible: true,
              domain: "airbox_only",
            },
          },
          vectors: {
            visible: true,
            domain: "airbox_only",
          },
        },
        vector_style: {
          ferromagnet_visibility:
            ferromagnetVisibilityMode === "hide" ? "ghost" : ferromagnetVisibilityMode,
        },
      });
    } else if (vectorRestoreState?.active) {
      const saved = vectorRestoreState;
      displayPatch = mergeVisualizationPatch(displayPatch, {
        layers: {
          airbox: {
            vectors: {
              visible: false,
              domain: "airbox_only",
            },
          },
          vectors: {
            visible: false,
            domain: saved.vectorDomainFilter,
          },
        },
        vector_style: {
          ferromagnet_visibility: saved.ferromagnetVisibilityMode,
        },
      });
      vectorRestoreState = null;
    } else {
      displayPatch = mergeVisualizationPatch(displayPatch, {
        layers: {
          airbox: {
            vectors: {
              visible: false,
              domain: "airbox_only",
            },
          },
          vectors: {
            visible: false,
            domain: "auto",
          },
        },
      });
    }
  }

  if (typeof patch.opacity === "number") {
    const opacityUnit = Math.max(0, Math.min(100, patch.opacity)) / 100;
    displayPatch = mergeVisualizationPatch(displayPatch, {
      layers: {
        airbox: {
          opacity: opacityUnit,
          surface: { opacity: opacityUnit },
        },
      },
    });
  }

  if (typeof patch.visible === "boolean") {
    displayPatch = mergeVisualizationPatch(displayPatch, {
      layers: {
        airbox: {
          visible: patch.visible,
        },
      },
    });
  }

  const meshResult = reduceAirboxMeshEntityViewState({
    patch,
    airboxParts,
    meshEntityViewState,
  });

  if (meshResult.airboxDisplayPatch) {
    displayPatch = mergeVisualizationPatch(displayPatch, meshResult.airboxDisplayPatch);
  }

  return {
    displayPatch,
    meshEntityViewState: meshResult.meshEntityViewState,
    meshEntityViewStateChanged: meshResult.changed,
    vectorRestoreState,
  };
}

function reduceAirboxMeshEntityViewState(args: {
  patch: AirboxDisplayPatch;
  airboxParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
}): {
  meshEntityViewState: MeshEntityViewStateMap;
  changed: boolean;
  airboxDisplayPatch: VisualizationStatePatch | null;
} {
  const { patch, airboxParts, meshEntityViewState } = args;
  const updatesRender =
    typeof patch.visible === "boolean" ||
    typeof patch.geometry === "boolean" ||
    typeof patch.opacity === "number" ||
    typeof patch.shaded === "boolean" ||
    typeof patch.wireframe === "boolean" ||
    typeof patch.points === "boolean" ||
    typeof patch.wireframeScope === "string" ||
    typeof patch.pointsScope === "string" ||
    typeof patch.vectorsScope === "string" ||
    typeof patch.renderMode === "string";

  if (!updatesRender || airboxParts.length === 0) {
    return {
      meshEntityViewState,
      changed: false,
      airboxDisplayPatch: null,
    };
  }

  const representativePart =
    airboxParts.find((part) => part.role === "air") ?? airboxParts[0];
  const representativeCurrent =
    meshEntityViewState[representativePart.id] ??
    defaultMeshEntityViewState(representativePart);
  const representativeModeDefaults = airboxDisplayStateFromRenderMode(
    representativeCurrent.renderMode,
  );
  const sharedCurrentDisplay = {
    ...representativeModeDefaults,
    geometryVisible: representativeCurrent.geometryVisible ?? true,
    surface:
      representativeCurrent.renderPasses?.surface ??
      representativeModeDefaults.surface,
    wireframe:
      representativeCurrent.renderPasses?.wireframe ??
      representativeModeDefaults.wireframe,
    points:
      representativeCurrent.renderPasses?.points ??
      representativeModeDefaults.points,
    wireframeScope:
      representativeCurrent.wireframeScope ??
      representativeModeDefaults.wireframeScope,
    pointsScope:
      representativeCurrent.pointsScope ?? representativeModeDefaults.pointsScope,
    vectorsScope:
      representativeCurrent.vectorsScope ?? representativeModeDefaults.vectorsScope,
  };
  const resolvedDisplay = resolveAirboxDisplayState(sharedCurrentDisplay, patch);
  let changed = false;
  const next = { ...meshEntityViewState };

  for (const part of airboxParts) {
    const current = next[part.id] ?? defaultMeshEntityViewState(part);
    const nextVisible =
      typeof patch.visible === "boolean" ? patch.visible : current.visible;
    const nextOpacity =
      typeof patch.opacity === "number" ? patch.opacity : current.opacity;
    if (
      current.visible === nextVisible &&
      (current.geometryVisible ?? true) === resolvedDisplay.geometryVisible &&
      (current.renderPasses?.surface ?? airboxDisplayStateFromRenderMode(current.renderMode).surface) ===
        resolvedDisplay.surface &&
      (current.renderPasses?.wireframe ?? airboxDisplayStateFromRenderMode(current.renderMode).wireframe) ===
        resolvedDisplay.wireframe &&
      (current.renderPasses?.points ?? airboxDisplayStateFromRenderMode(current.renderMode).points) ===
        resolvedDisplay.points &&
      current.renderMode === resolvedDisplay.renderMode &&
      current.opacity === nextOpacity &&
      (current.wireframeScope ?? "surface") === resolvedDisplay.wireframeScope &&
      (current.pointsScope ?? "surface") === resolvedDisplay.pointsScope &&
      (current.vectorsScope ?? "surface") === resolvedDisplay.vectorsScope
    ) {
      if (!next[part.id]) {
        next[part.id] = current;
        changed = true;
      }
      continue;
    }
    next[part.id] = {
      ...current,
      visible: nextVisible,
      geometryVisible: resolvedDisplay.geometryVisible,
      renderPasses: {
        surface: resolvedDisplay.surface,
        wireframe: resolvedDisplay.wireframe,
        points: resolvedDisplay.points,
      },
      renderMode: resolvedDisplay.renderMode,
      wireframeScope: resolvedDisplay.wireframeScope,
      pointsScope: resolvedDisplay.pointsScope,
      vectorsScope: resolvedDisplay.vectorsScope,
      opacity: nextOpacity,
    };
    changed = true;
  }

  return {
    meshEntityViewState: changed ? next : meshEntityViewState,
    changed,
    airboxDisplayPatch: airboxPatchFromDisplayState(resolvedDisplay),
  };
}

function airboxPatchFromDisplayState(display: {
  geometryVisible: boolean;
  surface: boolean;
  wireframe: boolean;
  points: boolean;
}): VisualizationStatePatch {
  const surfaceVisible = display.geometryVisible && display.surface;
  const wireframeVisible = display.geometryVisible && display.wireframe;
  const pointsVisible = display.geometryVisible && display.points;
  return {
    layers: {
      airbox: {
        surface: { visible: surfaceVisible },
        wireframe: { visible: wireframeVisible },
        points: { visible: pointsVisible },
      },
    },
  };
}

function mergeVisualizationPatch(
  base: VisualizationStatePatch | null,
  patch: VisualizationStatePatch,
): VisualizationStatePatch {
  return {
    ...(base ?? {}),
    ...patch,
    layers:
      base?.layers || patch.layers
        ? {
            ...(base?.layers ?? {}),
            ...(patch.layers ?? {}),
            airbox:
              base?.layers?.airbox || patch.layers?.airbox
                ? {
                    ...(base?.layers?.airbox ?? {}),
                    ...(patch.layers?.airbox ?? {}),
                    surface:
                      base?.layers?.airbox?.surface || patch.layers?.airbox?.surface
                        ? {
                            ...(base?.layers?.airbox?.surface ?? {}),
                            ...(patch.layers?.airbox?.surface ?? {}),
                          }
                        : undefined,
                    wireframe:
                      base?.layers?.airbox?.wireframe || patch.layers?.airbox?.wireframe
                        ? {
                            ...(base?.layers?.airbox?.wireframe ?? {}),
                            ...(patch.layers?.airbox?.wireframe ?? {}),
                          }
                        : undefined,
                    points:
                      base?.layers?.airbox?.points || patch.layers?.airbox?.points
                        ? {
                            ...(base?.layers?.airbox?.points ?? {}),
                            ...(patch.layers?.airbox?.points ?? {}),
                          }
                        : undefined,
                    vectors:
                      base?.layers?.airbox?.vectors || patch.layers?.airbox?.vectors
                        ? {
                            ...(base?.layers?.airbox?.vectors ?? {}),
                            ...(patch.layers?.airbox?.vectors ?? {}),
                          }
                        : undefined,
                  }
                : undefined,
            vectors:
              base?.layers?.vectors || patch.layers?.vectors
                ? {
                    ...(base?.layers?.vectors ?? {}),
                    ...(patch.layers?.vectors ?? {}),
                  }
                : undefined,
          }
        : undefined,
    vector_style:
      base?.vector_style || patch.vector_style
        ? {
            ...(base?.vector_style ?? {}),
            ...(patch.vector_style ?? {}),
          }
        : undefined,
  };
}
