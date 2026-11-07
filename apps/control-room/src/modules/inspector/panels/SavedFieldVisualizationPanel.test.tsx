import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pinnedMaterializedDatasetSelectionRef } from "@/kernel/selection/selectionTypes";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";

import { SavedFieldVisualizationPanel } from "./SavedFieldVisualizationPanel";

const mocks = vi.hoisted(() => ({
  section: { data: { clip: { enabled: false, axis: "z", position_percent: 50 } }, optimisticData: null as unknown },
  session: { session_id: "session-A", epoch: "epoch-A" },
  resource: vi.fn(),
  controls: vi.fn(),
  overview: vi.fn(),
}));
vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => ({ selection: {} }) }));
vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>(),
  useSessionResourceIdentity: () => mocks.session,
}));
vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => { mocks.resource(); return mocks.section; },
}));
vi.mock("@/kernel/visualization/useObjectVisualization", () => ({
  useObjectVisualizationController: () => new ObjectVisualizationController(),
}));
vi.mock("../visualization/ViewportClippingControls", () => ({
  ViewportClippingControls: (props: { ownerKey: string }) => {
    mocks.controls(props);
    return <span>Shared workspace section</span>;
  },
}));
vi.mock("./ObjectVisualizationOverview", () => ({
  VisualizationInspectorOverview: (props: { clipping?: ReactNode; clippingSummary?: string }) => {
    mocks.overview(props);
    return <>{props.clipping}<span>{props.clippingSummary}</span></>;
  },
}));

const selection = pinnedMaterializedDatasetSelectionRef({
  projectId: "project", runId: "run", solutionSetId: "solution", containingRevision: "1",
  memberId: "member", artifactId: "artifact", manifestObjectRef: "manifest", sampleId: "sample",
  itemId: "item", fieldId: "H_ant", datasetId: "dataset", datasetRevision: "1",
});
function render() {
  const controller = new ObjectVisualizationController();
  controller.setSavedFieldPresentation(selection, "H_ant", "3");
  return renderToStaticMarkup(<SavedFieldVisualizationPanel
    presentation={controller.getSnapshot().savedFieldPresentation!} dataset={null} />);
}
describe("saved field workspace section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.section.optimisticData = null;
    mocks.session.epoch = "epoch-A";
  });

  it("exposes the common section with exactly one visualization resource owner", () => {
    expect(render()).toContain("Shared workspace section");
    expect(mocks.resource).toHaveBeenCalledTimes(1);
    expect(mocks.controls.mock.calls[0]?.[0].resource).toBe(mocks.section);
    expect(mocks.overview.mock.calls[0]?.[0].clippingSummary).toBe("Section: Off");
  });

  it("prefers optimistic section position to the confirmed resource state", () => {
    mocks.section.optimisticData = { clip: { enabled: true, axis: "y", position_percent: 37.5 } };
    expect(render()).toContain("On: Y 37.5%");
    expect(mocks.controls).toHaveBeenCalledTimes(1);
  });

  it("scopes section gestures to the current session and pinned saved result", () => {
    render();
    const first = mocks.controls.mock.calls[0]?.[0].ownerKey;
    expect(first).toContain(selection.nodeId);
    mocks.session.epoch = "epoch-B";
    render();
    expect(mocks.controls.mock.calls[1]?.[0].ownerKey).not.toBe(first);
  });
});
