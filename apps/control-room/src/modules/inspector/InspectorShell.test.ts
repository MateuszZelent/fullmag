import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./InspectorShell.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("InspectorShell scroll lifecycle", () => {
  it("resets scroll only when the inspector descriptor identity changes", () => {
    const resetEffectStart = source.indexOf(
      "useLayoutEffect(() => {\n    resetInspectorScroll",
    );
    const resetEffect = source.slice(
      resetEffectStart,
      source.indexOf("\n\n  return (", resetEffectStart),
    );

    expect(resetEffectStart).toBeGreaterThan(-1);
    expect(resetEffect).toContain("}, [descriptorKey]);");
    expect(resetEffect).not.toContain("descriptor.tabs");
  });

  it("exposes a command-backed icon for hiding the Inspector panel", () => {
    expect(source).toContain("PanelRightClose");
    expect(source).toContain('aria-label="Hide Inspector"');
    expect(source).toContain('data-panel-toggle="inspector"');
    expect(source).toContain("onToggleVisibility");
  });
});
