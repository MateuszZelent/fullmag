import { describe, expect, it } from "vitest";

import { openMeshBuildDiagnostics } from "./meshBuildDiagnosticsNavigation";

describe("MeshBuildDialog", () => {
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
