import type { ModuleManifest } from "@/kernel/types";

import { explorerManifest } from "./explorer/manifest";
import { inspectorManifest } from "./inspector/manifest";
import { overlayManifest } from "./overlay/manifest";
import { ribbonManifest } from "./ribbon/manifest";
import { statusBarManifest } from "./status-bar/manifest";

export const ALL_MODULES: ModuleManifest[] = [
  ribbonManifest,
  explorerManifest,
  inspectorManifest,
  overlayManifest,
  statusBarManifest,
];
