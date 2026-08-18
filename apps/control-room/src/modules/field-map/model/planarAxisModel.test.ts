import { describe, expect, it } from "vitest";

import {
  resolvePlanarAxes,
  resolvePlanarProbeCoordinates,
} from "./planarAxisModel";

const bounds = [-4e-6, 6e-6, -2e-6, 3e-6] as const;
const origin = [0, 0, 0] as const;

describe("planar axis model", () => {
  it.each([
    [
      "xy",
      { normal: [0, -5e-10, 1], origin, uAxis: [1, 0, 5e-10], vAxis: [0, 1, 0] },
      { cut: "z", horizontal: "x", vertical: "y" },
    ],
    [
      "xz",
      { normal: [0, -1, 0], origin, uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
      { cut: "y", horizontal: "x", vertical: "z" },
    ],
    [
      "yz",
      { normal: [1, 0, 0], origin, uAxis: [0, 1, 0], vAxis: [0, 0, 1] },
      { cut: "x", horizontal: "y", vertical: "z" },
    ],
  ] as const)("infers the %s preset from its right-handed world basis", (preset, frame, labels) => {
    const axes = resolvePlanarAxes(frame, bounds, bounds, 640, 480);

    expect(axes.preset).toBe(preset);
    expect({
      cut: axes.cut.label,
      horizontal: axes.horizontal.label,
      vertical: axes.vertical.label,
    }).toEqual(labels);
  });

  it("classifies a deviation beyond the Cartesian tolerance as oblique", () => {
    const axes = resolvePlanarAxes(
      {
        normal: [0, 0, 1],
        origin,
        uAxis: [1, 0, 2e-9],
        vAxis: [0, 1, 0],
      },
      bounds,
      bounds,
      640,
      480,
    );

    expect(axes.preset).toBe("oblique");
    expect(axes.horizontal.label).toBe("x′");
    expect(axes.vertical.label).toBe("y′");
    expect(axes.cut.label).toBe("normal");
    expect(axes.horizontal.directionWorld).toEqual([1, 0, 2e-9]);
    expect(axes.vertical.directionWorld).toEqual([0, 1, 0]);
  });

  it("rejects a Cartesian-looking u/v pair with an inconsistent normal", () => {
    const axes = resolvePlanarAxes(
      {
        normal: [0, 0, -1],
        origin,
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
      },
      bounds,
      bounds,
      640,
      480,
    );

    expect(axes.preset).toBe("oblique");
  });

  it.each([
    [5e-7, "nm", 1e9],
    [5e-4, "µm", 1e6],
    [0.5, "mm", 1e3],
    [2, "m", 1],
  ] as const)(
    "selects one display unit from a largest visible span of %s metres",
    (span, unit, scale) => {
      const axes = resolvePlanarAxes(
        { normal: [0, 0, 1], origin, uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
        [0, span, 0, span / 2],
        [0, span, 0, span / 2],
        640,
        480,
      );

      expect(axes.displayLengthUnit).toEqual({ scale, symbol: unit });
    },
  );

  it("keeps asymmetric negative tick values in metres while formatting display-only labels", () => {
    const axes = resolvePlanarAxes(
      { normal: [0, 0, 1], origin, uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      [-3.7e-6, 8.2e-6, -1e-6, 1e-6],
      [-3.7e-6, 8.2e-6, -1e-6, 1e-6],
      900,
      480,
    );
    const ticks = axes.horizontal.ticks;

    expect(ticks[0]).toMatchObject({ endpoint: true, value: -3.7e-6 });
    expect(ticks.at(-1)).toMatchObject({ endpoint: true, value: 8.2e-6 });
    expect(ticks.find((tick) => tick.zero)).toMatchObject({ label: "0", value: 0 });
    expect(ticks.some((tick) => tick.label.includes("µm"))).toBe(false);
    expect(ticks.every((tick) => Number.isFinite(tick.value))).toBe(true);
  });

  it("uses only 1, 2, 2.5, 5, or 10 nice-step mantissas and adds ticks for wider plots", () => {
    const frame = {
      normal: [0, 0, 1] as const,
      origin,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    const narrow = resolvePlanarAxes(
      frame,
      [0, 0.013, 0, 0.004],
      [0, 0.013, 0, 0.004],
      240,
      480,
    );
    const wide = resolvePlanarAxes(
      frame,
      [0, 0.013, 0, 0.004],
      [0, 0.013, 0, 0.004],
      960,
      480,
    );

    for (const step of [narrow.horizontal.stepMetres, wide.horizontal.stepMetres]) {
      const exponent = Math.floor(Math.log10(step));
      const mantissa = step / 10 ** exponent;
      expect([1, 2, 2.5, 5, 10].some((value) => Math.abs(value - mantissa) < 1e-12)).toBe(true);
    }
    expect(wide.horizontal.stepMetres).toBeLessThan(narrow.horizontal.stepMetres);
    expect(wide.horizontal.ticks.length).toBeGreaterThan(narrow.horizontal.ticks.length);
  });

  it("filters colliding labels without removing endpoints or zero", () => {
    const axes = resolvePlanarAxes(
      { normal: [0, 0, 1], origin, uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      [-9.876543e-9, 12.345678e-9, -1e-9, 1e-9],
      [-9.876543e-9, 12.345678e-9, -1e-9, 1e-9],
      90,
      480,
    );

    expect(axes.horizontal.ticks).toHaveLength(3);
    expect(axes.horizontal.ticks.map((tick) => tick.value)).toEqual([
      -9.876543e-9,
      0,
      12.345678e-9,
    ]);
    expect(axes.horizontal.ticks.every((tick) => tick.endpoint || tick.zero)).toBe(true);
  });

  it("formats tiny and large ranges without changing their metre endpoints", () => {
    const frame = {
      normal: [0, 0, 1] as const,
      origin,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    const tiny = resolvePlanarAxes(
      frame,
      [-2e-12, 7e-12, 0, 1e-12],
      [-2e-12, 7e-12, 0, 1e-12],
      640,
      480,
    );
    const large = resolvePlanarAxes(
      frame,
      [-2e3, 7e3, 0, 1e3],
      [-2e3, 7e3, 0, 1e3],
      640,
      480,
    );

    expect(tiny.displayLengthUnit.symbol).toBe("nm");
    expect(tiny.horizontal.ticks[0]?.value).toBe(-2e-12);
    expect(tiny.horizontal.ticks.at(-1)?.value).toBe(7e-12);
    expect(large.displayLengthUnit.symbol).toBe("m");
    expect(large.horizontal.ticks[0]?.value).toBe(-2e3);
    expect(large.horizontal.ticks.at(-1)?.value).toBe(7e3);
    expect([...tiny.horizontal.ticks, ...large.horizontal.ticks].every((tick) => tick.label.length > 0)).toBe(true);
  });

  it("derives units and denser steps from the visible zoomed viewport", () => {
    const frame = {
      normal: [0, 0, 1] as const,
      origin,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    const full = resolvePlanarAxes(
      frame,
      [-2e-3, 2e-3, -1e-3, 1e-3],
      [-2e-3, 2e-3, -1e-3, 1e-3],
      640,
      480,
    );
    const zoomed = resolvePlanarAxes(
      frame,
      [-2e-3, 2e-3, -1e-3, 1e-3],
      [-4e-7, 6e-7, -2e-7, 2e-7],
      640,
      480,
    );

    expect(full.displayLengthUnit.symbol).toBe("mm");
    expect(zoomed.displayLengthUnit.symbol).toBe("µm");
    expect(zoomed.horizontal.rangeMetres).toEqual([-4e-7, 6e-7]);
    expect(zoomed.horizontal.stepMetres).toBeLessThan(full.horizontal.stepMetres);
  });

  it("uses the full panned viewport even where it extends outside target bounds", () => {
    const axes = resolvePlanarAxes(
      { normal: [0, 0, 1], origin, uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
      [-1, 1, -2, 2],
      [-3, 4, -5, 6],
      640,
      480,
    );

    expect(axes.horizontal.rangeMetres).toEqual([-3, 4]);
    expect(axes.vertical.rangeMetres).toEqual([-5, 6]);
  });

  it("uses plot height for vertical ticks and plot width for horizontal ticks", () => {
    const frame = {
      normal: [0, 0, 1] as const,
      origin,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    const wideShort = resolvePlanarAxes(frame, [0, 10, 0, 10], [0, 10, 0, 10], 1_200, 80);
    const narrowTall = resolvePlanarAxes(frame, [0, 10, 0, 10], [0, 10, 0, 10], 80, 1_200);

    expect(wideShort.horizontal.ticks.length).toBeGreaterThan(narrowTall.horizontal.ticks.length);
    expect(wideShort.vertical.ticks.length).toBeLessThan(narrowTall.vertical.ticks.length);
  });

  it("emits finite bounded fallback axes for non-finite and zero-span inputs", () => {
    const axes = resolvePlanarAxes(
      {
        normal: [0, 0, 1],
        origin: [Number.NaN, Number.POSITIVE_INFINITY, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
      },
      [Number.NaN, Number.POSITIVE_INFINITY, -3, 3],
      [Number.NaN, Number.POSITIVE_INFINITY, 2, 2],
      Number.NaN,
      Number.POSITIVE_INFINITY,
    );
    const numbers = [
      axes.displayLengthUnit.scale,
      ...axes.horizontal.rangeMetres,
      axes.horizontal.stepMetres,
      ...axes.horizontal.ticks.flatMap((tick) => [tick.positionPx, tick.value]),
      ...axes.vertical.rangeMetres,
      axes.vertical.stepMetres,
      ...axes.vertical.ticks.flatMap((tick) => [tick.positionPx, tick.value]),
    ];

    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(axes.horizontal.rangeMetres).toEqual([0, 1]);
    expect(axes.vertical.rangeMetres).toEqual([-3, 3]);
    expect(axes.horizontal.ticks.length).toBeLessThanOrEqual(32);
    expect(axes.vertical.ticks.length).toBeLessThanOrEqual(32);
    expect(axes).toMatchObject({
      horizontal: { label: "x′" },
      preset: "oblique",
      vertical: { label: "y′" },
    });
    expect(resolvePlanarProbeCoordinates(
      {
        normal: [0, 0, 1],
        origin: [Number.NaN, Number.POSITIVE_INFINITY, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
      },
      2,
      3,
    )).toMatchObject({
      horizontal: { label: "x′", valueMetres: 2 },
      preset: "oblique",
      vertical: { label: "y′", valueMetres: 3 },
    });
  });

  it("labels Cartesian ticks with world coordinates and preserves screen order for a reversed axis", () => {
    const axes = resolvePlanarAxes(
      {
        normal: [0, 0, -1],
        origin: [10, 20, 30],
        uAxis: [-1, 0, 0],
        vAxis: [0, 1, 0],
      },
      [-2, 3, -1, 2],
      [-2, 3, -1, 2],
      640,
      480,
    );

    expect(axes.preset).toBe("xy");
    expect(axes.horizontal.label).toBe("x");
    expect(axes.horizontal.rangeMetres).toEqual([12, 7]);
    expect(axes.horizontal.ticks[0]).toMatchObject({ endpoint: true, label: "12", value: 12 });
    expect(axes.horizontal.ticks.at(-1)).toMatchObject({ endpoint: true, label: "7", value: 7 });
    expect(axes.horizontal.ticks.map((tick) => tick.positionPx)).toEqual(
      [...axes.horizontal.ticks].map((tick) => tick.positionPx).sort((left, right) => left - right),
    );
    expect(axes.vertical.rangeMetres).toEqual([19, 22]);
  });

  it("keeps oblique axes in local coordinates even when the frame origin is offset", () => {
    const axes = resolvePlanarAxes(
      {
        normal: [0, 0, 1],
        origin: [100, 200, 300],
        uAxis: [Math.SQRT1_2, Math.SQRT1_2, 0],
        vAxis: [-Math.SQRT1_2, Math.SQRT1_2, 0],
      },
      [-2, 3, -1, 2],
      [-2, 3, -1, 2],
      640,
      480,
    );

    expect(axes.preset).toBe("oblique");
    expect(axes.horizontal.rangeMetres).toEqual([-2, 3]);
    expect(axes.vertical.rangeMetres).toEqual([-1, 2]);
  });

  it.each([
    [
      "xy",
      { normal: [0, 0, -1], origin: [10, 20, 30], uAxis: [-1, 0, 0], vAxis: [0, 1, 0] },
      [2, 3],
      { horizontal: { label: "x", valueMetres: 8 }, vertical: { label: "y", valueMetres: 23 } },
    ],
    [
      "xz",
      { normal: [0, -1, 0], origin: [10, 20, 30], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
      [2, 3],
      { horizontal: { label: "x", valueMetres: 12 }, vertical: { label: "z", valueMetres: 33 } },
    ],
    [
      "yz",
      { normal: [1, 0, 0], origin: [10, 20, 30], uAxis: [0, 1, 0], vAxis: [0, 0, 1] },
      [2, 3],
      { horizontal: { label: "y", valueMetres: 22 }, vertical: { label: "z", valueMetres: 33 } },
    ],
  ] as const)("reports %s probe positions in world coordinates", (_preset, frame, point, expected) => {
    expect(resolvePlanarProbeCoordinates(frame, point[0], point[1])).toMatchObject(expected);
  });

  it("reports oblique probe positions in the local primed frame", () => {
    const coordinates = resolvePlanarProbeCoordinates(
      {
        normal: [0, 0, 1],
        origin: [100, 200, 300],
        uAxis: [Math.SQRT1_2, Math.SQRT1_2, 0],
        vAxis: [-Math.SQRT1_2, Math.SQRT1_2, 0],
      },
      -2,
      3,
    );

    expect(coordinates).toMatchObject({
      horizontal: { label: "x′", valueMetres: -2 },
      preset: "oblique",
      vertical: { label: "y′", valueMetres: 3 },
    });
  });
});
