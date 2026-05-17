"use client";

import { useMemo } from "react";

import {
  surfaceColorSourceToColorMode,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DMeshPart } from "../viewport3dDomainAdapter";
import {
  type Viewport3DFieldRenderOptions,
  type Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";

const EMPTY_FIELD_RENDER_OPTIONS: Viewport3DFieldRenderOptions = {
  fullVectorBudget: 0,
  partVectorBudgets: new Map(),
  scalarColorModes: new Set(),
  scalarColorsVisible: false,
};
const fieldRenderOptionsCache = new WeakMap<
  Viewport3DTopologyRenderModel<Viewport3DMeshPart>,
  Viewport3DFieldRenderOptions
>();

export function useViewport3DFieldRenderOptions({
  airboxSettings,
  fallbackSettings,
  getPartSettings,
  topologyRenderModel,
  vectorColorMode,
  vectorDomain,
}: {
  airboxSettings: VisualizationTargetSettings;
  fallbackSettings: VisualizationTargetSettings;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  topologyRenderModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  vectorColorMode: string;
  vectorDomain: string;
}): Viewport3DFieldRenderOptions {
  return useMemo(() => {
    if (!topologyRenderModel) {
      return EMPTY_FIELD_RENDER_OPTIONS;
    }

    const partVectorBudgets = new Map<string, number>();
    const partVectorScopes = new Map<string, "surface" | "full">();
    const partVectorScales = new Map<string, number>();
    const scalarColorModes = new Set<string>();
    let scalarColorsVisible = false;
    let fullVectorBudget = 0;
    const magneticVectorsAllowed = vectorDomain !== "airbox_only";
    const airboxVectorsAllowed =
      vectorDomain !== "magnetic_only" &&
      vectorDomain !== "object" &&
      vectorDomain !== "part";

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
          }
        }
        partVectorScopes.set(partId, settings.geometryScope);
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
      if (fallbackVisible) {
        fullVectorBudget = fallbackSettings.vectorBudget;
      }
    }

    for (const partModel of topologyRenderModel.airboxParts) {
      const partId = partModel.part.id;
      if (airboxSettings.visible && airboxSettings.shaderVisible) {
        const scalarColorMode = surfaceColorSourceToColorMode(
          airboxSettings.surfaceColorSource,
        );
        if (scalarColorMode) {
          scalarColorsVisible = true;
          scalarColorModes.add(scalarColorMode);
        }
      }
      partVectorScopes.set(partId, airboxSettings.geometryScope);
      const airboxVisible =
        airboxVectorsAllowed &&
        airboxSettings.visible &&
        airboxSettings.vectorsVisible;
      if (airboxVisible && airboxSettings.vectorBudget > 0) {
        partVectorBudgets.set(partId, airboxSettings.vectorBudget);
      }
      if (airboxSettings.vectorLengthScale !== 1) {
        partVectorScales.set(partId, airboxSettings.vectorLengthScale);
      }
    }

    return retainViewport3DFieldRenderOptions(topologyRenderModel, {
      fullVectorBudget,
      partVectorBudgets,
      partVectorScales: partVectorScales.size > 0 ? partVectorScales : undefined,
      partVectorScopes,
      scalarColorModes,
      scalarColorsVisible,
      vectorColorMode,
    });
  }, [
    airboxSettings.vectorBudget,
    airboxSettings.vectorLengthScale,
    airboxSettings.vectorsVisible,
    airboxSettings.geometryScope,
    airboxSettings.surfaceColorSource,
    airboxSettings.shaderVisible,
    airboxSettings.visible,
    fallbackSettings.surfaceColorSource,
    fallbackSettings.shaderVisible,
    fallbackSettings.vectorBudget,
    fallbackSettings.vectorsVisible,
    fallbackSettings.visible,
    getPartSettings,
    topologyRenderModel,
    vectorColorMode,
    vectorDomain,
  ]);
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
    Boolean(left.scalarColorsVisible) === Boolean(right.scalarColorsVisible) &&
    (left.vectorColorMode ?? "") === (right.vectorColorMode ?? "") &&
    sameNumberMap(left.partVectorBudgets, right.partVectorBudgets) &&
    sameNumberMap(left.partVectorScales, right.partVectorScales) &&
    sameStringMap(left.partVectorScopes, right.partVectorScopes) &&
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
