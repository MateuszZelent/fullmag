import type { ReactNode } from "react";
import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
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
  VisualizationInspectorOverview: (props: { context?: ReactNode; clipping?: ReactNode; clippingSummary?: string }) => {
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

  it("retained_dtq_display_distinguishes_raw_and_signed_per_a", () => {
    const controller = new ObjectVisualizationController();
    controller.setSavedFieldPresentation(selection, "H_ant", "3");
    const dataset = {
      integrity: "verified", dataset: { status: { availability: "ready" } },
      field: { producer_id: "fullmag.retained-current-field", producer_version: "1", accepted_state: null,
        descriptor: { quantity_id: "H_ant", unit: "A/m", value_representation: "physical_field",
          normalization: "none", complex_encoding: "real", sample_location: "node" },
        coverage: { component_count: "3", total_elements: "4" } },
    } as unknown as MaterializedDatasetResource;
    renderToStaticMarkup(<SavedFieldVisualizationPanel
      presentation={controller.getSnapshot().savedFieldPresentation!} dataset={dataset} />);
    const context = renderToStaticMarkup(mocks.overview.mock.calls[0]?.[0].context as ReactNode);
    expect(context).toContain("Raw H [A/m]");
    expect(context).toContain("Signed per-A [1/m] is unavailable");
    expect(context).toContain("no canonical H/I transform");
    expect(context).not.toContain("role=\"combobox\"");
    expect(dataset.field.descriptor.unit).toBe("A/m");
    expect(dataset.field.descriptor.normalization).toBe("none");
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
