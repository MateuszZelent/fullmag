import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sanitizeViewport3DCanvasMeasure } from "./Viewport3DCanvas";

describe("Viewport3DCanvas", () => {
  it("passes only stable R3F size keys to root.configure", () => {
    const size = sanitizeViewport3DCanvasMeasure({
      bottom: 340,
      height: 240,
      left: 12,
      right: 332,
      top: 100,
      width: 320,
      x: 12,
      y: 100,
    } as DOMRectReadOnly);

    expect(size).toEqual({
      height: 240,
      left: 0,
      top: 0,
      width: 320,
    });
    expect(Object.keys(size).toSorted()).toEqual([
      "height",
      "left",
      "top",
      "width",
    ]);
  });

  it("renders scene changes without reconfiguring the R3F root", () => {
    const source = readFileSync(
      new URL("./Viewport3DCanvas.tsx", import.meta.url),
      "utf8",
    );
    const configureCall = source.indexOf(".configure({");
    const configureDependenciesStart = source.indexOf("  }, [", configureCall);
    const configureDependenciesEnd = source.indexOf("  ]);", configureDependenciesStart);
    const configureDependencies = source.slice(
      configureDependenciesStart,
      configureDependenciesEnd,
    );

    expect(configureCall).toBeGreaterThanOrEqual(0);
    expect(configureDependencies).not.toContain("children");
    expect(configureDependencies).not.toContain("fallback");
    expect(source).toContain("rootRef.current?.render(sceneContent);");
  });
});
