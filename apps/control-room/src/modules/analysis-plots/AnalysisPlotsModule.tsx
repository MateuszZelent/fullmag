"use client";

import type { ModuleProps } from "@/kernel/types";

import { AnalysisPlotsView } from "./AnalysisPlotsView";
import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

export { AnalysisPlotsView } from "./AnalysisPlotsView";

export default function AnalysisPlotsModule(props: ModuleProps) {
  return <AnalysisWorkbenchModule {...props} />;
}
function AnalysisWorkbenchModule({ kernel }: ModuleProps) {
  const controller = useAnalysisPlotsController(kernel);
  return (
    <AnalysisPlotsView
      activeSurface={controller.activeSurface}
      availableColumns={controller.availableColumns}
      frequencyDomainSeries={controller.frequencyDomainSeries}
      frequencyDomainStatus={controller.frequencyDomainStatus}
      frequencyDomainTitle={controller.frequencyDomainTitle}
      frequencyDomainUnavailableReason={controller.frequencyDomainUnavailableReason}
      kernel={kernel}
      liveMode={controller.liveMode}
      onClearRange={controller.clearRange}
      onLiveModeToggle={() => controller.setLiveMode(
        controller.liveMode === "following" ? "paused" : "following",
      )}
      onPointSelect={controller.selectPoint}
      onRangeChange={controller.setRange}
      onSelectXAxis={controller.setXAxisId}
      onRangeModeChange={controller.setRangeMode}
      onTargetPointsChange={controller.setTargetPoints}
      onSeriesSelect={controller.selectSeries}
      onSelectedSeriesIdsChange={controller.setSelectedSeriesIds}
      onSurfaceChange={controller.setActiveSurface}
      range={controller.range}
      rangeMode={controller.rangeMode}
      selectedPoint={controller.selectedPoint}
      selectedStageId={controller.selectedStageId}
      solverEnergySeries={controller.solverEnergySeries}
      solverEnergyStatus={controller.solverEnergyStatus}
      tableRowsStatus={controller.tableRowsStatus}
      tableRowsRefresh={controller.tableRowsRefresh}
      targetPoints={controller.targetPoints}
      visibleTable={controller.visibleTable}
      xAxisId={controller.xAxisId}
      selectedSeriesIds={controller.selectedSeriesIds}
    />
  );
}
