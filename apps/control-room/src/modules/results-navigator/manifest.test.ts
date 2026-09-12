import { describe, expect, it } from "vitest";

import { resultsNavigatorManifest } from "./manifest";

describe("results navigator manifest", () => {
  it("is a panel-left module with a lazy root and declared selection event", () => {
    expect(resultsNavigatorManifest.id).toBe("results-navigator");
    expect(resultsNavigatorManifest.slots).toEqual(["panel-left"]);
    expect(resultsNavigatorManifest.activationTab).toBe("results");
    expect(resultsNavigatorManifest.title).toBe("Results");
    expect(resultsNavigatorManifest.component).toBeTypeOf("function");
    expect(resultsNavigatorManifest.emits).toContain("workspace:selection-changed");
  });
});
