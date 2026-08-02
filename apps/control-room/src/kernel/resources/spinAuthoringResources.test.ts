import { describe, expect, it, vi } from "vitest";

import {
  invalidateSpinAuthoringResources,
  transportMutationResourceKeys,
} from "./spinAuthoringResources";

describe("invalidateSpinAuthoringResources", () => {
  it("uses the committed scene revision for every related resource", () => {
    const invalidate = vi.fn();

    invalidateSpinAuthoringResources(
      { invalidate },
      { scene_revision: 42 },
      ["model.spin-transports", "model.spin-interfaces"],
    );

    expect(invalidate.mock.calls).toEqual([
      ["model.spin-transports", 42],
      ["model.spin-interfaces", 42],
    ]);
  });
});

describe("transportMutationResourceKeys", () => {
  it("invalidates the interface projection with its owning spin transports", () => {
    expect(transportMutationResourceKeys("spin_transport")).toEqual([
      "model.spin-transports",
      "model.spin-interfaces",
    ]);
  });

  it("keeps current transport invalidation scoped to the current collection", () => {
    expect(transportMutationResourceKeys("current_transport")).toEqual([
      "model.current-transports",
    ]);
  });
});
