"use client";

import type { ModuleProps } from "@/kernel/types";

import { AnalysisPlotsView } from "./AnalysisPlotsView";
import { AnalysisQuickChartDock } from "./AnalysisQuickChartDock";
import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

export { AnalysisPlotsView } from "./AnalysisPlotsView";

export default function AnalysisPlotsModule(props: ModuleProps) {
  return props.slotId === "panel-bottom"
    ? <AnalysisQuickChartDock />
    : <AnalysisWorkbenchModule {...props} />;
}

function AnalysisWorkbenchModule({ kernel }: ModuleProps) {
  const controller = useAnalysisPlotsController(kernel);
  return (
    <AnalysisPlotsView
      activeSurface={controller.activeSurface}
      kernel={kernel}
      selectedStageId={controller.selectedStageId}
      onClearRange={controller.clearRange}
      onPointSelect={controller.selectPoint}
      onRangeChange={controller.setRange}
      onSeriesSelect={controller.selectSeries}
      onSurfaceChange={controller.setActiveSurface}
      frequencyDomainSeries={controller.frequencyDomainSeries}
      frequencyDomainStatus={controller.frequencyDomainStatus}
      frequencyDomainTitle={controller.frequencyDomainTitle}
      frequencyDomainUnavailableReason={controller.frequencyDomainUnavailableReason}
      range={controller.range}
      selectedPoint={controller.selectedPoint}
      solverEnergySeries={controller.solverEnergySeries}
      solverEnergyStatus={controller.solverEnergyStatus}
      tableRowsStatus={controller.tableRowsStatus}
      visibleTable={controller.visibleTable}
      xAxisId={controller.xAxisId}
      yAxisIds={controller.yAxisIds}
      spinWaveGamma={controller.spinWaveGamma}
      spinWaveGammaStatus={controller.spinWaveGammaStatus}
      dynamicStructureFactor={controller.dynamicStructureFactor}
    />
  );
}
