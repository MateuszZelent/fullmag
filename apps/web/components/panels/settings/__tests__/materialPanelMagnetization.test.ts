import { describe, expect, it } from "vitest";

import { buildMagnetizationAssetFingerprint } from "../materialPanelMagnetization";
import type { MagnetizationAsset } from "@/lib/session/types";

function vortexAsset(presetParams: Record<string, unknown>): MagnetizationAsset {
  return {
    id: "mag:free",
    name: "free magnetization",
    kind: "preset_texture",
    value: null,
    seed: null,
    source_path: null,
    source_format: null,
    dataset: null,
    sample_index: null,
    mapping: {
      space: "object",
      projection: "object_local",
      clamp_mode: "none",
    },
    texture_transform: {
      translation: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
    },
    preset_kind: "vortex",
    preset_params: presetParams,
    preset_version: 1,
    ui_label: "vortex",
  };
}

describe("buildMagnetizationAssetFingerprint", () => {
  it("compares the selected object's effective texture instead of transient asset ids", () => {
    const baseline = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: vortexAsset({ circulation: 1, core_polarity: 1, plane: "xy" }),
    });
    const aliased = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: {
        ...vortexAsset({ circulation: 1, core_polarity: 1, plane: "xy" }),
        id: "mag-free",
      },
    });

    expect(aliased).toBe(baseline);
  });

  it("canonicalizes backend and frontend key order before comparing", () => {
    const baseline = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: vortexAsset({ circulation: 1, core_polarity: 1, plane: "xy" }),
    });
    const reordered = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: {
        ...vortexAsset({ circulation: 1, core_polarity: 1, plane: "xy" }),
        mapping: {
          clamp_mode: "none",
          projection: "object_local",
          space: "object",
        },
        texture_transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      },
    });

    expect(reordered).toBe(baseline);
  });

  it("treats omitted preset defaults and explicit defaults as the same asset", () => {
    const implicitDefault = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: vortexAsset({ circulation: 1, core_polarity: 1, plane: "xy" }),
    });
    const explicitDefault = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: vortexAsset({
        circulation: 1,
        core_polarity: 1,
        core_radius: 1e-9,
        plane: "xy",
      }),
    });

    expect(implicitDefault).toBe(explicitDefault);
  });

  it("keeps real preset parameter edits dirty", () => {
    const baseline = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: vortexAsset({ circulation: 1, core_polarity: 1, plane: "xy" }),
    });
    const edited = buildMagnetizationAssetFingerprint({
      objectId: "free",
      asset: vortexAsset({
        circulation: 1,
        core_polarity: 1,
        core_radius: 2e-9,
        plane: "xy",
      }),
    });

    expect(edited).not.toBe(baseline);
  });
});
