import { Activity, BarChart3, Box, Database, ListChecks, type LucideIcon } from "lucide-react";

import type { ExplorerTabId } from "./explorerTypes";

/** Explorer resource families; the tab bar and the left side rail share this list. */
export const EXPLORER_TABS: ReadonlyArray<{ id: ExplorerTabId; label: string; icon: LucideIcon }> = [
  { id: "model", label: "Model", icon: Box },
  { id: "resources", label: "Resources", icon: Database },
  { id: "results", label: "Results", icon: BarChart3 },
  { id: "jobs", label: "Jobs", icon: ListChecks },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];
