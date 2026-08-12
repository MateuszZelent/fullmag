import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";

export interface AxisDescriptor {
  label: string;
  unit: string;
}

export type AnalysisSurfaceHandoff =
  | "branch-overlay"
  | "mode-overlay"
  | "none"
  | "response-overlay";

export interface AnalysisSurfaceDescriptor {
  handoff: AnalysisSurfaceHandoff;
  inspectorRouteId: string;
  selectionKind: "analysis.chart";
  surface: AnalysisSurface | "frequency-domain";
  title: string;
  xAxis: AxisDescriptor;
  yAxes: readonly AxisDescriptor[];
}

const chartRoute = "chart";

const frequencyDomainDescriptor: AnalysisSurfaceDescriptor = Object.freeze({
  handoff: "none",
  inspectorRouteId: chartRoute,
  selectionKind: "analysis.chart",
  surface: "frequency-domain",
  title: "Frequency domain",
  xAxis: { label: "frequency-domain coordinate", unit: "series-defined" },
  yAxes: [{ label: "observable", unit: "series-defined" }],
});

const modalSpectrumDescriptor: AnalysisSurfaceDescriptor = Object.freeze({
  handoff: "mode-overlay",
  inspectorRouteId: chartRoute,
  selectionKind: "analysis.chart",
  surface: "resonance-fmr",
  title: "Eigenmode spectrum",
  xAxis: { label: "mode index", unit: "1" },
  yAxes: [{ label: "frequency", unit: "Hz" }],
});

const dispersionDescriptor: AnalysisSurfaceDescriptor = Object.freeze({
  handoff: "branch-overlay",
  inspectorRouteId: chartRoute,
  selectionKind: "analysis.chart",
  surface: "dispersion",
  title: "Eigenmode dispersion",
  xAxis: { label: "path_s", unit: "rad/m" },
  yAxes: [{ label: "frequency", unit: "Hz" }],
});

const responseSweepDescriptor: AnalysisSurfaceDescriptor = Object.freeze({
  handoff: "response-overlay",
  inspectorRouteId: chartRoute,
  selectionKind: "analysis.chart",
  surface: "resonance-fmr",
  title: "Frequency response",
  xAxis: { label: "frequency", unit: "Hz" },
  yAxes: [{ label: "observable", unit: "series-defined" }],
});

const surfaceDescriptors: Readonly<Record<AnalysisSurface, AnalysisSurfaceDescriptor>> = {
  comparison: {
    ...frequencyDomainDescriptor,
    surface: "comparison",
    title: "Comparison",
  },
  dynamics: {
    ...frequencyDomainDescriptor,
    surface: "dynamics",
    title: "Magnetization dynamics",
    xAxis: { label: "time", unit: "s" },
  },
  dispersion: {
    ...dispersionDescriptor,
    title: "Spin-wave dispersion",
  },
  "resonance-fmr": {
    ...modalSpectrumDescriptor,
    title: "Resonance & FMR",
  },
  hysteresis: {
    ...frequencyDomainDescriptor,
    surface: "hysteresis",
    title: "Hysteresis",
    xAxis: { label: "field", unit: "A/m" },
    yAxes: [{ label: "magnetization", unit: "A/m" }],
  },
};

export function descriptorForFrequencyTable(tableId: string): AnalysisSurfaceDescriptor {
  switch (tableId) {
    case "frequency-domain:eigen-dispersion":
      return dispersionDescriptor;
    case "frequency-domain:response-sweep":
      return responseSweepDescriptor;
    case "frequency-domain:eigen-spectrum":
      return modalSpectrumDescriptor;
    default:
      return frequencyDomainDescriptor;
  }
}

export function descriptorForSurface(surface: AnalysisSurface): AnalysisSurfaceDescriptor {
  return surfaceDescriptors[surface];
}
