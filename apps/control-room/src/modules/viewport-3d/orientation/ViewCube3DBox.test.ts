import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sourceUrl = new URL("./ViewCube3DBox.tsx", import.meta.url);

describe("ViewCube3DBox", () => {
  it("keeps orbit callbacks in latest refs without render-cycle effects", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("function useLatestRef");
    expect(source).toContain("const onOrbitRef = useLatestRef(onOrbit);");
    expect(source).toContain("const onOrbitEndRef = useLatestRef(onOrbitEnd);");
  });

  it("tracks orbit ring drags on window so leaving the canvas does not drop motion", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("const attachWindowDragListeners = useCallback");
    expect(source).toContain("const detachWindowDragListeners = useCallback");
    expect(source).toContain(
      'window.addEventListener("pointermove", dragMoveListener',
    );
    expect(source).toContain('window.addEventListener("pointerup", dragEndListener');
    expect(source).toContain(
      'window.addEventListener("pointercancel", dragEndListener',
    );
    expect(source).toContain("attachWindowDragListeners();");
    expect(source).not.toContain('canvas.addEventListener("pointermove", handleMove');
  });

  it("does not keep orbit ring pointermove attached while idle", () => {
    const source = readFileSync(sourceUrl, "utf8");
    const orbitRingBlock = source.slice(
      source.indexOf("function OrbitRing3D"),
      source.indexOf("function useLatestRef"),
    );
    const effectBlock = orbitRingBlock.slice(
      orbitRingBlock.indexOf("useEffect(() => {"),
      orbitRingBlock.indexOf("return ("),
    );

    expect(effectBlock).not.toContain(
      'window.addEventListener("pointermove", handleMove',
    );
    expect(effectBlock).toContain("detachWindowDragListeners();");
  });

  it("uses the native view cube hit path without a duplicate fallback mesh pointerdown", () => {
    const source = readFileSync(sourceUrl, "utf8");
    const fallbackBoxBlock = source.slice(
      source.indexOf("userData={{ viewCubeFallbackBox: true }}") - 220,
      source.indexOf("userData={{ viewCubeFallbackBox: true }}") + 80,
    );

    expect(fallbackBoxBlock).not.toContain("onPointerDown=");
  });

  it("uses double-sided hit panels so hidden-side wall, edge, and corner snaps remain clickable", () => {
    const source = readFileSync(sourceUrl, "utf8");
    const panelBlock = source.slice(
      source.indexOf("function ViewCubeFacePanel"),
      source.indexOf("function AutoOrientText"),
    );

    expect(source).toContain("DoubleSide");
    expect(panelBlock).toContain("side={DoubleSide}");
  });

  it("uses a native raycast fallback for screen-space box clicks", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain('addEventListener("pointerdown", handlePointerDown');
    expect(source).toContain("capture: true");
    expect(source).toContain("let cachedRect = element.getBoundingClientRect();");
    expect(source).toContain("new ResizeObserver");
    expect(source).toContain("raycaster.intersectObject(group, true)");
    expect(source).toContain("viewCubeTargetDirection");
    expect(source).toContain("viewCubeFallbackBox");
  });
});
