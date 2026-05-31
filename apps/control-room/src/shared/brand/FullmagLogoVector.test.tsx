import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FullmagLogoVector } from "./FullmagLogoVector";

const componentSource = readFileSync(
  new URL("./FullmagLogoVector.tsx", import.meta.url),
  "utf8",
);
const assetSource = readFileSync(
  new URL("../../../public/brand/fullmag-logo-vector.svg", import.meta.url),
  "utf8",
);

describe("FullmagLogoVector", () => {
  it("keeps the TSX wrapper lightweight and serves traced paths as a static asset", () => {
    const html = renderToStaticMarkup(
      <FullmagLogoVector aria-label="Fullmag logo" className="fm-test-logo" />,
    );

    expect(componentSource.length).toBeLessThan(4_096);
    expect(componentSource).toContain("/brand/fullmag-logo-vector.svg");
    expect(componentSource).not.toContain("<path d=");
    expect(html).toContain('href="/brand/fullmag-logo-vector.svg"');
    expect(html).toContain('class="fm-test-logo"');
  });

  it("keeps the static SVG valid outside React", () => {
    expect(assetSource).toContain("<svg ");
    expect(assetSource).toContain("</svg>");
    expect(assetSource).toContain("<path d=");
    expect(assetSource).not.toContain("{...props}");
  });
});
