import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";
import { ResultsHistoryExitOwnerProvider } from "@/kernel/visualization/ResultsHistoryExitOwnerContext";

import {
  clampPlaybackFrameIndex,
  formatSavedPlaybackTimeNs,
  SavedResultsPlaybackInspector,
} from "./SavedResultsPlaybackInspector";

const playbackMocks = vi.hoisted(() => ({
  selection: null as null | {
    itemId: string;
    name: string;
    stageId: string | null;
    frameIndex: number;
    component: 0 | 1 | 2;
    colorLimit: number | null;
  },
  resource: null as unknown,
  sessionIdentity: null as {
    requestScopeEpoch: string;
    sessionEpoch: string;
    sessionId: string;
  } | null,
}));

const returnToLiveMock = vi.hoisted(() => ({
  call: vi.fn(),
}));

vi.mock("@/kernel/saved-results/useSavedResultsPlayback", () => ({
  useSavedResultsPlaybackSelection: () => playbackMocks.selection,
}));

vi.mock("@/kernel/resources/savedResultsPlaybackResources", () => ({
  useSavedResultsManifestResource: () => playbackMocks.resource,
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => playbackMocks.sessionIdentity,
}));

vi.mock("@/kernel/visualization/returnResultsToLive", () => ({
  returnResultsToLive: returnToLiveMock.call,
}));

vi.mock("@/shared/ui/Slider", async () => {
  const React = await import("react");
  return {
    Slider: (props: {
      readonly ["aria-label"]?: string;
      readonly ["aria-valuetext"]?: string;
      readonly id?: string;
      readonly max?: number;
      readonly min?: number;
      readonly step?: number;
      readonly value?: readonly number[];
    }) => React.createElement("input", {
      "aria-label": props["aria-label"],
      "aria-valuetext": props["aria-valuetext"],
      id: props.id,
      max: props.max,
      min: props.min,
      readOnly: true,
      role: "slider",
      step: props.step,
      value: props.value?.[0],
    }),
  };
});

const manifest = {
  schema: "fullmag.saved-playback.v1",
  revision: "sha256:manifest-v1",
  name: "yig-ring",
  grid_cells_xyz: [2, 2, 1],
  cell_size_m: [5e-9, 5e-9, 20e-9],
  origin_m: [-5e-9, -5e-9, -10e-9],
  source_note: "Complete data recovered after ENOSPC; original publication failed.",
  stages: [
    { stage_id: "relax", frame_count: 3, times_s: [0, 1e-9, 2e-9], quantity_ids: ["m"] },
  ],
};

const controller = {
  close: vi.fn(),
  selectFrame: vi.fn(),
  selectStage: vi.fn(),
  setColorLimit: vi.fn(),
  setComponent: vi.fn(),
};

function renderInspector(owner: "saved" | "current" | null = null) {
  return renderToStaticMarkup(
    <KernelContext.Provider value={{ savedResultsPlayback: controller } as unknown as KernelApi}>
      <ResultsHistoryExitOwnerProvider owner={owner}>
        <SavedResultsPlaybackInspector />
      </ResultsHistoryExitOwnerProvider>
    </KernelContext.Provider>,
  );
}

describe("SavedResultsPlaybackInspector", () => {
  beforeEach(() => {
    playbackMocks.selection = {
      itemId: "result-yig-ring",
      name: "yig-ring",
      stageId: "relax",
      frameIndex: 0,
      component: 2,
      colorLimit: null,
    };
    playbackMocks.resource = { data: manifest, error: null, refreshError: null, status: "ready" };
    playbackMocks.sessionIdentity = null;
    vi.clearAllMocks();
  });

  it("shows direct read-only folder context, the source note, and keyboard-accessible frame controls", () => {
    const html = renderInspector();

    expect(html).toContain("No source project or active session is required");
    expect(html).toContain("Complete data recovered after ENOSPC; original publication failed.");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Saved frame index"');
    expect(html).toContain('aria-valuetext="Sample 1 of 3"');
    expect(html).toContain("Time: 0 ns");
    expect(html).toContain('aria-label="Saved results stage"');
    expect(html).toContain('aria-label="Saved results magnetization component"');
    expect(html).toContain("Close results");
  });

  it("shows nodal FEM support while retaining the same time controls", () => {
    playbackMocks.resource={data:{...manifest,grid_cells_xyz:undefined,cell_size_m:undefined,origin_m:undefined,fem_mesh:{node_count:5,cell_count:2,facet_count:6}},error:null,refreshError:null,status:"ready"};
    const html=renderInspector();
    expect(html).toContain("FEM mesh");
    expect(html).toContain("5 nodes · 2 cells");
    expect(html).toContain("Canonical H1/P1 nodes");
    expect(html).toContain('aria-label="Saved frame index"');
    expect(html).not.toContain("Cell size");
  });

  it("bounds frame navigation at the first and last saved frames", () => {
    const firstFrame = renderInspector();
    expect(firstFrame).toMatch(/<button[^>]*aria-label="First frame"[^>]*disabled=""/);
    expect(firstFrame).toMatch(/<button[^>]*aria-label="Previous frame"[^>]*disabled=""/);
    expect(firstFrame).not.toMatch(/<button[^>]*aria-label="Next frame"[^>]*disabled=""/);

    playbackMocks.selection = { ...playbackMocks.selection!, frameIndex: 2 };
    const lastFrame = renderInspector();
    expect(lastFrame).not.toMatch(/<button[^>]*aria-label="Previous frame"[^>]*disabled=""/);
    expect(lastFrame).toMatch(/<button[^>]*aria-label="Next frame"[^>]*disabled=""/);
    expect(lastFrame).toMatch(/<button[^>]*aria-label="Last frame"[^>]*disabled=""/);
    // Radix assigns the Thumb's collection index after DOM registration.
    // SSR verifies the visible selection; managed browser QA checks the hydrated ARIA value.
    expect(lastFrame).toContain('>3 / 3</output>');
    expect(lastFrame).toContain('aria-valuetext="Sample 3 of 3"');
    expect(lastFrame).toContain("Time: 2 ns");
  });

  it("exposes the middle and empty frame ordinals to the slider", () => {
    playbackMocks.selection = { ...playbackMocks.selection!, frameIndex: 1 };
    expect(renderInspector()).toContain('aria-valuetext="Sample 2 of 3"');

    playbackMocks.resource = {
      data: { ...manifest, stages: [{ ...manifest.stages[0]!, frame_count: 0, times_s: [] }] },
      error: null,
      refreshError: null,
      status: "ready",
    };
    expect(renderInspector()).toContain('aria-valuetext="Sample unavailable"');
  });

  it("clamps descriptor-driven frame indexes to the saved range", () => {
    expect(clampPlaybackFrameIndex(-7, 3)).toBe(0);
    expect(clampPlaybackFrameIndex(2, 3)).toBe(2);
    expect(clampPlaybackFrameIndex(99, 3)).toBe(2);
    expect(clampPlaybackFrameIndex(4, 0)).toBe(0);
    expect(formatSavedPlaybackTimeNs(2e-9)).toBe("2 ns");
  });

  it("uses the live-return label only for a confirmed session", () => {
    playbackMocks.sessionIdentity = {
      requestScopeEpoch: "scope-1",
      sessionEpoch: "epoch-1",
      sessionId: "session-1",
    };
    const html = renderInspector();
    expect(html).toContain("Return to live");
    expect(html).not.toContain("Close results");
  });

  it("leaves the exit action to the Saved shell owner", () => {
    expect(renderInspector("saved")).not.toContain("Close results");
    expect(renderInspector("saved")).not.toContain("Return to live");
  });

  it("returns through the shared historical-results cleanup helper", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const kernel = { savedResultsPlayback: controller } as unknown as KernelApi;

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <SavedResultsPlaybackInspector />
          </KernelContext.Provider>,
        );
      });
      const closeButton = findElement(
        container,
        (element) => element.getAttribute("class")?.includes("fm-saved-results-playback-inspector__close") === true,
        "saved results exit button",
      );
      await act(async () => {
        closeButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(returnToLiveMock.call).toHaveBeenCalledOnce();
      expect(returnToLiveMock.call).toHaveBeenCalledWith(kernel);
      expect(controller.close).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
