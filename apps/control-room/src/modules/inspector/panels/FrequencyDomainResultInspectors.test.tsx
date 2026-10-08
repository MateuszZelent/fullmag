import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import * as frequencyInspectors from "./frequency-domain/FrequencyDomainResultInspectors";

import { resolveInspectorPanel } from "../inspectorRegistry";
import {
  DispersionRelationResultInspector,
  ResonanceDrivenSpectrumResultInspector,
  ResonanceModalCouplingResultInspector,
  ResonanceModalSpectrumResultInspector,
} from "./physics-first/PhysicsFirstResultInspectors";
import {
  buildFrequencyResponsePlotCommandInput,
  buildFrequencyResponsePointResidualSummary,
  countResidualEvidencePoints,
  FrequencyResponsePointResidualFields,
} from "./frequency-domain/FrequencyDomainResultInspectors";

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

  it("keeps typed response residuals distinct and prioritizes the raw point resource", () => {
    const residuals = buildFrequencyResponsePointResidualSummary(
      {
        relative_residual_l2_norm: 2e-8,
        residual_l2_norm: 3e-4,
      },
      {
        residualAbsoluteL2: 8e-4,
        residualNorm: 7e-5,
        residualRelativeL2: 9e-8,
      },
    );
    const html = renderToStaticMarkup(
      <FrequencyResponsePointResidualFields residuals={residuals} />,
    );

    expect(residuals).toEqual({
      absoluteL2: 3e-4,
      relativeL2: 2e-8,
      reported: 7e-5,
    });
    expect(html).toContain("Absolute residual (L2)");
    expect(html).toContain("0.0003000");
    expect(html).toContain("Relative residual (L2)");
    expect(html).toContain("2.000e-8");
    expect(html).toContain("Response residual (type unspecified)");
    expect(html).toContain("0.00007000");
  });

  it("uses typed response summary fallback without calling a legacy norm relative L2", () => {
    const residuals = buildFrequencyResponsePointResidualSummary(null, {
      residualAbsoluteL2: 3e-4,
      residualNorm: 5e-5,
      residualRelativeL2: 2e-8,
    });
    const html = renderToStaticMarkup(
      <FrequencyResponsePointResidualFields residuals={residuals} />,
    );

    expect(residuals).toEqual({
      absoluteL2: 3e-4,
      relativeL2: 2e-8,
      reported: 5e-5,
    });
    expect(html).toContain("Relative residual (L2)");
    expect(html).toContain("2.000e-8");
    expect(html).toContain("Response residual (type unspecified)");
    expect(html).toContain("5.000e-5");
  });

  it("keeps a legacy response residual outside the relative L2 field", () => {
    const residuals = buildFrequencyResponsePointResidualSummary(null, {
      residualNorm: 5e-5,
    });
    const html = renderToStaticMarkup(
      <FrequencyResponsePointResidualFields residuals={residuals} />,
    );

    expect(residuals.relativeL2).toBeNull();
    expect(html).toContain("Relative residual (L2)");
    expect(html).toContain("not available");
    expect(html).toContain("Response residual (type unspecified)");
    expect(html).toContain("0.00005000");
  });

  it("keeps the legacy relative residual alias under the unspecified-norm label", () => {
    const residuals = buildFrequencyResponsePointResidualSummary({
      relative_residual_norm: 5e-5,
    }, null);
    const html = renderToStaticMarkup(
      <FrequencyResponsePointResidualFields residuals={residuals} />,
    );

    expect(residuals.relativeL2).toBeNull();
    expect(residuals.reported).toBe(5e-5);
    expect(html).toContain("Relative residual (L2)");
    expect(html).toContain("not available");
    expect(html).toContain("Response residual (type unspecified)");
    expect(html).toContain("0.00005000");
  });

  it("rejects invalid raw canonical response L2 values without inventing a fallback", () => {
    expect(buildFrequencyResponsePointResidualSummary({
      relative_residual_l2_norm: -1,
      residual_l2_norm: Number.NaN,
    }, null)).toEqual({
      absoluteL2: null,
      relativeL2: null,
      reported: null,
    });
  });

  it("counts each point once for valid typed L2 or legacy residual evidence", () => {
    expect(countResidualEvidencePoints([
      {
        residualAbsoluteL2: 3e-4,
        residualNorm: null,
        residualRelativeL2: 2e-8,
      },
      { residualNorm: 7e-5, residualRelativeL2: 2e-8 },
      { residualNorm: null, residualRelativeL2: 0 },
      { residualNorm: null, residualRelativeL2: -1 },
      { residualNorm: null, residualRelativeL2: Number.NaN },
      { residualNorm: null },
    ])).toBe(3);
  });
});
