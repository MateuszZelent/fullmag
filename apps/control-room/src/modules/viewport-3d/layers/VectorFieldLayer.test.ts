import { describe, expect, it } from "vitest";

import { resolveVectorFieldLayerStyle } from "./VectorFieldLayer";

describe("VectorFieldLayer style mapping", () => {
  it("maps canonical vector style into material alpha, monochrome color, and glyph thickness", () => {
    expect(
      resolveVectorFieldLayerStyle({
        colorMode: "monochrome",
        fallbackColor: "#55ccff",
        opacity: 0.5,
        style: {
          alpha: 0.4,
          monoColor: "#ff3366",
          thickness: 2,
        },
      }),
    ).toEqual({
      headRadiusRatio: 0.28,
      materialColor: "#ff3366",
      materialOpacity: 0.2,
      shaftRadiusRatio: 0.09,
    });
  });
});
