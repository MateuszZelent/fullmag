import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

describe("RootLayout runtime config", () => {
  it("does not inject temporary browser config through inline scripts", () => {
    expect(source).toContain("<ThemeProvider>{children}</ThemeProvider>");
    expect(source).not.toContain("window.__FULLMAG_CONFIG__");
    expect(source).not.toContain("next/script");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("beforeInteractive");
    expect(source).not.toContain("disablePerformanceDiagnostics: false");
  });
});
