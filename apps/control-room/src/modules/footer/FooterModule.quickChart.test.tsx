import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";

import FooterModule from "./FooterModule";
import { setFooterChannelFilter } from "./footerUiStore";

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>(),
  useSessionStatusSelector: () => null,
}));
vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/studyRuntimeResources")>(),
  useStageExecutionResource: () => ({ data: null, status: "idle" }),
}));

vi.mock("@/shared/analysis-charts/QuickChartResourceView", () => ({
  QuickChartResourceView: () => <div>Quick resource mounted</div>,
}));

vi.mock("@/shared/ui/Tabs", () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
}));

describe("Footer Quick Chart lifecycle", () => {
  it("keeps Quick Chart conditional and preserves the Logs toolbar state", async () => {
    setFooterChannelFilter("transport");
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    layout.setBottomPanelTab("logs");
    const kernel = {
      bus,
      commandDiagnostics: {
        clear: vi.fn(),
        getVersion: () => 0,
        listNewestFirst: () => [],
        subscribe: () => () => undefined,
      },
      diagnostics: {
        clear: vi.fn(),
        getVersion: () => 0,
        listNewestFirst: () => [],
        subscribe: () => () => undefined,
      },
      layout,
    } as unknown as KernelApi;
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <FooterModule
              config={{}}
              kernel={kernel}
              moduleId="transport-footer"
              setConfig={vi.fn()}
              slotId="panel-bottom"
            />
          </KernelContext.Provider>,
        );
      });
      expect(container.textContent).not.toContain("Quick resource mounted");
      expect(container.querySelector(".fm-footer__clear")).not.toBeNull();
      const httpFilter = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ).find((button) => button.textContent?.trim() === "HTTP");
      expect(httpFilter?.getAttribute("aria-pressed")).toBe("false");
      expect(container.textContent).not.toContain("HTTP + WS + Perf");

      await act(async () => httpFilter?.click());
      const selectedHttpFilter = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ).find((button) => button.textContent?.trim() === "HTTP");
      expect(selectedHttpFilter?.getAttribute("aria-pressed")).toBe("true");

      await act(async () => {
        container.querySelector<HTMLButtonElement>(".fm-footer__clear")?.click();
      });
      expect(kernel.commandDiagnostics.clear).toHaveBeenCalledTimes(1);
      expect(kernel.diagnostics.clear).toHaveBeenCalledTimes(1);

      await act(async () => layout.openBottomPanel("quick-chart"));
      expect(container.textContent).toContain("Quick resource mounted");
      expect(container.querySelector(".fm-footer__clear")).toBeNull();
      expect(layout.get().activeViewportMainModuleId).toBe("viewport-3d");

      await act(async () => layout.setBottomPanelTab("logs"));
      expect(container.textContent).not.toContain("Quick resource mounted");
      const restoredHttpFilter = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      ).find((button) => button.textContent?.trim() === "HTTP");
      expect(restoredHttpFilter?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      setFooterChannelFilter("transport");
      dom.restore();
    }
  });
});
