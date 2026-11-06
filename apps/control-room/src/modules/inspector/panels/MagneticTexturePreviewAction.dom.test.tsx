import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { MagnetizationApplyReceipt } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";
import { observationSourceWorkspaceStore } from "@/kernel/workspace/observationSourceWorkspace";

import { MagneticTextureActionsSection } from "./ObjectMagneticTexturePanel";
import type { MagneticTexturePanelModel } from "./ObjectMagneticTexturePanelViewModel";

const SCOPE = "session=A&epoch=1&request_scope_epoch=1";
const RECEIPT: MagnetizationApplyReceipt = {
  operation_id: "apply-a", scene_revision: 5, scopes: [{ object_id: "magnet" }],
  status: "initial_state_ready",
  prepared_initial_state: {
    scene_revision: 5, initial_state_revision: 2, publication_id: "publication-a",
    observation_frame_id: "frame-a", domain_generation_id: "mesh-a",
    values_sha256: "a".repeat(64),
  },
};

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => ({ sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" }),
}));

describe("Magnetic texture preview intent", () => {
  it("keeps a saved result opened during the preview check and lets an explicit retry switch views", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const selection = { nodeId: "magnet", ref: null };
    let playback: { runId: string } | null = null;
    let completeProbe!: () => void;
    const preparedMagnetization = vi.fn(() => new Promise<void>((resolve) => { completeProbe = resolve; }));
    const close = vi.fn(() => { playback = null; });
    const noop = () => undefined;
    const kernel = {
      api: { data: { fields: { preparedMagnetization } } },
      commands: { getSessionScopeKey: () => SCOPE },
      selection: { get: () => selection },
      savedResultsPlayback: { getSnapshot: () => playback, close },
      visualization: { clearSavedFieldPresentation: noop, setArtifactFieldSelection: noop },
      analysisFieldOverlay: { clear: noop },
      layout: { setActiveViewportMainModule: noop },
    } as unknown as KernelApi;
    const show = async () => {
      const button = Array.from(container.querySelectorAll("button"))
        .find((element) => element.textContent === "Show initial magnetization");
      if (!button) throw new Error("Missing initial magnetization action");
      await act(async () => button.click());
    };
    observationSourceWorkspaceStore.reset();

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel}>
          <MagneticTextureActionsSection
            dirty={false}
            feedback={{ kind: "success", message: "Texture saved.", preview: { receipt: RECEIPT, sessionScopeKey: SCOPE } }}
            model={{ mode: "committed", objectId: "magnet", targetKind: "object" } as MagneticTexturePanelModel}
            onActivateLoad={noop}
            onClear={noop}
            onRevert={noop}
            onSave={noop}
            pending={false}
          />
        </KernelContext.Provider>,
      ));
      await show();
      playback = { runId: "history-b" };
      await act(async () => completeProbe());
      expect(playback).toEqual({ runId: "history-b" });
      expect(close).not.toHaveBeenCalled();
      expect(observationSourceWorkspaceStore.getSnapshot().prepared).toBeNull();

      await show();
      await act(async () => completeProbe());
      expect(close).toHaveBeenCalledOnce();
      expect(observationSourceWorkspaceStore.getSnapshot().prepared?.source).toBe(RECEIPT.prepared_initial_state);
    } finally {
      await act(async () => root.unmount());
      observationSourceWorkspaceStore.reset();
      dom.restore();
    }
  });
});
