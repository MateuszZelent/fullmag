import { describe, expect, it } from "vitest";

import { resolveInspectorRoute } from "./inspectorRouteCatalog";
import { FrozenSpinsInspectorPanel } from "./panels/constraint/FrozenSpinsInspectorPanel";

describe("Frozen Spins inspector route", () => {
  it("resolves the semantic Explorer selection to its dedicated inspector", () => {
    const route = resolveInspectorRoute("object.frozen-spins");
    expect(route).toMatchObject({
      id: "object-frozen-spins",
      title: "Frozen Spins",
    });
    expect(route?.component).toBe(FrozenSpinsInspectorPanel);
  });
});
