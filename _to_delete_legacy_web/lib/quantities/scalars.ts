import { quantityById } from "./catalog";
import type { QuantityId } from "./types";

export type ScalarSeriesKey = string;

export interface ScalarSeriesMeta {
  key: ScalarSeriesKey;
  label: string;
  unit: string;
  kind: "quantity" | "diagnostic" | "derived";
}

export interface ScalarDescriptorSource {
  label: string;
  unit: string;
  shape?: string;
  kind?: string;
  scalarMetricKey?: string | null;
  scalar_metric_key?: string | null;
}

const DIAGNOSTIC_SERIES: readonly ScalarSeriesMeta[] = [
  { key: "step", label: "Step", unit: "", kind: "diagnostic" },
  { key: "time", label: "Time", unit: "s", kind: "diagnostic" },
  { key: "solver_dt", label: "Δt", unit: "s", kind: "diagnostic" },
];

const DERIVED_SERIES = [
  scalarFromQuantity("mx", "m", "m_x avg"),
  scalarFromQuantity("my", "m", "m_y avg"),
  scalarFromQuantity("mz", "m", "m_z avg"),
  scalarFromQuantity("max_dm_dt", "dm_dt", "max |dm/dt|"),
  scalarFromQuantity("max_h_eff", "H_eff", "max |H_eff|"),
  scalarFromQuantity("max_h_demag", "H_demag", "max |H_demag|"),
  { key: "max_torque_Apm", label: "max |m×H_eff|", unit: "A/m", kind: "derived" as const },
  { key: "max_torque_T", label: "max |m×B_eff|", unit: "T", kind: "derived" as const },
] satisfies readonly ScalarSeriesMeta[];

function scalarFromQuantity(
  key: string,
  quantityId: QuantityId,
  label: string,
): ScalarSeriesMeta {
  const descriptor = quantityById(quantityId);
  return {
    key,
    label,
    unit: descriptor?.unit ?? "",
    kind: "derived",
  };
}

function quantityMetaMap(
  quantities: readonly ScalarDescriptorSource[],
): Map<string, ScalarSeriesMeta> {
  return new Map(
    quantities
      .filter((quantity) => {
        const shape = "shape" in quantity ? quantity.shape : quantity.kind;
        const scalarMetricKey =
          "scalarMetricKey" in quantity ? quantity.scalarMetricKey : quantity.scalar_metric_key;
        return shape === "global_scalar" && Boolean(scalarMetricKey);
      })
      .map((quantity) => [
        ("scalarMetricKey" in quantity ? quantity.scalarMetricKey : quantity.scalar_metric_key) as string,
        {
          key: ("scalarMetricKey" in quantity ? quantity.scalarMetricKey : quantity.scalar_metric_key) as string,
          label: quantity.label,
          unit: quantity.unit,
          kind: "quantity" as const,
        },
      ]),
  );
}

export function scalarSeriesMeta(
  key: string,
  quantities: readonly ScalarDescriptorSource[],
): ScalarSeriesMeta | null {
  const quantityMeta = quantityMetaMap(quantities).get(key);
  if (quantityMeta) {
    return quantityMeta;
  }
  return (
    DIAGNOSTIC_SERIES.find((entry) => entry.key === key)
    ?? DERIVED_SERIES.find((entry) => entry.key === key)
    ?? null
  );
}

export function scalarSeriesList(
  keys: readonly string[],
  quantities: readonly ScalarDescriptorSource[],
): ScalarSeriesMeta[] {
  return keys
    .map((key) => scalarSeriesMeta(key, quantities))
    .filter((entry): entry is ScalarSeriesMeta => entry != null);
}

export function defaultScalarTableSeries(
  quantities: readonly ScalarDescriptorSource[],
): ScalarSeriesMeta[] {
  return scalarSeriesList(
    [
      "step",
      "time",
      "solver_dt",
      "mx",
      "my",
      "mz",
      "e_ex",
      "e_demag",
      "e_ext",
      "e_ani",
      "e_dmi",
      "e_total",
      "max_dm_dt",
      "max_h_eff",
      "max_h_demag",
      "max_torque_Apm",
      "max_torque_T",
    ],
    quantities,
  );
}
