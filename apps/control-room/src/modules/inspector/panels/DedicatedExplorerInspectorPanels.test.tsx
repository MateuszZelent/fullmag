import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  AirboxVisualizationInspectorPanel,
  MeshPartAirboxInspectorPanel,
} from "./DedicatedExplorerInspectorPanels";

vi.mock("./airbox/AirboxVisualizationPanel", () => ({
  AirboxVisualizationPanel: () => (
    <div className="fm-scientific-inspector" data-inspector-owner="airbox.visualization">
      <section>View</section>
      <section>Status</section>
    </div>
  ),
}));

vi.mock("./DedicatedInspectorRouteFrame", () => ({
  DedicatedInspectorRouteFrame: ({
    children,
    owner,
  }: {
    children: React.ReactNode;
    owner: string;
  }) => (
    <div data-inspector-route-owner={owner}>
      <section>Status</section>
      {children}
    </div>
  ),
}));

const selection = {
  kind: "airbox.visualization",
  label: "Airbox visualization",
  moduleSource: "explorer",
  nodeId: "model:airbox:visualization",
  objectId: null,
  ref: null,
} satisfies Selection;

describe("DedicatedExplorerInspectorPanels visualization framing", () => {
  it.each([
    ["Airbox route", AirboxVisualizationInspectorPanel],
    ["Airbox mesh-part route", MeshPartAirboxInspectorPanel],
  ])("keeps %s self-framed with View before one Status section", (_label, Panel) => {
    const html = renderToStaticMarkup(<Panel selection={selection} />);

    expect(html).not.toContain("data-inspector-route-owner");
    expect(html.match(/fm-scientific-inspector/g)).toHaveLength(1);
    expect(html.match(/>Status</g)).toHaveLength(1);
    expect(html.indexOf(">View<")).toBeLessThan(html.indexOf(">Status<"));
  });
});
