import { describe, expect, it } from "vitest";
import { Mesh, Object3D, Ray, Vector3 } from "three";

import {
  eventIntersectsRegionOverlay,
  pickRegionOverlayFromRay,
} from "./regionOverlayPicking";
import type { RegionOverlayModel } from "./regionOverlayModel";

const baseRegion = {
  color: "red",
  enabled: true,
  label: "Core",
  meshPartIds: null,
  objectId: "film",
  priority: null,
  regionId: "core",
  selected: false,
  slot: 0,
  style: {
    wireframeColor: null,
    wireframeOpacity: 0.72,
    wireframeScale: 1.004,
    wireframeVisible: true,
  },
  transform: {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
  },
} as const;

describe("regionOverlayPicking", () => {
  it("detects region overlay hits through parent object names", () => {
    const fdmSurface = new Mesh();
    const regionGroup = new Object3D();
    const regionSurface = new Mesh();

    regionGroup.name = "region-overlay:film:core";
    regionGroup.add(regionSurface);

    expect(
      eventIntersectsRegionOverlay({
        intersections: [
          { object: fdmSurface },
          { object: regionSurface },
        ],
      }),
    ).toBe(true);
  });

  it("ignores ordinary mesh intersections", () => {
    expect(
      eventIntersectsRegionOverlay({
        intersections: [{ object: new Mesh() }],
      }),
    ).toBe(false);
  });

  it("picks the nearest sphere region from a world-space ray", () => {
    const region = {
      ...baseRegion,
      center: [0, 0, 0],
      kind: "sphere",
      radius: 1,
    } satisfies RegionOverlayModel;

    expect(
      pickRegionOverlayFromRay(
        new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1)),
        [region],
      ),
    ).toEqual({ objectId: "film", regionId: "core" });
  });

  it("picks box and cylinder regions without relying on R3F intersection ordering", () => {
    const box = {
      ...baseRegion,
      center: [0, 0, 0],
      kind: "box",
      regionId: "box",
      size: [2, 2, 2],
    } satisfies RegionOverlayModel;
    const cylinder = {
      ...baseRegion,
      axis: [0, 0, 1],
      center: [4, 0, 0],
      height: 2,
      kind: "cylinder",
      radius: 1,
      regionId: "cylinder",
    } satisfies RegionOverlayModel;

    expect(
      pickRegionOverlayFromRay(
        new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1)),
        [box, cylinder],
      ),
    ).toEqual({ objectId: "film", regionId: "box" });
    expect(
      pickRegionOverlayFromRay(
        new Ray(new Vector3(4, 0, 5), new Vector3(0, 0, -1)),
        [box, cylinder],
      ),
    ).toEqual({ objectId: "film", regionId: "cylinder" });
  });
});
