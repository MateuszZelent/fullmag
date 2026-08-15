import { describe, expect, it } from "vitest";

import * as frequencyInspectors from "./frequency-domain/FrequencyDomainResultInspectors";

import { resolveInspectorPanel } from "../inspectorRegistry";
import {
  DispersionRelationResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalSpectrumResultInspector,
} from "./physics-first/PhysicsFirstResultInspectors";
import { buildFrequencyResponsePlotCommandInput } from "./frequency-domain/FrequencyDomainResultInspectors";

describe("physics-first frequency result inspectors", () => {
  it("keeps response-map readiness fail-closed until a typed k-by-f resource exists", () => {
    const resolveAvailability = (
      frequencyInspectors as unknown as {
        responseMapAvailabilityFromTypedResource?: (resource: unknown) => string;
      }
    ).responseMapAvailabilityFromTypedResource;

    expect(resolveAvailability?.(null)).toBe("unsupported");
    expect(resolveAvailability?.({ data: { points: [] }, status: "ready" })).toBe("ready");
    expect(resolveAvailability?.({ data: null, status: "ready" })).toBe("unsupported");
  });

  it("routes modal spectrum as eigenfrequency rather than automatic FMR", () => {
    expect(resolveInspectorPanel({ kind: "results.resonance.modal.spectrum" })?.component)
      .toBe(ResonanceModalSpectrumResultInspector);
    expect(resolveInspectorPanel({ kind: "results.resonance.modal.coupling" })?.component)
      .toBe(ResonanceModalCouplingResultInspector);
  });

  it("keeps driven response and modal dispersion as distinct semantic owners", () => {
    expect(resolveInspectorPanel({ kind: "results.resonance.driven.spectrum" })?.component)
      .toBe(ResonanceDrivenSpectrumResultInspector);
    expect(resolveInspectorPanel({ kind: "results.dispersion.modal.relation" })?.component)
      .toBe(DispersionRelationResultInspector);
  });

  it("keeps the response frequency identity in a 3D plot command", () => {
    expect(
      buildFrequencyResponsePlotCommandInput({
        fieldId: "analysis:frequency-response:frequency-0003",
        frequencyIndex: 3,
        label: "response 1.5 GHz",
        phaseRad: 0,
        view: "phase_rotated_real",
      }),
    ).toEqual({
      fieldId: "analysis:frequency-response:frequency-0003",
      frequencyIndex: 3,
      label: "response 1.5 GHz",
      phaseRad: 0,
      source: "frequency-response",
      view: "phase_rotated_real",
    });
  });
});
