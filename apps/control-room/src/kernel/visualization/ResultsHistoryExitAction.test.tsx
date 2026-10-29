import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import {
  findElement,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ResultsHistoryExitOwnerProvider } from "./ResultsHistoryExitOwnerContext";
import { ResultsHistoryExitAction } from "./ResultsHistoryExitAction";

const { returnResultsToLiveMock } = vi.hoisted(() => ({
  returnResultsToLiveMock: vi.fn(),
}));

vi.mock("./returnResultsToLive", () => ({
  returnResultsToLive: returnResultsToLiveMock,
}));

describe("ResultsHistoryExitAction", () => {
  it("is absent without an owner and visible only for current-history ownership", () => {
    const kernel = {} as KernelApi;

    expect(
      renderAction(kernel, null),
    ).not.toContain('aria-label="Return to live"');
    expect(
      renderAction(kernel, "saved"),
    ).not.toContain('aria-label="Return to live"');
    expect(
      renderAction(kernel, "current"),
    ).toContain('aria-label="Return to live"');
  });

  it("uses the shared return-to-live helper", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const kernel = {} as KernelApi;
    returnResultsToLiveMock.mockClear();

    try {
      await act(async () => {
        root.render(
          <ResultsHistoryExitOwnerProvider owner="current">
            <ResultsHistoryExitAction kernel={kernel} />
          </ResultsHistoryExitOwnerProvider>,
        );
      });
      const action = findElement(
        container,
        (candidate) => candidate.getAttribute("aria-label") === "Return to live",
        "Return to live action",
      );
      expect(action).toBeTruthy();
      await act(async () => {
        action!.click();
      });
      expect(returnResultsToLiveMock).toHaveBeenCalledWith(kernel);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function renderAction(
  kernel: KernelApi,
  owner: "saved" | "current" | null,
): string {
  return renderToStaticMarkup(
    <ResultsHistoryExitOwnerProvider owner={owner}>
      <ResultsHistoryExitAction kernel={kernel} />
    </ResultsHistoryExitOwnerProvider>,
  );
}
