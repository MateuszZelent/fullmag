import type { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import type { DecodedTopology } from "@/kernel/api/codecs";
import {
  savedSupportNodeIsActive,
  type DecodedSavedSupport,
} from "@/kernel/api/codecs/savedSupportCodec";
import type { SavedPlaybackResource } from "@/kernel/api/savedResultsPlayback";
import {
  decodeSavedPlaybackFrame,
  savedPlaybackNodeCount,
} from "@/kernel/api/savedResultsPlayback";
import type {
  StudyResultStateResource,
  StudyStageResult,
} from "@/kernel/api/apiTypes";
import {
  type Export3DColorMode,
  type Export3DFieldFrame,
  type Export3DFramesFieldInput,
  type Export3DRealFieldInput,
  type Export3DScalarPalette,
  type Export3DTargetInput,
} from "@/shared/export-3d";

import { buildTopologySurfaceIndicesForElements } from "../viewport3dTopologyIndexModel";
import { cellEnd, cellStart, topologyCellCsr } from "../viewport3dTopologyCells";
import {
  buildFemTargetFromSelection,
  resolvePaletteFromSettings,
  sanitizeSlug,
} from "./extractViewport3DExportSource";

export type SavedPlaybackStage = SavedPlaybackResource["stages"][number];

export interface SavedPlaybackExportSource {
  readonly availableFrameCount: number;
  readonly currentFrameIndex: number;
  readonly defaultAnimationMode: "static";
  readonly defaultColorMode: Export3DColorMode;
  readonly defaultPalette: Export3DScalarPalette;
  readonly femActiveNodeIndices: Uint32Array | null;
  readonly itemId?: string;
  readonly manifest?: SavedPlaybackResource;
  readonly provenance: Record<string, unknown>;
  readonly quantityId: string;
  readonly sourceLabel: string;
  readonly stageId?: string;
  readonly suggestedFilenameStem: string;
  readonly targets: Export3DTargetInput[];
  readonly warnings: readonly string[];
}

export interface SavedFolderPlaybackExportInput {
  readonly colorPalette?: string | null;
  readonly component?: number | null;
  readonly colorLimit?: number;
  readonly femSupport?: DecodedSavedSupport | null;
  readonly femTopology?: DecodedTopology | null;
  readonly frameData?: Float64Array | null;
  readonly frameIndex: number;
  readonly itemId: string;
  readonly manifest: SavedPlaybackResource;
  readonly name?: string | null;
  readonly quantityId?: string | null;
  readonly stage?: SavedPlaybackStage | null;
}

export interface StudyResultPlaybackExportInput {
  readonly colorPalette?: string | null;
  readonly component?: number | null;
  readonly colorLimit?: number;
  readonly descriptor: StudyResultStateResource;
  readonly quantityId?: string | null;
  readonly result: StudyStageResult;
  readonly samples?: Float64Array | null;
  readonly support?: DecodedSavedSupport | null;
  readonly topology?: DecodedTopology | null;
}

export interface LoadSavedPlaybackFramesInput {
  readonly activeNodeIndices?: Uint32Array | readonly number[] | null;
  readonly api: {
    readonly workspace: Pick<ControlRoomApi["workspace"], "playbackFrame">;
  };
  readonly frameStride?: number;
  readonly itemId: string;
  readonly manifest: SavedPlaybackResource;
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly quantityId?: string | null;
  readonly signal?: AbortSignal;
  readonly stageId?: string | null;
}

function savedColorMode(component: number | null | undefined): Export3DColorMode {
  const modes = ["x", "y", "z"] as const;
  return component === 0 || component === 1 || component === 2 ? modes[component] : "orientation";
}

function buildFemActiveNodesAndSurface(
  topology: DecodedTopology,
  support: DecodedSavedSupport | null | undefined,
): {
  readonly activeNodes: Uint8Array;
  readonly surfaceIndices: Uint32Array;
} {
  const count = topology.nodeCount;
  const activeNodes = new Uint8Array(count);
  if (support && support.nodeCount === count) {
    for (let node = 0; node < count; node += 1) {
      activeNodes[node] = Number(savedSupportNodeIsActive(support, node));
    }
    const csr = topologyCellCsr(topology);
    if (csr.count > 0) {
      const cells = new Set<number>();
      for (let cell = 0; cell < csr.count; cell += 1) {
        const start = cellStart(csr, cell);
        const end = cellEnd(csr, cell);
        if (end <= start) continue;
        let active = true;
        for (let k = start; k < end; k += 1) {
          const n = csr.nodes[k] ?? -1;
          if (n < 0 || n >= count || !activeNodes[n]) {
            active = false;
            break;
          }
        }
        if (active) cells.add(cell);
      }
      if (cells.size > 0) {
        const surfaceIndices = buildTopologySurfaceIndicesForElements(
          topology,
          cells,
        );
        return { activeNodes, surfaceIndices };
      }
    }
  } else {
    activeNodes.fill(1);
  }
  return {
    activeNodes,
    surfaceIndices: buildTopologySurfaceIndicesForElements(topology, null),
  };
}

function normalizeGridTriple(
  values: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!values || values.length < 3) return null;
  const x = values[0] ?? Number.NaN;
  const y = values[1] ?? Number.NaN;
  const z = values[2] ?? Number.NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

function sliceFrameValuesForNodes(
  values: Float64Array,
  activeNodeIndices: Uint32Array | readonly number[],
): Float64Array {
  const count = activeNodeIndices.length;
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const src = activeNodeIndices[i] ?? 0;
    const srcBase = src * 3;
    const dstBase = i * 3;
    out[dstBase] = values[srcBase] ?? 0;
    out[dstBase + 1] = values[srcBase + 1] ?? 0;
    out[dstBase + 2] = values[srcBase + 2] ?? 0;
  }
  return out;
}

/**
 * Extract 3D export targets and playback metadata from a SavedFolderPlayback view.
 */
export function extractSavedFolderPlaybackExportSource(
  input: SavedFolderPlaybackExportInput,
): SavedPlaybackExportSource {
  const warnings: string[] = [];
  const { manifest } = input;
  const stage = input.stage ?? manifest.stages[0] ?? null;
  const quantityId =
    input.quantityId?.trim() || stage?.quantity_ids?.[0] || "m";
  const defaultPalette = resolvePaletteFromSettings(
    input.colorPalette,
    "coolwarm",
  );
  const colorMode = savedColorMode(input.component);
  const colorRange = input.colorLimit === undefined ? undefined : { min: -input.colorLimit, max: input.colorLimit };
  const targets: Export3DTargetInput[] = [];
  let femActiveNodeIndices: Uint32Array | null = null;

  if (manifest.fem_mesh) {
    if (!input.femTopology) {
      warnings.push("Saved FEM topology binary is not loaded yet.");
    } else {
      const topology = input.femTopology;
      const { activeNodes, surfaceIndices } = buildFemActiveNodesAndSurface(
        topology,
        input.femSupport,
      );
      const rawField: Export3DRealFieldInput | null =
        input.frameData && input.frameData.length >= topology.nodeCount * 3
          ? {
              kind: "real",
              quantityId,
              componentCount: 3,
              values: input.frameData,
            }
          : null;
      if (!rawField) {
        warnings.push(
          "Current saved FEM frame is unavailable; exporting geometry only.",
        );
      }
      const femTarget = buildFemTargetFromSelection({
        id: "saved-fem-mesh",
        name: input.name || manifest.name || "Saved FEM Result",
        positionsM: Float32Array.from(topology.positions),
        nodeCount: topology.nodeCount,
        surfaceIndices,
        topology,
        allowedNodes: activeNodes,
        field: rawField,
        appearance: {
          colorMode: rawField ? colorMode : "monochrome",
          colorRange,
          colorPalette: defaultPalette,
          includeSurface: true,
          includeWireframe: false,
          includeVectors: Boolean(rawField),
        },
      });
      if (femTarget) {
        if (
          femTarget.nodeIndices &&
          femTarget.nodeIndices instanceof Uint32Array
        ) {
          femActiveNodeIndices = femTarget.nodeIndices;
        }
        targets.push(femTarget);
      }
    }
  } else {
    const gridShape = normalizeGridTriple(manifest.grid_cells_xyz);
    const cellSizeM = normalizeGridTriple(manifest.cell_size_m);
    const originM = normalizeGridTriple(manifest.origin_m) ?? [0, 0, 0];
    if (gridShape && cellSizeM) {
      const totalCells = gridShape[0] * gridShape[1] * gridShape[2];
      const field: Export3DRealFieldInput | null =
        input.frameData && input.frameData.length >= totalCells * 3
          ? {
              kind: "real",
              quantityId,
              componentCount: 3,
              values: input.frameData,
            }
          : null;
      if (!field) {
        warnings.push(
          "Current saved FDM frame is unavailable; exporting grid geometry only.",
        );
      }
      targets.push({
        kind: "fdm_grid",
        id: "saved-fdm-grid",
        name: input.name || manifest.name || "Saved FDM Result",
        gridShape,
        cellSizeM,
        originM,
        field,
        appearance: {
          colorMode: field ? colorMode : "monochrome",
          colorRange,
          colorPalette: defaultPalette,
          includeSurface: true,
          includeWireframe: false,
          includeVectors: Boolean(field),
        },
      });
    } else {
      warnings.push("Saved playback grid metadata is missing.");
    }
  }

  const label = input.name || manifest.name || "Saved Result";
  const stageSuffix = stage?.stage_id ? `-${stage.stage_id}` : "";
  const suggestedFilenameStem = sanitizeSlug(
    `${label}${stageSuffix}-frame-${input.frameIndex}`,
    "saved-playback",
  );

  return {
    availableFrameCount: stage?.frame_count ?? 0,
    currentFrameIndex: input.frameIndex,
    defaultAnimationMode: "static",
    defaultColorMode: targets.some((t) => Boolean(t.field))
      ? colorMode
      : "monochrome",
    defaultPalette,
    femActiveNodeIndices,
    itemId: input.itemId,
    manifest,
    provenance: {
      source: "saved-folder-playback",
      itemId: input.itemId,
      manifestRevision: manifest.revision,
      manifestSchema: manifest.schema,
      ...(stage ? { stageId: stage.stage_id, frameCount: stage.frame_count } : {}),
      frameIndex: input.frameIndex,
      ...(stage?.times_s?.[input.frameIndex] !== undefined
        ? { timeS: stage.times_s[input.frameIndex] }
        : {}),
      quantityId,
    },
    quantityId,
    sourceLabel: stage ? `${label} · ${stage.stage_id}` : label,
    ...(stage ? { stageId: stage.stage_id } : {}),
    suggestedFilenameStem,
    targets,
    warnings,
  };
}

/**
 * Extract 3D export targets and provenance from a pinned StudyResultPlayback view.
 */
export function extractStudyResultPlaybackExportSource(
  input: StudyResultPlaybackExportInput,
): SavedPlaybackExportSource {
  const warnings: string[] = [];
  const { descriptor, result } = input;
  const quantityId = input.quantityId?.trim() || "m";
  const defaultPalette = resolvePaletteFromSettings(
    input.colorPalette,
    "coolwarm",
  );
  const colorMode = savedColorMode(input.component);
  const colorRange = input.colorLimit === undefined ? undefined : { min: -input.colorLimit, max: input.colorLimit };
  const targets: Export3DTargetInput[] = [];
  const geom = descriptor.geometry;
  let femActiveNodeIndices: Uint32Array | null = null;

  if (geom.kind === "fem") {
    if (!input.topology) {
      warnings.push("Saved Study FEM topology is unavailable.");
    } else {
      const topology = input.topology;
      const { activeNodes, surfaceIndices } = buildFemActiveNodesAndSurface(
        topology,
        input.support,
      );
      const rawField: Export3DRealFieldInput | null =
        input.samples && input.samples.length >= topology.nodeCount * 3
          ? {
              kind: "real",
              quantityId,
              componentCount: 3,
              values: input.samples,
            }
          : null;
      const femTarget = buildFemTargetFromSelection({
        id: `study-fem-${result.artifact_id}`,
        name: `${result.source.step_id} (FEM)`,
        positionsM: Float32Array.from(topology.positions),
        nodeCount: topology.nodeCount,
        surfaceIndices,
        topology,
        allowedNodes: activeNodes,
        field: rawField,
        appearance: {
          colorMode: rawField ? colorMode : "monochrome",
          colorRange,
          colorPalette: defaultPalette,
          includeSurface: true,
          includeWireframe: false,
          includeVectors: Boolean(rawField),
        },
      });
      if (femTarget) {
        if (
          femTarget.nodeIndices &&
          femTarget.nodeIndices instanceof Uint32Array
        ) {
          femActiveNodeIndices = femTarget.nodeIndices;
        }
        targets.push(femTarget);
      }
    }
  } else if (geom.kind === "fdm_multilayer") {
    const support = input.support;
    for (const layer of geom.layers) {
      const gridShape = normalizeGridTriple(layer.grid_cells);
      const cellSizeM = normalizeGridTriple(layer.cell_size_m);
      const originM = normalizeGridTriple(layer.origin_m) ?? [0, 0, 0];
      if (!gridShape || !cellSizeM) continue;
      const totalCells = gridShape[0] * gridShape[1] * gridShape[2];
      let activeMask: Uint8Array | null = null;
      if (support && support.nodeCount >= layer.value_offset + totalCells) {
        let anyInactive = false;
        const mask = new Uint8Array(totalCells);
        for (let i = 0; i < totalCells; i += 1) {
          const active = savedSupportNodeIsActive(
            support,
            layer.value_offset + i,
          );
          mask[i] = active ? 1 : 0;
          if (!active) anyInactive = true;
        }
        if (anyInactive) activeMask = mask;
      }
      const start = layer.value_offset * 3;
      const end = start + totalCells * 3;
      const layerSamples =
        input.samples && input.samples.length >= end
          ? input.samples.subarray(start, end)
          : null;
      const field: Export3DRealFieldInput | null = layerSamples
        ? {
            kind: "real",
            quantityId,
            componentCount: 3,
            values: layerSamples,
          }
        : null;
      targets.push({
        kind: "fdm_grid",
        id: layer.layer_id,
        name: layer.object_id || layer.layer_id,
        gridShape,
        cellSizeM,
        originM,
        ...(activeMask ? { activeMask } : {}),
        field,
        appearance: {
          colorMode: field ? colorMode : "monochrome",
          colorRange,
          colorPalette: defaultPalette,
          includeSurface: true,
          includeWireframe: false,
          includeVectors: Boolean(field),
        },
      });
    }
  } else {
    const gridShape = normalizeGridTriple(geom.grid_cells);
    const cellSizeM = normalizeGridTriple(geom.cell_size_m);
    const originM = normalizeGridTriple(geom.origin_m) ?? [0, 0, 0];
    if (gridShape && cellSizeM) {
      const totalCells = gridShape[0] * gridShape[1] * gridShape[2];
      let activeMask: Uint8Array | null = null;
      if (input.support && input.support.nodeCount >= totalCells) {
        let anyInactive = false;
        const mask = new Uint8Array(totalCells);
        for (let i = 0; i < totalCells; i += 1) {
          const active = savedSupportNodeIsActive(input.support, i);
          mask[i] = active ? 1 : 0;
          if (!active) anyInactive = true;
        }
        if (anyInactive) activeMask = mask;
      }
      const field: Export3DRealFieldInput | null =
        input.samples && input.samples.length >= totalCells * 3
          ? {
              kind: "real",
              quantityId,
              componentCount: 3,
              values: input.samples,
            }
          : null;
      targets.push({
        kind: "fdm_grid",
        id: `study-fdm-${result.artifact_id}`,
        name: result.source.step_id,
        gridShape,
        cellSizeM,
        originM,
        ...(activeMask ? { activeMask } : {}),
        field,
        appearance: {
          colorMode: field ? colorMode : "monochrome",
          colorRange,
          colorPalette: defaultPalette,
          includeSurface: true,
          includeWireframe: false,
          includeVectors: Boolean(field),
        },
      });
    }
  }

  const label = `${result.source.step_id} (step ${descriptor.step})`;
  const suggestedFilenameStem = sanitizeSlug(
    `study-${result.source.run_id}-${result.source.step_id}-step-${descriptor.step}`,
    "study-result",
  );

  return {
    availableFrameCount: 1,
    currentFrameIndex: 0,
    defaultAnimationMode: "static",
    defaultColorMode: targets.some((t) => Boolean(t.field))
      ? colorMode
      : "monochrome",
    defaultPalette,
    femActiveNodeIndices,
    provenance: {
      source: "study-result-playback",
      projectId: descriptor.project_id,
      artifactId: descriptor.artifact_id,
      artifactSha256: descriptor.artifact_sha256,
      domainGenerationId: descriptor.domain_generation_id,
      topologyFingerprint: descriptor.topology_fingerprint,
      runId: result.source.run_id,
      stepId: result.source.step_id,
      caseId: result.source.case_id,
      step: descriptor.step,
      timeS: descriptor.time_s,
      quantityId,
    },
    quantityId,
    sourceLabel: label,
    suggestedFilenameStem,
    targets,
    warnings,
  };
}

/**
 * Load multiple decoded playback frames through the typed ControlRoomApi client
 * to assemble an `Export3DFramesFieldInput` for animated glTF/GLB export.
 */
export async function loadSavedPlaybackFramesForExport(
  input: LoadSavedPlaybackFramesInput,
): Promise<Export3DFramesFieldInput> {
  const { api, itemId, manifest, signal, onProgress } = input;
  const stage =
    (input.stageId
      ? manifest.stages.find((s) => s.stage_id === input.stageId)
      : undefined) ?? manifest.stages[0];
  if (!stage || stage.frame_count <= 0) {
    throw new Error("No saved playback frames are available in this stage.");
  }

  const stride = Math.max(1, Math.floor(input.frameStride ?? 1));
  const selectedIndices: number[] = [];
  for (let i = 0; i < stage.frame_count; i += stride) {
    selectedIndices.push(i);
  }
  const total = selectedIndices.length;
  onProgress?.(0, total);

  const expectedNodeCount = savedPlaybackNodeCount(manifest);
  const frames: Export3DFieldFrame[] = [];

  for (let i = 0; i < total; i += 1) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The playback frame export was aborted.", "AbortError");
    }

    const frameIdx = selectedIndices[i] ?? 0;
    const response = await api.workspace.playbackFrame(
      itemId,
      stage.stage_id,
      frameIdx,
      manifest.revision,
      signal ? { signal } : undefined,
    );

    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The playback frame export was aborted.", "AbortError");
    }

    if (response.status !== "ready") {
      throw new Error(
        `Saved playback frame ${frameIdx} is unavailable (${response.status}).`,
      );
    }

    const decoded = decodeSavedPlaybackFrame(response.data, expectedNodeCount);
    const values =
      input.activeNodeIndices &&
      input.activeNodeIndices.length < expectedNodeCount
        ? sliceFrameValuesForNodes(decoded, input.activeNodeIndices)
        : decoded;

    const timeS = stage.times_s?.[frameIdx];
    frames.push({
      values,
      ...(typeof timeS === "number" && Number.isFinite(timeS)
        ? { timeS }
        : {}),
      label: `frame_${frameIdx}`,
    });

    onProgress?.(i + 1, total);
  }

  return {
    kind: "frames",
    quantityId: input.quantityId?.trim() || stage.quantity_ids?.[0] || "m",
    componentCount: 3,
    frames,
  };
}
