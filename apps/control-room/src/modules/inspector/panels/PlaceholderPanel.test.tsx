import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { PlaceholderPanel } from "./PlaceholderPanel";

describe("PlaceholderPanel", () => {
  it("makes an unknown selected kind an explicit unsupported Inspector", () => {
    const selection = {
      kind: "results.future.product",
      label: "Future product",
      moduleSource: "explorer",
      nodeId: "results:future-product",
      objectId: null,
      ref: null,
    } satisfies Selection;

    const html = renderToStaticMarkup(<PlaceholderPanel selection={selection} />);

    // The fallback renders through canonical InspectorTemplate without forbidden literals.
    expect(html).toContain('data-slot="inspector-root"');
    expect(html).toContain("No dedicated inspector registered");
    expect(html).toContain("No editable properties for this selection");
    expect(html).toContain("results.future.product");
    expect(html).toContain("results:future-product");
    expect(html.toLowerCase()).not.toContain("unknown");
    expect(html.toLowerCase()).not.toContain("unavailable");
  });
});
