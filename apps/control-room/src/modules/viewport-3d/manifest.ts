import type { ModuleManifest } from "@/kernel/types";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import { viewport3dStore } from "./viewport3dStore";
import type { Viewport3DVisualProfileId } from "./viewport3dVisualProfile";

const VISUAL_PROFILE_COMMANDS: Array<{
  id: string;
  profileId: Viewport3DVisualProfileId;
  title: string;
}> = [
  {
    id: "viewport-3d.profile-interactive-lite",
    profileId: "interactive-lite",
    title: "Use Interactive Lite 3D Profile",
  },
  {
    id: "viewport-3d.profile-interactive",
    profileId: "interactive",
    title: "Use Interactive 3D Profile",
  },
  {
    id: "viewport-3d.profile-balanced",
    profileId: "balanced",
    title: "Use Balanced 3D Profile",
  },
  {
    id: "viewport-3d.profile-figure",
    profileId: "figure",
    title: "Use Figure 3D Profile",
  },
  {
    id: "viewport-3d.profile-capture",
    profileId: "capture",
    title: "Use Capture 3D Profile",
  },
];

export const viewport3dManifest: ModuleManifest = {
  id: "viewport-3d",
  title: "3D Viewport",
  version: "0.1.0",
  slots: ["viewport-main"],
  component: () => import("./Viewport3DModule"),
  contributes: {
    commands: [
      {
        id: "viewport-3d.fit",
        title: "Fit 3D View",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: () => {
          viewport3dStore.requestFit();
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.reset-camera",
        title: "Reset 3D Camera",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: () => {
          viewport3dStore.resetCamera();
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.capture-frame",
        title: "Capture 3D Frame",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: () => {
          viewport3dStore.requestCapture();
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.toggle-viewcube",
        title: "Toggle ViewCube",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () => viewport3dStore.getSnapshot().widgets.viewCubeVisible,
        run: () => {
          viewport3dStore.toggleViewCube();
          return { status: "completed" };
        },
      },
      {
        id: "workspace.visualization-settings",
        title: "Visualization Settings",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        run: () => {
          viewport3dStore.setSettingsDialogOpen(true);
          return { status: "completed" };
        },
      },
      {
        id: "view-projection",
        title: "Toggle projection",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: (context) => {
          const state = visualizationStateFromContext(context);
          return state
            ? state.camera.projection === "orthographic"
            : viewport3dStore.getSnapshot().widgets.cameraProjection ===
                "orthographic";
        },
        run: async (context) => {
          const current =
            visualizationStateFromContext(context) ??
            (context.api ? await context.api.visualization.state() : null);
          const currentProjection =
            current?.camera?.projection ??
            viewport3dStore.getSnapshot().widgets.cameraProjection;
          const nextProjection =
            currentProjection === "orthographic" ? "perspective" : "orthographic";
          if (context.visualizationSync) {
            context.visualizationSync.queuePatch({
              camera: { projection: nextProjection },
            });
          } else if (context.api) {
            const state = await context.api.visualization.patch({
              camera: { projection: nextProjection },
            });
            context.resources?.invalidate(VISUALIZATION_STATE_PATH, state.revision);
          } else {
            viewport3dStore.toggleCameraProjection();
          }
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.hsl-reference-auto",
        title: "HSL Reference Auto",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.hslReferenceMode === "auto",
        run: () => {
          viewport3dStore.setHslReferenceMode("auto");
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.hsl-reference-on",
        title: "Show HSL Reference",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.hslReferenceMode === "on",
        run: () => {
          viewport3dStore.setHslReferenceMode("on");
          return { status: "completed" };
        },
      },
      {
        id: "viewport-3d.hsl-reference-off",
        title: "Hide HSL Reference",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.hslReferenceMode === "off",
        run: () => {
          viewport3dStore.setHslReferenceMode("off");
          return { status: "completed" };
        },
      },
      ...VISUAL_PROFILE_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport" as const,
        isActive: () =>
          viewport3dStore.getSnapshot().visualProfileId === command.profileId,
        run: () => {
          viewport3dStore.setVisualProfile(command.profileId);
          return { status: "completed" as const };
        },
      })),
    ],
  },
  emits: ["workspace:selection-changed"],
  listens: ["resource:invalidated", "workspace:selection-changed"],
};

function visualizationStateFromContext(context: {
  resourceData?: Readonly<Record<string, unknown>>;
}): VisualizationStateResource | null {
  const value = context.resourceData?.[VISUALIZATION_STATE_PATH];
  return value && typeof value === "object"
    ? (value as VisualizationStateResource)
    : null;
}
