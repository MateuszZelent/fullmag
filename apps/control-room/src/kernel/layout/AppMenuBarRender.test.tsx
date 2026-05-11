import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@/design/theme/ThemeProvider";

import { AppMenuBar } from "./AppMenuBar";

describe("AppMenuBar", () => {
  it("renders header controls through shared shadcn-style button primitives", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <AppMenuBar />
      </ThemeProvider>,
    );

    expect(html).toContain("fm-button");
    expect(html).toContain("fm-header__nav-item");
    expect(html).toContain("fm-header__action-btn");
    expect(html).toContain("fm-header__app-trigger");
    expect(html).toContain("Command search");
    expect(html).toContain("Runtime controls");
    expect(html).toContain('aria-label="Switch to light theme"');
  });
});
