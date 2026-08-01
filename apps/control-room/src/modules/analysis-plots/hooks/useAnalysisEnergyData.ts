"use client";

/**
 * useAnalysisEnergyData — resource hook for solver energy history.
 *
 * Owns:
 *   - /session/energy-history resource
 *   - ChartSeries derivation for energy plots
 *
 * Enabled only when `activeSurface` is "energy".
 *
 * Etap 10: controller split by resource family.
 * See: docs/analysis-tab-refactoring-plan.md §T10
 */

import { useMemo } from "react";

import {
  shouldLoadRuntimeScalars,
  useSolverEnergyHistoryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";

import type { ChartSeries } from "../chartTableModel";
import { buildSolverEnergyHistoryChartSeries } from "../energyHistoryAdapter";

export interface AnalysisEnergyDataResult {
  /** Energy series ready for ChartSection / EChartsSurface */
  solverEnergySeries: ChartSeries[];
  /** Resource status: "loading" | "ready" | "stale" | "error" */
  solverEnergyStatus: string;
}

/**
 * Resource hook: solver energy data family.
 *
 * Enabled only when `activeSurface` is "energy".
 */
export function useAnalysisEnergyData(
  activeSurface: string,
): AnalysisEnergyDataResult {
  const scalarsRevision = useSessionStatusSelector(
    (status) => status.data?.resources.scalars_revision ?? null,
  );
  const loadScalars = shouldLoadRuntimeScalars(
    true,
    scalarsRevision === null
      ? null
      : { resources: { scalars_revision: scalarsRevision } },
  );
  const loadEnergy =
    loadScalars &&
    activeSurface === "energy";

  const solverEnergyHistory = useSolverEnergyHistoryResource(400, {
    enabled: loadEnergy,
  });

  const solverEnergySeries = useMemo(
    () =>
      buildSolverEnergyHistoryChartSeries(
        solverEnergyHistory.data,
        solverEnergyHistory.status,
      ),
    [solverEnergyHistory.data, solverEnergyHistory.status],
  );

  return {
    solverEnergySeries,
    solverEnergyStatus: solverEnergyHistory.status,
  };
}
