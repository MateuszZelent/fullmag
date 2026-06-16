import { describe, expect, it } from "vitest";

import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import { resolveViewport3DLightingRig } from "./Viewport3DLightingRig";

describe("Viewport3DLightingRig", () => {
  it("keeps the lite profile cheap", () => {
    const rig = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("interactive-lite"),
    );

    expect(rig.directional).toHaveLength(0);
    expect(rig.hemisphere).toBeNull();
    expect(rig.ambient.intensity).toBe(0.6);
  });

  it("keeps interactive rendering free of directional highlights", () => {
    const rig = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("interactive"),
    );

    expect(rig.directional).toHaveLength(0);
    expect(rig.hemisphere).toBeNull();
  });

  it("keeps capture-oriented profiles on the same neutral light topology", () => {
    const interactive = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("interactive"),
    );
    const figure = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("figure"),
    );

    expect(figure.directional).toHaveLength(interactive.directional.length);
    expect(figure.hemisphere).toBe(interactive.hemisphere);
  });
});
