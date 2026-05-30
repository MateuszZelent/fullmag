import type { CrossSectionWorkspaceState } from "@/kernel/workspace/crossSectionWorkspace";

import type { ModelTreeCrossSectionSnapshot } from "./explorerTypes";

export function selectExplorerCrossSections(
  state: CrossSectionWorkspaceState,
): ModelTreeCrossSectionSnapshot {
  return {
    activePlotId: state.activePlotId,
    draft: state.draft
      ? {
          colorScale: state.draft.colorScale,
          filterExpression: state.draft.filterExpression,
          frameExtent: state.draft.frameExtent,
          id: state.draft.id,
          includeWireframe: state.draft.includeWireframe,
          metric: state.draft.metric,
          name: state.draft.name,
          plane: state.draft.plane,
          positionPercent: state.draft.positionPercent,
          rotationDegrees: state.draft.rotationDegrees,
          shrinkFactor: state.draft.shrinkFactor,
        }
      : null,
    plots: state.plots.map((plot) => ({
      colorScale: plot.renderOptions.colorScale,
      filterExpression: plot.renderOptions.filterExpression,
      frameExtent: plot.frameExtent,
      id: plot.id,
      metric: plot.metric,
      name: plot.name,
      plane: plot.plane,
      positionPercent: plot.positionPercent,
      rotationDegrees: plot.rotationDegrees,
      shrinkFactor: plot.renderOptions.shrinkFactor,
      wireframeVisible: plot.renderOptions.wireframeVisible,
    })),
  };
}

export function explorerCrossSectionsEqual(
  previous: ModelTreeCrossSectionSnapshot,
  next: ModelTreeCrossSectionSnapshot,
): boolean {
  if (previous.activePlotId !== next.activePlotId) return false;
  if (!crossSectionDraftEqual(previous.draft, next.draft)) return false;
  return (
    previous.plots.length === next.plots.length &&
    previous.plots.every((plot, index) =>
      crossSectionPlotSummaryEqual(plot, next.plots[index]),
    )
  );
}

function crossSectionDraftEqual(
  previous: ModelTreeCrossSectionSnapshot["draft"],
  next: ModelTreeCrossSectionSnapshot["draft"],
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.colorScale === next.colorScale &&
    previous.filterExpression === next.filterExpression &&
    previous.frameExtent === next.frameExtent &&
    previous.id === next.id &&
    previous.includeWireframe === next.includeWireframe &&
    previous.metric === next.metric &&
    previous.name === next.name &&
    previous.plane === next.plane &&
    previous.positionPercent === next.positionPercent &&
    previous.rotationDegrees === next.rotationDegrees &&
    previous.shrinkFactor === next.shrinkFactor
  );
}

function crossSectionPlotSummaryEqual(
  previous: ModelTreeCrossSectionSnapshot["plots"][number],
  next: ModelTreeCrossSectionSnapshot["plots"][number] | undefined,
): boolean {
  if (!next) return false;
  return (
    previous.colorScale === next.colorScale &&
    previous.filterExpression === next.filterExpression &&
    previous.frameExtent === next.frameExtent &&
    previous.id === next.id &&
    previous.metric === next.metric &&
    previous.name === next.name &&
    previous.plane === next.plane &&
    previous.positionPercent === next.positionPercent &&
    previous.rotationDegrees === next.rotationDegrees &&
    previous.shrinkFactor === next.shrinkFactor &&
    previous.wireframeVisible === next.wireframeVisible
  );
}
