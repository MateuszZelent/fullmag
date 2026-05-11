import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SlotHost } from "./SlotHost";

describe("SlotHost", () => {
  it("renders an empty slot fallback when no module is active", () => {
    const html = renderToStaticMarkup(
      <SlotHost slotId="panel-left" moduleManifest={null} />,
    );

    expect(html).toContain("data-slot-id=\"panel-left\"");
    expect(html).toContain("No module mounted");
  });
});
