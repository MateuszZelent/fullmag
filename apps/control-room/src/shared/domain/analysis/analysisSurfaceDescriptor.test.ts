import { describe, expect, it } from "vitest";

import {
  descriptorForFrequencyTable,
  descriptorForSurface,
} from "./analysisSurfaceDescriptor";

describe("analysis surface descriptors", () => {
  it("describes modal spectrum axes and mode handoff", () => {
    expect(descriptorForFrequencyTable("frequency-domain:eigen-spectrum")).toMatchObject({
      surface: "eigenmodes",
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
      surface: "frequency-response",
      xAxis: { label: "frequency", unit: "Hz" },
      handoff: "response-overlay",
    });
  });

  it("provides stable titles for the public analysis surfaces", () => {
    expect(descriptorForSurface("eigenmodes")).toMatchObject({
      title: "Eigenmodes",
      surface: "eigenmodes",
    });
    expect(descriptorForSurface("frequency-response")).toMatchObject({
      title: "Frequency response",
      surface: "frequency-response",
    });
  });
});
