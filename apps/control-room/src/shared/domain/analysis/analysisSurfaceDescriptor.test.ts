import { describe, expect, it } from "vitest";

import {
  descriptorForFrequencyTable,
  descriptorForSurface,
} from "./analysisSurfaceDescriptor";

describe("analysis surface descriptors", () => {
  it("describes modal spectrum axes and mode handoff", () => {
    expect(descriptorForFrequencyTable("frequency-domain:eigen-spectrum")).toMatchObject({
      surface: "resonance-fmr",
      selectionKind: "analysis.chart",
      xAxis: { label: "mode index", unit: "1" },
      yAxes: [{ label: "frequency", unit: "Hz" }],
      inspectorRouteId: "chart",
      handoff: "mode-overlay",
    });
  });

  it("keeps dispersion path coordinates separate from frequency units", () => {
    expect(descriptorForFrequencyTable("frequency-domain:eigen-dispersion")).toMatchObject({
      surface: "dispersion",
      xAxis: { label: "path_s", unit: "rad/m" },
      yAxes: [{ label: "frequency", unit: "Hz" }],
      handoff: "branch-overlay",
    });
  });

  it("describes driven response as a frequency-axis handoff", () => {
    expect(descriptorForFrequencyTable("frequency-domain:response-sweep")).toMatchObject({
      surface: "resonance-fmr",
      xAxis: { label: "frequency", unit: "Hz" },
      handoff: "response-overlay",
    });
  });

  it("provides stable titles for the public analysis surfaces", () => {
    expect(descriptorForSurface("resonance-fmr")).toMatchObject({
      title: "Resonance & FMR",
      surface: "resonance-fmr",
    });
  });
});
