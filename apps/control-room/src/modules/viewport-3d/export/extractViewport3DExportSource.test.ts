import { describe, expect, it } from "vitest";

import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";
import { useNodeBlobFileReader } from "@/shared/export-3d/__tests__/useNodeBlobFileReader";
import {
  EXPORT_3D_INACTIVE_REGION_ID,
  export3DModel,
  summarizeExport3DCapabilities,
} from "@/shared/export-3d";

import { extractViewport3DExportSource } from "./extractViewport3DExportSource";

describe("extractViewport3DExportSource", () => {
  useNodeBlobFileReader();

  it("extracts single-grid FDM with inactive regionIds and optional visible airbox", () => {
    const regionIds = new Uint32Array([
      1,
      FMRM_INACTIVE_REGION_ID,
      1,
      FMRM_INACTIVE_REGION_ID,
    ]);
    const values = new Float32Array([
      1, 0, 0,
      0, 0, 0,
      0, 1, 0,
      0, 0, 0,
    ]);

    const sourceWithoutAirbox = extractViewport3DExportSource({
      domainId: "permalloy-strip",
      sessionDiscretization: "fdm",
      fdmLaneActive: true,
      fdmDomain: {
        kind: "fdm-grid",
        bounds: null,
        displayCellBudget: 1000,
        displayCellCount: 4,
        origin: [0, 0, 0],
        shape: [2, 2, 1],
        spacing: [5e-9, 5e-9, 10e-9],
      },
      fdmRegionMembershipBinary: {
        counts: [2, 2, 1],
        cellCount: 4,
        legendCount: 1,
        gridFingerprint: "fp-1",
        formatVersion: 2,
        semanticStatus: "canonical",
        payloadKind: 1,
        regionIds,
      },
      fieldVector: {
        dtype: "float32",
        formatVersion: 3,
        grid: [2, 2, 1],
        nComp: 3,
        pointCount: 4,
        quantityId: "m",
        values,
      },
      fdmSettings: {
        activeQuantityId: "m",
        scalarColorPalette: "plasma",
        surfaceColorSource: "scalar",
        vectorColorMode: "magnitude",
        vectorsVisible: true,
      },
      airboxSettings: { visible: false },
    });

    expect(sourceWithoutAirbox.suggestedFilenameStem).toBe("permalloy-strip");
    expect(sourceWithoutAirbox.defaultAnimationMode).toBe("static");
    expect(sourceWithoutAirbox.defaultColorMode).toBe("magnitude");
    expect(sourceWithoutAirbox.defaultPalette).toBe("plasma");
    expect(sourceWithoutAirbox.targets).toHaveLength(1);
    const fdmTarget = sourceWithoutAirbox.targets[0];
    expect(fdmTarget?.kind).toBe("fdm_grid");
    if (fdmTarget?.kind === "fdm_grid") {
      expect(Array.from(fdmTarget.activeMask ?? [])).toEqual([1, 0, 1, 0]);
      expect(fdmTarget.regionIds?.[1]).toBe(EXPORT_3D_INACTIVE_REGION_ID);
      expect(fdmTarget.field?.kind).toBe("real");
    }

    const sourceWithAirbox = extractViewport3DExportSource({
      domainId: "permalloy-strip",
      fdmLaneActive: true,
      fdmDomain: {
        kind: "fdm-grid",
        bounds: null,
        displayCellBudget: 1000,
        displayCellCount: 4,
        origin: [0, 0, 0],
        shape: [2, 2, 1],
        spacing: [5e-9, 5e-9, 10e-9],
      },
      fdmRegionMembershipBinary: {
        counts: [2, 2, 1],
        cellCount: 4,
        legendCount: 1,
        gridFingerprint: "fp-1",
        formatVersion: 2,
        semanticStatus: "canonical",
        payloadKind: 1,
        regionIds,
      },
      fieldVector: {
        dtype: "float32",
        formatVersion: 3,
        grid: [2, 2, 1],
        nComp: 3,
        pointCount: 4,
        quantityId: "m",
        values,
      },
      fdmAirboxFieldVector: {
        dtype: "float32",
        formatVersion: 3,
        grid: [2, 2, 1],
        nComp: 3,
        pointCount: 4,
        quantityId: "B_demag",
        values,
      },
      airboxSettings: { visible: true, surfaceOpacityPercent: 20 },
    });

    expect(sourceWithAirbox.targets).toHaveLength(2);
    expect(sourceWithAirbox.targets[1]?.id).toBe("fdm-airbox");
    expect(sourceWithAirbox.targets[1]?.appearance?.opacity).toBeCloseTo(0.2);
  });

  it("extracts multilayer FDM native layer views and multilayer airbox", () => {
    const layer1Target = { id: "fdm-native:layer-1", kind: "fdm-native-layer", label: "Bottom CoFeB" } as never;
    const layer2Target = { id: "fdm-native:layer-2", kind: "fdm-native-layer", label: "Top Py" } as never;

    const source = extractViewport3DExportSource({
      fdmLaneActive: true,
      fdmNativeLayerViews: [
        {
          domain: {
            kind: "fdm-native-layer",
            bounds: null,
            displayCellBudget: 1000,
            displayCellCount: 4,
            origin: [0, 0, 0],
            shape: [2, 2, 1],
            spacing: [2e-9, 2e-9, 2e-9],
            activeCellCount: 2,
            layerId: "layer-1",
            magnetName: "Bottom CoFeB",
            objectId: "obj-bottom",
            gridFingerprint: "g1",
            transferKind: "native",
            activeMaskPresent: true,
            inactiveCellCount: 2,
          },
          fieldVector: {
            dtype: "float64",
            formatVersion: 3,
            grid: [2, 2, 1],
            nComp: 3,
            pointCount: 2,
            nodeIndices: [0, 3],
            quantityId: "m",
            values: new Float64Array([1, 0, 0, 0, 1, 0]),
          },
          model: {
            cellSize: [2e-9, 2e-9, 2e-9],
            cellIndices: new Uint32Array([0, 3]),
            centers: new Float32Array(6),
            count: 2,
            gridShape: [2, 2, 1],
            matrices: new Float32Array(32),
            matrixContentRevision: "m1",
            membershipRevision: "mem1",
            regionIds: null,
          },
          settings: {
            scalarColorPalette: "viridis",
            surfaceColorSource: "hsl",
            shaderVisible: true,
            vectorsVisible: true,
            visible: true,
            wireframeVisible: false,
          } as never,
          surfaceColors: null,
          target: layer1Target,
          vectorGlyphColors: null,
          vectorSegments: null,
        },
        {
          domain: {
            kind: "fdm-native-layer",
            bounds: null,
            displayCellBudget: 1000,
            displayCellCount: 4,
            origin: [0, 0, 4e-9],
            shape: [2, 2, 1],
            spacing: [2e-9, 2e-9, 2e-9],
            activeCellCount: 4,
            layerId: "layer-2",
            magnetName: "Top Py",
            objectId: "obj-top",
            gridFingerprint: "g2",
            transferKind: "native",
            activeMaskPresent: false,
            inactiveCellCount: 0,
          },
          fieldVector: {
            dtype: "float32",
            formatVersion: 3,
            grid: [2, 2, 1],
            nComp: 3,
            pointCount: 4,
            quantityId: "m",
            values: new Float32Array(12).fill(0.5),
          },
          model: null,
          settings: {
            scalarColorPalette: "viridis",
            surfaceColorSource: "hsl",
            shaderVisible: true,
            vectorsVisible: true,
            visible: true,
            wireframeVisible: false,
          } as never,
          surfaceColors: null,
          target: layer2Target,
          vectorGlyphColors: null,
          vectorSegments: null,
        },
      ],
      fdmMultilayerAirboxView: {
        domain: {
          kind: "fdm-multilayer-airbox",
          bounds: null,
          displayCellBudget: 1000,
          displayCellCount: 8,
          origin: [0, 0, 0],
          shape: [2, 2, 2],
          spacing: [2e-9, 2e-9, 2e-9],
          carrierFingerprint: "ab",
          domainGenerationId: "gen-1",
          geometryOnly: false,
          geometryRevision: "1",
          layoutRevision: 1,
          observationRevision: 1,
        },
        fieldBuffer: null,
        fieldVector: null,
        model: null,
        settings: { visible: true, surfaceOpacityPercent: 15 } as never,
        surfaceColors: null,
        target: { id: "airbox", kind: "airbox", label: "Airbox" } as never,
        vectorBuildReference: null,
        vectorGlyphColors: null,
        vectorSegments: null,
      },
      airboxSettings: { visible: true, surfaceOpacityPercent: 15 },
    });

    expect(source.targets).toHaveLength(3);
    expect(source.targets[0]?.id).toBe("layer-1");
    if (source.targets[0]?.kind === "fdm_grid") {
      expect(Array.from(source.targets[0].activeMask ?? [])).toEqual([1, 0, 0, 1]);
    }
    expect(source.targets[1]?.id).toBe("layer-2");
    expect(source.targets[2]?.id).toBe("airbox");
    expect(source.targets[2]?.appearance?.opacity).toBeCloseTo(0.15);
  });

  it("un-interleaves complex eigenmode fields and mode composition layers with phase_cycle default", () => {
    const complexInterleaved = new Float64Array([
      1.0, 0.25, 0.0, -0.5, 0.5, 0.5,
      -1.0, 0.0, 0.25, 0.75, 0.0, -0.25,
    ]);

    const source = extractViewport3DExportSource({
      fdmLaneActive: true,
      fdmDomain: {
        kind: "fdm-grid",
        bounds: null,
        displayCellBudget: 100,
        displayCellCount: 2,
        origin: [0, 0, 0],
        shape: [2, 1, 1],
        spacing: [4e-9, 4e-9, 4e-9],
      },
      analysisComplexField: {
        componentCount: 3,
        dtype: "complex128",
        grid: [2, 1, 1],
        pointCount: 2,
        quantityId: "dm",
        valueCount: 6,
        values: complexInterleaved,
      },
      analysisOverlay: {
        fieldId: "eig-mode-3",
        label: "Kittel FMR Mode 3",
        source: "eigen-mode",
        frequencyHz: 9.4e9,
        modeIndex: 3,
        phasorConvention: "exp_minus_i_omega_t",
        floquetSpatialConvention: "exp_plus_i_k_dot_r",
        wavevectorKf: [1e7, 0, 0],
        cellOrigin: [1e-9, 0, 0],
        visualizationPhaseRad: Math.PI / 4,
        appearance: {
          displayGain: 2.5,
          scalarColorPalette: "twilight",
          surfaceColorSource: "scalar",
        },
        query: { component: "full" },
      } as never,
    });

    expect(source.defaultAnimationMode).toBe("phase_cycle");
    expect(source.defaultPalette).toBe("twilight");
    expect(source.suggestedFilenameStem).toBe("Kittel-FMR-Mode-3");
    const field = source.targets[0]?.field;
    expect(field?.kind).toBe("complex");
    if (field?.kind === "complex") {
      expect(Array.from(field.realValues)).toEqual([1.0, 0.0, 0.5, -1.0, 0.25, 0.0]);
      expect(Array.from(field.imagValues)).toEqual([0.25, -0.5, 0.5, 0.0, 0.75, -0.25]);
      expect(field.phasorConvention).toBe("exp_minus_i_omega_t");
      expect(field.floquetSpatialConvention).toBe("exp_plus_i_k_dot_r");
      expect(field.wavevectorKf).toEqual([1e7, 0, 0]);
      expect(field.cellOriginM).toEqual([1e-9, 0, 0]);
      expect(field.amplitudeScale).toBe(2.5);
      expect(field.complexPhaseRad).toBeCloseTo(Math.PI / 4);
    }

    const caps = summarizeExport3DCapabilities(source.targets);
    expect(caps.hasComplexField).toBe(true);
    expect(caps.supportedAnimationModes).toContain("phase_cycle");

    // Mode composition multi-layer test
    const modeCompSource = extractViewport3DExportSource({
      fdmLaneActive: true,
      modeCompositionId: "comp-1",
      modeCompositionPhaseByLayerId: new Map([["mc-l1", 1.25]]),
      modeCompositionFieldLayers: new Map([
        [
          "fdm-native:layer-1",
          {
            status: "ready",
            error: null,
            reason: null,
            identity: null,
            layer: {
              layer_id: "mc-l1",
              target_id: "fdm-native:layer-1",
              object_id: "obj-1",
              amplitude_scale: 1.75,
              phase_rad: 0.2,
              representation: "abs",
            } as never,
            field: {
              componentCount: 3,
              dtype: "complex128",
              grid: [2, 1, 1],
              pointCount: 2,
              quantityId: "dm",
              valueCount: 6,
              values: complexInterleaved,
            },
          },
        ],
      ]),
      fdmNativeLayerViews: [
        {
          domain: {
            kind: "fdm-native-layer",
            bounds: null,
            displayCellBudget: 100,
            displayCellCount: 2,
            origin: [0, 0, 0],
            shape: [2, 1, 1],
            spacing: [4e-9, 4e-9, 4e-9],
            activeCellCount: 2,
            layerId: "layer-1",
            magnetName: "Layer 1",
            objectId: "obj-1",
            gridFingerprint: "g",
            transferKind: "native",
            activeMaskPresent: false,
            inactiveCellCount: 0,
          },
          fieldVector: null,
          model: null,
          settings: { visible: true } as never,
          surfaceColors: null,
          target: { id: "fdm-native:layer-1" } as never,
          vectorGlyphColors: null,
          vectorSegments: null,
        },
      ],
    });
    expect(modeCompSource.defaultAnimationMode).toBe("phase_cycle");
    const compField = modeCompSource.targets[0]?.field;
    expect(compField?.kind).toBe("complex");
    if (compField?.kind === "complex") {
      expect(compField.amplitudeScale).toBe(1.75);
      expect(compField.complexPhaseRad).toBe(1.25);
      expect(compField.complexRepresentation).toBe("abs");
    }
  });

  it("extracts FEM mesh targets skipping hidden airbox and safely filtering/mapping volumeCells", () => {
    // Nodes 0..3: magnetic tet [0..10nm]; Nodes 4..7: far-field airbox tet [0..1000nm]
    const positions = new Float32Array([
      0, 0, 0,
      10e-9, 0, 0,
      0, 10e-9, 0,
      0, 0, 10e-9,
      1000e-9, 0, 0,
      0, 1000e-9, 0,
      0, 0, 1000e-9,
      1000e-9, 1000e-9, 1000e-9,
    ]);
    const topology = {
      nodeCount: 8,
      positions,
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      cellCount: 2,
      cellTypes: new Uint32Array([1, 1]),
      cellOffsets: new Uint32Array([0, 4, 8]),
      cellNodes: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
    };

    const magSurface = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const airSurface = new Uint32Array([4, 6, 5, 4, 5, 7]);
    const magFieldValues = new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]);

    const source = extractViewport3DExportSource({
      sessionDiscretization: "fem",
      domainId: "fem-disk",
      topology,
      topologyModel: {
        nodeCount: 8,
        positions,
        fallbackSurfaceIndices: magSurface,
        fallbackSurfaceEdgeIndices: null,
        fallbackSurfaceNodeIndices: new Uint32Array([0, 1, 2, 3]),
        fallbackVolumeEdgeIndices: new Uint32Array(),
        meshGenerationId: "mg-1",
        meshRevision: 1,
        meshTopologyHash: "hash-1",
        magneticParts: [
          {
            part: {
              id: "part-magnet",
              label: "Cobalt Disk",
              role: "magnetic",
              boundary_face_start: 0,
              boundary_face_count: 4,
              element_start: 0,
              element_count: 1,
              nodeIndices: [0, 1, 2, 3],
            } as never,
            edgeIndices: null,
            fullNodeSelection: { nodeIndices: [0, 1, 2, 3] },
            surfaceIndices: magSurface,
            surfaceNodeIndices: new Uint32Array([0, 1, 2, 3]),
            surfaceNodeSelection: null,
            volumeEdgeIndices: null,
          },
        ],
        airboxParts: [
          {
            part: {
              id: "part-airbox",
              label: "Far Airbox",
              role: "airbox",
              boundary_face_start: 4,
              boundary_face_count: 2,
              element_start: 1,
              element_count: 1,
              nodeIndices: [4, 5, 6, 7],
            } as never,
            edgeIndices: null,
            fullNodeSelection: { nodeIndices: [4, 5, 6, 7] },
            surfaceIndices: airSurface,
            surfaceNodeIndices: new Uint32Array([4, 5, 6, 7]),
            surfaceNodeSelection: null,
            volumeEdgeIndices: null,
          },
        ],
      },
      fieldModel: {
        complexFieldVector: null,
        derivedWorkItems: [],
        fullVectorBuild: null,
        fullVectorSegments: null,
        modeOverlay: null,
        partVectorBuilds: new Map(),
        partVectorSegments: new Map(),
        scalarColors: null,
        scalarColorsByPartAndMode: new Map(),
        scalarColorsByMode: new Map(),
        targetDiagnostics: [],
        visualizationPhaseRad: null,
        targetPasses: new Map([
          [
            "part-magnet",
            {
              fieldBufferState: "ready",
              fieldBuffer: {
                bufferId: "buf-1",
                capability: "primary-field",
                component: "full",
                consumers: [],
                fieldRevision: "1",
                pointCount: 4,
                nodeIndices: new Uint32Array([0, 1, 2, 3]),
                decodedFieldVector: {
                  dtype: "float32",
                  grid: [4, 1, 1],
                  nComp: 3,
                  nodeIndices: new Uint32Array([0, 1, 2, 3]),
                  pointCount: 4,
                  quantityId: "m",
                  values: magFieldValues,
                },
              },
              surface: {} as never,
              vectors: {} as never,
            },
          ],
        ]),
      },
      airboxSettings: { visible: false },
    });

    expect(source.targets).toHaveLength(1);
    const femTarget = source.targets[0];
    expect(femTarget?.kind).toBe("fem_mesh");
    if (femTarget?.kind === "fem_mesh") {
      // Compacted to magnetic nodes 0..3 only (airbox nodes 4..7 excluded!)
      expect(femTarget.positionsM.length).toBe(12);
      expect(femTarget.volumeCells?.cellCount).toBe(1);
      expect(Array.from(femTarget.volumeCells?.cellNodes ?? [])).toEqual([0, 1, 2, 3]);
      expect(femTarget.field?.kind).toBe("real");
      expect(femTarget.field?.nodeIndices).toBeNull();
    }

    const caps = summarizeExport3DCapabilities(source.targets);
    expect(caps.hasFemTargets).toBe(true);
    expect(caps.supportsVolumetricVtu).toBe(true);
    expect(caps.boundsM?.max[0]).toBeCloseTo(10e-9);
  });

  it("falls back to authored primitive objects with world coordinates and magnetization previews", async () => {
    const source = extractViewport3DExportSource({
      primitiveModel: {
        sceneRevision: 3,
        objects: [
          {
            objectId: "obj-box",
            kind: "box",
            label: "Permalloy Strip",
            fallbackLabel: "Box",
            geometryKey: "k-box",
            meshState: "unmeshed",
            role: "magnetic",
            sceneRevision: 3,
            csgPreview: null,
            bounds: {
              center: [25e-9, -10e-9, 5e-9],
              size: [50e-9, 20e-9, 10e-9],
              radius: 30e-9,
            },
            magnetizationTexturePreview: {
              assetId: "tex-vortex",
              color: "#27c4e8",
              label: "Vortex Core",
              presetKind: "vortex",
              source: "object",
            },
          },
          {
            objectId: "obj-hidden",
            kind: "sphere",
            label: "Hidden Sphere",
            fallbackLabel: "Sphere",
            geometryKey: "k-sphere",
            meshState: "unmeshed",
            role: "magnetic",
            sceneRevision: 3,
            csgPreview: null,
            magnetizationTexturePreview: null,
            bounds: {
              center: [0, 0, 0],
              size: [10e-9, 10e-9, 10e-9],
              radius: 5e-9,
            },
          },
        ],
      },
      getObjectSettings: (id) =>
        ({
          visible: id !== "obj-hidden",
          shaderVisible: true,
          wireframeVisible: false,
          surfaceOpacityPercent: 100,
        }) as never,
    });

    expect(source.targets).toHaveLength(1);
    const primTarget = source.targets[0];
    expect(primTarget?.kind).toBe("surface_geometry");
    expect(primTarget?.name).toBe("Permalloy Strip");
    expect(primTarget?.appearance?.monochromeColor?.[0]).toBeCloseTo(0x27 / 255);
    expect(source.provenance.magnetizationTexturePreviews).toHaveLength(1);

    const caps = summarizeExport3DCapabilities(source.targets);
    expect(caps.hasExportableGeometry).toBe(true);
    expect(caps.boundsM?.min[0]).toBeCloseTo(0);
    expect(caps.boundsM?.max[0]).toBeCloseTo(50e-9);
    expect(caps.boundsM?.center).toEqual([
      expect.closeTo(25e-9, 12),
      expect.closeTo(-10e-9, 12),
      expect.closeTo(5e-9, 12),
    ]);

    const result = await export3DModel({
      targets: source.targets,
      options: { format: "glb", filename: source.suggestedFilenameStem },
    });
    expect(result.bytes.byteLength).toBeGreaterThan(20);
  });
});
