import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KernelApi } from "../types";
import {
  cancelDomainSetupNavigation,
  pendingDomainSetupNavigation,
  requestDomainSetupNavigation,
  useDomainSetupNavigation,
} from "./domainSetupNavigation";
import { installSimulationPreparationTestDom } from "./simulationPreparationTestDom.test-support";

afterEach(() => {
  cancelDomainSetupNavigation();
});

function Probe({ kernel, sessionId, scopeKey }: {
  kernel: KernelApi;
  sessionId: string | null;
  scopeKey: string | null;
}) {
  useDomainSetupNavigation(kernel, sessionId, scopeKey);
  return null;
}

async function mountProbe() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root = createRoot(container as unknown as Element);
  const layout = { setPanelVisible: vi.fn() };
  const selection = { set: vi.fn() };
  const kernel = { layout, selection } as unknown as KernelApi;
  const render = async (sessionId: string | null, scopeKey: string | null) => {
    await act(async () => root.render(<Probe kernel={kernel} sessionId={sessionId} scopeKey={scopeKey} />));
  };
  return {
    layout,
    selection,
    render,
    remount: async () => {
      await act(async () => root.unmount());
      root = createRoot(container as unknown as Element);
    },
    dispose: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

describe("domain setup navigation", () => {
  it("selects the Universe once the requested session is confirmed, across remounts", async () => {
    const probe = await mountProbe();
    try {
      requestDomainSetupNavigation("new-session");

      // The previous session is still current while the shell switches.
      await probe.render("old-session", "session=old-session");
      await probe.remount();
      await probe.render("new-session", null);
      expect(probe.selection.set).not.toHaveBeenCalled();

      await probe.render("new-session", "session=new-session");
      expect(probe.layout.setPanelVisible).toHaveBeenCalledWith("right", true);
      expect(probe.selection.set).toHaveBeenCalledTimes(1);
      expect(probe.selection.set).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "universe.root", nodeId: "model:universe" }),
        "ribbon",
      );
      expect(pendingDomainSetupNavigation()).toBeNull();

      await probe.render("new-session", "session=new-session&epoch=2");
      expect(probe.selection.set).toHaveBeenCalledTimes(1);
    } finally {
      await probe.dispose();
    }
  });

  it("does nothing without a request", async () => {
    const probe = await mountProbe();
    try {
      await probe.render("new-session", "session=new-session");
      expect(probe.selection.set).not.toHaveBeenCalled();
      expect(probe.layout.setPanelVisible).not.toHaveBeenCalled();
    } finally {
      await probe.dispose();
    }
  });
});
