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
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Color theme: System (currently dark)"');
    for (const label of ["Light", "System", "Dark"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toContain("fm-button");
  });
});
