import { describe, expect, it } from "vitest";

import {
  resolveComputeFieldsQuantity,
  resolveQuantitySwitchCacheState,
  shouldPatchDisplayForQuantitySwitch,
  visualizationPatchForViewModeChange,
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

describe("workspace compute fields quantity guard", () => {
  it("redirects native FEM compute fields away from antenna-only preview quantity", () => {
    expect(
      resolveComputeFieldsQuantity({
        femDiscretization: true,
        selectedQuantity: "H_ant",
      }),
    ).toBe("H_eff");
  });

  it("keeps supported native FEM and non-FEM quantities unchanged", () => {
    expect(
      resolveComputeFieldsQuantity({
        femDiscretization: true,
        selectedQuantity: "H_demag",
      }),
    ).toBe("H_demag");
    expect(
      resolveComputeFieldsQuantity({
        femDiscretization: false,
        selectedQuantity: "H_ant",
      }),
    ).toBe("H_ant");
  });
});

describe("workspace view-mode transition patches", () => {
  it("preserves the current 2D component when switching into 2D mode", () => {
    expect(visualizationPatchForViewModeChange("2D")).toEqual({
      view_mode: "2d",
    });
  });

  it("keeps the legacy 3D patch semantics for full-vector mode", () => {
    expect(visualizationPatchForViewModeChange("3D")).toEqual({
      view_mode: "3d",
      field_component: "magnitude",
    });
  });
});
