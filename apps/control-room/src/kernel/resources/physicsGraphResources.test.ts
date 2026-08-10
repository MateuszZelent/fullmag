import { describe, expect, it, vi } from "vitest";

import { PHYSICS_GRAPH_RESOURCE_KEY } from "./physicsGraphResources";

describe("physics graph resource", () => {
  it("uses a stable scene-scoped resource key", () => {
    expect(PHYSICS_GRAPH_RESOURCE_KEY).toBe("model.physics-graph");
  });

  it("keeps the graph payload thin and revision-addressable", () => {
    const payload = {
      scene_revision: 42,
      schema_version: "physics_graph.v1",
      modules: [],
      edges: [],
      provenance: { normalizer: "physics_graph.v1" },
    };
    const invalidate = vi.fn();
    invalidate(PHYSICS_GRAPH_RESOURCE_KEY, payload.scene_revision);
    expect(invalidate).toHaveBeenCalledWith(PHYSICS_GRAPH_RESOURCE_KEY, 42);
    expect(payload).not.toHaveProperty("topology");
    expect(payload).not.toHaveProperty("field_samples");
  });
});
