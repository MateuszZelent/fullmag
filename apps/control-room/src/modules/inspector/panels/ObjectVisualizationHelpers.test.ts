import { describe, expect, it } from "vitest";

import { selectObjectVisualizationManifestStatus } from "./ObjectVisualizationHelpers";

describe("selectObjectVisualizationManifestStatus", () => {
  it("fails closed without throwing when a runtime status omits capabilities", () => {
    const status = selectObjectVisualizationManifestStatus({
      data: {
        domain: { discretization: "fdm" },
        resources: {},
      } as never,
    });

    expect(status).toEqual({
      capabilities: { explicit_topology: false },
      domain: { discretization: "fdm" },
      resources: { mesh_revision: undefined },
    });
  });
});
