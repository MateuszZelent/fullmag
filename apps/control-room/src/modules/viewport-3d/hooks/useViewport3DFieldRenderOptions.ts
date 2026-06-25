"use client";

import { useMemo } from "react";

import {
  surfaceColorSourceToColorMode,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DMeshPart } from "../viewport3dDomainAdapter";
import {
  distributeVectorGlyphBudget,
  resolveNodeSelectionCount,
  type Viewport3DFieldRenderOptions,
  type Viewport3DTopologyRenderModel,
  type Viewport3DVectorBudgetTarget,
} from "../viewport3dRenderModel";

const EMPTY_FIELD_RENDER_OPTIONS: Viewport3DFieldRenderOptions = {
  fullVectorBudget: 0,
  partVectorBudgets: new Map(),
  scalarColorModes: new Set(),
  scalarColorPalette: "viridis",
  scalarColorsVisible: false,
};
const fieldRenderOptionsCache = new WeakMap<
  Viewport3DTopologyRenderModel<Viewport3DMeshPart>,
  Viewport3DFieldRenderOptions
>();

export function useViewport3DFieldRenderOptions({
  airboxSettings,
  airboxQuantityCompatible,
  fallbackSettings,
  getPartSettings,
  scalarColorPalette,
  topologyRenderModel,
  vectorColorMode,
  vectorDomain,
  maxVectorGlyphs,
}: {
  airboxSettings: VisualizationTargetSettings;
  airboxQuantityCompatible: boolean;
  fallbackSettings: VisualizationTargetSettings;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  maxVectorGlyphs: number;
  scalarColorPalette: string;
  topologyRenderModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  vectorColorMode: string;
  vectorDomain: string;
}): Viewport3DFieldRenderOptions {
  return useMemo(() => {
    if (!topologyRenderModel) {
      return EMPTY_FIELD_RENDER_OPTIONS;
    }

    const partVectorBudgets = new Map<string, number>();
    const partVectorAnchorModes = new Map<string, "center" | "tail">();
    const partVectorScopes = new Map<string, "surface" | "full">();
    const partVectorScales = new Map<string, number>();
    const partVectorSurfaceOffsetEnabled = new Set<string>();
    const partVectorSurfaceOffsetScales = new Map<string, number>();
    const partScalarColorModes = new Map<string, string>();
    const partScalarColorPalettes = new Map<string, string>();
    const scalarColorModes = new Set<string>();
    let scalarColorsVisible = false;
    let fullVectorBudget = 0;
    let fullVectorAnchorMode: "center" | "tail" = "center";
    let fullVectorSurfaceOffsetEnabled = false;
    let fullVectorSurfaceOffsetScale = 0;
    const magneticVectorsAllowed = vectorDomain !== "airbox_only";
    const airboxVectorsVisible = viewport3DAirboxVectorsVisible(
      airboxSettings.visible,
      airboxSettings.vectorsVisible,
      airboxQuantityCompatible,
      vectorDomain,
    );

    if (topologyRenderModel.magneticParts.length > 0) {
      for (const partModel of topologyRenderModel.magneticParts) {
        const partId = partModel.part.id;
        const settings = getPartSettings(partModel.part);
        const visible =
          magneticVectorsAllowed &&
          settings.visible &&
          settings.vectorsVisible;
        if (settings.visible && settings.shaderVisible) {
          const scalarColorMode = surfaceColorSourceToColorMode(
            settings.surfaceColorSource,
          );
          if (scalarColorMode) {
            scalarColorsVisible = true;
            scalarColorModes.add(scalarColorMode);
            partScalarColorModes.set(partId, scalarColorMode);
            partScalarColorPalettes.set(partId, settings.scalarColorPalette);
          }
        }
        partVectorScopes.set(partId, settings.geometryScope);
        if (!settings.vectorCenteringEnabled) {
          partVectorAnchorModes.set(partId, "tail");
        }
        if (settings.vectorSurfaceOffsetEnabled) {
          partVectorSurfaceOffsetEnabled.add(partId);
          partVectorSurfaceOffsetScales.set(partId, settings.vectorSurfaceOffsetScale);
        }
        if (visible && settings.vectorBudget > 0) {
          partVectorBudgets.set(partId, settings.vectorBudget);
        }
        if (settings.vectorLengthScale !== 1) {
          partVectorScales.set(partId, settings.vectorLengthScale);
        }
      }
    } else {
      scalarColorsVisible =
        fallbackSettings.visible && fallbackSettings.shaderVisible;
      if (scalarColorsVisible) {
        const scalarColorMode = surfaceColorSourceToColorMode(
          fallbackSettings.surfaceColorSource,
        );
        if (scalarColorMode) {
          scalarColorModes.add(scalarColorMode);
        } else {
          scalarColorsVisible = false;
        }
      }
      const fallbackVisible =
        magneticVectorsAllowed &&
        fallbackSettings.visible &&
        fallbackSettings.vectorsVisible;
      fullVectorAnchorMode = fallbackSettings.vectorCenteringEnabled
        ? "center"
        : "tail";
      fullVectorSurfaceOffsetEnabled =
        fallbackSettings.vectorSurfaceOffsetEnabled;
      fullVectorSurfaceOffsetScale = fallbackSettings.vectorSurfaceOffsetScale;
      if (fallbackVisible) {
        fullVectorBudget = fallbackSettings.vectorBudget;
      }
    }

    for (const partModel of topologyRenderModel.airboxParts) {
      const partId = partModel.part.id;
      if (
        airboxQuantityCompatible &&
        airboxSettings.visible &&
        airboxSettings.shaderVisible
      ) {
        const scalarColorMode = surfaceColorSourceToColorMode(
          airboxSettings.surfaceColorSource,
        );
        if (scalarColorMode) {
          scalarColorsVisible = true;
          scalarColorModes.add(scalarColorMode);
          partScalarColorModes.set(partId, scalarColorMode);
          partScalarColorPalettes.set(partId, airboxSettings.scalarColorPalette);
        }
      }
      partVectorScopes.set(partId, airboxSettings.geometryScope);
      if (!airboxSettings.vectorCenteringEnabled) {
        partVectorAnchorModes.set(partId, "tail");
      }
      if (airboxSettings.vectorSurfaceOffsetEnabled) {
        partVectorSurfaceOffsetEnabled.add(partId);
        partVectorSurfaceOffsetScales.set(partId, airboxSettings.vectorSurfaceOffsetScale);
      }
      if (airboxVectorsVisible && airboxSettings.vectorBudget > 0) {
        partVectorBudgets.set(partId, airboxSettings.vectorBudget);
      }
      if (airboxSettings.vectorLengthScale !== 1) {
        partVectorScales.set(partId, airboxSettings.vectorLengthScale);
      }
    }

    const next = limitViewport3DFieldRenderVectorBudgets(
      {
        fullVectorBudget,
        fullVectorAnchorMode,
        fullVectorSurfaceOffsetEnabled,
        fullVectorSurfaceOffsetScale,
        partVectorAnchorModes:
          partVectorAnchorModes.size > 0 ? partVectorAnchorModes : undefined,
        partVectorBudgets,
        partVectorScales: partVectorScales.size > 0 ? partVectorScales : undefined,
        partVectorScopes,
        partVectorSurfaceOffsetEnabled:
          partVectorSurfaceOffsetEnabled.size > 0
            ? partVectorSurfaceOffsetEnabled
            : undefined,
        partVectorSurfaceOffsetScales:
          partVectorSurfaceOffsetScales.size > 0
            ? partVectorSurfaceOffsetScales
            : undefined,
        partScalarColorModes:
          partScalarColorModes.size > 0 ? partScalarColorModes : undefined,
        partScalarColorPalettes:
          partScalarColorPalettes.size > 0
            ? partScalarColorPalettes
            : undefined,
        scalarColorModes,
        scalarColorPalette,
        scalarColorsVisible,
        vectorColorMode,
      },
      topologyRenderModel,
      maxVectorGlyphs,
    );

    return retainViewport3DFieldRenderOptions(topologyRenderModel, next);
  }, [
    airboxSettings.vectorBudget,
    airboxSettings.vectorCenteringEnabled,
    airboxSettings.vectorLengthScale,
    airboxSettings.vectorSurfaceOffsetEnabled,
    airboxSettings.vectorSurfaceOffsetScale,
    airboxSettings.vectorsVisible,
    airboxSettings.geometryScope,
    airboxSettings.scalarColorPalette,
    airboxSettings.surfaceColorSource,
    airboxSettings.shaderVisible,
    airboxSettings.visible,
    airboxQuantityCompatible,
    fallbackSettings.surfaceColorSource,
    fallbackSettings.shaderVisible,
    fallbackSettings.vectorBudget,
    fallbackSettings.vectorCenteringEnabled,
    fallbackSettings.vectorSurfaceOffsetEnabled,
    fallbackSettings.vectorSurfaceOffsetScale,
    fallbackSettings.vectorsVisible,
    fallbackSettings.visible,
    getPartSettings,
    maxVectorGlyphs,
    scalarColorPalette,
    topologyRenderModel,
    vectorColorMode,
    vectorDomain,
  ]);
}

export function clampViewport3DInteractiveVectorBudget(
  requestedBudget: number,
  maxVectorGlyphs: number,
): number {
  const requested = Math.max(0, Math.floor(requestedBudget));
  const max = Math.max(0, Math.floor(maxVectorGlyphs));
  if (requested <= 0 || max <= 0) return 0;
  return Math.min(requested, max);
}

export function limitViewport3DFieldRenderVectorBudgets(
  options: Viewport3DFieldRenderOptions,
  topologyRenderModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart>,
  maxVectorGlyphs: number,
): Viewport3DFieldRenderOptions {
  const maxGlyphs = Math.max(0, Math.floor(maxVectorGlyphs));
  const fullVectorBudget = clampViewport3DInteractiveVectorBudget(
    options.fullVectorBudget ?? 0,
    maxGlyphs,
  );
  const requestedBudgets = options.partVectorBudgets ?? new Map<string, number>();
  if (requestedBudgets.size === 0) {
    return fullVectorBudget === (options.fullVectorBudget ?? 0)
      ? options
      : { ...options, fullVectorBudget };
  }

  const partsById = new Map(
    [...topologyRenderModel.magneticParts, ...topologyRenderModel.airboxParts].map(
      (partModel) => [partModel.part.id, partModel] as const,
    ),
  );
  const requestedByPartId = new Map<string, number>();
  const budgetTargets: Viewport3DVectorBudgetTarget[] = [];

  for (const [partId, requestedBudget] of requestedBudgets) {
    const requested = Math.max(0, Math.floor(requestedBudget));
    if (requested <= 0) continue;

    const partModel = partsById.get(partId);
    const vectorScope = options.partVectorScopes?.get(partId) ?? "full";
    const availableNodeCount = partModel
      ? resolveNodeSelectionCount(
          vectorScope === "surface"
            ? partModel.surfaceNodeSelection ?? partModel.part
            : partModel.part,
          topologyRenderModel,
        )
      : requested;
    const targetNodeCount = Math.min(requested, availableNodeCount);
    if (targetNodeCount <= 0) continue;

    requestedByPartId.set(partId, requested);
    budgetTargets.push({
      id: partId,
      nodeCount: targetNodeCount,
      visible: true,
    });
  }

  const distributedBudgets = distributeVectorGlyphBudget(
    budgetTargets,
    maxGlyphs,
  );
  const partVectorBudgets = new Map<string, number>();
  for (const [partId, requested] of requestedByPartId) {
    const budget = distributedBudgets.get(partId) ?? 0;
    if (budget > 0) {
      partVectorBudgets.set(partId, Math.min(requested, budget));
    }
  }

  if (
    fullVectorBudget === (options.fullVectorBudget ?? 0) &&
    sameNumberMap(partVectorBudgets, requestedBudgets)
  ) {
    return options;
  }

  return {
    ...options,
    fullVectorBudget,
    partVectorBudgets,
  };
}

export function viewport3DAirboxVectorsVisible(
  visible: boolean,
  vectorsVisible: boolean,
  quantityCompatible: boolean,
  vectorDomain: string,
): boolean {
  return (
    visible &&
    vectorsVisible &&
    quantityCompatible &&
    vectorDomain !== "magnetic_only" &&
    vectorDomain !== "object" &&
    vectorDomain !== "part"
  );
}

function retainViewport3DFieldRenderOptions(
  topologyRenderModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart>,
  next: Viewport3DFieldRenderOptions,
): Viewport3DFieldRenderOptions {
  const previous = fieldRenderOptionsCache.get(topologyRenderModel);
  if (previous && sameViewport3DFieldRenderOptions(previous, next)) {
    return previous;
  }
  fieldRenderOptionsCache.set(topologyRenderModel, next);
  return next;
}

export function sameViewport3DFieldRenderOptions(
  left: Viewport3DFieldRenderOptions,
  right: Viewport3DFieldRenderOptions,
): boolean {
  return (
    (left.fullVectorBudget ?? 0) === (right.fullVectorBudget ?? 0) &&
    (left.fullVectorAnchorMode ?? "") === (right.fullVectorAnchorMode ?? "") &&
    Boolean(left.fullVectorSurfaceOffsetEnabled) ===
      Boolean(right.fullVectorSurfaceOffsetEnabled) &&
    (left.fullVectorSurfaceOffsetScale ?? 0) ===
      (right.fullVectorSurfaceOffsetScale ?? 0) &&
    Boolean(left.scalarColorsVisible) === Boolean(right.scalarColorsVisible) &&
    (left.scalarColorPalette ?? "viridis") ===
      (right.scalarColorPalette ?? "viridis") &&
    (left.vectorColorMode ?? "") === (right.vectorColorMode ?? "") &&
    sameStringMap(left.partVectorAnchorModes, right.partVectorAnchorModes) &&
    sameNumberMap(left.partVectorBudgets, right.partVectorBudgets) &&
    sameNumberMap(left.partVectorScales, right.partVectorScales) &&
    sameStringMap(left.partVectorScopes, right.partVectorScopes) &&
    sameStringMap(left.partScalarColorModes, right.partScalarColorModes) &&
    sameStringMap(left.partScalarColorPalettes, right.partScalarColorPalettes) &&
    sameStringSet(
      left.partVectorSurfaceOffsetEnabled,
      right.partVectorSurfaceOffsetEnabled,
    ) &&
    sameNumberMap(
      left.partVectorSurfaceOffsetScales,
      right.partVectorSurfaceOffsetScales,
    ) &&
    sameStringSet(left.scalarColorModes, right.scalarColorModes)
  );
}

function sameNumberMap(
  left: ReadonlyMap<string, number> | null | undefined,
  right: ReadonlyMap<string, number> | null | undefined,
): boolean {
  return sameMap(left, right, (a, b) => a === b);
}

function sameStringMap(
  left: ReadonlyMap<string, string> | null | undefined,
  right: ReadonlyMap<string, string> | null | undefined,
): boolean {
  return sameMap(left, right, (a, b) => a === b);
}

function sameMap<TValue>(
  left: ReadonlyMap<string, TValue> | null | undefined,
  right: ReadonlyMap<string, TValue> | null | undefined,
  sameValue: (left: TValue, right: TValue) => boolean,
): boolean {
  const leftSize = left?.size ?? 0;
  const rightSize = right?.size ?? 0;
  if (leftSize !== rightSize) return false;
  if (!left || !right) return true;

  for (const [key, leftValue] of left) {
    const rightValue = right.get(key);
    if (rightValue === undefined || !sameValue(leftValue, rightValue)) {
      return false;
    }
  }
  return true;
}

function sameStringSet(
  left: ReadonlySet<string> | null | undefined,
  right: ReadonlySet<string> | null | undefined,
): boolean {
  const leftSize = left?.size ?? 0;
  const rightSize = right?.size ?? 0;
  if (leftSize !== rightSize) return false;
  if (!left || !right) return true;

  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
