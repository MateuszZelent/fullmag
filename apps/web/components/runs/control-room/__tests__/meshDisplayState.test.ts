import { describe, expect, it } from "vitest";

import {
  bestPresetFromPasses,
  legacyRenderModeFromPasses,
  legacyStateFromMeshPasses,
  mergePasses,
  meshPassesFromLegacyState,
  passesAreEmpty,
  passesFromPreset,
  type MeshPasses,
} from "../meshDisplayState";

describe("passesFromPreset", () => {
  it("surface → surface=true, rest false", () => {
    expect(passesFromPreset("surface")).toEqual({
      surface: true,
      surfaceEdges: false,
      volumeEdges: false,
      points: false,
    });
  });

  it("wireframe → surfaceEdges=true, rest false", () => {
    expect(passesFromPreset("wireframe")).toEqual({
      surface: false,
      surfaceEdges: true,
      volumeEdges: false,
      points: false,
    });
  });

  it("surface+edges → surface + surfaceEdges, no volume/points", () => {
    expect(passesFromPreset("surface+edges")).toEqual({
      surface: true,
      surfaceEdges: true,
      volumeEdges: false,
      points: false,
    });
  });

  it("points → points=true, rest false", () => {
    expect(passesFromPreset("points")).toEqual({
      surface: false,
      surfaceEdges: false,
      volumeEdges: false,
      points: true,
    });
  });

  it("mesh → volumeEdges=true, rest false", () => {
    expect(passesFromPreset("mesh")).toEqual({
      surface: false,
      surfaceEdges: false,
      volumeEdges: true,
      points: false,
    });
  });
});

describe("bestPresetFromPasses", () => {
  it("round-trips all named presets", () => {
    const presets = ["surface", "wireframe", "surface+edges", "points", "mesh"] as const;
    for (const preset of presets) {
      expect(bestPresetFromPasses(passesFromPreset(preset))).toBe(preset);
    }
  });

  it("returns 'custom' for surface + points", () => {
    expect(bestPresetFromPasses({ surface: true, surfaceEdges: false, volumeEdges: false, points: true })).toBe("custom");
  });

  it("returns 'custom' for wireframe + points", () => {
    expect(bestPresetFromPasses({ surface: false, surfaceEdges: true, volumeEdges: false, points: true })).toBe("custom");
  });

  it("returns 'custom' for surface + wireframe + points", () => {
    expect(bestPresetFromPasses({ surface: true, surfaceEdges: true, volumeEdges: false, points: true })).toBe("custom");
  });

  it("returns 'custom' for all-false (no active pass)", () => {
    expect(bestPresetFromPasses({ surface: false, surfaceEdges: false, volumeEdges: false, points: false })).toBe("custom");
  });
});

describe("legacyRenderModeFromPasses", () => {
  it("returns exact preset name when passes match a preset", () => {
    expect(legacyRenderModeFromPasses(passesFromPreset("surface"))).toBe("surface");
    expect(legacyRenderModeFromPasses(passesFromPreset("wireframe"))).toBe("wireframe");
    expect(legacyRenderModeFromPasses(passesFromPreset("surface+edges"))).toBe("surface+edges");
    expect(legacyRenderModeFromPasses(passesFromPreset("points"))).toBe("points");
  });

  it("surface + points → 'surface' (drops points for legacy compat)", () => {
    expect(legacyRenderModeFromPasses({ surface: true, surfaceEdges: false, volumeEdges: false, points: true })).toBe("surface");
  });

  it("wireframe + points → 'wireframe'", () => {
    expect(legacyRenderModeFromPasses({ surface: false, surfaceEdges: true, volumeEdges: false, points: true })).toBe("wireframe");
  });

  it("surface + wireframe + points → 'surface+edges'", () => {
    expect(legacyRenderModeFromPasses({ surface: true, surfaceEdges: true, volumeEdges: false, points: true })).toBe("surface+edges");
  });

  it("volumeEdges → 'mesh'", () => {
    expect(legacyRenderModeFromPasses({ surface: false, surfaceEdges: false, volumeEdges: true, points: false })).toBe("mesh");
  });
});

describe("bridge functions", () => {
  const cases: MeshPasses[] = [
    { surface: true, surfaceEdges: false, volumeEdges: false, points: false },
    { surface: false, surfaceEdges: true, volumeEdges: false, points: false },
    { surface: true, surfaceEdges: true, volumeEdges: false, points: false },
    { surface: false, surfaceEdges: false, volumeEdges: true, points: false },
    { surface: false, surfaceEdges: false, volumeEdges: false, points: true },
    { surface: true, surfaceEdges: false, volumeEdges: false, points: true },
    { surface: true, surfaceEdges: true, volumeEdges: false, points: true },
  ];

  it("meshPassesFromLegacyState ∘ legacyStateFromMeshPasses = identity", () => {
    for (const passes of cases) {
      expect(meshPassesFromLegacyState(legacyStateFromMeshPasses(passes))).toEqual(passes);
    }
  });

  it("legacyStateFromMeshPasses maps surfaceEdges → wireframe", () => {
    const legacy = legacyStateFromMeshPasses({ surface: true, surfaceEdges: true, volumeEdges: false, points: false });
    expect(legacy.wireframe).toBe(true);
    expect(legacy.surface).toBe(true);
  });

  it("legacyStateFromMeshPasses maps volumeEdges → volumeMesh", () => {
    const legacy = legacyStateFromMeshPasses({ surface: false, surfaceEdges: false, volumeEdges: true, points: false });
    expect(legacy.volumeMesh).toBe(true);
  });
});

describe("passesAreEmpty", () => {
  it("returns true for all-false passes", () => {
    expect(passesAreEmpty({ surface: false, surfaceEdges: false, volumeEdges: false, points: false })).toBe(true);
  });

  it("returns false if any pass is active", () => {
    expect(passesAreEmpty({ surface: true, surfaceEdges: false, volumeEdges: false, points: false })).toBe(false);
    expect(passesAreEmpty({ surface: false, surfaceEdges: false, volumeEdges: false, points: true })).toBe(false);
  });
});

describe("mergePasses", () => {
  it("applies partial patch without touching untouched passes", () => {
    const base: MeshPasses = { surface: true, surfaceEdges: true, volumeEdges: false, points: false };
    const result = mergePasses(base, { points: true });
    expect(result).toEqual({ surface: true, surfaceEdges: true, volumeEdges: false, points: true });
  });

  it("returns new object, does not mutate base", () => {
    const base: MeshPasses = { surface: true, surfaceEdges: false, volumeEdges: false, points: false };
    const result = mergePasses(base, { surface: false });
    expect(base.surface).toBe(true);
    expect(result.surface).toBe(false);
  });
});
