import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
  it("renders shadcn-compatible button variants with fm-prefixed classes", () => {
    const html = renderToStaticMarkup(
      <Button size="sm" variant="primary">
        Run
      </Button>,
    );

    expect(html).toContain("fm-button");
    expect(html).toContain("fm-button--primary");
    expect(html).toContain("fm-button--sm");
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("h-fm-control-sm");
    expect(html).toContain("bg-fm-accent");
    expect(html).toContain("text-fm-inverse");
    expect(html).toContain("shadow-[var(--fm-shadow-control)]");
    expect(html).toContain("active:scale-[0.98]");
    expect(html).toContain(">Run</button>");
  });
});
