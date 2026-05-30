import type { ModuleManifest } from "@/kernel/types";

import { analysisPlotsManifest } from "./analysis-plots/manifest";
import { appMenuManifest } from "./app-menu/manifest";
import { crossSectionImageManifest } from "./cross-section-image/manifest";
import { explorerManifest } from "./explorer/manifest";
import { footerManifest } from "./footer/manifest";
import { inspectorManifest } from "./inspector/manifest";
import { overlayManifest } from "./overlay/manifest";
import { ribbonManifest } from "./ribbon/manifest";
import { statusBarManifest } from "./status-bar/manifest";
import { viewport3dManifest } from "./viewport-3d/manifest";

export const ALL_MODULES: ModuleManifest[] = [
  appMenuManifest,
  ribbonManifest,
  explorerManifest,
  viewport3dManifest,
  crossSectionImageManifest,
  analysisPlotsManifest,
  inspectorManifest,
  footerManifest,
  overlayManifest,
  statusBarManifest,
];
