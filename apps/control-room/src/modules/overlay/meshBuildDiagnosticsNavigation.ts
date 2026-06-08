import type { KernelApi } from "@/kernel/types";

type MeshDiagnosticNavigation = {
  readonly bus: {
    emit: (
      event: "footer:tab-requested",
      payload: { reason?: string; tab: "engine" | "logs" | "mesh" | "telemetry" },
    ) => void;
  };
  readonly layout: Pick<KernelApi["layout"], "setFocusedSlot" | "setPanelVisible">;
};

export function openMeshBuildDiagnostics(kernel: MeshDiagnosticNavigation) {
  kernel.layout.setPanelVisible("bottom", true);
  kernel.layout.setFocusedSlot("panel-bottom");
  kernel.bus.emit("footer:tab-requested", {
    reason: "mesh-build",
    tab: "mesh",
  });
}
