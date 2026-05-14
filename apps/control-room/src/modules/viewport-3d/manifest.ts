import type { ModuleManifest } from "@/kernel/types";

import { viewport3dStore } from "./viewport3dStore";

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
        id: "view-projection",
        title: "Toggle projection",
        group: "viewport-3d",
        category: "Viewport",
        scope: "viewport",
        isActive: () =>
          viewport3dStore.getSnapshot().widgets.cameraProjection === "orthographic",
        run: () => {
          viewport3dStore.toggleCameraProjection();
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
    ],
  },
  emits: ["workspace:selection-changed"],
  listens: ["resource:invalidated", "workspace:selection-changed"],
};
