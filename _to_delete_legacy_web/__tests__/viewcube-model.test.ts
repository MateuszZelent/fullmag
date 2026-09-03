import { describe, expect, it } from "vitest";

import {
  buildViewCubeFaces,
  buildViewCubeTargetMap,
} from "../components/preview/viewcube/viewCubeModel";

describe("buildViewCubeFaces", () => {
  it("builds all six faces with a full 3x3 snap grid", () => {
    const faces = buildViewCubeFaces("identity");

    expect(faces).toHaveLength(6);
    expect(faces.every((face) => face.targets.length === 9)).toBe(true);
  });

  it("keeps 26 unique snap targets across faces", () => {
    const faces = buildViewCubeFaces("identity");
    const targets = buildViewCubeTargetMap(faces);

    expect(targets.size).toBe(26);
    expect(targets.has("right-top-front")).toBe(true);
    expect(targets.has("left-bottom-back")).toBe(true);
  });

  it("labels the top and front faces as physical Y and Z", () => {
    const faces = buildViewCubeFaces("identity");
    const topFace = faces.find((face) => face.id === "top");
    const frontFace = faces.find((face) => face.id === "front");

    expect(topFace?.targets[4]?.label).toBe("Y");
    expect(frontFace?.targets[4]?.label).toBe("Z");
  });
});
