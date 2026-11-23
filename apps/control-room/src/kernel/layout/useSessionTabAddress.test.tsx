import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
} from "./simulationPreparationTestDom.test-support";
import { notifyTabRouteAddressChanged } from "./tabRouteAddressStore";
import { useSessionTabAddress } from "./useSessionTabAddress";

function SessionAddressIndicator() {
  const address = useSessionTabAddress();
  return (
    <div data-session-tab-address={
      address === null ? "unknown" : address ? "session" : "other"
    } />
  );
}

describe("useSessionTabAddress", () => {
  it("updates after the tab synchronizer changes history without popstate", async () => {
    const dom = installSimulationPreparationTestDom();
    Object.defineProperty(window.location, "pathname", {
      configurable: true,
      value: "/home",
      writable: true,
    });
    Object.defineProperty(window.location, "search", {
      configurable: true,
      value: "",
      writable: true,
    });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(<SessionAddressIndicator />));
      expect(
        findElement(
          container,
          (element) => element.getAttribute("data-session-tab-address") === "other",
          "Home tab address",
        ),
      ).toBeTruthy();

      await act(async () => {
        window.location.pathname = "/session/example";
        notifyTabRouteAddressChanged();
      });

      expect(
        findElement(
          container,
          (element) => element.getAttribute("data-session-tab-address") === "session",
          "Session tab address",
        ),
      ).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
