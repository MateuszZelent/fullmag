import { describe, expect, it } from "vitest";

import { resolveInspectorPanel } from "../inspectorRegistry";
import { PhysicsFirstResultInspectorPanel } from "./physics-first/PhysicsFirstResultInspectorPanel";
import { EigenSpectrumInspectorPanel } from "./frequency-domain/FrequencyDomainResultInspectors";

describe("physics-first frequency result inspectors", () => {
  it("routes modal spectrum as eigenfrequency rather than automatic FMR", () => {
    expect(resolveInspectorPanel({ kind: "results.resonance.modal.spectrum" })?.component)
      .toBe(EigenSpectrumInspectorPanel);
    expect(resolveInspectorPanel({ kind: "results.resonance.modal.coupling" })?.component)
      .toBe(PhysicsFirstResultInspectorPanel);
  });

  it("keeps driven response and modal dispersion as distinct semantic owners", () => {
    expect(resolveInspectorPanel({ kind: "results.resonance.driven.spectrum" })?.component)
      .toBe(PhysicsFirstResultInspectorPanel);
    expect(resolveInspectorPanel({ kind: "results.dispersion.modal.relation" })?.component)
      .not.toBe(PhysicsFirstResultInspectorPanel);
  });
});
