import { describe, expect, it } from "vitest";

import { MAGNETIZATION_TEXTURE_COMMANDS } from "@/kernel/authoring/magnetization-texture/commands";
import { MAGNETIZATION_TEXTURE_PRESETS } from "./texturePresets";

describe("bimeron magnetization texture contract", () => {
  it("is present in the v2 catalog with metric defaults", () => {
    const preset = MAGNETIZATION_TEXTURE_PRESETS.find((entry) => entry.id === "bimeron");

    expect(preset).toEqual({
      defaultParams: {
        plane: "xy",
        radius: 10e-9,
        wall_width: 2e-9,
        vorticity: 1,
        helicity_rad: 0,
        background_sign: 1,
      },
      id: "bimeron",
      label: "Bimeron",
    });
  });

  it("has a resource-first assignment command", () => {
    const command = MAGNETIZATION_TEXTURE_COMMANDS.find(
      (entry) => entry.id === "magnetization-texture.assign-bimeron",
    );

    expect(command?.title).toBe("Assign Bimeron Magnetization");
  });
});

