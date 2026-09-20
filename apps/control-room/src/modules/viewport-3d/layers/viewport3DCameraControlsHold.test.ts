import { describe, expect, it } from "vitest";

import { holdViewport3DCameraControls } from "./viewport3DCameraControlsHold";

describe("camera controls suspension", () => {
  it.each([true, false])("restores nested HUD and ring holds in either order (%s)", (outerFirst) => {
    const controls = { enabled: true };
    const outer = holdViewport3DCameraControls(controls);
    const ring = holdViewport3DCameraControls(controls);
    const [first, last] = outerFirst ? [outer, ring] : [ring, outer];

    first();
    expect(controls.enabled).toBe(false);
    last();
    expect(controls.enabled).toBe(true);
    last();
    expect(controls.enabled).toBe(true);
  });

  it("does not enable controls which were already disabled", () => {
    const controls = { enabled: false };
    const release = holdViewport3DCameraControls(controls);
    release();
    expect(controls.enabled).toBe(false);
  });

  it("restores only the control instance it suspended", () => {
    const previous = { enabled: true };
    const replacement = { enabled: false };
    const release = holdViewport3DCameraControls(previous);
    release();
    expect(previous.enabled).toBe(true);
    expect(replacement.enabled).toBe(false);
  });
});
