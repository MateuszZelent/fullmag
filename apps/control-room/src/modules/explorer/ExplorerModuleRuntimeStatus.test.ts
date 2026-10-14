import { describe, expect, it } from "vitest";

import { explorerModelRuntimeStatusEquals, resolveExplorerModelDiscretization } from "./ExplorerModule";

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


it("invalidates Explorer authoring method when legacy identity becomes explicitly missing", () => {
  const legacy = { capabilities: { explicit_topology: true, active_lane: { resolved: { discretization: "fem" } } }, domain: { discretization: "fem" }, resources: { mesh_revision: 0, mesh_build_revision: 0, stages_revision: 0 } };
  const missing = { ...legacy, capabilities: { ...legacy.capabilities, active_lane: { ...legacy.capabilities.active_lane, authored: null } } };
  expect(explorerModelRuntimeStatusEquals(legacy, missing)).toBe(false);
});
