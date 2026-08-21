import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildViewport3DResourceFrameKey } from "./viewport3dInvalidation";

describe("buildViewport3DResourceFrameKey", () => {
  it("changes when viewport resources settle or fail", () => {
    const loading = buildViewport3DResourceFrameKey([
      { id: "scene", revision: null, status: "loading" },
      { id: "field", revision: null, status: "loading" },
    ]);
    const ready = buildViewport3DResourceFrameKey([
      { id: "scene", revision: 4, status: "ready" },
      { id: "field", revision: 9, status: "ready" },
    ]);
    const failed = buildViewport3DResourceFrameKey([
      { error: "404 /model/scene", id: "scene", revision: null, status: "error" },
      { id: "field", revision: null, status: "loading" },
    ]);

    expect(ready).not.toBe(loading);
    expect(failed).not.toBe(loading);
    expect(failed).toContain("404 /model/scene");
  });

  it("routes every viewport invalidation consumer through the one root-owned controller", () => {
    const source = readFileSync(
      new URL("./viewport3dBatchedInvalidate.ts", import.meta.url),
      "utf8",
    );
    const canvasSource = readFileSync(
      new URL("./Viewport3DCanvas.tsx", import.meta.url),
      "utf8",
    );
    const root = join(process.cwd(), "src/modules/viewport-3d");
    const sourceFiles = readdirSync(root, { recursive: true })
      .map((entry) => join(root, entry.toString()))
      .filter((entry) => /\.tsx?$/.test(entry))
      .filter((entry) => !/\.test\.tsx?$/.test(entry))
      .filter((entry) => !entry.endsWith("viewport3dBatchedInvalidate.ts"));

    expect(source).toContain("Viewport3DInvalidationProvider");
    expect(canvasSource).toContain("Viewport3DInvalidationProvider");
    for (const sourceFile of sourceFiles) {
      const sourceText = readFileSync(sourceFile, "utf8");
      const rawInvalidatePatterns = [
        /useThree\s*\(\s*\)\s*\.\s*invalidate/,
        /\b(?:const|let|var)\s*{[^;=]*\binvalidate\b[^;=]*}\s*=\s*useThree\s*\(\s*\)/,
        /useThree\s*\(\s*\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>\s*[A-Za-z_$][\w$]*\s*\.\s*invalidate\s*\)/,
        /useThree\s*\(\s*\(\s*{[\s\S]*?\binvalidate\b[\s\S]*?}\s*\)\s*=>/,
      ];
      for (const rawInvalidatePattern of rawInvalidatePatterns) {
        expect(sourceText, `${sourceFile} uses a raw R3F invalidation alias`).not.toMatch(
          rawInvalidatePattern,
        );
      }
    }
  });
});
