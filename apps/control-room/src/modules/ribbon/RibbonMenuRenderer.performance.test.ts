import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/modules/ribbon/RibbonMenuRenderer.tsx"),
  "utf8",
);

describe("RibbonMenuRenderer performance contracts", () => {
  it("stages high-frequency slider values locally and flushes only on interaction boundaries", () => {
    expect(source).not.toContain("SLIDER_COMMAND_DEBOUNCE_MS");
    expect(source).not.toContain("useDebouncedSliderCommand");
    expect(source).not.toContain("setTimeout(flushSliderCommand");
    expect(source).toContain("useDraftSliderCommand");
    expect(source).toContain("onPointerUp={flushSliderCommand}");
    expect(source).toContain("onPointerCancel={flushSliderCommand}");
    expect(source).toContain("onBlur={flushSliderCommand}");
    expect(source).toContain("onKeyUp={flushSliderCommand}");
    expect(source).toContain("value={draftValue}");
    expect(source).toContain("key={node.id}");
  });
});
