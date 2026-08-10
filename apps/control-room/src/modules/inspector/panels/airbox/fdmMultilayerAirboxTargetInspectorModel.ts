import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";
import { resolveFdmMultilayerAirboxTarget } from "@/shared/domain/mesh/fdmMultilayerAirboxTarget";

export interface FdmMultilayerAirboxTargetInspectorRow {
  label: string;
  mono?: boolean;
  unit?: string;
  value: string;
}

export type FdmMultilayerAirboxTargetInspectorModel =
  | {
      notice: string;
      status: "unavailable";
    }
  | {
      fieldCapabilityRows: readonly FdmMultilayerAirboxTargetInspectorRow[];
      provenanceRows: readonly FdmMultilayerAirboxTargetInspectorRow[];
      status: "ready";
      targetGridRows: readonly FdmMultilayerAirboxTargetInspectorRow[];
    };

function tuple(values: readonly number[]): string {
  return `[${values.join(", ")}]`;
}

function runtimeIdentity(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not published";
  try {
    return JSON.stringify(value);
  } catch {
    return "not published";
  }
}

export function resolveFdmMultilayerAirboxTargetInspectorModel(
  layout: FdmMultilayerLayoutResource | null | undefined,
): FdmMultilayerAirboxTargetInspectorModel {
  const target = resolveFdmMultilayerAirboxTarget(layout);
  if (!target || !layout) {
    return {
      notice: layout?.airbox.unavailable_reason ?? "Target-only Airbox carrier is not published or failed validation.",
      status: "unavailable",
    };
  }
  const airbox = layout.airbox;
  return {
    status: "ready",
    targetGridRows: [
      { label: "Target-only", value: "yes" },
      { label: "Cells", value: tuple(target.cells) },
      { label: "Origin", value: tuple(target.origin), unit: "m" },
      { label: "Cell size", value: tuple(target.cellSize), unit: "m" },
      { label: "Samples", value: String(target.sampleCount) },
      { label: "Values", value: String(target.valueCount) },
    ],
    fieldCapabilityRows: [
      { label: "H_demag", value: "available" },
      {
        label: "H_eff",
        value: `unavailable (${airbox.h_eff_unavailable_reason ?? "not published"})`,
      },
    ],
    provenanceRows: [
      { label: "Carrier fingerprint", value: target.carrierFingerprint, mono: true },
      { label: "Carrier revision", value: String(airbox.carrier_revision ?? "not published") },
      { label: "Layout revision", value: String(layout.layout_revision) },
      { label: "Observation revision", value: String(layout.observation_revision) },
      { label: "Source policy", value: airbox.source_policy ?? "not published", mono: true },
      {
        label: "Source grids",
        value: airbox.source_grid_fingerprints?.join(", ") || "not published",
        mono: true,
      },
      { label: "Runtime", value: runtimeIdentity(airbox.source_runtime_identity), mono: true },
    ],
  };
}
