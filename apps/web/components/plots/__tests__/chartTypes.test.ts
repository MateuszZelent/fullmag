import { describe, expect, it } from "vitest";

import {
  buildScalarSeriesSpecsForScope,
  scopeRefFromSelectedDomain,
} from "../chartTypes";

describe("chartTypes semantic scope helpers", () => {
  it("builds universe scope when no domain is selected", () => {
    const scope = scopeRefFromSelectedDomain(null, [{ id: "objA", label: "Object A" }]);
    expect(scope).toEqual({ kind: "universe", id: null, label: "Universe" });
  });

  it("builds object scope with domain label and scoped series ids", () => {
    const scope = scopeRefFromSelectedDomain("objA", [{ id: "objA", label: "Object A" }]);
    const specs = buildScalarSeriesSpecsForScope({
      seriesKeys: ["e_total", "mx"],
      scope,
      xAxis: "time",
    });

    expect(specs).toHaveLength(2);
    expect(specs[0]?.scope).toEqual({ kind: "object", id: "objA", label: "Object A" });
    expect(specs[0]?.id).toContain("object:objA:e_total:scalar_native");
    expect(specs[1]?.id).toContain("object:objA:mx:scalar_native");
  });
});
