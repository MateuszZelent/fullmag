import { describe, expect, it } from "vitest";

import { resolveInspectorPanel } from "../inspectorRegistry";
import {
  DispersionRelationResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalSpectrumResultInspector,
} from "./physics-first/PhysicsFirstResultInspectors";

describe("physics-first frequency result inspectors", () => {
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
});
