import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Progress } from "./Progress";

describe("Progress accessibility", () => {
  it("passes the determinate value to the Radix root", () => {
    const markup = renderToStaticMarkup(createElement(Progress, { value: 50, "aria-label": "Field samples" }));
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('aria-valuemax="100"');
  });

  it("keeps unknown progress indeterminate without an invented zero", () => {
    const markup = renderToStaticMarkup(createElement(Progress, { value: null, "aria-label": "Field samples" }));
    expect(markup).toContain('data-state="indeterminate"');
    expect(markup).not.toContain("aria-valuenow");
  });
});
