import { describe, expect, it } from "vitest";
import * as React from "react";
import { ScrollArea, ScrollBar } from "../scroll-area";

describe("ScrollArea", () => {
  it("renders native div container", () => {
    const element = ScrollArea({
      className: "h-12",
      children: React.createElement("span", null, "content"),
    });
    expect(React.isValidElement(element)).toBe(true);
    expect(element.type).toBe("div");
    expect(element.props["data-slot"]).toBe("scroll-area");
  });

  it("keeps ScrollBar as no-op for compatibility", () => {
    expect(ScrollBar({})).toBeNull();
  });
});
