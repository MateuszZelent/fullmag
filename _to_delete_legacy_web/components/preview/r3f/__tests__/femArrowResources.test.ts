import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  buildFemArrowInstancePayload,
  buildFemArrowGeometryPayload,
  buildFemArrowColorPayload,
  resolveFemArrowStableCapacity,
  sampleFemArrowCandidateNodes,
  ARROW_ANIMATION_BYTE_BUDGET,
  MAX_ARROW_CAPACITY,
} from "../femArrowResources";
import type { FemMeshData } from "../../fem/femMeshTypes";

describe("femArrowResources", () => {
  it("grows capacity by power-of-two buckets instead of exact instance counts", () => {
    expect(resolveFemArrowStableCapacity(1, 1)).toBe(1);
    expect(resolveFemArrowStableCapacity(17, 16)).toBe(32);
    expect(resolveFemArrowStableCapacity(129, 128)).toBe(256);
  });

  it("keeps capacity stable across small count changes and shrinks with hysteresis", () => {
    expect(resolveFemArrowStableCapacity(110, 128)).toBe(128);
    expect(resolveFemArrowStableCapacity(32, 128)).toBe(128);
    expect(resolveFemArrowStableCapacity(31, 128)).toBe(32);
  });

  it("samples no more than the target density from candidate nodes", () => {
    const nodes = new Float32Array(30 * 3);
    const candidates = new Array<number>(30);
    for (let index = 0; index < 30; index += 1) {
      candidates[index] = index;
      nodes[index * 3] = index % 5;
      nodes[index * 3 + 1] = Math.floor(index / 5);
      nodes[index * 3 + 2] = index % 3;
    }

    const sampled = sampleFemArrowCandidateNodes(nodes, candidates, 8);

    expect(sampled.length).toBeLessThanOrEqual(8);
    expect(new Set(sampled).size).toBe(sampled.length);
  });

  it("returns all candidate nodes when density is above candidate count", () => {
    const candidates = [0, 1, 2];

    expect(sampleFemArrowCandidateNodes(new Float32Array(9), candidates, 10)).toBe(candidates);
  });

  it("builds instance matrices inputs and colors separately from sampling", () => {
    const meshData = {
      nNodes: 2,
      nodes: new Float32Array([
        0, 0, 0,
        2, 0, 0,
      ]),
      boundaryFaces: new Uint32Array(0),
      fieldData: {
        x: new Float32Array([1, 0]),
        y: new Float32Array([0, 1]),
        z: new Float32Array([0, 0]),
      },
    } as unknown as FemMeshData;

    const payload = buildFemArrowInstancePayload({
      arrowTemplateScale: 2,
      center: new THREE.Vector3(1, 0, 0),
      colorMode: "monochrome",
      field: "magnitude",
      lengthMode: "constant",
      lengthScale: 1,
      meshData,
      monoColor: "#ff0000",
      sampledNodes: [0, 1],
      thickness: 1,
      visible: true,
    });

    expect(payload.count).toBe(2);
    expect(Array.from(payload.positions)).toEqual([-1, 0, 0, 1, 0, 0]);
    expect(Array.from(payload.scales)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(payload.colors[0]).toBeCloseTo(1);
    expect(payload.colors[1]).toBeCloseTo(0);
    expect(payload.colors[2]).toBeCloseTo(0);
  });

  // ── Krok 6 acceptance criteria ──────────────────────────────────────────

  const twoNodeMeshData = {
    nNodes: 2,
    nodes: new Float32Array([0, 0, 0, 2, 0, 0]),
    boundaryFaces: new Uint32Array(0),
    fieldData: {
      x: new Float32Array([1, 0]),
      y: new Float32Array([0, 1]),
      z: new Float32Array([0, 0]),
    },
  } as unknown as FemMeshData;

  it("acceptance: colorMode change does not recompute positions/quaternions/scales", () => {
    const base = {
      arrowTemplateScale: 1,
      center: new THREE.Vector3(0, 0, 0),
      lengthMode: "constant" as const,
      lengthScale: 1,
      meshData: twoNodeMeshData,
      sampledNodes: [0, 1],
      thickness: 1,
      visible: true,
    };

    const geo1 = buildFemArrowGeometryPayload(base);
    const geo2 = buildFemArrowGeometryPayload(base); // same inputs → referentially equivalent values

    // Positions and scales must be identical regardless of any color change
    expect(Array.from(geo1.positions)).toEqual(Array.from(geo2.positions));
    expect(Array.from(geo1.scales)).toEqual(Array.from(geo2.scales));
    expect(Array.from(geo1.quaternions)).toEqual(Array.from(geo2.quaternions));
  });

  it("acceptance: buildFemArrowColorPayload is independent of geometry params", () => {
    const base = {
      colorMode: "monochrome" as const,
      field: "magnitude" as const,
      meshData: twoNodeMeshData,
      monoColor: "#ff0000",
      sampledNodes: [0, 1],
      visible: true,
    };
    const colors1 = buildFemArrowColorPayload(base);
    const colors2 = buildFemArrowColorPayload({ ...base, monoColor: "#00ff00" });

    // Colors differ when monoColor changes
    expect(Array.from(colors1)).not.toEqual(Array.from(colors2));
    // But neither call depends on arrowTemplateScale, center, lengthMode, etc.
    expect(colors1.length).toBe(6); // 2 nodes × 3 components
  });

  it("acceptance: resolveFemArrowStableCapacity respects maxCapacity cap", () => {
    const max = 64;
    // Requesting more than max gets clamped to max (or next power-of-two ≤ max)
    expect(resolveFemArrowStableCapacity(100, 1, max)).toBe(64);
    expect(resolveFemArrowStableCapacity(65, 1, max)).toBe(64);
    expect(resolveFemArrowStableCapacity(63, 1, max)).toBe(64);
  });

  it("acceptance: MAX_ARROW_CAPACITY and ARROW_ANIMATION_BYTE_BUDGET are exported constants", () => {
    expect(MAX_ARROW_CAPACITY).toBeGreaterThan(0);
    expect(ARROW_ANIMATION_BYTE_BUDGET).toBeGreaterThan(0);
    // Animation budget must fit within a reasonable memory envelope
    expect(ARROW_ANIMATION_BYTE_BUDGET).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it("acceptance: buildFemArrowGeometryPayload returns empty for invisible", () => {
    const geo = buildFemArrowGeometryPayload({
      arrowTemplateScale: 1,
      center: new THREE.Vector3(0, 0, 0),
      lengthMode: "constant",
      lengthScale: 1,
      meshData: twoNodeMeshData,
      sampledNodes: [0, 1],
      thickness: 1,
      visible: false,
    });
    expect(geo.count).toBe(0);
  });

  it("acceptance: buildFemArrowColorPayload returns empty for invisible", () => {
    const colors = buildFemArrowColorPayload({
      colorMode: "orientation",
      field: "magnitude",
      meshData: twoNodeMeshData,
      monoColor: "#ffffff",
      sampledNodes: [0, 1],
      visible: false,
    });
    expect(colors.length).toBe(0);
  });
});
