import { BoxGeometry, DoubleSide, InstancedMesh, Matrix4, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import type { FdmCuboidPickingGrid } from "./fdmCuboidBuildModel";
import { createFdmCuboidGridPicker } from "./fdmCuboidGridPicking";

const origin = [-8e-8, -2e-8, -1e-9] as const;
const spacing = [5e-9, 5e-9, 1e-9] as const;
const shape = [32, 8, 3] as const;

function center(cell: number, grid: FdmCuboidPickingGrid = { origin, spacing }, dimensions: readonly [number, number, number] = shape) {
  const [nx, ny] = dimensions;
  const coordinates = [cell % nx, Math.floor(cell / nx) % ny, Math.floor(cell / (nx * ny))];
  return new Vector3(...grid.origin).add(new Vector3(...grid.spacing).multiply(
    new Vector3(coordinates[0] + 0.5, coordinates[1] + 0.5, coordinates[2] + 0.5),
  ));
}

function carrier(
  indices: number[],
  fill = 0.92,
  grid: FdmCuboidPickingGrid = { origin, spacing },
  dimensions: readonly [number, number, number] = shape,
) {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), indices.length);
  const [dx, dy, dz] = grid.spacing;
  for (const [instance, cell] of indices.entries()) {
    mesh.setMatrixAt(instance, new Matrix4().makeScale(dx * fill, dy * fill, dz * fill).setPosition(center(cell, grid, dimensions)));
  }
  mesh.updateMatrixWorld();
  return {
    mesh,
    pick: createFdmCuboidGridPicker(grid, dimensions, Uint32Array.from(indices)),
  };
}

function compare(
  { mesh, pick }: ReturnType<typeof carrier>,
  raycaster: Raycaster,
  expectedOrdinal: number | null,
) {
  const native = raycaster.intersectObject(mesh, false)[0];
  const result = pick(raycaster, [mesh]);
  expect(native?.instanceId ?? null).toBe(expectedOrdinal);
  expect(result?.instanceId ?? null).toBe(expectedOrdinal);
  if (result && native) expect(result.point.distanceTo(native.point)).toBeLessThan(1e-15);
}

describe("FDM grid picking", () => {
  it("uses the visible instance order and passes through holes in the selected cells", () => {
    const view = carrier([521, 10, 9]);
    const start = center(9);
    compare(view, new Raycaster(start.clone().setZ(5e-9), new Vector3(0, 0, -1)), 0);
    compare(view, new Raycaster(start.clone().setZ(-5e-9), new Vector3(0, 0, 1)), 2);
    compare(view, new Raycaster(center(10).setZ(5e-9), new Vector3(0, 0, -1)), 1);
    view.mesh.count = 2;
    compare(view, new Raycaster(start.clone().setZ(-5e-9), new Vector3(0, 0, 1)), 0);
    view.mesh.visible = false;
    expect(view.pick(new Raycaster(start.clone().setZ(5e-9), new Vector3(0, 0, -1)), [view.mesh])).toBeNull();
  });

  it("uses real cuboid faces for gaps, material sidedness, and clipped rays", () => {
    const view = carrier([9, 10, 265, 521], 0.8);
    const start = center(9);
    compare(view, new Raycaster(start.clone().setX(start.x + spacing[0] / 2).setZ(8e-9), new Vector3(0, 0, -1)), null);
    compare(view, new Raycaster(start, new Vector3(0, 0, 1), 0, 1e-8), 2);
    view.mesh.material.side = DoubleSide;
    compare(view, new Raycaster(start, new Vector3(0, 0, 1), 0, 1e-8), 0);
    compare(view, new Raycaster(start, new Vector3(0, 0, 1), 0, 1e-10), null);
    compare(view, new Raycaster(center(9).setZ(6e-9), new Vector3(0, 0, -1), 5e-9), 2);
  });

  it("tests only the first intersected rendered box and skips expensive mesh scans on a miss", () => {
    const { mesh, pick } = carrier(Array.from({ length: 768 }, (_, index) => index));
    const readMatrix = vi.spyOn(mesh, "getMatrixAt");
    expect(pick(new Raycaster(new Vector3(0, 1, 1), new Vector3(0, 0, -1)), [mesh])).toBeNull();
    expect(readMatrix).not.toHaveBeenCalled();
    const hit = pick(new Raycaster(center(0).setZ(1e-8), new Vector3(0, 0, -1)), [mesh]);
    expect(hit?.instanceId).toBe(512);
    expect(readMatrix).toHaveBeenCalledTimes(1);
  });

  it("matches native picking along shared faces and at exact edge crossings", () => {
    const grid = { origin: [0, 0, 0], spacing: [1, 1, 1] } as const;
    const dimensions = [2, 2, 2] as const;
    const parallel = new Raycaster(new Vector3(1, 0.5, 3), new Vector3(0, 0, -1));
    compare(carrier([0], 1, grid, dimensions), parallel, 0);
    compare(carrier([0, 1], 1, grid, dimensions), parallel, 0);
    const diagonal = new Raycaster(new Vector3(-1, 3, 0.5), new Vector3(1, -1, 0).normalize());
    compare(carrier([0], 1, grid, dimensions), diagonal, 0);
    compare(carrier([0, 1], 1, grid, dimensions), diagonal, 0);
    const corner = new Raycaster(new Vector3(-1, 3, 3), new Vector3(1, -1, -1).normalize());
    compare(carrier([0], 1, grid, dimensions), corner, 0);
  });

  it("matches native picking for oblique rays in a scaled and rotated carrier", () => {
    const sparse = Array.from({ length: 768 }, (_, cell) => cell).filter(cell => cell % 5 > 1);
    const view = carrier(sparse);
    view.mesh.rotation.set(0.2, 0.5, -0.3);
    view.mesh.scale.set(1.4, 0.7, 2.2);
    view.mesh.position.set(2e-8, 4e-8, -3e-8);
    view.mesh.updateMatrixWorld();
    let hitCount = 0;
    for (let i = 0; i < 150; i += 1) {
      const destination = center((i * 31) % 768);
      const start = destination.clone().add(new Vector3((i % 13 - 6) * 5e-9, (i % 7 - 3) * 5e-9, 9e-9));
      destination.applyMatrix4(view.mesh.matrixWorld);
      start.applyMatrix4(view.mesh.matrixWorld);
      const ray = new Raycaster(start, destination.sub(start).normalize());
      const expected = ray.intersectObject(view.mesh, false)[0];
      compare(view, ray, expected?.instanceId ?? null);
      if (expected) hitCount += 1;
    }
    expect(hitCount).toBeGreaterThan(50);
  });
});
