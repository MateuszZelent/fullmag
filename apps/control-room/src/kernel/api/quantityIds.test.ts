import { describe, expect, it } from "vitest";

import {
  sameQuantityId,
  sameRenderableFieldQuantityId,
} from "./quantityIds";

describe("quantity identity", () => {
  it("keeps ordinary canonical quantity equality unchanged", () => {
    expect(sameQuantityId("h_eff", "H_eff")).toBe(true);
    expect(sameQuantityId("H_demag", "H_eff")).toBe(false);
  });

  it("treats analysis field payloads as renderable magnetization fields", () => {
    expect(
      sameRenderableFieldQuantityId(
        "analysis:eigen:sample-0000:mode-0000",
        "m",
      ),
    ).toBe(true);
    expect(
      sameRenderableFieldQuantityId(
        "analysis:frequency-response:field-0001",
        "m",
      ),
    ).toBe(true);
    expect(sameRenderableFieldQuantityId("H_eff", "m")).toBe(false);
    expect(sameRenderableFieldQuantityId(null, "m")).toBe(true);
  });
});
