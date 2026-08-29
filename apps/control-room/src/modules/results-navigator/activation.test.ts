import { describe, expect, it } from "vitest";

import { resultsNavigatorIsActiveForTab } from "./activation";

describe("Results workspace activation", () => {
  it("activates the Results panel only for the canonical Results ribbon tab", () => {
    expect(resultsNavigatorIsActiveForTab("results")).toBe(true);
    expect(resultsNavigatorIsActiveForTab("home")).toBe(false);
    expect(resultsNavigatorIsActiveForTab("study")).toBe(false);
  });
});
