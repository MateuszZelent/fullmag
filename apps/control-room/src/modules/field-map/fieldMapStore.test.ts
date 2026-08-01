import { afterEach, describe, expect, it, vi } from "vitest";

import { fieldMapStore } from "./fieldMapStore";

describe("field-map store", () => {
  afterEach(() => fieldMapStore.reset());

  it("publishes only real external-store changes", () => {
    const listener = vi.fn();
    const unsubscribe = fieldMapStore.subscribe(listener);

    fieldMapStore.set({ activeMonitorId: "plane-1" });
    fieldMapStore.set({ activeMonitorId: "plane-1" });

    expect(fieldMapStore.get().activeMonitorId).toBe("plane-1");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("uses the same deterministic snapshot for server and first client render", () => {
    expect(fieldMapStore.get()).toEqual({
      activeMonitorId: null,
      component: "magnitude",
      quantityId: "m",
    });
  });
});
