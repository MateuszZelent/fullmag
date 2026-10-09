import type { PostprocessingDefinition } from "@/kernel/api/apiTypes";
import { importedReferencePoints } from "@/kernel/analysis-modules/postprocessingDefinitions";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

const FREQUENCY_DIVISORS: Readonly<Record<string, number>> = {
  GHz: 1e9,
  Hz: 1,
  MHz: 1e6,
  THz: 1e12,
  kHz: 1e3,
};

/**
 * Overlay series for imported references saved as postprocessing definitions
 * (ADR 0054, spec 32 §9). They share the computed series' frequency unit and
 * path axis, and carry `reference_frequency`, so their points never select a
 * computed mode. Only references of the shown run and stage are drawn.
 */
export function referenceOverlaySeries(
  computed: readonly ChartSeries[],
  definitions: readonly PostprocessingDefinition[],
  identity: { runId: string | null; stageId: string | null },
): ChartSeries[] {
  const template = computed[0];
  const divisor = template ? FREQUENCY_DIVISORS[template.unit] : undefined;
  if (!template || !divisor || !identity.runId || !identity.stageId) return [];
  return definitions.flatMap((definition): ChartSeries[] => {
    if (
      definition.module_id !== "analysis.dispersion" ||
      definition.data_ref.run_id !== identity.runId ||
      definition.data_ref.dataset_id !== identity.stageId
    ) {
      return [];
    }
    const points = importedReferencePoints(definition);
    if (!points) return [];
    return [
      {
        id: `analysis.reference:${definition.definition_id}`,
        kind: "line",
        label: `${definition.label} (reference)`,
        points: points.map(([path, frequency], rowIndex) => ({
          rowIndex,
          x: path,
          y: frequency / divisor,
        })),
        quantity: "reference_frequency",
        source: template.source,
        status: "ready",
        unit: template.unit,
        xUnit: "rad/m",
      },
    ];
  });
}
