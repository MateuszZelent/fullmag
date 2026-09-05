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
    component: string;
    physicalBoundsM: readonly [number, number, number, number];
    quantityId: string;
    resolution: readonly [number, number];
    sampleIdentity: string;
    units: {
      canonical: string;
      display: string | null;
    };
  };
  exportedAt: string;
  figureSpec: PlanarFigureSpec;
  revisions: {
    fieldRevision?: string;
    sampleIdentity: string;
  };
  samplerVersion: "fullmag-planar-sampling.v2";
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
    quantityId: options.quantityId ?? model.component,
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
  exportedAt: string = new Date().toISOString(),
): PlanarExportManifest {
  return {
    datasetSpec: {
      component: spec.component,
      physicalBoundsM: spec.meshBounds,
      quantityId: spec.quantityId,
      resolution: spec.resolution,
      sampleIdentity: spec.sampleIdentity,
      units: {
        canonical: spec.canonicalUnit,
        display: spec.displayUnit,
      },
    },
    exportedAt,
    figureSpec: spec,
    revisions: {
      fieldRevision: spec.fieldRevision,
      sampleIdentity: spec.sampleIdentity,
    },
    samplerVersion: "fullmag-planar-sampling.v2",
    schemaVersion: "fullmag.planar-figure-manifest.v1",
  };
}

export function serializePlanarFigureSpec(spec: PlanarFigureSpec): string {
  return JSON.stringify(spec, null, 2);
}

export function deserializePlanarFigureSpec(json: string): PlanarFigureSpec {
  return JSON.parse(json) as PlanarFigureSpec;
}
