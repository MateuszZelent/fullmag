import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./InspectorShell.tsx", import.meta.url), "utf8");

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
});
