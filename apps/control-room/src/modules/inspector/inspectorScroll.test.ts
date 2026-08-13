import { describe, expect, it, vi } from "vitest";

import { resetInspectorScroll } from "./inspectorScroll";

describe("resetInspectorScroll", () => {
  it("returns the inspector viewport to its origin for a new selection", () => {
    const scrollTo = vi.fn();
    const root = {
      querySelector: vi.fn(() => ({ scrollTo })),
    } as unknown as HTMLElement;

    resetInspectorScroll(root);

    expect(root.querySelector).toHaveBeenCalledWith(".fm-scroll-area__viewport");
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", left: 0, top: 0 });
  });
});
