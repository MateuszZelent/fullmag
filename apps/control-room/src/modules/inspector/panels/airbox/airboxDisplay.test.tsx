import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AirboxFieldRow, airboxEffectiveLengthUnit } from "./airboxDisplay";

describe("Airbox display boundary", () => {
  it("shows SI units for effective physical lengths only", () => {
    expect(airboxEffectiveLengthUnit("airbox_hmax")).toBe("m");
    expect(airboxEffectiveLengthUnit("airbox_hmin")).toBe("m");
    expect(airboxEffectiveLengthUnit("padding")).toBe("m");
    expect(airboxEffectiveLengthUnit("size")).toBe("m");
    expect(airboxEffectiveLengthUnit("center")).toBe("m");
    expect(airboxEffectiveLengthUnit("airbox_growth_rate")).toBeUndefined();
    expect(airboxEffectiveLengthUnit("mode")).toBeUndefined();
  });

  it.each(["topology", "quality"])("bounds multibyte %s backend text in DOM", (kind) => {
    const huge = `${kind}:` + "界".repeat(2_000);
    const html = renderToStaticMarkup(<AirboxFieldRow label={kind} value={huge} />);
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(1_000);
    expect(html).not.toContain("界".repeat(513));
    expect(html).toContain("…");
  });
});
