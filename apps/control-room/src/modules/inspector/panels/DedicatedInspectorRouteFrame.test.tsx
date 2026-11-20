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
  it("leaves identity to the shell and states the route method as a fact", () => {
    const html = renderToStaticMarkup(
      <DedicatedInspectorRouteFrame owner="object.magnetic-texture.asset" selection={selection}>
        <div>Asset content</div>
      </DedicatedInspectorRouteFrame>,
    );

    expect(html).toContain('data-inspector-route-owner="object.magnetic-texture.asset"');
    // InspectorShell renders the one identity header (specs/frontend-v2/13 §1a).
    expect(html).not.toContain("Scientific result path");
    expect(html).not.toContain("<h3>Magnetic texture asset</h3>");
    expect(html).toMatch(/Method<\/span><span[^>]*>Published asset</);
    expect(html).toContain("Physical properties");
    expect(html).toContain("Asset content");
  });

  it("does not collapse a route identity to the selected node label", () => {
    const html = renderToStaticMarkup(
      <DedicatedInspectorRouteFrame owner="object.magnetic-texture.transform" selection={{ ...selection, kind: "object.magnetic-texture.transform", label: "Texture asset" }}>
        <div>Transform content</div>
      </DedicatedInspectorRouteFrame>,
    );

    expect(html).toMatch(/Method<\/span><span[^>]*>Coordinate transform</);
    expect(html).not.toContain('data-inspector-route-owner="object.magnetic-texture.asset"');
  });

  it("omits facts the route cannot state instead of showing unknown", () => {
    const html = renderToStaticMarkup(
      <DedicatedInspectorRouteFrame owner="object.magnetic-texture.asset" selection={selection}>
        <div>Asset content</div>
      </DedicatedInspectorRouteFrame>,
    );
    const strip = html.slice(
      html.indexOf('data-slot="inspector-metric-strip"'),
      html.indexOf("</ul>"),
    );

    expect(strip).toContain("Scope");
    expect(strip).not.toContain("unknown");
    expect(strip).not.toContain("Resource");
  });

  it.each(["object.geometry", "builder.primitive", "fdm.cell"])(
    "leaves %s identity to the shared Inspector header",
    (owner) => {
      const html = renderToStaticMarkup(
        <DedicatedInspectorRouteFrame owner={owner} selection={{ ...selection, kind: owner }}>
          <div>Geometry content</div>
        </DedicatedInspectorRouteFrame>,
      );

      expect(html).toContain(`data-inspector-route-owner="${owner}"`);
      expect(html).toContain("Geometry content");
      expect(html).not.toContain("fm-scientific-inspector");
      expect(html).not.toContain("Physical properties");
      expect(html).not.toContain("Explorer node");
    },
  );

  it.each([
    ["mesh.quality", "Quality gates", "Mesh realization"],
    ["mesh.cross-section.plot", "Cross-section plot", "Derived visualization"],
    ["analysis.chart-point", "Data point inspection", "Published data"],
    ["study.stage.relax", "Relaxation stage", "Study pipeline"],
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
