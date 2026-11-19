import { afterEach, describe, expect, it, vi } from "vitest";

import { planarToolStore } from "./planarToolStore";

const RECT = { u_min_m: 0, u_max_m: 1e-9, v_min_m: 0, v_max_m: 2e-9 };

describe("planar tool store", () => {
  afterEach(() => planarToolStore.reset());

  it("starts on the navigate tool on the client and the server", () => {
    expect(planarToolStore.getSnapshot().activeTool).toBe("navigate");
    expect(planarToolStore.getServerSnapshot().activeTool).toBe("navigate");
    expect(planarToolStore.getServerSnapshot()).toEqual({
      activeTool: "navigate",
      cropDraft: null,
      cursorUv: null,
      measure: null,
    });
  });

  it("notifies subscribers once per tool change", () => {
    const listener = vi.fn();
    const unsubscribe = planarToolStore.subscribe(listener);

    planarToolStore.setActiveTool("crop");
    planarToolStore.setActiveTool("crop");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(planarToolStore.getSnapshot().activeTool).toBe("crop");
    unsubscribe();
  });

  it("drops an uncommitted crop rectangle when the tool changes", () => {
    planarToolStore.setActiveTool("crop");
    planarToolStore.setCropDraft(RECT);
    expect(planarToolStore.getSnapshot().cropDraft).toEqual(RECT);

    planarToolStore.setActiveTool("navigate");

    expect(planarToolStore.getSnapshot().cropDraft).toBeNull();
  });

  it("ignores an unchanged cursor position and keeps the server snapshot untouched", () => {
    const listener = vi.fn();
    const unsubscribe = planarToolStore.subscribe(listener);

    planarToolStore.setCursorUv({ u_m: 1, v_m: 2 });
    planarToolStore.setCursorUv({ u_m: 1, v_m: 2 });
    planarToolStore.setMeasure({ u0_m: 0, v0_m: 0, u1_m: 1, v1_m: 1 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(planarToolStore.getServerSnapshot().cursorUv).toBeNull();
    planarToolStore.reset();
    expect(planarToolStore.getSnapshot().cursorUv).toBeNull();
    expect(planarToolStore.getSnapshot().measure).toBeNull();
    unsubscribe();
  });
});
