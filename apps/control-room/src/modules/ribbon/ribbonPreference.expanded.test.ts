import { describe, expect, it } from "vitest";

import { getRibbonExpanded, setRibbonExpanded, subscribeRibbonExpanded, toggleRibbonExpanded } from "./ribbonPreference";

describe("ribbon collapse preference", () => {
  it("starts expanded, toggles, and notifies subscribers", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeRibbonExpanded(() => seen.push(getRibbonExpanded()));
    setRibbonExpanded(true);
    expect(toggleRibbonExpanded()).toBe(false);
    expect(getRibbonExpanded()).toBe(false);
    setRibbonExpanded(false);
    expect(toggleRibbonExpanded()).toBe(true);
    unsubscribe();
    expect(seen).toEqual([false, true]);
  });
});
