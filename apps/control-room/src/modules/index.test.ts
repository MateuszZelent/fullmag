import { describe, expect, it } from "vitest";

import { resolveControlRoomModules } from ".";

describe("control-room module runtime flags", () => {
  it("can temporarily disable the 3D viewport module from browser config", () => {
    const modules = resolveControlRoomModules({ disableViewport3D: true });

    expect(modules.map((module) => module.id)).not.toContain("viewport-3d");
    expect(modules.map((module) => module.id)).not.toContain(
      "cross-section-image",
    );
    expect(modules.map((module) => module.id)).toContain("analysis-plots");
    expect(modules.map((module) => module.id)).toContain("field-map");
  });
});
