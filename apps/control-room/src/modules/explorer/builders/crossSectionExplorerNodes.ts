import type {
  ExplorerNode,
  ModelTreeCrossSectionSnapshot,
} from "../explorerTypes";

export function buildCrossSectionNodes(
  crossSections: ModelTreeCrossSectionSnapshot | null | undefined,
): ExplorerNode | null {
  const plots = crossSections?.plots ?? [];
  const draft = crossSections?.draft ?? null;
  if (!draft && plots.length === 0) return null;

  const children: ExplorerNode[] = [];
  if (draft) {
    children.push({
      id: "model:visualizations-2d:draft",
      kind: "visualizations-2d.draft",
      label: draft.name,
      parentId: "model:visualizations-2d",
      badge: crossSectionPlaneBadge(
        draft.plane,
        draft.positionPercent,
        draft.metric,
      ),
      crossSectionDraftId: draft.id,
      icon: "triangle",
      selectable: true,
      status: "queued",
      contextCommands: ["workspace.focus-selection"],
    });
  }

  children.push(
    ...plots.map((plot) => ({
      id: `model:visualizations-2d:${plot.id}`,
      kind: "visualizations-2d.plot" as const,
      label: plot.name,
      parentId: "model:visualizations-2d",
      badge: crossSectionPlaneBadge(
        plot.plane,
        plot.positionPercent,
        plot.metric,
      ),
      crossSectionPlotId: plot.id,
      icon: "gauge" as const,
      selectable: true,
      status: "ready" as const,
      contextCommands: ["workspace.focus-selection"],
    })),
  );

  return {
    id: "model:visualizations-2d",
    kind: "visualizations-2d.root",
    label: "Visualizations 2D",
    parentId: "model:session",
    badge: crossSectionRootBadge(plots.length, Boolean(draft)),
    icon: "layers",
    selectable: true,
    status: "ready",
    contextCommands: ["explorer.expand-all", "explorer.collapse-all"],
    children,
  };
}

function crossSectionPlaneBadge(
  plane: string,
  positionPercent: number,
  metric: string,
): string {
  return `${plane.toUpperCase()} ${formatPercent(positionPercent)} / ${metric}`;
}

function crossSectionRootBadge(plotCount: number, hasDraft: boolean): string {
  if (plotCount > 0) {
    return `${plotCount} ${plotCount === 1 ? "plot" : "plots"}`;
  }
  return hasDraft ? "draft" : "0 plots";
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}
