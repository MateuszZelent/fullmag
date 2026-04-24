"use client";

import type { SceneDocument } from "@/lib/session/types";

import type { WorkspaceMode } from "./context-hooks";
import type { ViewportMode } from "./shared";

export interface CameraFirstViewportArgs {
  workspaceMode: WorkspaceMode;
  activeCoreTab: string | null;
  effectiveViewMode: ViewportMode;
}

export function isGeometryAuthoringWorkspace(
  workspaceMode: WorkspaceMode,
  activeCoreTab: string | null,
): boolean {
  return workspaceMode === "build" && activeCoreTab === "Geometry";
}

export function shouldForceCameraFirstViewport({
  workspaceMode,
  activeCoreTab,
  effectiveViewMode,
}: CameraFirstViewportArgs): boolean {
  return (
    effectiveViewMode === "3D" &&
    !isGeometryAuthoringWorkspace(workspaceMode, activeCoreTab)
  );
}

export function resetSceneEditorToCameraFirst(
  scene: SceneDocument | null,
): SceneDocument | null {
  if (!scene) {
    return scene;
  }
  if (
    scene.editor.active_transform_scope === null &&
    scene.editor.gizmo_mode === null
  ) {
    return scene;
  }
  return {
    ...scene,
    editor: {
      ...scene.editor,
      active_transform_scope: null,
      gizmo_mode: null,
    },
  };
}
