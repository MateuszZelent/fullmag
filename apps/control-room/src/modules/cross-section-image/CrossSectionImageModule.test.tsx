import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import type { CrossSectionImageQuery } from "@/kernel/api/apiTypes";

import CrossSectionImageModule from "./CrossSectionImageModule";

const crossSectionImageQueries = vi.hoisted(
  () => [] as CrossSectionImageQuery[],
);
const crossSectionImageData = vi.hoisted(
  () => ({ current: null as ArrayBuffer | null }),
);
const objectUrlCalls = vi.hoisted(() => ({
  createObjectUrl: vi.fn(() => "blob:cross-section-image"),
  revokeObjectUrl: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    layout: {
      setFocusedSlot: vi.fn(),
      setPanelVisible: vi.fn(),
    },
    selection: {
      set: vi.fn(),
    },
  }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: null,
    error: null,
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/crossSectionResources", () => ({
  useCrossSectionImageResource: (query: CrossSectionImageQuery) => {
    crossSectionImageQueries.push(query);
    return {
      data: crossSectionImageData.current,
      error: null,
      status: crossSectionImageData.current ? "ready" : "loading",
    };
  },
}));

vi.mock("./objectUrl", () => objectUrlCalls);

describe("CrossSectionImageModule", () => {
  beforeEach(() => {
    resetCrossSectionWorkspaceForTests();
    crossSectionImageQueries.length = 0;
    crossSectionImageData.current = null;
    objectUrlCalls.createObjectUrl.mockClear();
    objectUrlCalls.revokeObjectUrl.mockClear();
  });

  it("renders saved plots as switchable image objects and keeps a new-image action available", () => {
    beginCrossSectionDraft();
    updateCrossSectionDraft({ name: "First cut", positionPercent: 25 });
    commitCrossSectionDraft();
    beginCrossSectionDraft();
    updateCrossSectionDraft({ name: "Second cut", positionPercent: 75 });
    commitCrossSectionDraft();

    const html = renderToStaticMarkup(<CrossSectionImageModule />);

    expect(html).toContain("First cut");
    expect(html).toContain("Second cut");
    expect(html).toContain("New Image");
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Image resolution"');
    expect(html).toContain("1024");
    expect(html).toContain("2048");
    expect(html).toContain("4096");
    expect(crossSectionImageQueries.at(-1)?.resolution).toBe(1024);
  });

  it("offers a new image action before any plot exists", () => {
    const html = renderToStaticMarkup(<CrossSectionImageModule />);

    expect(html).toContain("New Image");
    expect(html).not.toContain("No cross-section image generated");
  });

  it("does not create object URLs during render", () => {
    beginCrossSectionDraft();
    commitCrossSectionDraft();
    crossSectionImageData.current = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

    renderToStaticMarkup(<CrossSectionImageModule />);

    expect(objectUrlCalls.createObjectUrl).not.toHaveBeenCalled();
  });
});
