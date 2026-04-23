import { describe, expect, it } from "vitest";

import {
  resolveQuantitySwitchCacheState,
  shouldPatchDisplayForQuantitySwitch,
} from "../hooks/useWorkspaceActions";

describe("workspace quantity switch helpers", () => {
  it("classifies cache hit as field-map-hit", () => {
    const cacheState = resolveQuantitySwitchCacheState({
      cachedFieldQuantities: new Set(["m", "H_eff"]),
      nextQuantity: "m",
      previewControlsActive: true,
    });
    expect(cacheState).toBe("field-map-hit");
    expect(
      shouldPatchDisplayForQuantitySwitch({
        cacheState,
        previewControlsActive: true,
      }),
    ).toBe(false);
  });

  it("classifies missing cached quantity as display-patch when preview controls are active", () => {
    const cacheState = resolveQuantitySwitchCacheState({
      cachedFieldQuantities: new Set(["m"]),
      nextQuantity: "H_demag",
      previewControlsActive: true,
    });
    expect(cacheState).toBe("display-patch");
    expect(
      shouldPatchDisplayForQuantitySwitch({
        cacheState,
        previewControlsActive: true,
      }),
    ).toBe(true);
  });

  it("classifies missing quantity as preview-recompute when preview controls are inactive", () => {
    const cacheState = resolveQuantitySwitchCacheState({
      cachedFieldQuantities: new Set(["m"]),
      nextQuantity: "H_demag",
      previewControlsActive: false,
    });
    expect(cacheState).toBe("preview-recompute");
    expect(
      shouldPatchDisplayForQuantitySwitch({
        cacheState,
        previewControlsActive: false,
      }),
    ).toBe(false);
  });
});
