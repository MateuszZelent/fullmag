import { describe, expect, it } from "vitest";

import { publishInspectorTabs, readInspectorTabs } from "./InspectorTabState";

describe("Inspector tab publishing for the side rail", () => {
  it("keeps the list identity when the same tabs are published again", () => {
    publishInspectorTabs([{ id: "overview", label: "Overview" }]);
    const first = readInspectorTabs();
    publishInspectorTabs([{ id: "overview", label: "Overview" }]);

    expect(readInspectorTabs()).toBe(first);
    expect(first.map((tab) => tab.id)).toEqual(["overview"]);
    publishInspectorTabs([]);
    expect(readInspectorTabs()).toEqual([]);
  });
});
