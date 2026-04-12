import { describe, expect, it } from "vitest";

import { scalarSeriesMeta } from "../scalars";
import { quantityCatalog } from "../catalog";

describe("scalar series metadata", () => {
  it("maps convergence metrics to canonical units", () => {
    const catalog = quantityCatalog();

    expect(scalarSeriesMeta("max_dm_dt", catalog)).toMatchObject({
      label: "max |dm/dt|",
      unit: "1/s",
    });
    expect(scalarSeriesMeta("max_h_eff", catalog)).toMatchObject({
      label: "max |H_eff|",
      unit: "A/m",
    });
  });

  it("uses backend quantity descriptors for energy scalars", () => {
    const catalog = quantityCatalog();

    expect(scalarSeriesMeta("e_total", catalog)).toMatchObject({
      label: "Total Energy",
      unit: "J",
      kind: "quantity",
    });
  });
});
