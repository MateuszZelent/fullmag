import { describe, expect, it } from "vitest";

import {
  resolveViewport3DTopologyIndexStatus,
  viewport3DTopologyIndexStateIsCompatible,
} from "./useViewport3DTopologyIndexBundle";

describe("useViewport3DTopologyIndexBundle", () => {
  it("marks topology indices as building before the worker effect resolves", () => {
    expect(
      resolveViewport3DTopologyIndexStatus({
        enabled: true,
        hasCompatibleBundle: false,
        hasCompatibleUnavailableState: false,
        hasTopology: true,
        pendingForCurrentRequest: false,
      }),
    ).toBe("building");
  });

  it("matches a built bundle only to the exact topology and part identities", () => {
    const topology = {};
    const magneticParts = {};
    const airboxParts = {};
    const magneticSurfacePartsByPartId = {};

    expect(
      viewport3DTopologyIndexStateIsCompatible(
        {
          airboxParts,
          magneticParts,
          magneticSurfacePartsByPartId,
          topology,
        },
        {
          airboxParts,
          magneticParts,
          magneticSurfacePartsByPartId,
          topology,
        },
      ),
    ).toBe(true);
    expect(
      viewport3DTopologyIndexStateIsCompatible(
        {
          airboxParts,
          magneticParts,
          magneticSurfacePartsByPartId,
          topology,
        },
        {
          airboxParts,
          magneticParts: {},
          magneticSurfacePartsByPartId,
          topology,
        },
      ),
    ).toBe(false);
  });
});
