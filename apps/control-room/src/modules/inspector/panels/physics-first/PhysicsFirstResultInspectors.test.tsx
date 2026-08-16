import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  DispersionOverviewResultInspector,
  DynamicsResultInspector,
  HysteresisResultInspector,
  ResonanceOverviewResultInspector,
} from "./PhysicsFirstResultInspectors";

function selection(kind: string, label: string): InspectorPanelProps["selection"] {
  return {
    kind,
    label,
    moduleSource: "explorer",
    nodeId: `results:run:run-1:${kind}`,
    objectId: null,
    ref: null,
  };
}

describe("physics-first result root Inspectors", () => {
  it("explains the time-domain and spectral handoff for Dynamics", () => {
    const html = renderToStaticMarkup(
      <DynamicsResultInspector
        selection={selection("results.dynamics.root", "Dynamics")}
      />,
    );

    expect(html).toContain("Time-domain observables");
    expect(html).toContain("Temporal Spectrum");
    expect(html).toContain("Spin-Wave Spectrum");
  });

  it("separates modal and driven products in the Resonance root", () => {
    const html = renderToStaticMarkup(
      <ResonanceOverviewResultInspector
        selection={selection("results.resonance.root", "Resonance & FMR")}
      />,
    );

    expect(html).toContain("Modal lane");
    expect(html).toContain("Driven lane");
    expect(html).toContain("FMR naming gate");
  });

  it("states that a driven response map is not a dispersion relation", () => {
    const html = renderToStaticMarkup(
      <DispersionOverviewResultInspector
        selection={selection(
          "results.dispersion.root",
          "Dispersion & k-resolved response",
        )}
      />,
    );

    expect(html).toContain("Modal relation fₙ(k)");
    expect(html).toContain("Driven map A(k,f)");
    expect(html).toContain("not a modal dispersion relation");
  });

  it("defines field-sweep observables and branch semantics for Hysteresis", () => {
    const html = renderToStaticMarkup(
      <HysteresisResultInspector
        selection={selection("results.hysteresis.root", "Hysteresis")}
      />,
    );

    expect(html).toContain("Field sweep");
    expect(html).toContain("Branch and turning-point data");
    expect(html).toContain("Magnetization observable");
  });
});
