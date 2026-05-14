import type { ModuleManifest } from "@/kernel/types";

export const footerManifest: ModuleManifest = {
  id: "transport-footer",
  title: "Transport Footer",
  version: "0.1.0",
  slots: ["panel-bottom"],
  component: () => import("./FooterModule"),
};
