import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
  it("renders the selected FM variant and size without duplicate utility styling", () => {
    const html = renderToStaticMarkup(
      <Button size="sm" variant="primary">
        Run
      </Button>,
    );

    expect(html).toContain("fm-button");
    expect(html).toContain("fm-button--primary");
    expect(html).toContain("fm-button--sm");
    expect(html).toContain('data-slot="button"');
    expect(html).not.toContain("h-fm-control-sm");
    expect(html).not.toContain("bg-fm-accent");
    expect(html).not.toContain("text-fm-inverse");
    expect(html).not.toContain("shadow-fm-control");
    expect(html).not.toContain("active:scale-");
    expect(html).toContain(">Run</button>");
  });
});
