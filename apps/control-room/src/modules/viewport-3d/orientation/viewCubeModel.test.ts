import { describe, expect, it } from "vitest";

import {
  buildViewCubeFaces,
  buildViewCubeTargetMap,
  getViewCubeAxisLabels,
  resolveViewCubeTargetCell,
} from "./viewCubeModel";

describe("view cube model", () => {
  it("keeps v1-compatible axis labels for the default scene convention", () => {
    expect(getViewCubeAxisLabels("identity")).toEqual({
      x: "+X",
      y: "+Y",
      z: "+Z",
    });
  });

  it("builds face, edge, and corner snap targets", () => {
    const targets = buildViewCubeTargetMap("identity");

    expect(targets.size).toBe(26);
    expect(targets.get("right")?.direction).toEqual([1, 0, 0]);
    expect(targets.get("top")?.direction).toEqual([0, 1, 0]);
    expect(targets.get("front")?.direction).toEqual([0, 0, 1]);
    expect(targets.get("right-top")?.direction).toEqual([1, 1, 0]);
    expect(targets.get("right-top-front")?.direction).toEqual([1, 1, 1]);
  });

  it("maps labels through the v1 swapYZ convention", () => {
    expect(getViewCubeAxisLabels("swapYZ")).toEqual({
      x: "+X",
      y: "+Z",
      z: "+Y",
    });
  });

  it("uses the v1 swapYZ convention by default", () => {
    expect(getViewCubeAxisLabels()).toEqual({
      x: "+X",
      y: "+Z",
      z: "+Y",
    });
  });

  it("builds the v1 face grid with face, edge, and corner snap targets", () => {
    const faces = buildViewCubeFaces("swapYZ");
    const topFace = faces.find((face) => face.id === "top");
    const frontFace = faces.find((face) => face.id === "front");

    expect(faces).toHaveLength(6);
    expect(faces.every((face) => face.targets.length === 9)).toBe(true);
    expect(topFace?.targets[0]).toMatchObject({
      direction: [-1, 1, 1],
      kind: "corner",
    });
    expect(topFace?.targets[1]).toMatchObject({
      direction: [0, 1, 1],
      kind: "edge",
    });
    expect(topFace?.targets[4]).toMatchObject({
      direction: [0, 1, 0],
      kind: "face",
      label: "Z",
    });
    expect(frontFace?.targets[4]).toMatchObject({
      direction: [0, 0, 1],
      kind: "face",
      label: "Y",
    });
  });

  it("keeps the v1 3x3 visible cell geometry for edges and corners", () => {
    const cells = Array.from({ length: 9 }, (_, index) =>
      resolveViewCubeTargetCell(index, 62, 10),
    );

    expect(cells[0]).toMatchObject({
      col: 0,
      height: 10,
      row: 0,
      width: 10,
      x: -26,
      y: 26,
    });
    expect(cells[1]).toMatchObject({
      col: 1,
      height: 10,
      row: 0,
      width: 42,
      x: 0,
      y: 26,
    });
    expect(cells[4]).toMatchObject({
      col: 1,
      height: 42,
      row: 1,
      width: 42,
      x: 0,
      y: 0,
    });
  });
});
