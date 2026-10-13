import { expect, it } from "vitest";
import { activeLaneCapabilityFixture } from "@/kernel/resources/activeLaneCapabilityFixture.testSupport";
import { meshBuildDialogRuntimeStatusEquals, type MeshBuildDialogRuntimeStatus } from "./MeshBuildDialogRuntimeStatus";

it("invalidates mesh dialog authoring identity on absent to explicit null", () => {
  const lane = activeLaneCapabilityFixture();
  const { authored: _authored, ...legacyLane } = lane;
  void _authored;
  const legacy = {
    capabilities: { explicit_topology: true, active_lane: legacyLane },
    domain: { discretization: "fem" }, resources: { mesh_revision: 0, mesh_build_revision: 0 },
  } as unknown as MeshBuildDialogRuntimeStatus;
  const missing = {
    ...legacy, capabilities: { ...legacy.capabilities, active_lane: { ...legacyLane, authored: null } },
  } as unknown as MeshBuildDialogRuntimeStatus;
  expect(meshBuildDialogRuntimeStatusEquals(legacy, missing)).toBe(false);
});
