import type { ModuleManifest } from "@/kernel/types";

import { ribbonManifest } from "./ribbon/manifest";
import { statusBarManifest } from "./status-bar/manifest";

export const ALL_MODULES: ModuleManifest[] = [ribbonManifest, statusBarManifest];
