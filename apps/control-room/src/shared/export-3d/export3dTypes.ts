import type {
  FloquetSpatialConvention,
  PhasorConvention,
} from "@/shared/domain/analysis/phasorConventionAdapter";
import type { ScalarColorPalette } from "@/shared/visualization/scalarColorPalette";

export type Export3DFormat = "glb" | "gltf" | "vtu" | "vtu_zip";

export type Export3DCoordinateScaleMode =
  | "auto_scene"
  | "nm"
  | "um"
  | "mm"
  | "si_m";

export type Export3DMaterialStyle = "unlit" | "pbr";

export type Export3DColorMode =
  | "orientation"
  | "magnitude"
  | "x"
  | "y"
  | "z"
  | "scalar"
  | "monochrome";

export type Export3DScalarPalette = ScalarColorPalette | "twilight";

export type Export3DComplexRepresentation =
  | "phase_rotated_real"
  | "real"
  | "imag"
  | "abs"
  | "phase";

export type Export3DAnimationMode =
  | "static"
  | "phase_cycle"
  | "playback_frames";

export type Export3DArrowAnchorMode = "center" | "tail";

export type Export3DVectorLengthMode = "proportional" | "uniform";

export type Export3DVectorScope = "full" | "surface";

export type Export3DVtkEncoding = "ascii" | "binary";

export type Export3DVtkFdmGeometryMode =
  | "volume_hexahedra"
  | "surface_triangles";

export type Export3DSurfaceDisplacementComponent =
  | "auto"
  | "z"
  | "x"
  | "y"
  | "normal";

export type Export3DNumericArray =
  | Float32Array
  | Float64Array
  | readonly number[];

export type Export3DIndexArray =
  | Uint32Array
  | Uint16Array
  | readonly number[];

export interface Export3DScalarRange {
  min: number;
  max: number;
}

export type Export3DRgbTuple = readonly [number, number, number];

export type Export3DFieldLocation = "cell" | "vertex";

export interface Export3DFieldFrame {
  timeS?: number;
  phaseRad?: number;
  label?: string;
  values: Export3DNumericArray;
}

interface Export3DFieldBase {
  quantityId: string;
  unit?: string;
  componentCount: 1 | 3;
  location?: Export3DFieldLocation;
  nodeIndices?: Export3DIndexArray | null;
}

export interface Export3DRealFieldInput extends Export3DFieldBase {
  kind: "real";
  values: Export3DNumericArray;
}

export interface Export3DComplexFieldInput extends Export3DFieldBase {
  kind: "complex";
  realValues: Export3DNumericArray;
  imagValues: Export3DNumericArray;
  phasorConvention?: PhasorConvention;
  floquetSpatialConvention?: FloquetSpatialConvention;
  wavevectorKf?: readonly [number, number, number] | null;
  cellOriginM?: readonly [number, number, number] | null;
  amplitudeScale?: number;
  complexRepresentation?: Export3DComplexRepresentation;
  complexPhaseRad?: number;
}

export interface Export3DFramesFieldInput extends Export3DFieldBase {
  kind: "frames";
  frames: readonly Export3DFieldFrame[];
}

export type Export3DFieldInput =
  | Export3DRealFieldInput
  | Export3DComplexFieldInput
  | Export3DFramesFieldInput;

export interface Export3DVtkVolumeCells {
  cellNodes: Export3DIndexArray;
  cellOffsets?: Export3DIndexArray | null;
  cellTypes?: Export3DIndexArray | null;
  cellCount?: number;
}

export interface Export3DTargetAppearance {
  colorMode?: Export3DColorMode;
  colorPalette?: Export3DScalarPalette;
  colorRange?: Export3DScalarRange | null;
  monochromeColor?: Export3DRgbTuple;
  opacity?: number;
  includeSurface?: boolean;
  includeWireframe?: boolean;
  includeVectors?: boolean;
  vectorColorMode?: Export3DColorMode;
}

/** The sampled arrows and linear RGB already used by the current 3D view. */
export interface Export3DRenderedVectors {
  /** Seven floats per arrow: tail XYZ, tip XYZ, relative magnitude. */
  segmentsM: Float32Array;
  colors: Float32Array | null;
  monochromeColor?: Export3DRgbTuple;
  opacity: number;
  headRadiusRatio?: number;
  shaftRadiusRatio?: number;
}

interface Export3DTargetBase {
  id: string;
  role?: "airbox";
  name?: string;
  field?: Export3DFieldInput | null;
  appearance?: Export3DTargetAppearance;
  /** null denotes a captured viewport target with no displayed arrows. */
  renderedVectors?: Export3DRenderedVectors | null;
}

export interface Export3DFdmGridTargetInput extends Export3DTargetBase {
  kind: "fdm_grid";
  gridShape: readonly [number, number, number];
  cellSizeM: readonly [number, number, number];
  originM?: readonly [number, number, number];
  activeMask?: Uint8Array | readonly number[] | null;
  regionIds?: Uint32Array | readonly number[] | null;
}

export interface Export3DFemMeshTargetInput extends Export3DTargetBase {
  kind: "fem_mesh";
  positionsM: Export3DNumericArray;
  surfaceIndices?: Export3DIndexArray | null;
  normals?: Export3DNumericArray | null;
  volumeCells?: Export3DVtkVolumeCells | null;
  nodeIndices?: Export3DIndexArray | null;
}

export interface Export3DSurfaceGeometryTargetInput extends Export3DTargetBase {
  kind: "surface_geometry";
  positionsM: Export3DNumericArray;
  indices?: Export3DIndexArray | null;
  normals?: Export3DNumericArray | null;
}

export type Export3DTargetInput =
  | Export3DFdmGridTargetInput
  | Export3DFemMeshTargetInput
  | Export3DSurfaceGeometryTargetInput;

export interface Export3DModelOptions {
  format: Export3DFormat;
  filename?: string;
  coordinateScale?: Export3DCoordinateScaleMode;
  materialStyle?: Export3DMaterialStyle;
  colorMode?: Export3DColorMode;
  colorPalette?: Export3DScalarPalette;
  colorRange?: Export3DScalarRange | null;
  monochromeColor?: Export3DRgbTuple;
  opacity?: number;
  includeSurface?: boolean;
  includeWireframe?: boolean;
  wireframeColor?: Export3DRgbTuple;
  includeVectors?: boolean;
  vectorColorMode?: Export3DColorMode;
  vectorColorPalette?: Export3DScalarPalette;
  maxVectors?: number;
  arrowLengthScale?: number;
  arrowAnchorMode?: Export3DArrowAnchorMode;
  vectorLengthMode?: Export3DVectorLengthMode;
  vectorScope?: Export3DVectorScope;
  animationMode?: Export3DAnimationMode;
  cycleDurationSeconds?: number;
  phaseFrameCount?: number;
  arrowFps?: number;
  surfaceDisplacementScale?: number;
  surfaceDisplacementComponent?: Export3DSurfaceDisplacementComponent;
  vtkEncoding?: Export3DVtkEncoding;
  /** Preserve sampled colors while omitting physical vector arrays in VTK. */
  vtkIncludeVectorData?: boolean;
  vtkFdmGeometryMode?: Export3DVtkFdmGeometryMode;
  frameIndex?: number;
  provenance?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Export3DModelRequest {
  targets: readonly Export3DTargetInput[];
  options: Export3DModelOptions;
}

export interface Export3DBoundsM {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  size: [number, number, number];
}

export interface Export3DCoordinateTransform {
  mode: Export3DCoordinateScaleMode;
  unitsPerMeter: number;
  siMetersPerUnit: number;
  originOffsetM: [number, number, number];
}

export interface Export3DStats {
  targetCount: number;
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
  cellCount: number;
  arrowCount: number;
  frameCount: number;
  animationChannelCount: number;
  materialCount: number;
  byteLength: number;
}

export interface Export3DResult {
  format: Export3DFormat;
  filename: string;
  extension: string;
  mimeType: string;
  bytes: Uint8Array;
  text?: string;
  coordinateTransform: Export3DCoordinateTransform;
  stats: Export3DStats;
  warnings: readonly string[];
}

export interface Export3DCapabilitySummary {
  hasExportableGeometry: boolean;
  hasFdmTargets: boolean;
  hasFemTargets: boolean;
  hasVectorField: boolean;
  hasScalarField: boolean;
  hasComplexField: boolean;
  hasPlaybackFrames: boolean;
  playbackFrameCount: number;
  supportedFormats: readonly Export3DFormat[];
  supportedAnimationModes: readonly Export3DAnimationMode[];
  supportsVectors: boolean;
  supportsSurfaceDisplacement: boolean;
  supportsVolumetricVtu: boolean;
  estimatedVertexCount: number;
  estimatedCellCount: number;
  boundsM: Export3DBoundsM | null;
  warnings: readonly string[];
}

export const EXPORT_3D_INACTIVE_REGION_ID = 0xffffffff;

const FIXED_SCALE_UNITS_PER_METER: Readonly<
  Record<Exclude<Export3DCoordinateScaleMode, "auto_scene">, number>
> = {
  nm: 1e9,
  um: 1e6,
  mm: 1e3,
  si_m: 1,
};

export function defaultCoordinateScaleForFormat(
  format: Export3DFormat,
): Export3DCoordinateScaleMode {
  return format === "glb" || format === "gltf" ? "auto_scene" : "si_m";
}

export function resolveEffectiveAnimationMode(
  targets: readonly Export3DTargetInput[],
  options: Export3DModelOptions,
): Export3DAnimationMode {
  if (options.animationMode) return options.animationMode;
  const hasMultiFrame = targets.some(
    (t) => t.field?.kind === "frames" && t.field.frames.length > 1,
  );
  return hasMultiFrame ? "playback_frames" : "static";
}

export function resolveBoundsFromTargets(
  targets: readonly Export3DTargetInput[],
): Export3DBoundsM | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const target of targets) {
    if (target.kind === "fdm_grid") {
      const [nx, ny, nz] = target.gridShape;
      const [dx, dy, dz] = target.cellSizeM;
      const [ox, oy, oz] = target.originM ?? [0, 0, 0];
      if (
        nx <= 0 ||
        ny <= 0 ||
        nz <= 0 ||
        !Number.isFinite(dx) ||
        !Number.isFinite(dy) ||
        !Number.isFinite(dz) ||
        dx <= 0 ||
        dy <= 0 ||
        dz <= 0
      ) {
        continue;
      }
      const total = nx * ny * nz;
      const hasActiveMask = target.activeMask != null && target.activeMask.length === total;
      const hasRegionIds =
        !hasActiveMask && target.regionIds != null && target.regionIds.length === total;
      if (!hasActiveMask && !hasRegionIds) {
        minX = Math.min(minX, ox);
        minY = Math.min(minY, oy);
        minZ = Math.min(minZ, oz);
        maxX = Math.max(maxX, ox + nx * dx);
        maxY = Math.max(maxY, oy + ny * dy);
        maxZ = Math.max(maxZ, oz + nz * dz);
        continue;
      }
      const planeStride = nx * ny;
      let anyActive = false;
      for (let cell = 0; cell < total; cell += 1) {
        const active = hasActiveMask
          ? Boolean(target.activeMask![cell])
          : (target.regionIds![cell] ?? EXPORT_3D_INACTIVE_REGION_ID) !==
            EXPORT_3D_INACTIVE_REGION_ID;
        if (!active) continue;
        anyActive = true;
        const ix = cell % nx;
        const iy = Math.floor(cell / nx) % ny;
        const iz = Math.floor(cell / planeStride) % nz;
        const x0 = ox + ix * dx;
        const y0 = oy + iy * dy;
        const z0 = oz + iz * dz;
        minX = Math.min(minX, x0);
        minY = Math.min(minY, y0);
        minZ = Math.min(minZ, z0);
        maxX = Math.max(maxX, x0 + dx);
        maxY = Math.max(maxY, y0 + dy);
        maxZ = Math.max(maxZ, z0 + dz);
      }
      if (!anyActive) {
        continue;
      }
    } else {
      const positions = target.positionsM;
      const count = Math.floor(positions.length / 3);
      for (let i = 0; i < count; i += 1) {
        const x = positions[i * 3] ?? Number.NaN;
        const y = positions[i * 3 + 1] ?? Number.NaN;
        const z = positions[i * 3 + 2] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          continue;
        }
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
    }
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(maxZ)
  ) {
    return null;
  }

  const size: [number, number, number] = [
    Math.max(0, maxX - minX),
    Math.max(0, maxY - minY),
    Math.max(0, maxZ - minZ),
  ];
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [
      minX + size[0] * 0.5,
      minY + size[1] * 0.5,
      minZ + size[2] * 0.5,
    ],
    size,
  };
}

export function resolveCoordinateTransform(
  boundsM: Export3DBoundsM | null,
  mode: Export3DCoordinateScaleMode,
): Export3DCoordinateTransform {
  if (mode === "auto_scene") {
    const maxDim = boundsM
      ? Math.max(boundsM.size[0], boundsM.size[1], boundsM.size[2])
      : 0;
    const unitsPerMeter = maxDim > 0 && Number.isFinite(maxDim) ? 2.0 / maxDim : 1;
    const siMetersPerUnit = maxDim > 0 && Number.isFinite(maxDim) ? maxDim / 2.0 : 1;
    const originOffsetM: [number, number, number] = boundsM
      ? [boundsM.center[0], boundsM.center[1], boundsM.center[2]]
      : [0, 0, 0];
    return {
      mode,
      unitsPerMeter,
      siMetersPerUnit,
      originOffsetM,
    };
  }

  const unitsPerMeter = FIXED_SCALE_UNITS_PER_METER[mode];
  return {
    mode,
    unitsPerMeter,
    siMetersPerUnit: 1 / unitsPerMeter,
    originOffsetM: [0, 0, 0],
  };
}

export function transformPositionByCoordinateTransform(
  xM: number,
  yM: number,
  zM: number,
  transform: Export3DCoordinateTransform,
): [number, number, number] {
  return [
    (xM - transform.originOffsetM[0]) * transform.unitsPerMeter,
    (yM - transform.originOffsetM[1]) * transform.unitsPerMeter,
    (zM - transform.originOffsetM[2]) * transform.unitsPerMeter,
  ];
}

/**
 * Sanitizes an Object3D node name to match `[A-Za-z0-9_-]+` strictly and
 * guarantees uniqueness within `usedNames`. Three.js PropertyBinding treats
 * `.`, `:`, `[`, `]`, and `/` as path delimiters in KeyframeTrack names.
 */
export function sanitizeGlTfNodeName(
  rawName: string,
  usedNames: Set<string>,
  fallback = "node",
): string {
  const sanitizedBase = rawName
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const fallbackSafe = fallback.replace(/[^A-Za-z0-9_-]+/g, "_") || "node";
  const base = sanitizedBase.length > 0 ? sanitizedBase : fallbackSafe;
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  let suffix = 2;
  while (usedNames.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  const uniqueName = `${base}_${suffix}`;
  usedNames.add(uniqueName);
  return uniqueName;
}

export function throwIfExportAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("3D model export aborted", "AbortError");
  }
}

export function sanitizeJsonExtrasValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonExtrasValue(item));
  }
  if (ArrayBuffer.isView(value)) {
    const typed = value as unknown as ArrayLike<number>;
    const out: number[] = [];
    for (let i = 0; i < typed.length; i += 1) {
      const n = Number(typed[i]);
      out.push(Number.isFinite(n) ? n : 0);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = sanitizeJsonExtrasValue(entry);
    }
    return out;
  }
  return String(value);
}
