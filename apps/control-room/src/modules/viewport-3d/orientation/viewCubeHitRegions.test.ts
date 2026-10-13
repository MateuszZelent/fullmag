import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { buildViewCubeFaces, resolveViewCubeBoxHitDirection, resolveViewCubeTargetCell, viewCubeFaceMatrix } from "./viewCubeModel";
import { VIEW_CUBE_FACE_SIZE, VIEW_CUBE_EDGE_SIZE, VIEW_CUBE_HALF } from "./orientationHudConstants";

describe("ViewCube rendered hit regions", () => {
  for (const face of buildViewCubeFaces()) {
    it(`${face.id}: uses an outward, non-mirrored face basis`, () => {
      expect(viewCubeFaceMatrix(face, VIEW_CUBE_HALF).determinant()).toBeCloseTo(1);
    });

    it(`${face.id}: all nine cell centers match their physical directions`, () => {
      const matrix = viewCubeFaceMatrix(face, VIEW_CUBE_HALF);
      for (const [index, target] of face.targets.entries()) {
        const cell = resolveViewCubeTargetCell(index, VIEW_CUBE_FACE_SIZE, VIEW_CUBE_EDGE_SIZE);
        const point = new Vector3(cell.x, cell.y, 0).applyMatrix4(matrix);
        expect(resolveViewCubeBoxHitDirection(point.toArray(), VIEW_CUBE_FACE_SIZE, VIEW_CUBE_EDGE_SIZE)).toEqual(target.direction);
      }
    });
  }
  it("preserves all 26 directions", () => {
    expect(new Set(buildViewCubeFaces().flatMap((face) => face.targets.map((target) => target.direction.join(",")))).size).toBe(26);
  });
});
