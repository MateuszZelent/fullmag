import { describe, expect, it } from "vitest";
import { resolveViewport3DCameraDepthRange } from "./viewport3DCameraClip";

const ringCamera = {
  position: { x: 1.6710714031932422e-7, y: -6.101199092239823e-7, z: 2.0428454917790962e-7 },
  target: { x: 0, y: 0, z: 1.55e-7 },
};
const universe = {
  center: [0, 0, 0] as [number, number, number],
  radius: 1.85e-6,
  size: [2.8e-6, 2.1e-6, 1.2e-6] as [number, number, number],
};
const direction = (from: typeof ringCamera.position, to: typeof ringCamera.target) => ({
  x: to.x - from.x, y: to.y - from.y, z: to.z - from.z,
});
const length = (value: typeof ringCamera.position) => Math.hypot(value.x, value.y, value.z);
const depthCode = (depth: number, near: number, far: number) =>
  Math.round((far / (far - near) - (far * near) / ((far - near) * depth)) * (2 ** 24 - 1));

describe("viewport camera depth range", () => {
  it("resolves thin surfaces while the eye is inside the universe sphere", () => {
    const forward = direction(ringCamera.position, ringCamera.target);
    const clip = resolveViewport3DCameraDepthRange(universe, ringCamera.position, forward, length(forward));
    const front = 6.34057e-7;
    expect(clip.near).toBeGreaterThan(5e-10);
    expect(clip.near).toBeLessThan(front / 100);
    expect(clip.far).toBeLessThan(1e-5);
    expect(depthCode(front + 1.6e-9, clip.near, clip.far) - depthCode(front, clip.near, clip.far)).toBeGreaterThan(20);
    expect(depthCode(front + 15e-9, 1e-12, 1e-3)).toBe(depthCode(front, 1e-12, 1e-3));
  });

  it("scales near and far with the same scene expressed at other physical scales", () => {
    const forward = direction(ringCamera.position, ringCamera.target);
    const baseline = resolveViewport3DCameraDepthRange(universe, ringCamera.position, forward, length(forward));
    for (const scale of [1e-6, 1e-3, 1e3, 1e6]) {
      const clip = resolveViewport3DCameraDepthRange(
        { center: [0, 0, 0], radius: universe.radius * scale, size: universe.size.map((n) => n * scale) as [number, number, number] },
        { x: ringCamera.position.x * scale, y: ringCamera.position.y * scale, z: ringCamera.position.z * scale },
        forward, length(forward) * scale,
      );
      expect(clip.near / scale / baseline.near).toBeCloseTo(1, 10);
      expect(clip.far / scale / baseline.far).toBeCloseTo(1, 10);
    }
  });

  it("keeps depth precision while panning past the universe centre plane", () => {
    for (const z of [-1e-9, 0, 1e-12, 1e-9]) {
      const clip = resolveViewport3DCameraDepthRange(
        universe, { x: 6e-7, y: 0, z }, { x: 0, y: 0, z: -1 }, 6e-7,
      );
      expect(clip.near).toBeCloseTo(6e-10, 20);
      expect(depthCode(6e-7 + 1.6e-9, clip.near, clip.far) - depthCode(6e-7, clip.near, clip.far)).toBeGreaterThan(20);
    }
  });

  it("caps near at close geometry and does not extend far to a distant target", () => {
    const radius = 5e-8;
    const front = 1e-12;
    const clip = resolveViewport3DCameraDepthRange(
      { center: [0, 0, 0], radius, size: [1e-7, 1e-7, 1e-7] },
      { x: 0, y: 0, z: radius + front }, { x: 0, y: 0, z: -1 }, 1,
    );
    expect(clip.near).toBeGreaterThan(0);
    expect(clip.near).toBeLessThan(front);
    expect(clip.far).toBeGreaterThan(radius * 2 + front);
    expect(clip.far).toBeLessThan(1e-6);
  });

  it("keeps orthographic depth resolution well below a thin film", () => {
    const forward = direction(ringCamera.position, ringCamera.target);
    const clip = resolveViewport3DCameraDepthRange(universe, ringCamera.position, forward, length(forward));
    expect((clip.far - clip.near) / (2 ** 24 - 1)).toBeLessThan(1.6e-9 / 1_000);
  });

  it("tracks dolly distance without requiring a saved camera pose", () => {
    for (const distance of [1e-10, 1e-8, 1e-6, 1e-3, 1]) {
      const clip = resolveViewport3DCameraDepthRange(
        universe, { x: 0, y: 0, z: distance }, { x: 0, y: 0, z: -1 }, distance,
      );
      expect(clip.near).toBeGreaterThan(0);
      expect(clip.near).toBeLessThan(distance);
      expect(clip.far).toBeGreaterThan(distance + universe.radius);
    }
  });
});
