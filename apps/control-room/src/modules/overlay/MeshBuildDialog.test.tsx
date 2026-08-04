import { describe, expect, it } from "vitest";

import {
  FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
  UNKNOWN_MESH_COMMAND_LANE_REASON,
} from "@/kernel/authoring/geometryLifecycleCommandContributions";
import {
  meshBuildDialogUnavailableMessage,
  resolveMeshBuildDialogLane,
  shouldLoadMeshBuildDialogFemResources,
} from "./MeshBuildDialog";
import { openMeshBuildDiagnostics } from "./meshBuildDiagnosticsNavigation";

describe("MeshBuildDialog", () => {
  it("requires an explicit FEM lane before loading FEM mesh resources", () => {
    expect(resolveMeshBuildDialogLane("fem")).toBe("fem");
    expect(resolveMeshBuildDialogLane("FDM")).toBe("fdm");
    expect(resolveMeshBuildDialogLane("auto")).toBe("unknown");
    expect(resolveMeshBuildDialogLane(undefined)).toBe("unknown");

    expect(shouldLoadMeshBuildDialogFemResources(false, "fem")).toBe(false);
    expect(shouldLoadMeshBuildDialogFemResources(true, "fem")).toBe(true);
    expect(shouldLoadMeshBuildDialogFemResources(true, "fdm")).toBe(false);
    expect(shouldLoadMeshBuildDialogFemResources(true, "unknown")).toBe(false);
  });

  it("publishes explicit not-applicable messages for FDM and unresolved lanes", () => {
    expect(meshBuildDialogUnavailableMessage("fdm")).toBe(
      FDM_MESH_COMMAND_NOT_APPLICABLE_REASON,
    );
    expect(meshBuildDialogUnavailableMessage("unknown")).toBe(
      UNKNOWN_MESH_COMMAND_LANE_REASON,
    );
    expect(meshBuildDialogUnavailableMessage("fem")).toBeNull();
  });

  it("opens the bottom engine diagnostics tab from mesh build context", () => {
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
      "footer:tab-requested:mesh:mesh-build",
    ]);
  });
});
