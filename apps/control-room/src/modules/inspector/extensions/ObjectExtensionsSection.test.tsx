import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";
import { Accordion } from "@/shared/ui/Accordion";

import { createObjectExtensionActivationState } from "./ObjectExtensionsSectionModel";
import { ObjectExtensionsSection } from "./ObjectExtensionsSection";

const objectRootSelection: Selection = {
  kind: "object.root",
  label: "permalloy_layer",
  moduleSource: "test",
  nodeId: "model:object:permalloy_layer",
  objectId: "permalloy_layer",
  ref: {
    kind: "object.root",
    nodeId: "model:object:permalloy_layer",
    objectId: "permalloy_layer",
    type: "scene-object",
    visualizationTargetId: "object:permalloy_layer",
  },
};

describe("ObjectExtensionsSection", () => {
  it("renders the object Extensions section with Topological Charge disabled by default", () => {
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["extensions"]}>
        <ObjectExtensionsSection
          activation={createObjectExtensionActivationState()}
          objectId="permalloy_layer"
          selection={objectRootSelection}
        />
      </Accordion>,
    );

    expect(html).toContain("Extensions");
    expect(html).toContain("Topological Charge");
    expect(html).toContain("disabled");
  });

  it("renders no section for non-root object selections", () => {
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["extensions"]}>
        <ObjectExtensionsSection
          activation={createObjectExtensionActivationState()}
          objectId="permalloy_layer"
          selection={{ ...objectRootSelection, kind: "object.geometry" }}
        />
      </Accordion>,
    );

    expect(html).not.toContain("Extensions");
    expect(html).not.toContain("Topological Charge");
  });
});
