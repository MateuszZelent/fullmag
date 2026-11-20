import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
} from "../viewport3dAppearancePreferences";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import { resolveViewport3DLightingRig } from "./Viewport3DLightingRig.model";

describe("Viewport3DLightingRig", () => {
  it("keeps flat lighting free of directional lights", () => {
    const rig = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("interactive-lite"),
      {
        ...DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
        lightingMode: "flat",
      },
    );

    expect(rig.directional).toHaveLength(0);
    expect(rig.hemisphere).toBeNull();
    expect(rig.ambient.intensity).toBe(0.6);
  });

  it("adds a neutral key and fill light for studio mode", () => {
    const rig = resolveViewport3DLightingRig(getViewport3DVisualProfile("interactive"));

    expect(rig.directional).toHaveLength(2);
    expect(rig.directional.map((light) => light.key)).toEqual(["key", "fill"]);
    expect(rig.directional.every((light) => light.color === 0xffffff)).toBe(true);
    expect(rig.directional[0].intensity).toBeCloseTo(0.82);
    expect(rig.directional[1].intensity).toBeCloseTo(0.28);
    expect(rig.hemisphere).toBeNull();
  });

  it("keeps lighting topology and intensity independent from quality profiles", () => {
    const interactive = resolveViewport3DLightingRig(
      getViewport3DVisualProfile("interactive"),
    );
    const figure = resolveViewport3DLightingRig(getViewport3DVisualProfile("figure"));
    const capture = resolveViewport3DLightingRig(getViewport3DVisualProfile("capture"));

    expect(figure.directional).toHaveLength(interactive.directional.length);
    expect(capture.directional).toEqual(interactive.directional);
    expect(figure.hemisphere).toBe(interactive.hemisphere);
    expect(figure.ambient.intensity).toBe(interactive.ambient.intensity);
  });
});
