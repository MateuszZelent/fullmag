import type { ModuleManifest } from "@/kernel/types";

export const crossSectionImageManifest: ModuleManifest = {
  id: "cross-section-image",
  title: "Cross-Section",
  version: "0.1.0",
  slots: ["viewport-main"],
  component: () => import("./CrossSectionImageModule"),
  contributes: {
    commands: [
      {
        id: "cross-section-image.open",
        title: "Open Cross-Section Image",
        group: "cross-section-image",
        category: "Viewport",
        scope: "viewport",
        isActive: (context) =>
          context.layout?.get().activeViewportMainModuleId ===
          "cross-section-image",
        run: (context) => {
          context.layout?.setActiveViewportMainModule("cross-section-image");
          context.layout?.setFocusedSlot("viewport-main");
          return { status: "completed" };
        },
      },
    ],
  },
};
