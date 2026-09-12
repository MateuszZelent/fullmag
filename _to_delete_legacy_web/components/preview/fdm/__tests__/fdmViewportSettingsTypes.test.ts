import { describe, expect, it } from "vitest";

import {
  settingsFromPreset,
  settingsToPreset,
  type FdmViewportSettings,
} from "../fdmViewportSettingsTypes";

describe("fdmViewportSettingsTypes", () => {
  it("maps preset wire format to internal settings shape", () => {
    const mapped = settingsFromPreset({
      quality: "ultra",
      render_mode: "voxel",
      voxel_color_mode: "y",
      sampling: 4,
      brightness: 2.1,
      voxel_opacity: 0.62,
      voxel_gap: 0.1,
      voxel_threshold: 0.18,
      topo_enabled: true,
      topo_component: "x",
      topo_multiplier: 8,
    });

    expect(mapped.renderMode).toBe("voxel");
    expect(mapped.voxelColorMode).toBe("y");
    expect(mapped.topoEnabled).toBe(true);
    expect(mapped.topoComponent).toBe("x");
    expect(mapped.topoMultiplier).toBe(8);
  });

  it("maps internal settings shape back to preset wire format", () => {
    const settings: FdmViewportSettings = {
      quality: "high",
      renderMode: "glyph",
      voxelColorMode: "orientation",
      sampling: 1,
      brightness: 1.5,
      voxelOpacity: 0.5,
      voxelGap: 0.14,
      voxelThreshold: 0.08,
      topoEnabled: false,
      topoComponent: "z",
      topoMultiplier: 5,
    };
    const mapped = settingsToPreset(settings);

    expect(mapped.render_mode).toBe("glyph");
    expect(mapped.voxel_color_mode).toBe("orientation");
    expect(mapped.topo_enabled).toBe(false);
    expect(mapped.topo_component).toBe("z");
    expect(mapped.topo_multiplier).toBe(5);
  });
});
