import type { ModuleManifest } from "@/kernel/types";

import { appMenuManifest } from "./app-menu/manifest";
import { explorerManifest } from "./explorer/manifest";
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
  inspectorManifest,
  overlayManifest,
  statusBarManifest,
];
