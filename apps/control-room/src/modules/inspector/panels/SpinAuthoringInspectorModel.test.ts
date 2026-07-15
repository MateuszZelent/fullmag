import { describe, expect, it } from "vitest";

import { isUnsupportedSpinAuthoringResource } from "./SpinAuthoringInspectorModel";

describe("spin authoring opaque compatibility records", () => {
  it("keeps future variants inspectable but read-only", () => {
    const future = {
      id: "future",
      kind: "vendor_future_torque",
      nested: { coefficients: [1, 2, 3] },
    };
    expect(isUnsupportedSpinAuthoringResource("spin_torque", future)).toBe(true);
    expect(JSON.parse(JSON.stringify(future))).toEqual(future);
  });

  it("keeps canonical variants writable", () => {
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { kind: "zhang_li" })).toBe(false);
    expect(isUnsupportedSpinAuthoringResource("oersted_field", { kind: "oersted_field" })).toBe(false);
  });
});
