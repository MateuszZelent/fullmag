import { describe, expect, it, vi } from "vitest";

import { createViewport3DVisibleColorScaleStore } from "./viewport3DVisibleColorScaleStore";

describe("viewport3DVisibleColorScaleStore", () => {
  it("publishes only matching-scope reports and preserves owner-aware removal", () => {
    const store = createViewport3DVisibleColorScaleStore("saved-result:1");
    const listener = vi.fn();
    store.subscribe(listener);
    const scale = {
      colorMode: "scalar",
      colorPalette: "viridis",
      quantityId: "m",
      range: { min: -1, max: 1 },
    };

    store.report({
      scopeKey: "saved-result:1",
      ownerId: "surface:current",
      pass: "surface",
      scale,
    });
    const published = store.getSnapshot();
    expect(published.passes.surface).toEqual({ ownerId: "surface:current", scale });
    expect(listener).toHaveBeenCalledTimes(1);

    store.report({
      scopeKey: "saved-result:2",
      ownerId: "surface:stale",
      pass: "surface",
      scale: null,
      removed: true,
    });
    store.report({
      scopeKey: "saved-result:1",
      ownerId: "surface:stale",
      pass: "surface",
      scale: null,
      removed: true,
    });

    expect(store.getSnapshot()).toBe(published);
    expect(store.getSnapshot().passes.surface).toEqual({ ownerId: "surface:current", scale });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
