import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginPlanarMonitorDraft,
  resetCrossSectionWorkspaceForTests,
} from "@/kernel/workspace/crossSectionWorkspace";

import { PlanarMonitorDraftInspectorPanel } from "./PlanarMonitorDraftInspectorPanel";

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {},
    layout: {},
    resources: {},
    selection: {},
  }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: { monitors: [], scene_revision: 7 },
    refetch: vi.fn(),
  }),
}));

describe("PlanarMonitorDraftInspectorPanel", () => {
  beforeEach(() => {
    resetCrossSectionWorkspaceForTests();
  });

  it("renders only canonical monitor geometry and transaction actions", () => {
    beginPlanarMonitorDraft();

    const html = renderToStaticMarkup(<PlanarMonitorDraftInspectorPanel />);

    expect(html).toContain("Monitor Frame");
    expect(html).toContain('value="Midplane"');
    expect(html).toContain("Magnetic domain");
    expect(html).toContain('aria-label="Monitor plane axis"');
    expect(html).toContain("Apply monitor");
    expect(html).toContain("Discard");
    expect(html).not.toContain("Quality metric");
    expect(html).not.toContain("Color scale");
    expect(html).not.toContain("Shrink");
  });
});
