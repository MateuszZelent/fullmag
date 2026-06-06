import { describe, expect, it } from "vitest";

import { buildSharedDomainPolicyDiffRows } from "./useMeshDetailsModel";

describe("useMeshDetailsModel helpers", () => {
  it("builds current, draft, and realized shared-domain policy diff rows", () => {
    const rows = buildSharedDomainPolicyDiffRows({
      activeBuild: {
        requested_policy: {
          algorithm_3d: 1,
          airbox_hmax: 1e-8,
        },
        realized_policy: {
          algorithm_3d: 2,
          airbox_hmax: 1e-8,
        },
      },
      latestBuild: null,
      semantics: {
        shared_domain_policy: {
          algorithm_3d: 1,
          airbox_hmax: 2e-8,
        },
      },
    });

    expect(rows.map((row) => [row.path, row.currentValue, row.draftValue, row.realizedValue, row.state])).toEqual([
      ["airbox_hmax", "2e-8", "1e-8", "1e-8", "changed"],
      ["algorithm_3d", "1", "1", "2", "realized-drift"],
    ]);
  });
});
