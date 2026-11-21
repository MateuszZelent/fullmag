import type {
  Export3DFormat,
  Export3DResult,
} from "@/shared/export-3d/export3dTypes";

import type { Viewport3DExportSource } from "./extractViewport3DExportSource";

export type ViewportModelSource = Pick<
  Viewport3DExportSource,
  | "defaultColorMode"
  | "defaultPalette"
  | "provenance"
  | "quantityId"
  | "sourceLabel"
  | "suggestedFilenameStem"
  | "targets"
  | "warnings"
>;

export const EXPORT_3D_FORMATS = {
  glb: "GLB (.glb)",
  gltf: "glTF (.gltf)",
  vtu: "VTK Unstructured Grid (.vtu)",
  vtu_zip: "ParaView archive (.vtu.zip)",
} satisfies Record<Export3DFormat, string>;

export const EXPORT_3D_FORMAT_OPTIONS: readonly (readonly [Export3DFormat, string])[] = [
  ["glb", EXPORT_3D_FORMATS.glb],
  ["gltf", EXPORT_3D_FORMATS.gltf],
  ["vtu", EXPORT_3D_FORMATS.vtu],
  ["vtu_zip", EXPORT_3D_FORMATS.vtu_zip],
];

export function formatViewportModelSourceSummary(source: ViewportModelSource | null): string {
  if (!source) return "Current 3D view";
  return [source.sourceLabel, source.quantityId]
    .filter((label, index, labels) => Boolean(label) && labels.indexOf(label) === index)
    .join(" · ") || "Current 3D view";
}

export function defaultIncludeVectorsForSource(source: ViewportModelSource | null): boolean {
  if (!source) return false;
  return source.targets.some(
    (target) =>
      target.role !== "airbox" &&
      target.field?.componentCount === 3 &&
      target.appearance?.includeVectors,
  );
}

export function computeViewportModelExportCapabilities(
  source: ViewportModelSource | null,
  format: Export3DFormat,
  includeAirbox: boolean,
) {
  const vtk = format === "vtu" || format === "vtu_zip";
  const hasAirbox = source?.targets.some((target) => target.role === "airbox") ?? false;
  const targets = source?.targets.filter((target) => includeAirbox || target.role !== "airbox") ?? [];
  const hasVectors = targets.some((target) => target.field?.componentCount === 3);
  const canAnimate =
    format !== "vtu" &&
    targets.some(
      ({ field }) =>
        field?.kind === "complex" &&
        (field.complexRepresentation ?? "phase_rotated_real") === "phase_rotated_real",
    );
  const missingAirboxVectors =
    hasAirbox &&
    includeAirbox &&
    !targets.some((target) => target.role === "airbox" && target.field?.componentCount === 3);

  return {
    vtk,
    hasAirbox,
    targets,
    hasVectors,
    canAnimate,
    missingAirboxVectors,
  };
}

export async function executeViewportModelExport({
  animate,
  filename,
  format,
  includeAirbox,
  includeVectors,
  signal,
  source,
}: {
  animate: boolean;
  filename: string;
  format: Export3DFormat;
  includeAirbox: boolean;
  includeVectors: boolean;
  signal: AbortSignal;
  source: ViewportModelSource;
}): Promise<Export3DResult> {
  const { canAnimate, targets } = computeViewportModelExportCapabilities(
    source,
    format,
    includeAirbox,
  );
  if (targets.length === 0) {
    throw new Error("No exportable geometry is selected.");
  }
  const { export3DModel } = await import("@/shared/export-3d");
  return export3DModel({
    targets: targets.map((target) => ({
      ...target,
      appearance: {
        ...target.appearance,
        includeVectors: includeVectors && target.field?.componentCount === 3,
        includeSurface:
          target.appearance?.includeSurface || !target.appearance?.includeWireframe,
      },
    })),
    options: {
      format,
      filename,
      animationMode: animate && canAnimate ? "phase_cycle" : "static",
      vtkIncludeVectorData: includeVectors,
      colorMode: source.defaultColorMode,
      colorPalette: source.defaultPalette,
      provenance: { ...source.provenance, quantity_id: source.quantityId },
      signal,
    },
  });
}

export function downloadExport3DModel(result: Export3DResult): void {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
