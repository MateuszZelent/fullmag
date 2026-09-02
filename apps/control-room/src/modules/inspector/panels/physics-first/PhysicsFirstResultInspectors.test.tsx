import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  DispersionOverviewResultInspector,
  DynamicsResultInspector,
  HysteresisResultInspector,
  LegacyTimeDomainResultInspector,
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

  it("makes a legacy spectral selection inspectable without promoting its field", () => {
    const ref: Extract<SelectionRef, { type: "frequency-domain" }> = {
      artifactPath: "/v2/sessions/current/analysis/spin-wave/gamma.v1",
      artifactRevision: "spin_wave_response.gamma.v1:sha256:gamma-1",
      availability: "partial",
      executionState: "completed",
      frequencyHz: 12.5e9,
      frequencyIndex: 7,
      kind: "results.time_domain.spectral_feature",
      nodeId: "analysis:legacy:time-domain:legacy%3Agamma%3Apeak%3A7",
      pointId: "legacy:gamma:peak:7",
      resourceRef: "/v2/sessions/current/analysis/spin-wave/gamma.v1",
      resourceState: "ready",
      sampleId: "gamma-spectrum-sample-0000",
      sampleIndex: 0,
      source: "time-domain-response",
      studyProduct: "time_domain_spectrum",
      type: "frequency-domain",
    };
    const html = renderToStaticMarkup(
      <LegacyTimeDomainResultInspector
        selection={{
          ...selection(ref.kind, "legacy:gamma:peak:7"),
          ref,
        }}
      />,
    );

    expect(html).toContain("Legacy time-domain selection");
    expect(html).toContain("legacy/partial");
    expect(html).toContain("1.250000e+10 Hz");
    expect(html).toContain("Unavailable from legacy reader");
    expect(html).toContain("Not published; keep this selection legacy/partial");
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
