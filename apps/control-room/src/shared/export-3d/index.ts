import { buildExport3DGltf } from "./export3dGltfBuilder";
import {
  resolveBoundsFromTargets,
  throwIfExportAborted,
  type Export3DAnimationMode,
  type Export3DCapabilitySummary,
  type Export3DFormat,
  type Export3DModelRequest,
  type Export3DResult,
  type Export3DTargetInput,
} from "./export3dTypes";
import { resolveFdmActiveCellMask } from "./export3dVoxelShell";
import { serializeVtkExport } from "./export3dVtkSerializer";

export * from "./export3dTypes";
export * from "./export3dColorEvaluator";
export * from "./export3dVoxelShell";
export * from "./export3dArrowGeometry";
export * from "./export3dGltfBuilder";
export * from "./export3dZipArchive";
export * from "./export3dVtkSerializer";

const FORMAT_METADATA: Readonly<
  Record<Export3DFormat, { extension: string; mimeType: string }>
> = {
  glb: { extension: "glb", mimeType: "model/gltf-binary" },
  gltf: { extension: "gltf", mimeType: "model/gltf+json" },
  vtu: { extension: "vtu", mimeType: "application/xml" },
  vtu_zip: { extension: "vtu.zip", mimeType: "application/zip" },
};

export function resolveExport3DFilename(
  requestedFilename: string | null | undefined,
  format: Export3DFormat,
): string {
  const { extension } = FORMAT_METADATA[format];
  const raw = (requestedFilename ?? "").trim();
  const stripped = raw
    .replace(/\.(?:vtu\.zip|glb|gltf|vtu)$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = stripped.length > 0 ? stripped : "fullmag-model";
  return `${stem}.${extension}`;
}

export function summarizeExport3DCapabilities(
  targets: readonly Export3DTargetInput[],
): Export3DCapabilitySummary {
  let hasFdmTargets = false;
  let hasFemTargets = false;
  let hasVectorField = false;
  let hasScalarField = false;
  let hasComplexField = false;
  let hasPlaybackFrames = false;
  let playbackFrameCount = 0;
  let supportsVolumetricVtu = false;
  let estimatedVertexCount = 0;
  let estimatedCellCount = 0;
  const warnings: string[] = [];

  for (const target of targets) {
    if (target.kind === "fdm_grid") {
      hasFdmTargets = true;
      supportsVolumetricVtu = true;
      const [nx, ny, nz] = target.gridShape;
      if (nx > 0 && ny > 0 && nz > 0) {
        let activeCount = nx * ny * nz;
        if (
          (target.activeMask && target.activeMask.length === activeCount) ||
          (target.regionIds && target.regionIds.length === activeCount)
        ) {
          activeCount = resolveFdmActiveCellMask(
            target.gridShape,
            target.activeMask,
            target.regionIds,
          ).activeCellCount;
        }
        estimatedCellCount += activeCount;
        estimatedVertexCount += activeCount > 0 ? Math.min(activeCount * 24, activeCount * 8) : 0;
      }
    } else {
      if (target.kind === "fem_mesh") {
        hasFemTargets = true;
        if (target.volumeCells) supportsVolumetricVtu = true;
      }
      const nodeCount = Math.floor(target.positionsM.length / 3);
      estimatedVertexCount += nodeCount;
      if (target.kind === "fem_mesh" && target.volumeCells) {
        const vc = target.volumeCells;
        const cellCount = vc.cellTypes
          ? vc.cellTypes.length
          : (vc.cellCount ?? Math.floor(vc.cellNodes.length / 4));
        estimatedCellCount += cellCount;
      } else {
        const idx =
          target.kind === "fem_mesh" ? target.surfaceIndices : target.indices;
        estimatedCellCount += idx
          ? Math.floor(idx.length / 3)
          : Math.floor(nodeCount / 3);
      }
    }

    if (target.renderedVectors?.segmentsM.length) hasVectorField = true;
    const field = target.field;
    if (field) {
      if (field.componentCount === 3) hasVectorField = true;
      else hasScalarField = true;
      if (field.kind === "complex") {
        hasComplexField = true;
      } else if (field.kind === "frames") {
        hasPlaybackFrames = true;
        if (field.frames.length > playbackFrameCount) {
          playbackFrameCount = field.frames.length;
        }
      }
    }
  }

  const hasExportableGeometry = estimatedVertexCount > 0;
  if (!hasExportableGeometry) {
    warnings.push("No exportable 3D geometry targets are available.");
  }

  const supportedFormats: Export3DFormat[] = hasExportableGeometry
    ? ["glb", "gltf", "vtu", "vtu_zip"]
    : [];

  const supportedAnimationModes: Export3DAnimationMode[] = ["static"];
  if (hasComplexField) supportedAnimationModes.push("phase_cycle");
  if (hasPlaybackFrames && playbackFrameCount > 1) {
    supportedAnimationModes.push("playback_frames");
  }

  return {
    hasExportableGeometry,
    hasFdmTargets,
    hasFemTargets,
    hasVectorField,
    hasScalarField,
    hasComplexField,
    hasPlaybackFrames,
    playbackFrameCount,
    supportedFormats,
    supportedAnimationModes,
    supportsVectors: hasVectorField,
    supportsSurfaceDisplacement:
      hasExportableGeometry && (hasVectorField || hasScalarField),
    supportsVolumetricVtu,
    estimatedVertexCount,
    estimatedCellCount,
    boundsM: resolveBoundsFromTargets(targets),
    warnings,
  };
}

/**
 * Exports one or more Fullmag FDM/FEM 3D scenes/fields into `.glb`, `.gltf`,
 * `.vtu`, or `.vtu.zip` (ParaView PVD collection + VTU frame sequence).
 */
export async function export3DModel(
  request: Export3DModelRequest,
): Promise<Export3DResult> {
  throwIfExportAborted(request.options.signal);
  if (!request.targets || request.targets.length === 0) {
    throw new Error("Cannot export 3D model: targets array is empty.");
  }

  const { format } = request.options;
  const meta = FORMAT_METADATA[format];
  if (!meta) {
    throw new RangeError(`Unsupported 3D export format: "${String(format)}"`);
  }
  const filename = resolveExport3DFilename(request.options.filename, format);

  if (format === "glb" || format === "gltf") {
    const built = await buildExport3DGltf(request);
    return {
      format,
      filename,
      extension: meta.extension,
      mimeType: meta.mimeType,
      bytes: built.bytes,
      text: built.text,
      coordinateTransform: built.coordinateTransform,
      stats: built.stats,
      warnings: built.warnings,
    };
  }

  const vtk = serializeVtkExport(request);
  return {
    format,
    filename,
    extension: meta.extension,
    mimeType: meta.mimeType,
    bytes: vtk.bytes,
    text: vtk.text,
    coordinateTransform: vtk.coordinateTransform,
    stats: vtk.stats,
    warnings: vtk.warnings,
  };
}
