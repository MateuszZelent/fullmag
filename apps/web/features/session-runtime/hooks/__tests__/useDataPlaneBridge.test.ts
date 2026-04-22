import { describe, expect, it } from "vitest";

import { decideFieldVectorFetch } from "../useDataPlaneBridge";

describe("decideFieldVectorFetch", () => {
  it("skips 3D vector fetch in 2D mode (slice API path)", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "2d",
      component: "magnitude",
    });
    expect(decision).toEqual({
      shouldFetch: false,
      component: "full",
    });
  });

  it("requests selected scalar component in 3D when possible", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "3d",
      component: "x",
    });
    expect(decision).toEqual({
      shouldFetch: true,
      component: "x",
    });
  });

  it("falls back to full payload for orientation/full-vector rendering", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "3d",
      component: "3D",
    });
    expect(decision).toEqual({
      shouldFetch: true,
      component: "full",
    });
  });
});

