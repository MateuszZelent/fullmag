import type { ModuleManifest } from "@/kernel/types";
import {
  type BrowserFullmagConfig,
  viewport3DEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";

import { analysisPlotsManifest } from "./analysis-plots/manifest";
import { appMenuManifest } from "./app-menu/manifest";
import { explorerManifest } from "./explorer/manifest";
import { fieldMapManifest } from "./field-map/manifest";
import { footerManifest } from "./footer/manifest";
import { inspectorManifest } from "./inspector/manifest";
import { overlayManifest } from "./overlay/manifest";
import { ribbonManifest } from "./ribbon/manifest";
import { statusBarManifest } from "./status-bar/manifest";
import { viewport3dManifest } from "./viewport-3d/manifest";

const REGISTERED_MODULES: ModuleManifest[] = [
  appMenuManifest,
  ribbonManifest,
  explorerManifest,
  viewport3dManifest,
  fieldMapManifest,
  analysisPlotsManifest,
  inspectorManifest,
  footerManifest,
  overlayManifest,
  statusBarManifest,
];

export function resolveControlRoomModules(
  config: BrowserFullmagConfig | undefined = undefined,
): ModuleManifest[] {
  if (viewport3DEnabledFromBrowserConfig(config)) {
    return REGISTERED_MODULES;
  }

  return REGISTERED_MODULES.filter((module) => module.id !== "viewport-3d");
}

export const ALL_MODULES: ModuleManifest[] = REGISTERED_MODULES;
