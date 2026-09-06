import type { FieldMapRenderLayers, FieldMapRenderModel } from "./fieldMapRenderModel";

export interface PlanarFigureSpec {
  backgroundPolicy: "transparent" | "solid" | "theme";
  camera: {
    panU: number;
    panV: number;
    zoom: number;
  };
  canonicalUnit: string;
  colormap: string;
  component: string;
  displayUnit: string | null;
  dpi: number;
  fieldRevision?: string;
  height: number;
  layers: FieldMapRenderLayers;
  meshBounds: readonly [number, number, number, number];
  pointStyle: {
    color: string;
    opacity: number;
    size: number;
  };
  quantityId: string;
  range: {
    max: number;
    min: number;
    mode: "auto" | "manual" | "symmetric";
  };
  rasterOpacity: number;
  resolution: readonly [number, number];
  sampleIdentity: string;
  vectorStyle: {
    color: string;
    colorMode: string;
    lengthMode: string;
    opacity: number;
    thickness: number;
  };
  width: number;
  wireframeStyle: {
    color: string;
    opacity: number;
  };
}

export interface PlanarExportManifest {
  datasetSpec: {
    carrierRevision?: string;
    component: string;
    frame?: {
      boundsUvM: readonly [number, number, number, number];
      normal: readonly [number, number, number];
      originM: readonly [number, number, number];
      uAxis: readonly [number, number, number];
      vAxis: readonly [number, number, number];
    };
    operator?: unknown;
    physicalBoundsM: readonly [number, number, number, number];
    quantityId: string;
    resolution: readonly [number, number];
    sampleIdentity: string;
    sampleSupport?: string;
    scopeId?: string | null;
    scopeKind?: string;
    source?: unknown;
    units: {
      canonical: string;
      display: string | null;
    };
  };
  exportedAt: string;
  figureSpec: PlanarFigureSpec;
  revisions: {
    carrierRevision?: string;
    fieldRevision?: string;
    meshRevision?: string;
    sampleIdentity: string;
    sceneRevision?: string;
  };
  samplerVersion: string;
  schemaVersion: "fullmag.planar-figure-manifest.v1";
}

export function createPlanarFigureSpec(
  model: FieldMapRenderModel,
  options: {
    backgroundPolicy?: "transparent" | "solid" | "theme";
    dpi?: number;
    fieldRevision?: string;
    height?: number;
    quantityId?: string;
    rangeMode?: "auto" | "manual" | "symmetric";
    width?: number;
  } = {},
): PlanarFigureSpec {
  return {
    backgroundPolicy: options.backgroundPolicy ?? "solid",
    camera: {
      panU: model.interaction.panU,
      panV: model.interaction.panV,
      zoom: model.interaction.zoom,
    },
    canonicalUnit: model.canonicalUnit,
    colormap: model.colormap,
    component: model.component,
    displayUnit: model.display.legendUnit,
    dpi: options.dpi ?? 300,
    fieldRevision: options.fieldRevision,
    height: options.height ?? model.resolution[1] * 4,
    layers: { ...model.layers },
    meshBounds: model.bounds,
    pointStyle: { ...model.pointStyle },
    quantityId: options.quantityId ?? model.quantityId ?? model.component,
    range: {
      max: model.range?.max ?? 0,
      min: model.range?.min ?? 0,
      mode: options.rangeMode ?? "auto",
    },
    rasterOpacity: model.rasterOpacity ?? 1,
    resolution: model.resolution,
    sampleIdentity: model.sampleIdentity,
    vectorStyle: { ...model.vectorStyle },
    width: options.width ?? model.resolution[0] * 4,
    wireframeStyle: { ...model.wireframeStyle },
  };
}

export function buildPlanarExportManifest(
  spec: PlanarFigureSpec,
  options?: string | {
    datasetMetadata?: {
      carrierRevision?: string;
      frame?: {
        boundsUvM: readonly [number, number, number, number];
        normal: readonly [number, number, number];
        originM: readonly [number, number, number];
        uAxis: readonly [number, number, number];
        vAxis: readonly [number, number, number];
      };
      meshRevision?: string;
      operator?: unknown;
      sampleSupport?: string;
      sceneRevision?: string;
      scopeId?: string | null;
      scopeKind?: string;
      source?: unknown;
    };
    exportedAt?: string;
    samplerVersion?: string;
  },
): PlanarExportManifest {
  const opts = typeof options === "string" ? { exportedAt: options } : (options ?? {});
  const dsMeta = typeof options === "object" && options !== null ? options.datasetMetadata : undefined;
  return {
    datasetSpec: {
      carrierRevision: dsMeta?.carrierRevision,
      component: spec.component,
      frame: dsMeta?.frame,
      operator: dsMeta?.operator,
      physicalBoundsM: spec.meshBounds,
      quantityId: spec.quantityId,
      resolution: spec.resolution,
      sampleIdentity: spec.sampleIdentity,
      sampleSupport: dsMeta?.sampleSupport,
      scopeId: dsMeta?.scopeId,
      scopeKind: dsMeta?.scopeKind,
      source: dsMeta?.source,
      units: {
        canonical: spec.canonicalUnit,
        display: spec.displayUnit,
      },
    },
    exportedAt: opts.exportedAt ?? new Date().toISOString(),
    figureSpec: spec,
    revisions: {
      carrierRevision: dsMeta?.carrierRevision,
      fieldRevision: spec.fieldRevision,
      meshRevision: dsMeta?.meshRevision,
      sampleIdentity: spec.sampleIdentity,
      sceneRevision: dsMeta?.sceneRevision,
    },
    samplerVersion: opts.samplerVersion ?? "fullmag-planar-sampling.v2",
    schemaVersion: "fullmag.planar-figure-manifest.v1",
  };
}

export function serializePlanarFigureSpec(spec: PlanarFigureSpec): string {
  return JSON.stringify(spec, null, 2);
}

export function deserializePlanarFigureSpec(json: string): PlanarFigureSpec {
  const parsed = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid PlanarFigureSpec: expected an object");
  }
  const spec = parsed as Partial<PlanarFigureSpec>;
  if (typeof spec.quantityId !== "string" || !spec.quantityId) {
    throw new Error("Invalid PlanarFigureSpec: missing or invalid quantityId");
  }
  if (typeof spec.component !== "string" || !spec.component) {
    throw new Error("Invalid PlanarFigureSpec: missing or invalid component");
  }
  if (typeof spec.canonicalUnit !== "string") {
    throw new Error("Invalid PlanarFigureSpec: missing or invalid canonicalUnit");
  }
  if (typeof spec.colormap !== "string" || !spec.colormap) {
    throw new Error("Invalid PlanarFigureSpec: missing or invalid colormap");
  }
  if (
    !Array.isArray(spec.resolution) ||
    spec.resolution.length !== 2 ||
    !Number.isFinite(spec.resolution[0]) ||
    !Number.isFinite(spec.resolution[1]) ||
    !Number.isInteger(spec.resolution[0]) ||
    !Number.isInteger(spec.resolution[1]) ||
    spec.resolution[0]! <= 0 ||
    spec.resolution[1]! <= 0
  ) {
    throw new Error("Invalid PlanarFigureSpec: resolution must be [width, height] positive numbers");
  }
  if (
    !Array.isArray(spec.meshBounds) ||
    spec.meshBounds.length !== 4 ||
    !spec.meshBounds.every(Number.isFinite) ||
    spec.meshBounds[0]! >= spec.meshBounds[1]! ||
    spec.meshBounds[2]! >= spec.meshBounds[3]!
  ) {
    throw new Error("Invalid PlanarFigureSpec: meshBounds must be [uMin, uMax, vMin, vMax] numbers");
  }
  if (
    !spec.range ||
    typeof spec.range !== "object" ||
    !Number.isFinite(spec.range.min) ||
    !Number.isFinite(spec.range.max) ||
    spec.range.min > spec.range.max
  ) {
    throw new Error("Invalid PlanarFigureSpec: invalid range object");
  }
  if (typeof spec.sampleIdentity !== "string" || !spec.sampleIdentity.trim()) {
    throw new Error("Invalid PlanarFigureSpec: missing or invalid sampleIdentity");
  }
  if (
    typeof spec.width !== "number" ||
    !Number.isFinite(spec.width) ||
    spec.width <= 0
  ) {
    throw new Error("Invalid PlanarFigureSpec: invalid width");
  }
  if (
    typeof spec.height !== "number" ||
    !Number.isFinite(spec.height) ||
    spec.height <= 0
  ) {
    throw new Error("Invalid PlanarFigureSpec: invalid height");
  }
  if (
    typeof spec.dpi !== "number" ||
    !Number.isFinite(spec.dpi) ||
    spec.dpi <= 0
  ) {
    throw new Error("Invalid PlanarFigureSpec: invalid dpi");
  }
  if (
    !spec.camera ||
    typeof spec.camera !== "object" ||
    !Number.isFinite(spec.camera.panU) ||
    !Number.isFinite(spec.camera.panV) ||
    !Number.isFinite(spec.camera.zoom) ||
    spec.camera.zoom <= 0
  ) {
    throw new Error("Invalid PlanarFigureSpec: invalid camera object");
  }
  if (!spec.layers || typeof spec.layers !== "object") {
    throw new Error("Invalid PlanarFigureSpec: missing or invalid layers object");
  }
  return spec as PlanarFigureSpec;
}
