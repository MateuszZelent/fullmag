import { describe, expect, it } from "vitest";

import {
  VIEWPORT_3D_PICK_PRIORITY,
  viewport3DPickShouldDefer,
} from "./viewport3DPickPriority";

describe("viewport 3D semantic pick priority", () => {
  it("lets a magnetic or orphan mesh behind the airbox own the pick", () => {
    const magneticGroup = {
      parent: null,
      userData: { viewportSemanticPickPriority: VIEWPORT_3D_PICK_PRIORITY.meshPart },
    };
    const magneticSurface = { parent: magneticGroup, userData: {} };

    expect(
      viewport3DPickShouldDefer(
        [{ object: magneticSurface }],
        VIEWPORT_3D_PICK_PRIORITY.airbox,
      ),
    ).toBe(true);
  });

  it("keeps the airbox pick when no higher-priority semantic carrier intersects", () => {
    expect(
      viewport3DPickShouldDefer(
        [{ object: { parent: null, userData: {} } }],
        VIEWPORT_3D_PICK_PRIORITY.airbox,
      ),
    ).toBe(false);
  });
});
