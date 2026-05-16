"use client";

export type MagnetizationInspectorView =
  | "overview"
  | "texture"
  | "transform_overview"
  | "transform_translate"
  | "transform_rotate"
  | "transform_scale";

export type MagnetizationInspectorNodeIds = {
  overview: string;
  texture: string;
  transformOverview: string;
  transformTranslate: string;
  transformRotate: string;
  transformScale: string;
};

function isRegionMagnetizationBranch(nodeId: string | undefined, objectName: string): boolean {
  return nodeId?.startsWith(`reg-${objectName}`) ?? false;
}

export function resolveMagnetizationInspectorView(
  nodeId: string | undefined,
): MagnetizationInspectorView {
  if (!nodeId) {
    return "overview";
  }
  if (
    nodeId.endsWith("-texture-transform-translate") ||
    nodeId.endsWith("-transform-translate")
  ) {
    return "transform_translate";
  }
  if (
    nodeId.endsWith("-texture-transform-rotate") ||
    nodeId.endsWith("-transform-rotate")
  ) {
    return "transform_rotate";
  }
  if (
    nodeId.endsWith("-texture-transform-scale") ||
    nodeId.endsWith("-transform-scale")
  ) {
    return "transform_scale";
  }
  if (
    nodeId.endsWith("-texture-transform") ||
    nodeId.endsWith("-transform")
  ) {
    return "transform_overview";
  }
  if (nodeId.endsWith("-texture") || nodeId.endsWith("-kind")) {
    return "texture";
  }
  return "overview";
}

export function buildMagnetizationInspectorNodeIds(
  nodeId: string | undefined,
  objectName: string,
): MagnetizationInspectorNodeIds {
  if (isRegionMagnetizationBranch(nodeId, objectName)) {
    const regionBase = `reg-${objectName}-item`;
    const transformBase = `${regionBase}-texture-transform`;
    return {
      overview: `mag-${objectName}`,
      texture: `${regionBase}-texture`,
      transformOverview: transformBase,
      transformTranslate: `${transformBase}-translate`,
      transformRotate: `${transformBase}-rotate`,
      transformScale: `${transformBase}-scale`,
    };
  }
  const objectBase = `mag-${objectName}`;
  const transformBase = `${objectBase}-transform`;
  return {
    overview: objectBase,
    texture: `${objectBase}-kind`,
    transformOverview: transformBase,
    transformTranslate: `${transformBase}-translate`,
    transformRotate: `${transformBase}-rotate`,
    transformScale: `${transformBase}-scale`,
  };
}
