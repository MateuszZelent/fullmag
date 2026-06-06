import { describe, expect, it } from "vitest";

import { diffMeshPolicies } from "./meshPolicyDiff";

describe("mesh policy diff", () => {
  it("normalizes equivalent numeric strings before comparing values", () => {
    const rows = diffMeshPolicies({
      current: { airbox_hmax: "1e-8" },
      draft: { airbox_hmax: "0.00000001" },
      realized: { airbox_hmax: "10e-9" },
      scope: "airbox",
    });

    expect(rows).toEqual([
      {
        currentValue: "1e-8",
        draftValue: "0.00000001",
        impact: "resolution",
        label: "airbox_hmax",
        path: "airbox_hmax",
        realizedValue: "10e-9",
        scope: "airbox",
        state: "unchanged",
      },
    ]);
  });

  it("classifies changed, added, removed, and realized-drift rows", () => {
    const rows = diffMeshPolicies({
      current: {
        algorithm_3d: 1,
        airbox_hmax: 2e-8,
        removed_knob: true,
      },
      draft: {
        added_knob: "Netgen",
        algorithm_3d: 1,
        airbox_hmax: 1e-8,
      },
      impacts: {
        added_knob: "backend",
        airbox_hmax: "resolution",
        removed_knob: "quality",
      },
      realized: {
        algorithm_3d: 2,
        airbox_hmax: 1e-8,
      },
      scope: "airbox",
    });

    expect(rows.map((row) => [row.path, row.state, row.impact])).toEqual([
      ["added_knob", "added", "backend"],
      ["airbox_hmax", "changed", "resolution"],
      ["algorithm_3d", "realized-drift", "backend"],
      ["removed_knob", "removed", "quality"],
    ]);
  });
});
