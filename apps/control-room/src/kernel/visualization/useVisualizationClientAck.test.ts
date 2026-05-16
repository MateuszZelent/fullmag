import { describe, expect, it } from "vitest";

import { resolveVisualizationEffectiveRenderMode } from "./useVisualizationClientAck";

describe("resolveVisualizationEffectiveRenderMode", () => {
  it("reports surface when the canonical surface layer is visible", () => {
    expect(
      resolveVisualizationEffectiveRenderMode({
        layers: {
          surface: { visible: true },
          wireframe: { visible: false },
        },
      }),
    ).toBe("surface");
  });

  it("reports all visible renderer layers in deterministic order", () => {
    expect(
      resolveVisualizationEffectiveRenderMode({
        layers: {
          points: { visible: true },
          surface: { visible: true },
          vectors: { visible: true },
          wireframe: { visible: true },
        },
      }),
    ).toBe("surface+wireframe+points+vectors");
  });

  it("reports hidden when no renderer layer is visible", () => {
    expect(resolveVisualizationEffectiveRenderMode({ layers: null })).toBe(
      "hidden",
    );
  });
});
