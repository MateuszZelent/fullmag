import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("planar monitor production availability wiring", () => {
  it("derives executable availability from active status and revisioned target/topology catalogs in both panels", () => {
    const hook = readFileSync(new URL("./usePlanarMonitorDefinitionAvailability.ts", import.meta.url), "utf8");
    const draftPanel = readFileSync(new URL("./PlanarMonitorDraftInspectorPanel.tsx", import.meta.url), "utf8");
    const committedPanel = readFileSync(new URL("./PlanarMonitorInspectorPanel.tsx", import.meta.url), "utf8");

    expect(hook).toContain("useSessionStatusSelector");
    expect(hook).toContain("useSceneResource");
    expect(hook).toContain("useModelRegionsResource");
    expect(hook).toContain("useFdmRegionMembershipResource");
    expect(hook).toContain("useMeshSharedDomainManifestResource");
    expect(hook).toContain("resolvePlanarMonitorDefinitionAvailability");
    expect(draftPanel).toContain("usePlanarMonitorDefinitionAvailability()");
    expect(committedPanel).toContain("usePlanarMonitorDefinitionAvailability()");
    expect(draftPanel).not.toContain("definitionAvailability = {}");
    expect(committedPanel).not.toContain("definitionAvailability = {}");
  });
});
