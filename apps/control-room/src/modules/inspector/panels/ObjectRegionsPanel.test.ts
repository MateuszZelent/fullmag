import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("ObjectRegionsPanel physical scalar inputs", () => {
  it("buffers scientific notation text locally while editing SI values", () => {
    const source = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("function PhysicalScalarField");
    expect(source).toContain("const [text, setText] = useState(formatted);");
    expect(source).toContain("parseRegionPhysicalScalar(nextText)");
    expect(source).toContain('type="text"');
    expect(source).toContain('inputMode="decimal"');
    expect(source).not.toContain("function parsePhysicalInput");
  });

  it("shows object-like geometry material and mesh sections on the region root", () => {
    const source = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );
    const defaultIndex = source.indexOf("default:");
    const defaultSections = source.slice(
      defaultIndex,
      source.indexOf("];", defaultIndex),
    );

    expect(defaultSections).toContain('"identity"');
    expect(defaultSections).toContain('"shape"');
    expect(defaultSections).toContain('"material"');
    expect(defaultSections).toContain('"mesh"');
    expect(defaultSections).toContain('"texture"');
    expect(defaultSections).toContain('"diagnostics"');
  });
});
