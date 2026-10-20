import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { antennaSamplingResolution, type AntennaSamplingGridDraft } from "./AntennaSamplingResolutionModel";

const distance = (value: number) => value >= 1e-9 && value < 1e-6 ? formatValueWithUnit(value * 1e9, "nm") : formatValueWithUnit(value, "m");
const wavevector = (value: number) => `${value.toExponential(4)} rad/m`;

export function AntennaSamplingResolution({ values, transform = "spatial_fft" }: { values: AntennaSamplingGridDraft; transform?: string }) {
  const metrics = antennaSamplingResolution(values, transform);
  if (transform !== "spatial_fft") return <div className="fm-antenna-readout" data-testid="antenna-sampling-resolution">
    <InspectorGroup title="Sampling resolution" badge={transform === "nonuniform_spatial_fft" ? "nonuniform grid" : "unsupported transform"} collapsible defaultOpen={false}>
      <p className="fm-inspector-hint">Uniform FFT spacing and k bounds do not describe a nonuniform k-grid. Inspect its authored k coordinates and result provenance.</p>
    </InspectorGroup>
  </div>;
  return <div className="fm-antenna-readout" data-testid="antenna-sampling-resolution">
    <InspectorGroup title="Sampling resolution" badge={metrics ? `${metrics.sampleCount.toLocaleString("en-US")} samples${metrics.withinBudget ? "" : " · over budget"}` : "unavailable"} collapsible defaultOpen={false}>
      <p className="fm-inspector-hint">Authored sampling geometry only. Both plane endpoints are included; FFT bins use N × sample spacing. Frame and source validation are separate. This does not certify field coverage, convergence or an excited mode.</p>
      <FieldRow label="Runtime sample budget" value={metrics ? `${metrics.sampleCount.toLocaleString("en-US")} / ${metrics.limit.toLocaleString("en-US")}` : "unavailable"} />
      <FieldRow label="Spacing u" value={metrics ? distance(metrics.u.spacingM) : "unavailable"} />
      <FieldRow label="Spacing v" value={metrics ? distance(metrics.v.spacingM) : "unavailable"} />
      <FieldRow label="FFT Δk u" value={metrics ? wavevector(metrics.u.deltaKRadPerM) : "unavailable"} />
      <FieldRow label="FFT Δk v" value={metrics ? wavevector(metrics.v.deltaKRadPerM) : "unavailable"} />
      <FieldRow label="FFT k u bounds" value={metrics ? `${wavevector(metrics.u.minimumKRadPerM)} → ${wavevector(metrics.u.maximumKRadPerM)}` : "unavailable"} />
      <FieldRow label="FFT k v bounds" value={metrics ? `${wavevector(metrics.v.minimumKRadPerM)} → ${wavevector(metrics.v.maximumKRadPerM)}` : "unavailable"} />
    </InspectorGroup>
  </div>;
}
