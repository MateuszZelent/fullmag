import { describe, expect, it } from "vitest";

import { getScalarColorPaletteStops } from "@/shared/visualization/scalarColorPalette";

import {
  evaluateComplexFieldArray,
  evaluateComplexHarmonicQuadratureBasis,
  evaluateDirectionLinear,
  evaluateDirectionSrgb,
  evaluateFieldColorsLinear,
  evaluateFieldColorsSrgbUInt8,
  evaluateScalarPaletteLinear,
  evaluateScalarPaletteSrgb,
  linearToSrgbChannel,
  normalizeExport3DColorMode,
  quantizeLinearRgb,
  resolveFieldScalarRange,
  srgbToLinearChannel,
  srgbToLinearRgb,
} from "./export3dColorEvaluator";
import type { Export3DComplexFieldInput } from "./export3dTypes";

describe("export3dColorEvaluator", () => {
  it("converts sRGB <-> linear-sRGB channels accurately across piecewise boundary", () => {
    for (const srgb of [0, 0.02, 0.04044, 0.04046, 0.1, 0.5, 0.8, 1]) {
      const linear = srgbToLinearChannel(srgb);
      expect(linear).toBeGreaterThanOrEqual(0);
      expect(linear).toBeLessThanOrEqual(1);
      expect(linearToSrgbChannel(linear)).toBeCloseTo(srgb, 10);
    }
    // The published rounded cutoffs do not round-trip exactly at 0.04045.
    expect(srgbToLinearChannel(0.04045)).toBe(0.04045 / 12.92);
    expect(linearToSrgbChannel(0.0031308)).toBe(0.0031308 * 12.92);
    expect(linearToSrgbChannel(srgbToLinearChannel(0.04045))).toBeCloseTo(0.04045, 7);
    expect(srgbToLinearChannel(0.5)).toBeCloseTo(0.21404114048223255, 8);
  });

  it("matches mumax3 HSL direction color in sRGB and converts once to linear-sRGB", () => {
    expect(evaluateDirectionSrgb(1, 0, 0)).toEqual([1, 0, 0]);
    expect(evaluateDirectionSrgb(-1, 0, 0)).toEqual([0, 1, 1]);
    expect(evaluateDirectionSrgb(0, 0, 1)).toEqual([1, 1, 1]);
    expect(evaluateDirectionSrgb(0, 0, -1)).toEqual([0, 0, 0]);
    expect(evaluateDirectionSrgb(0, 0, 0)).toEqual([0.6, 0.6, 0.6]);

    // +45 deg tilt out of plane: mid-tone must be linear-converted once.
    const tiltedSrgb = evaluateDirectionSrgb(1, 0, 0.2);
    const tiltedLin = evaluateDirectionLinear(1, 0, 0.2);
    expect(tiltedLin[0]).toBeCloseTo(srgbToLinearChannel(tiltedSrgb[0]), 8);
    expect(tiltedLin[1]).toBeCloseTo(srgbToLinearChannel(tiltedSrgb[1]), 8);
    expect(tiltedLin[2]).toBeCloseTo(srgbToLinearChannel(tiltedSrgb[2]), 8);

    const neutralLin = evaluateDirectionLinear(0, 0, 0);
    expect(neutralLin[0]).toBeCloseTo(srgbToLinearChannel(0.6), 8);
  });

  it("supports all scalar palettes including twilight without viridis fallback or double linearization", () => {
    const twilightStops = getScalarColorPaletteStops("twilight");
    const tw0 = evaluateScalarPaletteSrgb(0, "twilight");
    const tw1 = evaluateScalarPaletteSrgb(1, "twilight");
    expect(tw0[0]).toBeCloseTo(twilightStops[0]![0], 6);
    expect(tw1[0]).toBeCloseTo(twilightStops[0]![0], 6);
    // Must not fall back to viridis at t = 0
    const vir0 = evaluateScalarPaletteSrgb(0, "viridis");
    expect(Math.abs(tw0[0] - vir0[0])).toBeGreaterThan(0.05);

    for (const palette of [
      "viridis",
      "inferno",
      "magma",
      "coolwarm",
      "jet",
      "plasma",
      "cividis",
      "turbo",
      "grayscale",
      "rdbu",
      "twilight",
    ] as const) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const srgb = evaluateScalarPaletteSrgb(t, palette);
        const linear = evaluateScalarPaletteLinear(t, palette);
        const expected = srgbToLinearRgb(srgb);
        expect(linear[0]).toBeCloseTo(expected[0], 10);
        expect(linear[1]).toBeCloseTo(expected[1], 10);
        expect(linear[2]).toBeCloseTo(expected[2], 10);
      }
    }
  });

  it("normalizes color mode aliases and auto-symmetrizes diverging signed components", () => {
    expect(normalizeExport3DColorMode("hsl")).toBe("orientation");
    expect(normalizeExport3DColorMode("hsl_direction")).toBe("orientation");
    expect(normalizeExport3DColorMode("HSL Sphere")).toBe("orientation");

    const values = new Float32Array([1, -5, 2, 3, 2, -1]);
    const divRange = resolveFieldScalarRange([values], 3, "y", "coolwarm");
    expect(divRange).toEqual({ min: -5, max: 5 });

    const seqRange = resolveFieldScalarRange([values], 3, "y", "viridis");
    expect(seqRange).toEqual({ min: -5, max: 2 });
  });

  it("evaluates complex phasor conventions, Floquet k_F spatial phase, and harmonic quadrature basis", () => {
    const complexField: Export3DComplexFieldInput = {
      kind: "complex",
      quantityId: "m_mode",
      componentCount: 3,
      realValues: new Float32Array([1, 0, 0, 0, 1, 0]),
      imagValues: new Float32Array([0, 2, 0, -1, 0, 0]),
      phasorConvention: "exp_i_omega_t",
      floquetSpatialConvention: "dst_equals_src_exp_minus_i_k_dot_delta_r",
      wavevectorKf: [Math.PI / 2, 0, 0],
      cellOriginM: [0, 0, 0],
      amplitudeScale: 2,
      complexRepresentation: "phase_rotated_real",
    };
    const positionsM = new Float32Array([0, 0, 0, 1, 0, 0]);

    const evalAtQuarter = evaluateComplexFieldArray(
      complexField,
      Math.PI / 2,
      positionsM,
    );
    // Point 0: spatialOffset = 0, theta = +pi/2 => 2 * (re*0 - im*1) = [0, -4, 0]
    expect(evalAtQuarter[0]).toBeCloseTo(0, 5);
    expect(evalAtQuarter[1]).toBeCloseTo(-4, 5);
    expect(evalAtQuarter[2]).toBeCloseTo(0, 5);

    // Point 1: spatialOffset = -pi/2, theta = 0 => 2 * re = [0, 2, 0]
    expect(evalAtQuarter[3]).toBeCloseTo(0, 5);
    expect(evalAtQuarter[4]).toBeCloseTo(2, 5);
    expect(evalAtQuarter[5]).toBeCloseTo(0, 5);

    // Verify exp_minus_i_omega_t reverses temporal rotation sign.
    const minusConvField: Export3DComplexFieldInput = {
      ...complexField,
      phasorConvention: "exp_minus_i_omega_t",
      wavevectorKf: null,
    };
    const evalMinus = evaluateComplexFieldArray(minusConvField, Math.PI / 2);
    // theta = -pi/2 => 2 * (re*0 - im*(-1)) = [0, +4, 0]
    expect(evalMinus[1]).toBeCloseTo(4, 5);

    // Verify exact equivalence of quadrature basis across arbitrary phi.
    const { cosBasis, sinBasis } = evaluateComplexHarmonicQuadratureBasis(
      complexField,
      positionsM,
    );
    for (const phi of [0, 0.37, 1.8, 3.7, 5.5]) {
      const exact = evaluateComplexFieldArray(complexField, phi, positionsM);
      for (let i = 0; i < exact.length; i += 1) {
        const reconstructed =
          Math.cos(phi) * cosBasis[i]! + Math.sin(phi) * sinBasis[i]!;
        expect(reconstructed).toBeCloseTo(exact[i]!, 5);
      }
    }

    // Verify abs & real & imag representations.
    const absEval = evaluateComplexFieldArray(
      { ...complexField, wavevectorKf: null, complexRepresentation: "abs" },
      0.5,
    );
    expect(absEval[0]).toBeCloseTo(2, 5);
    expect(absEval[1]).toBeCloseTo(4, 5);
  });

  it("evaluates linear-sRGB and UInt8 sRGB buffers including missing coverage fallback and quantization", () => {
    const values = new Float32Array([1, 0, 0, 0, 0, 1]);
    const linColors = evaluateFieldColorsLinear({
      values,
      componentCount: 3,
      colorMode: "orientation",
      colorPalette: "viridis",
      range: { min: 0, max: 1 },
      outputTargetIndices: [0, 1, 2],
      outputCount: 3,
      domainEntryCount: 3,
      fieldNodeIndices: [0, 1],
    });
    expect(linColors.slice(0, 3)).toEqual(new Float32Array([1, 0, 0]));
    expect(linColors.slice(3, 6)).toEqual(new Float32Array([1, 1, 1]));
    // Index 2 is uncovered -> neutral [0.5, 0.5, 0.5] sRGB linearized
    expect(linColors[6]).toBeCloseTo(srgbToLinearChannel(0.5), 6);

    const srgbBytes = evaluateFieldColorsSrgbUInt8({
      values,
      componentCount: 3,
      colorMode: "orientation",
      colorPalette: "viridis",
      range: { min: 0, max: 1 },
      outputTargetIndices: [0, 1, 2],
      outputCount: 3,
      domainEntryCount: 3,
      fieldNodeIndices: [0, 1],
    });
    expect(Array.from(srgbBytes)).toEqual([255, 0, 0, 255, 255, 255, 128, 128, 128]);

    const q = quantizeLinearRgb([1, 0, 0], 4);
    expect(q.key).toBe("3_0_0");
    expect(q.rgb[0]).toBeCloseTo(1, 6);
  });
});
