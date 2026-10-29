import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";

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
}));

vi.mock("@/kernel/saved-results/useSavedResultsPlayback", () => ({
  useSavedResultsPlaybackSelection: () => playbackMocks.selection,
}));

vi.mock("@/kernel/resources/savedResultsPlaybackResources", () => ({
  useSavedResultsManifestResource: () => playbackMocks.resource,
}));

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

function renderInspector() {
  return renderToStaticMarkup(
    <KernelContext.Provider value={{ savedResultsPlayback: controller } as unknown as KernelApi}>
      <SavedResultsPlaybackInspector />
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
    vi.clearAllMocks();
  });

  it("shows direct read-only folder context, the source note, and keyboard-accessible frame controls", () => {
    const html = renderInspector();

    expect(html).toContain("No source project or active session is required");
    expect(html).toContain("Complete data recovered after ENOSPC; original publication failed.");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Saved frame index"');
    expect(html).toContain("Time: 0 ns");
    expect(html).toContain('aria-label="Saved results stage"');
    expect(html).toContain('aria-label="Saved results magnetization component"');
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
    expect(lastFrame).toContain("Time: 2 ns");
  });

  it("clamps descriptor-driven frame indexes to the saved range", () => {
    expect(clampPlaybackFrameIndex(-7, 3)).toBe(0);
    expect(clampPlaybackFrameIndex(2, 3)).toBe(2);
    expect(clampPlaybackFrameIndex(99, 3)).toBe(2);
    expect(clampPlaybackFrameIndex(4, 0)).toBe(0);
    expect(formatSavedPlaybackTimeNs(2e-9)).toBe("2 ns");
  });
});
