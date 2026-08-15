import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
const appRoot = join(process.cwd());

describe("RootLayout runtime config", () => {
  it("does not inject temporary browser config through inline scripts", () => {
    expect(source).toContain("<ThemeProvider>{children}</ThemeProvider>");
    expect(source).not.toContain("window.__FULLMAG_CONFIG__");
    expect(source).not.toContain("next/script");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("beforeInteractive");
    expect(source).not.toContain("disablePerformanceDiagnostics: false");
  });

  it("tolerates browser extensions adding attributes to the document body", () => {
    expect(source).toContain("<body suppressHydrationWarning>");
  });

  it("uses the project-root client instrumentation hook for early diagnostics", () => {
    expect(existsSync(join(appRoot, "instrumentation-client.ts"))).toBe(true);
  });
});
