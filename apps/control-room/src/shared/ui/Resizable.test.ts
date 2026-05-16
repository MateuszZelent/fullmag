import { describe, expect, it } from "vitest";

import { normalizeStoredPanelLayout } from "./Resizable";

describe("ResizablePanelGroup storage", () => {
  it("rejects a stored one-panel layout map for a two-panel group", () => {
    expect(normalizeStoredPanelLayout({ left: 100 }, 2)).toBeUndefined();
  });

  it("accepts a stored layout only when panel count and total size match", () => {
    expect(
      normalizeStoredPanelLayout({ left: 24, main: 52, right: 24 }, 3),
    ).toEqual({ left: 24, main: 52, right: 24 });
    expect(normalizeStoredPanelLayout({ left: 30, right: 30 }, 2))
      .toBeUndefined();
  });
});
