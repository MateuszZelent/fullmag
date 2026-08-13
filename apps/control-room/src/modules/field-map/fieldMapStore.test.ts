import { afterEach, describe, expect, it, vi } from "vitest";

import { fieldMapStore } from "./fieldMapStore";

describe("field-map store", () => {
  afterEach(() => fieldMapStore.reset());

  it("keeps only ephemeral hover state outside the server-owned planar profile", () => {
    const listener = vi.fn();
    const unsubscribe = fieldMapStore.subscribe(listener);

    fieldMapStore.set({ hoverUv: [0.25, 0.75] });
    fieldMapStore.set({ hoverUv: [0.25, 0.75] });

    expect(fieldMapStore.get()).toEqual({ hoverUv: [0.25, 0.75] });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("uses the same deterministic snapshot for server and first client render", () => {
    expect(fieldMapStore.get()).toEqual({ hoverUv: null });
  });
});
