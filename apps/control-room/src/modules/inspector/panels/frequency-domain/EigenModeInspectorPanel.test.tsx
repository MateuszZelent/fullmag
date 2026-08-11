import { describe, expect, it } from "vitest";

import { buildEigenModeIdentityViewModel } from "./EigenModeInspectorPanel";

describe("EigenModeInspectorPanel identity model", () => {
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
});
