import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { buildEigenResidualSummary } from "@/shared/domain/analysis/eigenResidualSummary";

import {
  buildEigenModeIdentityViewModel,
  EigenModeResidualFields,
} from "./EigenModeInspectorPanel";

describe("EigenModeInspectorPanel model and residual fields", () => {
  it("keeps mode index, branch and field provenance together", () => {
    expect(
      buildEigenModeIdentityViewModel({
        branchId: "acoustic",
        fieldId: "analysis:eigen:sample-0004:mode-0005",
        modeIndex: 5,
        resourceRef: "field://mode-0005",
        sampleIndex: 4,
      }),
    ).toEqual({
      branchId: "acoustic",
      fieldId: "analysis:eigen:sample-0004:mode-0005",
      label: "sample 4, mode 5",
      modeIndex: 5,
      resourceRef: "field://mode-0005",
      sampleIndex: 4,
    });
  });

  it("fails closed when a mode selection is incomplete", () => {
    expect(buildEigenModeIdentityViewModel({ modeIndex: 5 })).toMatchObject({
      label: "not selected",
      modeIndex: 5,
      sampleIndex: null,
    });
  });

  it("renders spectrum canonical relative L2 under the typed inspector label", () => {
    const residual = buildEigenResidualSummary(null, 6e-5, 2e-9);
    const html = renderToStaticMarkup(
      <EigenModeResidualFields residual={residual} />,
    );

    expect(html).toContain("Relative residual (L2)");
    expect(html).toContain("2.000e-9");
    expect(html).toContain("Spectrum residual (type unspecified)");
    expect(html).toContain("0.00006000");
  });

  it("keeps a legacy spectrum residual under its unspecified-norm label", () => {
    const residual = buildEigenResidualSummary(null, 6e-5);
    const html = renderToStaticMarkup(
      <EigenModeResidualFields residual={residual} />,
    );

    expect(html).toContain("Relative residual (L2)");
    expect(html).toContain("not available");
    expect(html).toContain("Spectrum residual (type unspecified)");
    expect(html).toContain("0.00006000");
  });
});
