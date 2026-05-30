import type { ModuleManifest } from "@/kernel/types";

import { appMenuManifest } from "./app-menu/manifest";
import { explorerManifest } from "./explorer/manifest";
import { footerManifest } from "./footer/manifest";
import { inspectorManifest } from "./inspector/manifest";
import { overlayManifest } from "./overlay/manifest";
import { ribbonManifest } from "./ribbon/manifest";
import { statusBarManifest } from "./status-bar/manifest";
import { viewport2dManifest } from "./viewport-2d/manifest";
import { viewport3dManifest } from "./viewport-3d/manifest";

export const ALL_MODULES: ModuleManifest[] = [
  appMenuManifest,
  ribbonManifest,
  explorerManifest,
  viewport3dManifest,
  viewport2dManifest,
  inspectorManifest,
  footerManifest,
  overlayManifest,
  statusBarManifest,
];
