import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeSwitcher } from "./ThemeSwitcher";

describe("ThemeSwitcher", () => {
  it("renders a token-styled icon button for the next theme", () => {
    const html = renderToStaticMarkup(
      <ThemeSwitcher theme="dark" onThemeChange={() => undefined} />,
    );

    expect(html).toContain("fm-theme-switcher");
    expect(html).toContain('aria-label="Switch to light theme"');
    expect(html).toContain("fm-button");
  });
});
