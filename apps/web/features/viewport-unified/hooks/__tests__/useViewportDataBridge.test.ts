import { describe, expect, it } from "vitest";

import { resolveEffectiveMeshEntityRenderMode } from "../useViewportDataBridge";

describe("resolveEffectiveMeshEntityRenderMode", () => {
  it("does not coerce non-air mesh part render mode from surface+edges", () => {
    const result = resolveEffectiveMeshEntityRenderMode({ currentRenderMode: "surface+edges" });

    expect(result).toBe("surface+edges");
  });

  it("does not coerce non-air mesh part render mode from surface", () => {
    const result = resolveEffectiveMeshEntityRenderMode({ currentRenderMode: "surface" });

    expect(result).toBe("surface");
  });

  it("preserves airbox render mode for airbox parts", () => {
    expect(resolveEffectiveMeshEntityRenderMode({ currentRenderMode: "surface" })).toBe("surface");
    expect(
      resolveEffectiveMeshEntityRenderMode({ currentRenderMode: "surface+edges" }),
    ).toBe("surface+edges");
  });
});
