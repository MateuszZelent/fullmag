import { describe, expect, it } from "vitest";

import {
  createViewport3DTopologyIndexBuildReference,
  resolveViewport3DTopologyIndexStatus,
  viewport3DTopologyIndexStateIsCompatible,
} from "./useViewport3DTopologyIndexBundle";

describe("useViewport3DTopologyIndexBundle", () => {
  it("creates semantic topology-index build references without field revisions", () => {
    const reference = createViewport3DTopologyIndexBuildReference({
      domainId: "shared-domain",
      sessionId: "current",
      targetVisualizationRevision: "targets-4",
      topologyRevision: "mesh-7",
    });

    expect(reference).not.toBeNull();
    expect(reference!).toEqual({
      buildKey:
        'topology-index:{"algorithmVersion":1,"domainId":"shared-domain","lane":"topology-index","sessionId":"current","targetVisualizationRevision":"targets-4","topologyRevision":"mesh-7"}',
      groupKey: "topology-index:session=current:domain=shared-domain",
      revisionSummary: "topology=mesh-7 targets=targets-4",
    });
    expect(reference!.buildKey).not.toContain("fieldRevision");
  });

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
