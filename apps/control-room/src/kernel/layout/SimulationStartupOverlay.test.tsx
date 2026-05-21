import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LiveStatusResource } from "../api/apiTypes";
import type { ResourceResult } from "../resources/resourceTypes";

import {
  SimulationStartupOverlayView,
  WorkspaceStartupGateView,
  resolveSimulationStartupOverlayState,
  shouldRefreshSimulationStartupStatus,
} from "./SimulationStartupOverlay";

const source = readFileSync(
  new URL("./SimulationStartupOverlay.tsx", import.meta.url),
  "utf8",
);

const refetch = vi.fn();

function statusResource(
  patch: Partial<LiveStatusResource>,
): ResourceResult<LiveStatusResource> {
  return {
    data: {
      resources: {},
      session: { name: "arch_waveguide_relax_50nm" },
      solver: { state: "awaiting_command" },
      ...patch,
    } as LiveStatusResource,
    error: null,
    refetch,
    revision: 1,
    status: "ready",
  };
}

describe("SimulationStartupOverlay", () => {
  it("shows while the session status resource is loading", () => {
    const state = resolveSimulationStartupOverlayState({
      data: null,
      error: null,
      refetch,
      revision: null,
      status: "loading",
    });

    expect(state).toMatchObject({
      detail: "Connecting to the local simulation backend.",
      isVisible: true,
      title: "Preparing simulation",
    });
  });

  it("shows explicit startup phases from the backend status", () => {
    expect(
      resolveSimulationStartupOverlayState(
        statusResource({
          solver: { state: "bootstrapping" },
        }),
      ),
    ).toMatchObject({
      detail: "Starting the runtime workspace.",
      isVisible: true,
      title: "Preparing simulation",
    });

    expect(
      resolveSimulationStartupOverlayState(
        statusResource({
          solver: { state: "materializing_script" },
        }),
      ),
    ).toMatchObject({
      detail: "Compiling the model and preparing runtime data.",
      isVisible: true,
      title: "Compiling simulation",
    });
  });

  it("treats a transient missing workspace error as startup loading", () => {
    const state = resolveSimulationStartupOverlayState({
      data: null,
      error: new Error("no active local live workspace"),
      refetch,
      revision: null,
      status: "error",
    });

    expect(state).toMatchObject({
      detail: "Waiting for the runtime workspace to become available.",
      isVisible: true,
      title: "Preparing simulation",
    });
  });

  it("hydrates the smoke bypass from browser config after startup", () => {
    expect(source).toContain("useState(false)");
    expect(source).toContain("useEffect(() => {");
    expect(source).toContain("window.setTimeout(() => {");
    expect(source).toContain("setAllowMissingSessionSmoke(");
    expect(source).toContain("getSimulationStartupSmokeBypassSnapshot()");
    expect(source).toContain("window.clearTimeout(timeoutId)");
  });

  it("allows controlled offline smoke tests to bypass the startup gate", () => {
    const state = resolveSimulationStartupOverlayState(
      {
        data: null,
        error: new Error("fetch failed"),
        refetch,
        revision: null,
        status: "error",
      },
      { allowMissingSessionSmoke: true },
    );

    expect(state).toEqual({ isVisible: false });
  });

  it("does not hide unrelated API errors behind the startup overlay", () => {
    expect(
      resolveSimulationStartupOverlayState({
        data: null,
        error: new Error("API contract version mismatch"),
        refetch,
        revision: null,
        status: "error",
      }),
    ).toEqual({ isVisible: false });
  });

  it("renders an accessible modal-style status panel", () => {
    const html = renderToStaticMarkup(
      <SimulationStartupOverlayView
        state={{
          detail: "Compiling the model and preparing runtime data.",
          isVisible: true,
          title: "Compiling simulation",
        }}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Compiling simulation");
    expect(html).toContain("Compiling the model");
  });

  it("does not mount workspace slots while startup overlay is visible", () => {
    const html = renderToStaticMarkup(
      <WorkspaceStartupGateView
        state={{
          detail: "Waiting for the runtime workspace to become available.",
          isVisible: true,
          title: "Preparing simulation",
        }}
      >
        <div data-slot-id="viewport-main">Viewport module</div>
      </WorkspaceStartupGateView>,
    );

    expect(html).toContain("Preparing simulation");
    expect(html).not.toContain("viewport-main");
  });

  it("selects startup overlay state instead of subscribing to full session status", () => {
    expect(source).toContain("selectSimulationStartupOverlayResourceState");
    expect(source).toContain("simulationStartupOverlayResourceStateEquals");
    expect(source).toMatch(
      /useSessionStatusSelector\(\s*selectSimulationStartupOverlayResourceState/,
    );
    expect(source).not.toContain("useSessionStatus,");
    expect(source).not.toContain("const sessionStatus = useSessionStatus();");
  });

  it("keeps refreshing status while startup overlay is visible", () => {
    expect(
      shouldRefreshSimulationStartupStatus({
        detail: "Compiling the model and preparing runtime data.",
        isVisible: true,
        title: "Compiling simulation",
      }),
    ).toBe(true);

    expect(shouldRefreshSimulationStartupStatus({ isVisible: false })).toBe(
      false,
    );
  });
});
