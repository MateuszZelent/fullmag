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

  it("uses a key/fill/rim studio rig for interactive rendering", () => {
    const rig = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("interactive"),
    );

    expect(rig.directional).toHaveLength(3);
    expect(rig.hemisphere).not.toBeNull();
    expect(rig.directional[0]?.intensity).toBeGreaterThan(
      rig.directional[1]?.intensity ?? 0,
    );
  });

  it("boosts the figure rig without changing the light topology", () => {
    const interactive = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("interactive"),
    );
    const figure = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("figure"),
    );

    expect(figure.directional).toHaveLength(interactive.directional.length);
    expect(figure.directional[0]?.intensity).toBeGreaterThan(
      interactive.directional[0]?.intensity ?? 0,
    );
  });
});

