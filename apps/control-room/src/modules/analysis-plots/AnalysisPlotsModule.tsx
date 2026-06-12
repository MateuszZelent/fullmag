"use client";

import type { ModuleProps } from "@/kernel/types";

import { AnalysisPlotsView } from "./AnalysisPlotsView";
import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

export { AnalysisPlotsView } from "./AnalysisPlotsView";

export default function AnalysisPlotsModule({ kernel }: ModuleProps) {
  const controller = useAnalysisPlotsController(kernel);

  return (
    <AnalysisPlotsView
      kernel={kernel}
      selectedStageId={controller.selectedStageId}
      onClearRange={controller.clearRange}
      onPointSelect={controller.selectPoint}
      onRangeChange={controller.setRange}
      onSeriesSelect={controller.selectSeries}
      frequencyDomainSeries={controller.frequencyDomainSeries}
      frequencyDomainStatus={controller.frequencyDomainStatus}
      frequencyDomainTitle={controller.frequencyDomainTitle}
      frequencyDomainUnavailableReason={
        controller.frequencyDomainUnavailableReason
      }
      range={controller.range}
      selectedPoint={controller.selectedPoint}
      solverEnergySeries={controller.solverEnergySeries}
      solverEnergyStatus={controller.solverEnergyStatus}
      tableRowsStatus={controller.tableRowsStatus}
      visibleTable={controller.visibleTable}
      xAxisId={controller.xAxisId}
      yAxisIds={controller.yAxisIds}
    />
  );
}
