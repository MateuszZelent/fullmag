import { describe, expect, it } from "vitest";

import { export3DModel, summarizeExport3DCapabilities } from "./index";
import type { Export3DTargetInput } from "./export3dTypes";
import { useNodeBlobFileReader } from "./__tests__/useNodeBlobFileReader";

interface GlbNode {
  name?: string;
  mesh?: number;
  extras?: {
    fullmag?: {
      si_meters_per_unit: number;
      origin_offset_m: number[];
    };
  };
}

type GlbMeshNode = GlbNode & { mesh: number };

interface GlbPrimitive {
  attributes: Record<string, number>;
  indices: number;
  material: number;
  mode?: number;
  targets?: Array<Record<string, number>>;
}

interface GlbJson {
  accessors: Array<{ min: number[]; max: number[] }>;
  animations: Array<{
    channels: Array<{ sampler: number; target: { node: number; path: string } }>;
    samplers: Array<{ interpolation: string }>;
  }>;
  extensionsUsed?: string[];
  materials: Array<{ doubleSided?: boolean; extensions?: Record<string, unknown> }>;
  meshes: Array<{ primitives: GlbPrimitive[] }>;
  nodes: GlbNode[];
  scenes: Array<Pick<GlbNode, "extras">>;
}

interface ParsedGlb {
  magic: number;
  version: number;
  totalLength: number;
  json: GlbJson;
  bin: Uint8Array;
}

function parseGlbBytes(bytes: Uint8Array): ParsedGlb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  expect(jsonType).toBe(0x4e4f534a);
  const jsonText = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength));
  const json = JSON.parse(jsonText) as GlbJson;

  const binHeaderOffset = 20 + jsonLength;
  let bin = new Uint8Array(0);
  if (binHeaderOffset + 8 <= bytes.byteLength) {
    const binLength = view.getUint32(binHeaderOffset, true);
    const binType = view.getUint32(binHeaderOffset + 4, true);
    expect(binType).toBe(0x004e4942);
    bin = bytes.subarray(binHeaderOffset + 8, binHeaderOffset + 8 + binLength);
  }
  return { magic, version, totalLength, json, bin };
}

describe("export3dGltfBuilder & export3DModel glTF/GLB", () => {
  useNodeBlobFileReader();

  it("exports static FDM grid to GLB with KHR_materials_unlit, COLOR_0, auto_scene transform, wireframe, and static arrows", async () => {
    const targets: Export3DTargetInput[] = [
      {
        kind: "fdm_grid",
        id: "film:layer[0]/mag",
        name: "Permalloy Film",
        gridShape: [4, 2, 1],
        cellSizeM: [10e-9, 10e-9, 5e-9],
        originM: [100e-9, 20e-9, 0],
        field: {
          kind: "real",
          quantityId: "m",
          unit: "1",
          componentCount: 3,
          values: new Float32Array([
            1, 0, 0,
            0, 1, 0,
            -1, 0, 0,
            0, -1, 0,
            0, 0, 1,
            0, 0, -1,
            0.7, 0.7, 0,
            0, 0.7, 0.7,
          ]),
        },
      },
    ];

    const caps = summarizeExport3DCapabilities(targets);
    expect(caps.hasExportableGeometry).toBe(true);
    expect(caps.hasFdmTargets).toBe(true);
    expect(caps.hasVectorField).toBe(true);
    expect(caps.supportedFormats).toEqual(["glb", "gltf", "vtu", "vtu_zip"]);
    expect(caps.supportedAnimationModes).toEqual(["static"]);

    const res = await export3DModel({
      targets,
      options: {
        format: "glb",
        filename: "permalloy_static",
        materialStyle: "unlit",
        colorMode: "orientation",
        includeSurface: true,
        includeWireframe: true,
        includeVectors: true,
        maxVectors: 8,
      },
    });

    expect(res.filename).toBe("permalloy_static.glb");
    expect(res.mimeType).toBe("model/gltf-binary");
    expect(res.coordinateTransform.mode).toBe("auto_scene");
    expect(res.coordinateTransform.siMetersPerUnit).toBeCloseTo(20e-9, 14);
    expect(res.coordinateTransform.originOffsetM[0]).toBeCloseTo(120e-9, 14);
    expect(res.coordinateTransform.originOffsetM[1]).toBeCloseTo(30e-9, 14);
    expect(res.coordinateTransform.originOffsetM[2]).toBeCloseTo(2.5e-9, 14);

    const glb = parseGlbBytes(res.bytes);
    expect(glb.magic).toBe(0x46546c67);
    expect(glb.version).toBe(2);
    expect(glb.totalLength).toBe(res.bytes.byteLength);
    expect(glb.json.extensionsUsed).toContain("KHR_materials_unlit");

    const sceneExtras = glb.json.scenes?.[0]?.extras?.fullmag;
    expect(sceneExtras).toBeDefined();
    expect(sceneExtras.si_meters_per_unit).toBeCloseTo(20e-9, 14);
    expect(sceneExtras.origin_offset_m[0]).toBeCloseTo(120e-9, 14);

    const rootNodeExtras = glb.json.nodes?.[0]?.extras?.fullmag;
    expect(rootNodeExtras?.si_meters_per_unit).toBeCloseTo(20e-9, 14);

    const primitives = glb.json.meshes.flatMap((m) => m.primitives);
    const triPrims = primitives.filter((p) => (p.mode ?? 4) === 4);
    const linePrims = primitives.filter((p) => p.mode === 1);
    expect(triPrims.length).toBe(2); // surface + static merged arrows
    expect(linePrims.length).toBe(1); // wireframe
    for (const p of triPrims) {
      expect(p.attributes.POSITION).toBeTypeOf("number");
      expect(p.attributes.NORMAL).toBeTypeOf("number");
      expect(p.attributes.COLOR_0).toBeTypeOf("number");
      const material = glb.json.materials[p.material];
      expect(material.doubleSided).toBe(true);
      expect(material.extensions?.KHR_materials_unlit).toEqual({});
    }

    // Verify centered auto_scene bounds in POSITION accessor [-1, 1] along largest axis (X).
    const posAccessor = glb.json.accessors[triPrims[0].attributes.POSITION];
    expect(posAccessor.min[0]).toBeCloseTo(-1, 5);
    expect(posAccessor.max[0]).toBeCloseTo(1, 5);
  });

  it("preserves the number, extents, and colors of captured Airbox arrows", async () => {
    const result = await export3DModel({
      targets: [{
        id: "airbox",
        kind: "fem_mesh",
        role: "airbox",
        positionsM: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        surfaceIndices: new Uint32Array([0, 1, 2, 0, 1, 3]),
        appearance: { includeVectors: true },
        renderedVectors: {
          segmentsM: new Float32Array([0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0, 3, 0, 1]),
          colors: new Float32Array([0, 1, 0, 0, 0, 1]),
          opacity: 0.7,
        },
      }],
      options: { format: "glb", coordinateScale: "si_m", maxVectors: 1 },
    });

    const glb = parseGlbBytes(result.bytes);
    const node = glb.json.nodes.find((entry) => entry.name === "airbox_vectors");
    expect(result.stats.arrowCount).toBe(2);
    expect(node?.mesh).toBeTypeOf("number");
    const attributes = glb.json.meshes[node!.mesh!].primitives[0].attributes;
    expect(glb.json.accessors[attributes.POSITION].max.slice(0, 2)).toEqual([2, 3]);
    expect(glb.json.accessors[attributes.COLOR_0].max).toEqual([0, 1, 1]);
  });

  it("exports valid .gltf JSON and supports PBR transparent materials", async () => {
    const res = await export3DModel({
      targets: [
        {
          kind: "surface_geometry",
          id: "tri_patch",
          positionsM: [0, 0, 0, 1e-6, 0, 0, 0, 1e-6, 0],
          indices: [0, 1, 2],
          field: {
            kind: "real",
            quantityId: "B_z",
            componentCount: 1,
            values: [0, 0.5, 1.0],
          },
        },
      ],
      options: {
        format: "gltf",
        coordinateScale: "um",
        materialStyle: "pbr",
        opacity: 0.6,
        colorPalette: "twilight",
      },
    });

    expect(res.filename).toBe("fullmag-model.gltf");
    expect(res.text).toBeDefined();
    const gltf = JSON.parse(res.text!);
    expect(gltf.asset.version).toBe("2.0");
    expect(gltf.extensionsUsed ?? []).not.toContain("KHR_materials_unlit");
    expect(gltf.materials[0].alphaMode).toBe("BLEND");
    expect(gltf.materials[0].pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.45, 5);
    expect(gltf.materials[0].pbrMetallicRoughness.metallicFactor).toBeCloseTo(0.08, 5);
    expect(gltf.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([
      1, 1, 1, 0.6,
    ]);
    expect(gltf.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it("exports animated phase_cycle mode with deduplicated POSITION accessors, morph targets, and 60fps arrows", async () => {
    const res = await export3DModel({
      targets: [
        {
          kind: "fdm_grid",
          id: "mode:slab[0]/dm.vec",
          gridShape: [3, 2, 1],
          cellSizeM: [10e-9, 10e-9, 5e-9],
          field: {
            kind: "complex",
            quantityId: "dm",
            componentCount: 3,
            realValues: new Float32Array([
              0, 0, 1, 1, 0, 0, 0, 1, 0,
              0, 0, -1, -1, 0, 0, 0, -1, 0,
            ]),
            imagValues: new Float32Array([
              1, 0, 0, 0, 0, 1, 0, 0, 1,
              -1, 0, 0, 0, 0, -1, 0, 0, -1,
            ]),
            phasorConvention: "exp_i_omega_t",
            floquetSpatialConvention: "dst_equals_src_exp_minus_i_k_dot_delta_r",
            wavevectorKf: [1e7, 0, 0],
            cellOriginM: [0, 0, 0],
          },
        },
      ],
      options: {
        format: "glb",
        animationMode: "phase_cycle",
        phaseFrameCount: 8,
        cycleDurationSeconds: 1.0,
        arrowFps: 60,
        surfaceDisplacementScale: 0.08,
        includeVectors: true,
        maxVectors: 4,
      },
    });

    const glb = parseGlbBytes(res.bytes);
    expect(glb.magic).toBe(0x46546c67);
    expect(glb.json.animations).toHaveLength(1);

    const surfaceNodes = glb.json.nodes.filter((n): n is GlbMeshNode =>
      n.mesh !== undefined && (n.name?.includes("_surface_f") ?? false),
    );
    expect(surfaceNodes).toHaveLength(8);

    // Every animated node name must strictly obey [A-Za-z0-9_-]+
    for (const node of glb.json.nodes) {
      if (node.name) {
        expect(node.name).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    }

    // All 8 surface frame meshes must share the EXACT SAME POSITION, NORMAL, and indices accessors!
    const posAccessors = new Set<number>();
    const normAccessors = new Set<number>();
    const idxAccessors = new Set<number>();
    const colorAccessors = new Set<number>();
    for (const node of surfaceNodes) {
      const prim = glb.json.meshes[node.mesh].primitives[0];
      posAccessors.add(prim.attributes.POSITION);
      normAccessors.add(prim.attributes.NORMAL);
      idxAccessors.add(prim.indices);
      colorAccessors.add(prim.attributes.COLOR_0);
      expect(prim.targets).toHaveLength(4);
    }
    expect(posAccessors.size).toBe(1);
    expect(normAccessors.size).toBe(1);
    expect(idxAccessors.size).toBe(1);
    expect(colorAccessors.size).toBe(8);

    // Check animation channels: STEP scale + LINEAR weights + LINEAR arrow TRS.
    const { channels, samplers } = glb.json.animations[0];

    const scaleChannels = channels.filter((c) => c.target.path === "scale");
    const weightChannels = channels.filter((c) => c.target.path === "weights");
    const rotChannels = channels.filter((c) => c.target.path === "rotation");
    const transChannels = channels.filter((c) => c.target.path === "translation");

    expect(weightChannels.length).toBe(8);
    expect(rotChannels.length).toBe(4);
    expect(transChannels.length).toBe(4);
    expect(scaleChannels.length).toBe(8 + 4);

    for (const ch of weightChannels) {
      expect(samplers[ch.sampler]!.interpolation).toBe("LINEAR");
    }
    for (const ch of rotChannels) {
      expect(samplers[ch.sampler]!.interpolation).toBe("LINEAR");
    }

    const arrowNodes = glb.json.nodes.filter((n): n is GlbMeshNode =>
      n.mesh !== undefined && (n.name?.includes("_arrow_") ?? false),
    );
    expect(arrowNodes).toHaveLength(4);
    const arrowMeshes = new Set(arrowNodes.map((n) => n.mesh));
    // Arrows share one unit arrow geometry across materials.
    const arrowPosAccessors = new Set(
      arrowNodes.map(
        (n) => glb.json.meshes[n.mesh].primitives[0].attributes.POSITION,
      ),
    );
    expect(arrowMeshes.size).toBeLessThanOrEqual(4);
    expect(arrowPosAccessors.size).toBe(1);
  });

  it("extracts FEM volume boundary surface automatically and exports playback_frames with displacement", async () => {
    // Single tetrahedron with 4 nodes and 2 playback frames.
    const targets: Export3DTargetInput[] = [
      {
        kind: "fem_mesh",
        id: "tet_domain",
        positionsM: new Float32Array([
          0, 0, 0,
          1e-6, 0, 0,
          0, 1e-6, 0,
          0, 0, 1e-6,
        ]),
        volumeCells: {
          cellNodes: [0, 1, 2, 3],
          cellOffsets: [0, 4],
          cellTypes: [1],
        },
        field: {
          kind: "frames",
          quantityId: "M",
          componentCount: 3,
          frames: [
            {
              timeS: 0,
              values: new Float32Array([
                1, 0, 0,
                1, 0, 0,
                1, 0, 0,
                1, 0, 0,
              ]),
            },
            {
              timeS: 1e-9,
              values: new Float32Array([
                0, 1, 0,
                0, 1, 0,
                0, 1, 0,
                0, 1, 0,
              ]),
            },
          ],
        },
      },
    ];

    const caps = summarizeExport3DCapabilities(targets);
    expect(caps.hasFemTargets).toBe(true);
    expect(caps.hasPlaybackFrames).toBe(true);
    expect(caps.playbackFrameCount).toBe(2);
    expect(caps.supportsVolumetricVtu).toBe(true);
    expect(caps.supportedAnimationModes).toContain("playback_frames");

    const res = await export3DModel({
      targets,
      options: {
        format: "glb",
        animationMode: "playback_frames",
        surfaceDisplacementScale: 0.05,
        includeVectors: true,
        maxVectors: 4,
      },
    });

    const glb = parseGlbBytes(res.bytes);
    expect(glb.magic).toBe(0x46546c67);
    expect(res.stats.frameCount).toBe(2);
    expect(res.stats.triangleCount).toBe(4); // 4 exterior boundary faces of a tet
    expect(res.stats.arrowCount).toBe(4);
    expect(glb.json.animations[0].channels.some((c) => c.target.path === "weights")).toBe(
      true,
    );
  });

  it("aborts cleanly when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      export3DModel({
        targets: [
          {
            kind: "fdm_grid",
            id: "aborted",
            gridShape: [2, 2, 1],
            cellSizeM: [1e-9, 1e-9, 1e-9],
          },
        ],
        options: {
          format: "glb",
          signal: controller.signal,
        },
      }),
    ).rejects.toThrow();
  });
});
