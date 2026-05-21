import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/modules/ribbon/RibbonMenuRenderer.tsx"),
  "utf8",
);

describe("RibbonMenuRenderer performance contracts", () => {
  it("debounces high-frequency slider commands and flushes on interaction end", () => {
    expect(source).toContain("SLIDER_COMMAND_DEBOUNCE_MS");
    expect(source).toContain("useDebouncedSliderCommand");
    expect(source).toContain("setTimeout(flushSliderCommand");
    expect(source).toContain("onPointerUp={flushSliderCommand}");
    expect(source).toContain("onBlur={flushSliderCommand}");
    expect(source).toContain("value={draftValue}");
    expect(source).toContain("key={node.id}");
  });
});
