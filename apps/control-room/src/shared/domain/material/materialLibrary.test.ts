import { describe, expect, it } from "vitest";

import {
  MATERIAL_LIBRARY_PRESETS,
  materialNameToId,
  materialPresetIdToSceneMaterialId,
} from "./materialLibrary";

describe("materialLibrary", () => {
  it("ships the canonical magnetic material presets with references", () => {
    expect(MATERIAL_LIBRARY_PRESETS.map((preset) => preset.id)).toEqual([
      "permalloy",
      "cofeb",
      "yig",
      "nickel",
      "iron",
    ]);
    for (const preset of MATERIAL_LIBRARY_PRESETS) {
      expect(preset.name).not.toBe("");
      expect(preset.properties.Ms).toEqual(expect.any(Number));
      expect(preset.properties.Aex).toEqual(expect.any(Number));
      expect(preset.properties.alpha).toEqual(expect.any(Number));
      expect(preset.references[0]?.url).toMatch(/^https:\/\/doi\.org\//);
    }
  });

  it("maps user and preset material names to scene material ids", () => {
    expect(materialPresetIdToSceneMaterialId("permalloy")).toBe("mat:permalloy");
    expect(materialNameToId("Permalloy Ni80Fe20")).toBe("mat:permalloy-ni80fe20");
    expect(materialNameToId("   ")).toBe("mat:material");
  });
});
