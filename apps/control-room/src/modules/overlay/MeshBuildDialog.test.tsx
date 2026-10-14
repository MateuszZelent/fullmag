import { describe, expect, it } from "vitest";

import {
  UNKNOWN_MESH_COMMAND_LANE_REASON,
} from "@/kernel/authoring/geometryLifecycleCommandContributions";
import {
  meshBuildDialogUnavailableMessage,
  resolveMeshBuildDialogLane,
  shouldLoadMeshBuildDialogFemResources,
} from "./MeshBuildDialog";
import {
  meshBuildDialogRuntimeStatusEquals,
  selectMeshBuildDialogRuntimeStatus,
} from "./MeshBuildDialogRuntimeStatus";
import { openMeshBuildDiagnostics } from "./meshBuildDiagnosticsNavigation";

describe("MeshBuildDialog", () => {
  it("re-renders when the resolved lane changes even if mesh revisions are stable", () => {
    const statusForLane = (lane: string) =>
      selectMeshBuildDialogRuntimeStatus({
        data: {
          capabilities: {
            active_lane: {
              resolved: { discretization: lane },
              operations: {
                grid_build: { reason: "shared gate", state: "available" },
              },
            },
            explicit_topology: true,
          },
          domain: { discretization: "fdm" },
          resources: { mesh_build_revision: 4, mesh_revision: 5 },
        } as never,
      });

    expect(
      meshBuildDialogRuntimeStatusEquals(statusForLane("fdm"), statusForLane("fem")),
    ).toBe(false);
  });

  it("requires an explicit FEM lane before loading FEM mesh resources", () => {
    // The caller projects session authoring intent before passing a lane here.
    expect(resolveMeshBuildDialogLane("fem")).toBe("fem");
    expect(resolveMeshBuildDialogLane("fdm")).toBe("fdm");
    expect(resolveMeshBuildDialogLane({ resolved: { discretization: "fem" } })).toBe("unknown");
    expect(resolveMeshBuildDialogLane("auto")).toBe("unknown");
    expect(resolveMeshBuildDialogLane(null)).toBe("unknown");

    expect(shouldLoadMeshBuildDialogFemResources(false, "fem")).toBe(false);
    expect(shouldLoadMeshBuildDialogFemResources(true, "fem")).toBe(true);
    expect(shouldLoadMeshBuildDialogFemResources(true, "fdm")).toBe(false);
    expect(shouldLoadMeshBuildDialogFemResources(true, "unknown")).toBe(false);
  });

  it("keeps FDM grid/mask refresh separate from FEM mesh controls", () => {
    expect(meshBuildDialogUnavailableMessage("fdm")).toBe(
      "FDM grid and membership masks are rebuilt by an atomic execution-plan replan. Use Mesh → Build Grid.",
    );
    expect(meshBuildDialogUnavailableMessage("unknown")).toBe(
      UNKNOWN_MESH_COMMAND_LANE_REASON,
    );
    expect(meshBuildDialogUnavailableMessage("fem")).toBeNull();
  });

  it("opens the shared Operations projection from mesh build context", () => {
    const calls: string[] = [];

    openMeshBuildDiagnostics({
      bus: {
        emit: (event, payload) => {
          calls.push(`${event}:${payload.tab}:${payload.reason}`);
        },
      },
      layout: {
        setFocusedSlot: (slotId) => {
          calls.push(`focus:${slotId}`);
        },
        setPanelVisible: (panel, visible) => {
          calls.push(`panel:${panel}:${visible}`);
        },
      },
    });

    expect(calls).toEqual([
      "panel:bottom:true",
      "focus:panel-bottom",
      "footer:tab-requested:operations:mesh-build",
    ]);
  });
});
