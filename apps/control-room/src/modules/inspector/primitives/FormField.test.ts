import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { FormField } from "./FormField";

describe("FormField physical numeric input contract", () => {
  it("renders unit-bearing numeric fields as text inputs for scientific notation", () => {
    const physical = renderToStaticMarkup(
      createElement(FormField, {
        label: "Maximum element size",
        onChange: () => undefined,
        type: "number",
        unit: "m",
        value: "1e-9",
      }),
    );
    const integer = renderToStaticMarkup(
      createElement(FormField, {
        label: "Priority",
        onChange: () => undefined,
        type: "number",
        value: "1",
      }),
    );

    expect(physical).toContain('type="text"');
    expect(physical).toContain('inputMode="decimal"');
    expect(physical).toContain('value="1e-9"');
    expect(integer).toContain('type="number"');
  });
});
