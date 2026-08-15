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

    expect(html).toContain("Unsupported Inspector");
    expect(html).toContain("No dedicated Inspector route is registered");
    expect(html).toContain("results.future.product");
    expect(html).toContain("results:future-product");
  });
});
