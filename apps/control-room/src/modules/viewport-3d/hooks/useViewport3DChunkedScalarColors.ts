"use client";

import { useEffect, useMemo, useState } from "react";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildVertexScalarColorsChunked,
  fieldTransformNeedsChunking,
  type ScalarColorBuffer,
} from "../viewport3dFieldMapping";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DRenderablePart,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";

interface ChunkedScalarColorState {
  buffers: Map<string, ScalarColorBuffer>;
  colorPalette: string;
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>;
}

export function mergeViewport3DFieldScalarColors(
  base: Viewport3DFieldRenderModel | null,
  chunkedColors: ReadonlyMap<string, ScalarColorBuffer>,
  vectorColorMode: string,
): Viewport3DFieldRenderModel | null {
  if (!base || chunkedColors.size === 0) return base;

  const scalarColorsByMode = new Map(base.scalarColorsByMode);
  for (const [mode, colors] of chunkedColors) {
    scalarColorsByMode.set(mode, colors);
  }

  return {
    ...base,
    scalarColors:
      scalarColorsByMode.get(vectorColorMode) ?? base.scalarColors,
    scalarColorsByMode,
  };
}

export function useViewport3DChunkedScalarColors({
  colorModes,
  colorPalette = "viridis",
  enabled,
  fieldVector,
  topology,
}: {
  colorModes: ReadonlySet<string> | null | undefined;
  colorPalette?: string;
  enabled: boolean;
  fieldVector: DecodedFieldVector | null | undefined;
  topology:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined;
}): ReadonlyMap<string, ScalarColorBuffer> {
  const modes = useMemo(
    () =>
      [...(colorModes ?? [])]
        .filter((mode) => mode !== "monochrome")
        .sort(),
    [colorModes],
  );
  const [state, setState] = useState<ChunkedScalarColorState | null>(null);

  useEffect(() => {
    if (
      !enabled ||
      !topology ||
      !fieldVector ||
      fieldVector.pointCount !== topology.nodeCount ||
      !fieldTransformNeedsChunking(fieldVector.pointCount) ||
      modes.length === 0
    ) {
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      const entries = await Promise.all(
        modes.map(async (mode) => [
          mode,
          await buildVertexScalarColorsChunked(fieldVector, {
            colorMode: mode,
            colorPalette,
            shaderOnly: true,
            signal: controller.signal,
            yieldToMain: yieldToViewport3DMainThread,
          }),
        ] as const),
      );

      if (!cancelled) {
        setState({
          buffers: new Map(entries),
          colorPalette,
          topology,
        });
      }
    })().catch(() => {
      if (!controller.signal.aborted && !cancelled) {
        setState((current) => current);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [colorPalette, enabled, fieldVector, modes, topology]);

  if (
    !enabled ||
    !topology ||
    state?.topology !== topology ||
    state.colorPalette !== colorPalette
  ) {
    return EMPTY_SCALAR_COLOR_MAP;
  }

  return state.buffers;
}

const EMPTY_SCALAR_COLOR_MAP = new Map<string, ScalarColorBuffer>();

function yieldToViewport3DMainThread(): Promise<void> {
  if (
    typeof window !== "undefined" &&
    typeof window.setTimeout === "function"
  ) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }
  return Promise.resolve();
}
