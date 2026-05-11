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
    ],
  },
  emits: ["workspace:selection-changed"],
  listens: ["resource:invalidated", "workspace:selection-changed"],
};
