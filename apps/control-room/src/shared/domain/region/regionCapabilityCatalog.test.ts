import { describe, expect, it } from "vitest";

import {
  regionCapabilityLabel,
  regionRuntimeBlockerPrefix,
} from "./regionCapabilityCatalog";

describe("regionCapabilityCatalog", () => {
  it("provides shared labels for region capability gates", () => {
    expect(regionCapabilityLabel("regions.mesh_policy")).toBe(
      "Mesh policy support",
    );
    expect(regionCapabilityLabel("regions.material_override")).toBe(
      "Regional material realization",
    );
    expect(
      regionCapabilityLabel("regions.conformal_or_projected_boundary"),
    ).toBe("Region realization support");
  });

  it("uses the same label for runtime blocker prefixes", () => {
    expect(regionRuntimeBlockerPrefix("regions.material_override")).toBe(
      "Regional material realization blocker",
    );
    expect(regionRuntimeBlockerPrefix("regions.unknown")).toBe(
      "Region-owned runtime blocker",
    );
  });
});
