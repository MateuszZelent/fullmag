import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

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

  it("does not pass FormField-only validation props to native inputs", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const html = renderToStaticMarkup(
        createElement(FormField, {
          invalid: false,
          label: "Center X",
          onChange: () => undefined,
          type: "text",
          unit: "m",
          value: "1e-9",
        }),
      );

      expect(html).not.toContain("invalid=");
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("non-boolean attribute"),
        expect.anything(),
        "invalid",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
