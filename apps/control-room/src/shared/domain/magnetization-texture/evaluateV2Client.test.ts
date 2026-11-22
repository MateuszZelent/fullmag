import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { presetMagnetizationAsset } from "./assetFactory";
import { resolveTargetBoundsMeters } from "./boundsResolver";
import {
  eulerDegreesToQuaternion,
  evaluatePresetTextureV2Points,
  quaternionToEulerDegrees,
  rotateVectorByQuaternion,
  samplePresetTextureV2Batch,
  samplePresetTextureV2Client,
} from "./evaluateV2Client";
import {
  buildPresetSpecFromDraft,
  computeRelativePresetDefaults,
  createDefaultMagneticTextureDraft,
  fitCharacteristicSizeToTarget,
  formatMagneticTexturePythonExpression,
  hydrateMagneticTextureDraftFromInitializer,
  serializeMagneticTextureDraftToInitializer,
  synchronizePlaneAndProjection,
  validateMagneticTextureDraft,
  validateScaleMultiplier,
} from "./presetDefaults";

interface ParityFixtureCase {
  preset_kind: string;
  preset_version: number;
  params: Record<string, unknown>;
  projection: "object_local" | "planar_xy" | "planar_xz" | "planar_yz";
  rotation_quat: [number, number, number, number] | null;
  points: [number, number, number][];
  expected: [number, number, number][];
}

function maxInfinityNormDiff(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
): number {
  return Math.max(
    Math.abs(actual[0] - expected[0]),
    Math.abs(actual[1] - expected[1]),
    Math.abs(actual[2] - expected[2]),
  );
}

describe("magnetization-texture V2 client evaluator, bounds and Fit Characteristic Size", () => {
  it("matches_rust_and_python_v2_reference_vectors_within_1e_12", () => {
    const fixturePath = resolve(
      process.cwd(),
      "../../crates/fullmag-plan/tests/fixtures/magnetization_textures_v2_parity.json",
    );
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as ParityFixtureCase[];
    expect(cases).toHaveLength(16);

    for (const testCase of cases) {
      const evaluated = evaluatePresetTextureV2Points(
        testCase.preset_kind,
        testCase.params,
        testCase.points,
        {
          projection: testCase.projection,
          rotationQuat: testCase.rotation_quat,
        },
      );
      expect(evaluated).toHaveLength(testCase.expected.length);
      let maxErr = 0;
      for (let i = 0; i < evaluated.length; i += 1) {
        const err = maxInfinityNormDiff(evaluated[i]!, testCase.expected[i]!);
        if (err > maxErr) maxErr = err;
      }
      expect(maxErr, `${testCase.preset_kind} max abs error`).toBeLessThan(1e-12);
    }

    // Verify all 4 Wave-2 presets (skyrmion_lattice, spiral, bloch_point, artificial_spin_ice)
    const samplePts: [number, number, number][] = [
      [0, 0, 0],
      [15e-9, 0, 0],
      [0, 20e-9, 5e-9],
      [-30e-9, 12e-9, -4e-9],
      [60e-9, 0, 0],
    ];

    const skHexSpec = {
      preset_kind: "skyrmion_lattice",
      preset_version: 2 as const,
      preset_params: {
        plane: "xy",
        lattice: "hexagonal",
        lattice_constant: 60e-9,
        radius: 15e-9,
        wall_width: 4e-9,
        kind: "bloch",
        core_polarity: -1,
        chirality: 1,
      },
    };
    const skOrigin = samplePresetTextureV2Client(skHexSpec, samplePts[0]!);
    const skBravais = samplePresetTextureV2Client(skHexSpec, samplePts[4]!);
    expect(maxInfinityNormDiff(skOrigin, skBravais)).toBeLessThan(1e-12);
    expect(skOrigin[2]).toBeLessThan(-0.99);

    const spiralSpec = {
      preset_kind: "spiral",
      preset_version: 2 as const,
      preset_params: {
        spiral_kind: "cycloidal",
        wavelength: 40e-9,
        propagation_axis: [1, 0, 0],
        chirality: 1,
        phase_rad: 0,
      },
    };
    const sp0 = samplePresetTextureV2Client(spiralSpec, [0, 0, 0]);
    const spQuarter = samplePresetTextureV2Client(spiralSpec, [10e-9, 0, 0]);
    const spFull = samplePresetTextureV2Client(spiralSpec, [40e-9, 0, 0]);
    expect(maxInfinityNormDiff(sp0, spFull)).toBeLessThan(1e-12);
    expect(
      Math.abs(sp0[0] * spQuarter[0] + sp0[1] * spQuarter[1] + sp0[2] * spQuarter[2]),
    ).toBeLessThan(1e-12);

    const bpSpec = {
      preset_kind: "bloch_point",
      preset_version: 2 as const,
      preset_params: {
        bp_kind: "circulating",
        polarity: 1,
        twist_rad: Math.PI / 2,
        core_radius: 1e-9,
      },
      mapping: { space: "object" as const, projection: "object_local" as const, clamp_mode: "none" as const },
    };
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(bpSpec, [0, 0, 0]), [0, 0, 1])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(bpSpec, [0, 0, 10e-9]), [0, 0, 1])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(bpSpec, [0, 0, -10e-9]), [0, 0, -1])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(bpSpec, [10e-9, 0, 0]), [0, 1, 0])).toBeLessThan(1e-12);

    const asiSpec = {
      preset_kind: "artificial_spin_ice",
      preset_version: 2 as const,
      preset_params: {
        plane: "xy",
        lattice: "square",
        vertex_state: "type_i_ground",
        pitch: 50e-9,
      },
    };
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(asiSpec, [25e-9, 0, 0]), [1, 0, 0])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(asiSpec, [-25e-9, 0, 0]), [-1, 0, 0])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(asiSpec, [0, 25e-9, 0]), [0, -1, 0])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(samplePresetTextureV2Client(asiSpec, [0, -25e-9, 0]), [0, 1, 0])).toBeLessThan(1e-12);

    // Verify all 3 planes (xy, xz, yz) right-handed frame orientation (for xz, e_n = -e_y!)
    for (const [plane, expectedCore] of [
      ["xy", [0, 0, 1]],
      ["xz", [0, -1, 0]],
      ["yz", [1, 0, 0]],
    ] as const) {
      const mCore = samplePresetTextureV2Client(
        {
          preset_kind: "vortex",
          preset_version: 2,
          preset_params: { plane, circulation: 1, core_polarity: 1, core_radius: 5e-9 },
        },
        [0, 0, 0],
      );
      expect(maxInfinityNormDiff(mCore, expectedCore)).toBeLessThan(1e-12);
    }

    // Verify rotate_vectors: true vs false (45 deg Z rotation on Bloch domain wall)
    const qRotZ45 = eulerDegreesToQuaternion([0, 0, 45]);
    const wallParams = {
      width: 10e-9,
      kind: "bloch",
      normal_axis: "x",
      left: [0, 0, 1],
      right: [0, 0, -1],
    };
    const mSpaceOnly = samplePresetTextureV2Client(
      {
        preset_kind: "domain_wall",
        preset_version: 2,
        preset_params: wallParams,
        texture_transform: {
          translation: [0, 0, 0],
          rotation_quat: qRotZ45,
          scale: [1, 1, 1],
          pivot: [0, 0, 0],
          rotate_vectors: false,
        },
      },
      [-20e-9, 20e-9, 0],
    );
    const mSpaceAndSpins = samplePresetTextureV2Client(
      {
        preset_kind: "domain_wall",
        preset_version: 2,
        preset_params: wallParams,
        texture_transform: {
          translation: [0, 0, 0],
          rotation_quat: qRotZ45,
          scale: [1, 1, 1],
          pivot: [0, 0, 0],
          rotate_vectors: true,
        },
      },
      [-20e-9, 20e-9, 0],
    );
    const invSqrt2 = Math.SQRT1_2;
    expect(maxInfinityNormDiff(mSpaceOnly, [0, -1, 0])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(mSpaceAndSpins, [invSqrt2, -invSqrt2, 0])).toBeLessThan(1e-12);

    // Verify all 5 clamp_mode modes: none, clamp, repeat, mirror, background
    const period: [number, number, number] = [50e-9, 50e-9, 5e-9];
    const baseSkyrmionParams = {
      plane: "xy",
      radius: 15e-9,
      wall_width: 4e-9,
      core_polarity: -1,
      chirality: 1,
    };
    const mRepeatBase = samplePresetTextureV2Client(
      {
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: baseSkyrmionParams,
        mapping: { space: "object", projection: "object_local", clamp_mode: "repeat", tile_period: period },
      },
      [10e-9, -5e-9, 0],
    );
    const mRepeatShifted = samplePresetTextureV2Client(
      {
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: baseSkyrmionParams,
        mapping: { space: "object", projection: "object_local", clamp_mode: "repeat", tile_period: period },
      },
      [60e-9, 45e-9, 0],
    );
    expect(maxInfinityNormDiff(mRepeatBase, mRepeatShifted)).toBeLessThan(1e-12);

    const mMirror10 = samplePresetTextureV2Client(
      {
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: baseSkyrmionParams,
        mapping: { space: "object", projection: "object_local", clamp_mode: "mirror", tile_period: period },
      },
      [10e-9, 0, 0],
    );
    const mMirror40 = samplePresetTextureV2Client(
      {
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: baseSkyrmionParams,
        mapping: { space: "object", projection: "object_local", clamp_mode: "mirror", tile_period: period },
      },
      [40e-9, 0, 0],
    );
    expect(maxInfinityNormDiff(mMirror10, mMirror40)).toBeLessThan(1e-12);

    const mClampEdge = samplePresetTextureV2Client(
      {
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: baseSkyrmionParams,
        mapping: { space: "object", projection: "object_local", clamp_mode: "clamp", tile_period: period },
      },
      [25e-9, 0, 0],
    );
    const mClampFar = samplePresetTextureV2Client(
      {
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: baseSkyrmionParams,
        mapping: { space: "object", projection: "object_local", clamp_mode: "clamp", tile_period: period },
      },
      [80e-9, 0, 0],
    );
    expect(maxInfinityNormDiff(mClampEdge, mClampFar)).toBeLessThan(1e-12);

    const mBackgroundOut = samplePresetTextureV2Client(
      {
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: baseSkyrmionParams,
        mapping: {
          space: "object",
          projection: "object_local",
          clamp_mode: "background",
          tile_period: period,
          background_vector: [0, 3, 4],
        },
      },
      [40e-9, 0, 0],
    );
    expect(maxInfinityNormDiff(mBackgroundOut, [0, 0.6, 0.8])).toBeLessThan(1e-12);

    // Verify Euler XYZ <-> Hamilton quaternion q = q_z * q_y * q_x exact round-trip
    const euler: [number, number, number] = [30, 45, 60];
    const quat = eulerDegreesToQuaternion(euler);
    const recoveredEuler = quaternionToEulerDegrees(quat);
    expect(maxInfinityNormDiff(recoveredEuler, euler)).toBeLessThan(1e-12);

    // Check R(q)v === Rz(60) * Ry(45) * Rx(30) * v
    const testVec: [number, number, number] = [0.3, -0.7, 1.2];
    const rx = (30 * Math.PI) / 180;
    const ry = (45 * Math.PI) / 180;
    const rz = (60 * Math.PI) / 180;
    const v1: [number, number, number] = [
      testVec[0],
      testVec[1] * Math.cos(rx) - testVec[2] * Math.sin(rx),
      testVec[1] * Math.sin(rx) + testVec[2] * Math.cos(rx),
    ];
    const v2: [number, number, number] = [
      v1[0] * Math.cos(ry) + v1[2] * Math.sin(ry),
      v1[1],
      -v1[0] * Math.sin(ry) + v1[2] * Math.cos(ry),
    ];
    const v3: [number, number, number] = [
      v2[0] * Math.cos(rz) - v2[1] * Math.sin(rz),
      v2[0] * Math.sin(rz) + v2[1] * Math.cos(rz),
      v2[2],
    ];
    expect(maxInfinityNormDiff(rotateVectorByQuaternion(testVec, quat), v3)).toBeLessThan(1e-14);
  });

  it("fitCharacteristicSize_sets_metric_nm_params_while_keeping_unit_scale_1_1_1", () => {
    const scene = {
      revision: 1,
      objects: [
        {
          id: "nanodisk",
          name: "Nanodisk",
          role: "magnet",
          geometry: {
            geometry_kind: "Cylinder",
            geometry_params: { radius: 50e-9, height: 5e-9 },
          },
        },
      ],
    };
    const bounds = resolveTargetBoundsMeters(scene as never, {
      kind: "object",
      objectId: "nanodisk",
    });
    expect(bounds.size[0]).toBeCloseTo(100e-9, 18);
    expect(bounds.size[1]).toBeCloseTo(100e-9, 18);
    expect(bounds.size[2]).toBeCloseTo(5e-9, 18);
    expect(bounds.source).toBe("object-primitive");

    // 1. Bloch skyrmion with corrupted scale [1e-7, 1e-7, 5e-9] -> Fit Characteristic Size resets scale to [1,1,1] and sets R = 25 nm, wall_width = 5 nm
    const skyrmionDraft = {
      ...createDefaultMagneticTextureDraft("bloch_skyrmion", bounds),
      scale: [1e-7, 1e-7, 5e-9] as [number, number, number],
      corePolarity: 1 as const,
      chirality: -1 as const,
    };
    const fittedSkyrmion = fitCharacteristicSizeToTarget(skyrmionDraft, bounds);
    expect(fittedSkyrmion.scale).toEqual([1, 1, 1]);
    expect(fittedSkyrmion.radiusM).toBeCloseTo(25e-9, 18);
    expect(fittedSkyrmion.wallWidthM).toBeCloseTo(5e-9, 18);
    // Preserves topological invariants chosen by the user
    expect(fittedSkyrmion.corePolarity).toBe(1);
    expect(fittedSkyrmion.chirality).toBe(-1);

    // 2. Helical on 100 nm x 100 nm x 5 nm -> wavelength = 50 nm (|q| = 2π / 50e-9 ≈ 1.256637e8 m^-1)
    const helicalDefaults = computeRelativePresetDefaults("helical", bounds);
    const q = helicalDefaults.wavevector as [number, number, number];
    const qNorm = Math.hypot(q[0], q[1], q[2]);
    expect(qNorm).toBeCloseTo((2 * Math.PI) / 50e-9, 2);

    const helicalDraft = {
      ...createDefaultMagneticTextureDraft("helical", bounds),
      scale: [2, 3, 4] as [number, number, number],
    };
    const fittedHelical = fitCharacteristicSizeToTarget(helicalDraft, bounds);
    expect(fittedHelical.scale).toEqual([1, 1, 1]);
    expect(fittedHelical.wavelengthM).toBeCloseTo(50e-9, 18);
    expect(Math.hypot(...fittedHelical.wavevectorPerM)).toBeCloseTo(1.2566370614359173e8, 2);

    // 3. Synchronization eliminates ConflictingPlane
    const sync2d = synchronizePlaneAndProjection("vortex", "auto", "xz", "planar_yz", bounds);
    expect(sync2d.resolvedPlane).toBe("xy");
    expect(sync2d.mappingProjection).toBe("planar_xy");

    const sync3d = synchronizePlaneAndProjection("hopfion", "xz", "xz", "planar_xz", bounds);
    expect(sync3d.mappingProjection).toBe("object_local");
  });

  it("rejects_metric_meters_entered_into_dimensionless_scale_multiplier", () => {
    const expectedMessage =
      "Scale is a dimensionless multiplier around 1.0 — set physical nm dimensions in Preset Parameters above.";
    expect(validateScaleMultiplier([1e-7, 1e-7, 1])).toBe(expectedMessage);
    expect(validateScaleMultiplier([1, 1e-8, 1])).toBe(expectedMessage);
    expect(validateScaleMultiplier([1, 1, 1])).toBeNull();
    expect(validateScaleMultiplier([-1, 2.5, 0.5])).toBeNull();

    const bounds = resolveTargetBoundsMeters(null, { kind: "object", objectId: "disk" });
    const invalidDraft = {
      ...createDefaultMagneticTextureDraft("bloch_skyrmion", bounds),
      scale: [1e-7, 1e-7, 1] as [number, number, number],
    };
    const errors = validateMagneticTextureDraft(invalidDraft);
    expect(errors.get("scale")).toBe(expectedMessage);
  });

  it("preserves_two_domain_smooth_wall_width_and_domain_wall_custom_center_spin", () => {
    const bounds = resolveTargetBoundsMeters(null, { kind: "object", objectId: "strip" });

    // Round-trip smooth two_domain(sharp=false, wall_width=5e-9)
    const smoothTwoDomainInit = {
      kind: "preset_texture",
      preset_kind: "two_domain",
      preset_version: 2,
      preset_params: {
        normal_axis: "x",
        left: [1, 0, 0],
        right: [0, 1, 0],
        wall: [Math.SQRT1_2, Math.SQRT1_2, 0],
        sharp: false,
        wall_width: 5e-9,
      },
      mapping: { space: "object", projection: "object_local", clamp_mode: "none" },
      texture_transform: {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
        rotate_vectors: true,
      },
    };
    const hydratedTwoDomain = hydrateMagneticTextureDraftFromInitializer(
      smoothTwoDomainInit,
      bounds,
      "object",
    );
    expect(hydratedTwoDomain.twoDomainSharp).toBe(false);
    expect(hydratedTwoDomain.wallWidthM).toBeCloseTo(5e-9, 18);

    const serializedTwoDomain = serializeMagneticTextureDraftToInitializer(
      hydratedTwoDomain,
      bounds,
    );
    expect(serializedTwoDomain.preset_params).toMatchObject({
      sharp: false,
      wall_width: 5e-9,
    });

    // Round-trip domain_wall with custom wall_center_direction & validate antiparallel + orthogonal rules
    const customDomainWallInit = {
      kind: "preset_texture",
      preset_kind: "domain_wall",
      preset_version: 2,
      preset_params: {
        normal_axis: "x",
        kind: "bloch",
        width: 12e-9,
        center_offset: 3e-9,
        left: [0, 1, 0],
        right: [0, -1, 0],
        wall_center_direction: [0, 0, -1],
      },
      mapping: { space: "object", projection: "object_local", clamp_mode: "none" },
      texture_transform: {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
        rotate_vectors: true,
      },
    };
    const hydratedWall = hydrateMagneticTextureDraftFromInitializer(
      customDomainWallInit,
      bounds,
      "object",
    );
    expect(hydratedWall.wallCenterMode).toBe("custom");
    expect(hydratedWall.wallCenterDirection).toEqual([0, 0, -1]);

    const serializedWall = serializeMagneticTextureDraftToInitializer(hydratedWall, bounds);
    expect(serializedWall.preset_params).toMatchObject({
      wall_center_direction: [0, 0, -1],
      width: 12e-9,
      center_offset: 3e-9,
    });

    // Non-antiparallel right domain triggers field-level validation error
    const nonAntiparallelErrors = validateMagneticTextureDraft({
      ...hydratedWall,
      lockAntiparallelRight: false,
      rightDomain: [1, 0, 0],
    });
    expect(nonAntiparallelErrors.get("rightDomain")).toContain("Right = −Left");

    // Non-orthogonal custom wall_center_direction triggers field-level validation error
    const nonOrthogonalErrors = validateMagneticTextureDraft({
      ...hydratedWall,
      wallCenterMode: "custom",
      wallCenterDirection: [0, 1, 0],
    });
    expect(nonOrthogonalErrors.get("wallCenterDirection")).toContain("orthogonal");

    // assetFactory leaves ui_label null when no custom user label is supplied
    const createdAsset = presetMagnetizationAsset({
      id: "mag:strip:bloch_skyrmion",
      presetKind: "bloch_skyrmion",
      presetParams: { radius: 25e-9, wall_width: 5e-9, core_polarity: -1, chirality: 1 },
    });
    expect(createdAsset.ui_label).toBeNull();
  });

  it("evaluates finite Z-axis thickness confinement identically across client, batch, draft hydration, and Python export", () => {
    const scene = {
      revision: 1,
      objects: [
        {
          id: "film",
          name: "Film",
          role: "magnet",
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [100e-9, 100e-9, 10e-9] },
          },
        },
      ],
    };
    const bounds = resolveTargetBoundsMeters(
      scene as unknown as Parameters<typeof resolveTargetBoundsMeters>[0],
      { kind: "object", objectId: "film" },
    );
    const draft = {
      ...createDefaultMagneticTextureDraft("bloch_skyrmion", bounds, "object"),
      radiusM: 15e-9,
      wallWidthM: 4e-9,
      corePolarity: -1 as const,
      chirality: 1 as const,
      translationM: [0, 0, 2e-9] as [number, number, number],
      axisExtentMode: "thickness" as const,
      axisThicknessM: 1e-9,
    };

    const spec = buildPresetSpecFromDraft(draft, bounds);
    expect(spec.mapping).toMatchObject({
      space: "object",
      projection: "object_local",
      clamp_mode: "none",
      axis_extent_mode: "thickness",
      axis_thickness_m: 1e-9,
    });

    const samplePts: [number, number, number][] = [
      [0, 0, 2.0e-9], // slab center -> core (-Z)
      [0, 0, 1.5e-9], // lower slab face -> core (-Z)
      [0, 0, 2.5e-9], // upper slab face -> core (-Z)
      [15e-9, 0, 2.0e-9], // Bloch wall inside slab -> +Y
      [0, 0, 1.49e-9], // below slab -> natural background (+Z)
      [0, 0, 2.51e-9], // above slab -> natural background (+Z)
      [15e-9, 0, 0], // z = 0 outside slab -> natural background (+Z)
    ];

    const batchVals = samplePresetTextureV2Batch(spec, samplePts, bounds);
    for (let i = 0; i < samplePts.length; i += 1) {
      const singleVal = samplePresetTextureV2Client(spec, samplePts[i]!, bounds);
      expect(maxInfinityNormDiff(singleVal, batchVals[i]!)).toBeLessThan(1e-15);
    }
    expect(batchVals[0]![2]).toBeLessThan(-0.99);
    expect(batchVals[1]![2]).toBeLessThan(-0.99);
    expect(batchVals[2]![2]).toBeLessThan(-0.99);
    expect(batchVals[3]![1]).toBeGreaterThan(0.99);
    expect(maxInfinityNormDiff(batchVals[4]!, [0, 0, 1])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(batchVals[5]!, [0, 0, 1])).toBeLessThan(1e-12);
    expect(maxInfinityNormDiff(batchVals[6]!, [0, 0, 1])).toBeLessThan(1e-12);

    // Tilted 90 deg around X + explicit background_vector rotates both the 1 nm slab and background spin
    const tiltedQuat = eulerDegreesToQuaternion([90, 0, 0]);
    const tiltedPts = evaluatePresetTextureV2Points(
      "bloch_skyrmion",
      { radius: 15e-9, wall_width: 4e-9, core_polarity: -1, chirality: 1, plane: "xy" },
      [
        [0, 0, 0],
        [0, 0, -2e-9],
      ],
      {
        rotationQuat: tiltedQuat,
        rotateVectors: true,
        axisExtentMode: "thickness",
        axisThicknessM: 1e-9,
        backgroundVector: [0, 3, 4],
      },
    );
    expect(maxInfinityNormDiff(tiltedPts[0]!, [0, 1, 0])).toBeLessThan(1e-6);
    expect(maxInfinityNormDiff(tiltedPts[1]!, [0, -0.8, 0.6])).toBeLessThan(1e-12);

    // Hydration, serialization, validation, and Python snippet roundtrip
    const serialized = serializeMagneticTextureDraftToInitializer(draft, bounds);
    const hydrated = hydrateMagneticTextureDraftFromInitializer(serialized, bounds, "object");
    expect(hydrated.axisExtentMode).toBe("thickness");
    expect(hydrated.axisThicknessM).toBeCloseTo(1e-9, 15);

    const pyExpr = formatMagneticTexturePythonExpression(hydrated, bounds);
    expect(pyExpr).toContain('axis_extent_mode="thickness"');
    expect(pyExpr).toContain("axis_thickness_m=1e-9");

    const invalidThicknessErrors = validateMagneticTextureDraft({
      ...hydrated,
      axisThicknessM: 0,
    });
    expect(invalidThicknessErrors.get("axisThicknessM")).toContain("positive");
  });
});
