import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createViewport3DCanvasLifecycleController,
  sanitizeViewport3DCanvasMeasure,
} from "./Viewport3DCanvas";

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

  it("invalidates an in-flight configure before teardown and balances strict mount cycles", () => {
    const lifecycle = createViewport3DCanvasLifecycleController();

    for (let cycle = 0; cycle < 100; cycle += 1) {
      lifecycle.mountRoot();
      const configureGeneration = lifecycle.startConfigure();
      lifecycle.eventsConnected();
      lifecycle.contextCreated();
      expect(lifecycle.isCurrentConfigure(configureGeneration)).toBe(true);

      lifecycle.unmountRoot();
      expect(lifecycle.isCurrentConfigure(configureGeneration)).toBe(false);
    }

    expect(lifecycle.getSnapshot()).toEqual({
      activeRoots: 0,
      configureCompleted: 0,
      configureStarted: 100,
      contextCreated: 100,
      contextDisposed: 100,
      eventConnections: 100,
      eventDisconnections: 100,
      rootsCreated: 100,
      rootsUnmounted: 100,
    });
  });

  it("rejects a second R3F root while the canvas root is active", () => {
    const lifecycle = createViewport3DCanvasLifecycleController();
    lifecycle.mountRoot();

    expect(() => lifecycle.mountRoot()).toThrow("already active");
  });

  it("records a typed frame-commit reason for every committed R3F frame", () => {
    const source = readFileSync(
      new URL("./layers/CanvasLifecycleProbe.tsx", import.meta.url),
      "utf8",
    );

    const frameStart = source.indexOf("useFrame(() => {");
    const firstFrameWindowRead = source.indexOf(
      "const now = performance.now();",
      frameStart,
    );

    expect(frameStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(frameStart, firstFrameWindowRead)).toContain(
      'tracker.recordDirtyFrame("frame-commit")',
    );
  });

  it("keeps session identity changes in the bounded dirty-reason contract", () => {
    const source = readFileSync(
      new URL("./viewport3dTypes.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('"session-identity-changed"');
  });
});
