import { describe, expect, it, vi } from "vitest";

import { legacyMenuItemsToNodes } from "../ribbonMenuAdapter";

describe("legacyMenuItemsToNodes", () => {
  it("maps visible flat menu items to rich item nodes", () => {
    const action = vi.fn();
    const nodes = legacyMenuItemsToNodes([
      { id: "open", label: "Open", description: "Open item", active: true, action },
      { id: "hidden", label: "Hidden", hidden: true },
      { id: "sep", label: "", separator: true },
    ]);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      type: "item",
      id: "open",
      label: "Open",
      description: "Open item",
      state: "active",
      action,
    });
    expect(nodes[1]).toMatchObject({
      type: "separator",
      id: "sep:separator",
    });
  });
});
