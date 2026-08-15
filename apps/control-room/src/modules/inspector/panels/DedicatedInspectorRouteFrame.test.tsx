import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { DedicatedInspectorRouteFrame } from "./DedicatedInspectorRouteFrame";

const selection = {
  kind: "object.magnetic-texture.asset",
  label: "Texture asset",
  moduleSource: "explorer",
  nodeId: "model:object:obj-1:texture:asset",
  objectId: "obj-1",
  ref: {
    kind: "object.magnetic-texture.asset",
    nodeId: "model:object:obj-1:texture:asset",
    type: "runtime-explorer",
    resourceKey: "magnetic-texture:obj-1",
    descriptorId: "texture:obj-1",
  },
} satisfies Selection;

describe("DedicatedInspectorRouteFrame", () => {
  it("gives each route a visible semantic identity while preserving shared Inspector chrome", () => {
    const html = renderToStaticMarkup(
      <DedicatedInspectorRouteFrame owner="object.magnetic-texture.asset" selection={selection}>
        <div>Asset content</div>
      </DedicatedInspectorRouteFrame>,
    );

    expect(html).toContain('data-inspector-route-owner="object.magnetic-texture.asset"');
    expect(html).toContain("Magnetic texture asset");
    expect(html).toContain("Physical properties");
    expect(html).toContain("Asset content");
  });

  it("does not collapse a route identity to the selected node label", () => {
    const html = renderToStaticMarkup(
      <DedicatedInspectorRouteFrame owner="object.magnetic-texture.transform" selection={{ ...selection, kind: "object.magnetic-texture.transform", label: "Texture asset" }}>
        <div>Transform content</div>
      </DedicatedInspectorRouteFrame>,
    );

    expect(html).toContain("Magnetic texture transform");
    expect(html).not.toContain('data-inspector-route-owner="object.magnetic-texture.asset"');
  });

  it.each([
    ["mesh.quality", "Quality gates", "Mesh realization"],
    ["mesh.cross-section.plot", "Cross-section plot", "Derived visualization"],
    ["analysis.chart-point", "Data point inspection", "Published data"],
    ["study.stage.relax", "Relaxation stage", "Study pipeline"],
    ["object.geometry", "Geometry authoring", "Model authoring"],
  ])("publishes a route-specific method and physical lane for %s", (owner, method, physicalLabel) => {
    const html = renderToStaticMarkup(
      <DedicatedInspectorRouteFrame owner={owner} selection={{ ...selection, kind: owner }}>
        <div>Route content</div>
      </DedicatedInspectorRouteFrame>,
    );

    expect(html).toContain(method);
    expect(html).toContain(physicalLabel);
  });
});
