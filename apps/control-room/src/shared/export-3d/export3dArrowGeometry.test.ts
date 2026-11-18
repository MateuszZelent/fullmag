import { BufferAttribute, InterpolateLinear, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";

import {
  buildAnimatedArrowMeshesAndTracks,
  buildMergedStaticArrowGeometry,
  createUnitArrowGeometry,
  samplePointIndicesSpatially,
} from "./export3dArrowGeometry";
import { resolveCoordinateTransform } from "./export3dTypes";

describe("export3dArrowGeometry", () => {
  it("builds a unit +Y arrow mesh with strictly outward-facing CCW triangles", () => {
    const geom = createUnitArrowGeometry({ radialSegments: 8 });
    const pos = geom.getAttribute("position") as BufferAttribute;
    const norm = geom.getAttribute("normal") as BufferAttribute;
    const idx = geom.getIndex() as BufferAttribute;

    expect(pos.count).toBeGreaterThan(20);
    expect(idx.count % 3).toBe(0);

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(1, 6);

    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t);
      const b = idx.getX(t + 1);
      const c = idx.getX(t + 2);
      const ax = pos.getX(a);
      const ay = pos.getY(a);
      const az = pos.getZ(a);
      const abx = pos.getX(b) - ax;
      const aby = pos.getY(b) - ay;
      const abz = pos.getZ(b) - az;
      const acx = pos.getX(c) - ax;
      const acy = pos.getY(c) - ay;
      const acz = pos.getZ(c) - az;
      const cx = aby * acz - abz * acy;
      const cy = abz * acx - abx * acz;
      const cz = abx * acy - aby * acx;
      const dot = cx * norm.getX(a) + cy * norm.getY(a) + cz * norm.getZ(a);
      expect(dot).toBeGreaterThan(0);
    }

    geom.dispose();
  });

  it("samples arbitrary 3D point clouds deterministically within budget", () => {
    const pts = new Float32Array(100 * 3);
    for (let i = 0; i < 100; i += 1) {
      pts[i * 3] = (i % 10) * 1e-8;
      pts[i * 3 + 1] = Math.floor(i / 10) * 1e-8;
      pts[i * 3 + 2] = 0;
    }
    const sampled = samplePointIndicesSpatially(pts, 16);
    expect(sampled.length).toBe(16);
    expect(new Set(sampled).size).toBe(16);
  });

  it("merges static arrows with COLOR_0 and skips zero-magnitude entries", () => {
    const transform = resolveCoordinateTransform(null, "si_m");
    const built = buildMergedStaticArrowGeometry({
      anchorsM: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      vectors: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 1]),
      maxMagnitude: 1,
      baseArrowLengthM: 0.5,
      anchorMode: "tail",
      vectorLengthMode: "uniform",
      coordinateTransform: transform,
      colorMode: "orientation",
      colorPalette: "viridis",
      colorRange: { min: 0, max: 1 },
    });

    expect(built).not.toBeNull();
    expect(built!.arrowCount).toBe(2);
    const colorAttr = built!.geometry.getAttribute("color") as BufferAttribute;
    expect(colorAttr.itemSize).toBe(3);
    // Arrow 0 (+X) -> red [1, 0, 0], Arrow 1 (+Z) -> white [1, 1, 1]
    expect(colorAttr.getX(0)).toBeCloseTo(1, 5);
    expect(colorAttr.getY(0)).toBeCloseTo(0, 5);
    const unitCount = colorAttr.count / 2;
    expect(colorAttr.getX(unitCount)).toBeCloseTo(1, 5);
    expect(colorAttr.getY(unitCount)).toBeCloseTo(1, 5);
    expect(colorAttr.getZ(unitCount)).toBeCloseTo(1, 5);
    built!.geometry.dispose();
  });

  it("shares one unit arrow geometry, bounded quantized materials, and continuous 60fps TRS tracks", () => {
    const usedNames = new Set<string>();
    const siteCount = 30;
    const anchorsM = new Float32Array(siteCount * 3);
    for (let i = 0; i < siteCount; i += 1) {
      anchorsM[i * 3] = i * 1e-8;
      anchorsM[i * 3 + 1] = 0;
      anchorsM[i * 3 + 2] = 0;
    }

    const keyCount = 61;
    const times: number[] = [];
    const frameVectors: Float32Array[] = [];
    for (let f = 0; f < keyCount; f += 1) {
      times.push((f / (keyCount - 1)) * 1.0);
      const fv = new Float32Array(siteCount * 3);
      const phi = (f / (keyCount - 1)) * Math.PI * 2;
      for (let i = 0; i < siteCount; i += 1) {
        // Precess full circle in XY plane passing through -Y anti-parallel to +Y.
        fv[i * 3] = Math.sin(phi + i * 0.2);
        fv[i * 3 + 1] = Math.cos(phi + i * 0.2);
        fv[i * 3 + 2] = i === 0 && f === 30 ? 0 : 0.1 * Math.sin(i);
      }
      // Force an exact zero-crossing on site 1 at frame 15
      fv[1 * 3] = 0;
      fv[1 * 3 + 1] = 0;
      fv[1 * 3 + 2] = 0;
      frameVectors.push(fv);
    }

    const built = buildAnimatedArrowMeshesAndTracks({
      targetId: "film:layer[0]/mag.domain",
      anchorsM,
      frameVectors,
      keyframeTimes: times,
      maxMagnitude: 1,
      baseArrowLengthM: 5e-9,
      anchorMode: "center",
      vectorLengthMode: "proportional",
      coordinateTransform: resolveCoordinateTransform(null, "nm"),
      materialStyle: "unlit",
      opacity: 1,
      colorMode: "orientation",
      colorPalette: "viridis",
      colorRange: { min: 0, max: 1 },
      usedNodeNames,
      maxQuantizationLevels: 4,
    });

    expect(built).not.toBeNull();
    expect(built!.arrowCount).toBe(siteCount);
    expect(built!.meshes.length).toBe(siteCount);
    expect(built!.materials.length).toBeLessThanOrEqual(64);
    expect(built!.materials.length).toBeLessThan(siteCount);

    for (const mesh of built!.meshes) {
      expect(mesh.geometry).toBe(built!.sharedGeometry);
      expect(mesh.name).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(new Set(built!.meshes.map((m) => m.name)).size).toBe(siteCount);
    expect(built!.tracks.length).toBe(siteCount * 3);

    // Every quaternion track must maintain dot(q_prev, q_next) >= 0 across full 2*pi rotation.
    for (const track of built!.tracks) {
      expect(track.getInterpolation()).toBe(InterpolateLinear);
      if (track instanceof QuaternionKeyframeTrack) {
        const vals = track.values;
        for (let k = 0; k + 1 < times.length; k += 1) {
          const a = k * 4;
          const b = (k + 1) * 4;
          const dot =
            vals[a]! * vals[b]! +
            vals[a + 1]! * vals[b + 1]! +
            vals[a + 2]! * vals[b + 2]! +
            vals[a + 3]! * vals[b + 3]!;
          expect(dot).toBeGreaterThanOrEqual(-1e-6);
        }
      }
      if (track instanceof VectorKeyframeTrack) {
        for (let i = 0; i < track.values.length; i += 1) {
          expect(Number.isFinite(track.values[i])).toBe(true);
        }
      }
    }

    built!.sharedGeometry.dispose();
    for (const mat of built!.materials) mat.dispose();
  });
});
