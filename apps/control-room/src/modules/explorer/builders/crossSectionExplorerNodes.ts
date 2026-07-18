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
    const draftId = "model:visualizations-2d:draft";
    children.push({
      id: draftId,
      kind: "visualizations-2d.draft",
      label: draft.name,
      parentId: "model:visualizations-2d",
      badge: crossSectionPlaneBadge(
        draft.plane,
        draft.positionPercent,
        draft.metric,
      ),
      children: crossSectionParameterNodes(draftId, {
        colorScale: draft.colorScale,
        filterExpression: draft.filterExpression,
        frameExtent: draft.frameExtent,
        metric: draft.metric,
        owner: "draft",
        rotationDegrees: draft.rotationDegrees,
        plane: draft.plane,
        positionPercent: draft.positionPercent,
        shrinkFactor: draft.shrinkFactor,
        wireframeVisible: draft.includeWireframe,
      }),
      crossSectionDraftId: draft.id,
      icon: "triangle",
      status: "queued",
      contextCommands: ["workspace.focus-selection"],
    });
  }

  children.push(
    ...plots.map((plot) => {
      const plotId = `model:visualizations-2d:${plot.id}`;
      return {
        id: plotId,
        kind: "visualizations-2d.plot" as const,
        label: plot.name,
        parentId: "model:visualizations-2d",
        badge: crossSectionPlaneBadge(
          plot.plane,
          plot.positionPercent,
          plot.metric,
        ),
        children: crossSectionParameterNodes(plotId, {
          colorScale: plot.colorScale,
          filterExpression: plot.filterExpression,
          frameExtent: plot.frameExtent,
          metric: plot.metric,
          owner: "plot",
          ownerId: plot.id,
          rotationDegrees: plot.rotationDegrees,
          plane: plot.plane,
          positionPercent: plot.positionPercent,
          shrinkFactor: plot.shrinkFactor,
          wireframeVisible: plot.wireframeVisible,
        }),
        crossSectionPlotId: plot.id,
        icon: "gauge" as const,
        status: "ready" as const,
        contextCommands: ["workspace.focus-selection"],
      };
    }),
  );

  return {
    id: "model:visualizations-2d",
    kind: "visualizations-2d.root",
    label: "Visualizations 2D",
    parentId: "model:session",
    badge: crossSectionRootBadge(plots.length, Boolean(draft)),
    icon: "layers",
    status: "ready",
    contextCommands: ["explorer.expand-all", "explorer.collapse-all"],
    children,
  };
}

interface CrossSectionParameterSource {
  colorScale: string;
  filterExpression: string;
  frameExtent: string;
  metric: string;
  owner: "draft" | "plot";
  ownerId?: string;
  plane: string;
  positionPercent: number;
  rotationDegrees: number;
  shrinkFactor: number;
  wireframeVisible: boolean;
}

function crossSectionParameterNodes(
  parentId: string,
  source: CrossSectionParameterSource,
): ExplorerNode[] {
  const ownerFields =
    source.owner === "draft"
      ? { crossSectionDraftId: "draft" as const }
      : { crossSectionPlotId: source.ownerId };
  return [
    {
      id: `${parentId}:frame`,
      kind: "visualizations-2d.parameter",
      label: "Frame",
      parentId,
      badge: `${formatFrameExtent(source.frameExtent)} / ${formatDegrees(source.rotationDegrees)}`,
      icon: "braces",
      status: "ready",
      ...ownerFields,
    },
    {
      id: `${parentId}:plane`,
      kind: "visualizations-2d.parameter",
      label: "Plane",
      parentId,
      badge: `${source.plane.toUpperCase()} ${formatPercent(source.positionPercent)}`,
      icon: "triangle",
      status: "ready",
      ...ownerFields,
    },
    {
      id: `${parentId}:quality`,
      kind: "visualizations-2d.parameter",
      label: "Quality",
      parentId,
      badge: `${source.metric} / ${source.colorScale}`,
      icon: "gauge",
      status: "ready",
      ...ownerFields,
    },
    {
      id: `${parentId}:render`,
      kind: "visualizations-2d.parameter",
      label: "Render",
      parentId,
      badge: renderBadge(source),
      icon: "settings",
      status: source.filterExpression ? "warning" : "ready",
      ...ownerFields,
    },
  ];
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

function renderBadge(source: CrossSectionParameterSource): string {
  const wireframe = source.wireframeVisible ? "wireframe on" : "wireframe off";
  const shrink = `shrink ${Number(source.shrinkFactor.toFixed(2))}`;
  const filter = source.filterExpression || "no filter";
  return `${wireframe} / ${shrink} / ${filter}`;
}

function formatFrameExtent(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatDegrees(value: number): string {
  return `${Number(value.toFixed(1))} deg`;
}
