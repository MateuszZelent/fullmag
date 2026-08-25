import { describe, expect, it } from "vitest";

import { resolveExplorerModelDiscretization } from "./ExplorerModule";

describe("resolveExplorerModelDiscretization", () => {
  it("prefers the resolved active lane over the legacy domain field", () => {
    expect(
      resolveExplorerModelDiscretization({
        activeLaneDiscretization: "fem",
        domainDiscretization: "fdm",
      }),
    ).toBe("fem");
  });

  it("falls back to the domain field for legacy status payloads", () => {
    expect(
      resolveExplorerModelDiscretization({
        activeLaneDiscretization: undefined,
        domainDiscretization: "fdm",
      }),
    ).toBe("fdm");
  });

  it("fails closed when an active lane exists but has no resolved discretization", () => {
    expect(
      resolveExplorerModelDiscretization({
        activeLaneDiscretization: null,
        domainDiscretization: "fdm",
      }),
    ).toBeNull();
  });
});
