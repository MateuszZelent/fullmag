import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import {
  InspectorEditSessionProvider,
  useInspectorEditSession,
  useRegisterInspectorEditSession,
  type InspectorEditSession,
} from "./InspectorEditSession";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

function SessionHarness({
  apply,
  historyMode,
  capture,
}: {
  apply: () => Promise<boolean>;
  historyMode: "bridge" | "mutation-owned";
  capture: (session: InspectorEditSession | null) => void;
}) {
  useRegisterInspectorEditSession(
    "staged",
    false,
    true,
    true,
    undefined,
    apply,
    () => undefined,
    { historyMode },
  );
  capture(useInspectorEditSession());
  return null;
}

describe("InspectorEditSession history ownership", () => {
  it("does not bracket mutation-owned callbacks or duplicate their history", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const sceneRead = vi.fn();
    const record = vi.fn();
    let sessionScopeKey: string | null = "session=A&epoch=4";
    let generation = 7;
    let registered: InspectorEditSession | null = null;
    const kernel = {
      api: { model: { scene: sceneRead } },
      authoringHistory: { getGeneration: () => generation, record },
      commands: { getSessionScopeKey: () => sessionScopeKey },
    } as unknown as KernelApi;
    const apply = vi.fn(async () => {
      record({} as never);
      return true;
    });

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <InspectorEditSessionProvider>
              <SessionHarness
                apply={apply}
                capture={(session) => { registered = session; }}
                historyMode="mutation-owned"
              />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      let applied = false;
      await act(async () => { applied = await registered!.apply(); });

      expect(applied).toBe(true);
      expect(apply).toHaveBeenCalledOnce();
      expect(sceneRead).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledOnce();
      expect(sessionScopeKey).toBe("session=A&epoch=4");
      expect(generation).toBe(7);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("rejects a mutation-owned result after session or history generation changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const sceneRead = vi.fn();
    const record = vi.fn();
    let sessionScopeKey: string | null = "session=A&epoch=4";
    let generation = 7;
    let registered: InspectorEditSession | null = null;
    const kernel = {
      api: { model: { scene: sceneRead } },
      authoringHistory: { getGeneration: () => generation, record },
      commands: { getSessionScopeKey: () => sessionScopeKey },
    } as unknown as KernelApi;
    const apply = vi.fn(async () => {
      sessionScopeKey = "session=B&epoch=5";
      generation += 1;
      record({} as never);
      return true;
    });

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <InspectorEditSessionProvider>
              <SessionHarness
                apply={apply}
                capture={(session) => { registered = session; }}
                historyMode="mutation-owned"
              />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      let applied = true;
      await act(async () => { applied = await registered!.apply(); });

      expect(applied).toBe(false);
      expect(apply).toHaveBeenCalledOnce();
      expect(sceneRead).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
