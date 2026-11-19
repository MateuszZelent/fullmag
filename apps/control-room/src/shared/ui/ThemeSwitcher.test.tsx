import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@/design/theme/ThemeProvider";

import { ThemeSwitcher } from "./ThemeSwitcher";

describe("ThemeSwitcher", () => {
  it("renders the selected theme preference accessibly", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ThemeSwitcher theme="dark" onThemeChange={() => undefined} />
      </ThemeProvider>,
    );

    expect(html).toContain("fm-theme-switcher");
    expect(html).toContain('aria-label="Color theme: System (currently dark)"');
    expect(html).toContain("fm-button");
  });
});
