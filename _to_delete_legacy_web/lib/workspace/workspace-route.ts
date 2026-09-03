import type { Route } from "next";
import type { WorkspaceTab } from "./workspace-store";

export type WorkspaceRouteTabSlug = "3d" | "2d" | "analyze" | "charts";

const SLUG_TO_CORE_TAB_ID: Record<WorkspaceRouteTabSlug, string> = {
  "3d": "core:3d",
  "2d": "core:2d",
  analyze: "core:analyze",
  charts: "core:charts",
};

const CORE_TAB_ID_TO_SLUG: Record<string, WorkspaceRouteTabSlug> = {
  "core:3d": "3d",
  "core:2d": "2d",
  "core:analyze": "analyze",
  "core:charts": "charts",
};

export function normalizeWorkspaceTabSlug(
  value: string | string[] | undefined | null,
): WorkspaceRouteTabSlug | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const slug = raw?.trim().toLowerCase();
  if (!slug) return null;
  if (slug === "3d" || slug === "viewport" || slug === "viewport-3d") return "3d";
  if (slug === "2d" || slug === "slice" || slug === "viewport-2d") return "2d";
  if (slug === "mesh" || slug === "mesh-workspace" || slug === "viewport-mesh") return "3d";
  if (slug === "analyze" || slug === "analysis") return "analyze";
  if (slug === "charts" || slug === "chart" || slug === "plots") return "charts";
  return null;
}

export function coreTabIdForWorkspaceRouteSlug(slug: WorkspaceRouteTabSlug): string {
  return SLUG_TO_CORE_TAB_ID[slug];
}

export function workspaceHrefForTabSlug(slug: WorkspaceRouteTabSlug): Route {
  return `/workspace/${slug}` as Route;
}

export function workspaceRouteSlugForTab(
  tab: Pick<WorkspaceTab, "id" | "kind"> | null | undefined,
): WorkspaceRouteTabSlug | null {
  if (!tab) return null;
  const coreSlug = CORE_TAB_ID_TO_SLUG[tab.id];
  if (coreSlug) return coreSlug;
  if (tab.kind === "viewport-3d" || tab.kind === "result-quantity") return "3d";
  if (tab.kind === "viewport-2d") return "2d";
  if (tab.kind === "viewport-mesh") return "3d";
  if (tab.kind === "viewport-charts") return "charts";
  return "analyze";
}
