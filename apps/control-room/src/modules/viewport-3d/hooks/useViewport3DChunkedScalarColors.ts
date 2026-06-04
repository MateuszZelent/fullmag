"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  colorPalette: string;
  modesKey: string;
  token: object;
  topology: object;
}

export type Viewport3DChunkedScalarColorStatus =
  | "building"
  | "idle"
  | "ready"
  | "stale-visible"
  | "unavailable";

export interface Viewport3DChunkedScalarColorResult {
  colors: ReadonlyMap<string, ScalarColorBuffer>;
  status: Viewport3DChunkedScalarColorStatus;
}

export interface ChunkedScalarColorCompatibilityRequest {
  colorPalette: string;
  enabled: boolean;
  fieldPointCount: number | null;
  modesKey: string;
  needsChunking: boolean;
  topology: object | null | undefined;
}

const chunkedScalarColorBuffers = new WeakMap<
  object,
  ReadonlyMap<string, ScalarColorBuffer>
>();

export function chunkedScalarColorStateIsCompatible(
  current: ChunkedScalarColorState | null,
  request: ChunkedScalarColorCompatibilityRequest,
): boolean {
  return Boolean(
    current &&
      request.enabled &&
      request.topology &&
      current.topology === request.topology &&
      current.colorPalette === request.colorPalette &&
      current.modesKey === request.modesKey &&
      request.fieldPointCount !== null &&
      request.fieldPointCount ===
        (request.topology as { nodeCount?: number }).nodeCount &&
      request.needsChunking,
  );
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
}): Viewport3DChunkedScalarColorResult {
  const modes = useMemo(
    () =>
      [...(colorModes ?? [])]
        .filter((mode) => mode !== "monochrome")
        .sort(),
    [colorModes],
  );
  const modesKey = useMemo(() => modes.join("|"), [modes]);
  const [state, setState] = useState<ChunkedScalarColorState | null>(null);
  const [pending, setPending] = useState(false);
  const activeTokenRef = useRef<object | null>(null);
  const needsChunking = Boolean(
    fieldVector && fieldTransformNeedsChunking(fieldVector.pointCount),
  );
  const eligibleForChunkedBuild =
    enabled &&
    Boolean(topology) &&
    Boolean(fieldVector) &&
    fieldVector?.pointCount === topology?.nodeCount &&
    needsChunking &&
    modes.length > 0;
  const compatibilityRequest = useMemo<ChunkedScalarColorCompatibilityRequest>(
    () => ({
      colorPalette,
      enabled,
      fieldPointCount: fieldVector?.pointCount ?? null,
      modesKey,
      needsChunking,
      topology,
    }),
    [
      colorPalette,
      enabled,
      fieldVector?.pointCount,
      modesKey,
      needsChunking,
      topology,
    ],
  );

  useEffect(() => {
    return () => {
      releaseChunkedScalarColorToken(activeTokenRef.current);
      activeTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    setState((current) => {
      if (chunkedScalarColorStateIsCompatible(current, compatibilityRequest)) {
        return current;
      }
      const currentToken = current ? current.token : null;
      releaseChunkedScalarColorToken(currentToken);
      if (activeTokenRef.current === currentToken) {
        activeTokenRef.current = null;
      }
      return null;
    });
  }, [compatibilityRequest, eligibleForChunkedBuild]);

  useEffect(() => {
    if (!eligibleForChunkedBuild || !topology || !fieldVector) {
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setPending(true);
      }
    });

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
        const token = {};
        chunkedScalarColorBuffers.set(token, new Map(entries));
        setState((current) => {
          releaseChunkedScalarColorToken(current?.token ?? null);
          activeTokenRef.current = token;
          return {
            colorPalette,
            modesKey,
            token,
            topology,
          };
        });
        setPending(false);
      }
    })().catch(() => {
      if (!cancelled) {
        setPending(false);
      }
      return undefined;
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [colorPalette, eligibleForChunkedBuild, fieldVector, modes, modesKey, topology]);

  const compatible = chunkedScalarColorStateIsCompatible(
    state,
    compatibilityRequest,
  );
  const colors =
    compatible && state
      ? chunkedScalarColorBuffers.get(state.token) ?? EMPTY_SCALAR_COLOR_MAP
      : EMPTY_SCALAR_COLOR_MAP;

  return {
    colors,
    status: resolveChunkedScalarColorStatus({
      colorsAvailable: colors.size > 0,
      eligibleForChunkedBuild,
      enabled,
      pending,
      topologyAvailable: Boolean(topology),
    }),
  };
}

const EMPTY_SCALAR_COLOR_MAP = new Map<string, ScalarColorBuffer>();

function releaseChunkedScalarColorToken(token: object | null): void {
  if (token) {
    chunkedScalarColorBuffers.delete(token);
  }
}

function resolveChunkedScalarColorStatus({
  colorsAvailable,
  eligibleForChunkedBuild,
  enabled,
  pending,
  topologyAvailable,
}: {
  colorsAvailable: boolean;
  eligibleForChunkedBuild: boolean;
  enabled: boolean;
  pending: boolean;
  topologyAvailable: boolean;
}): Viewport3DChunkedScalarColorStatus {
  if (!enabled) return "idle";
  if (!topologyAvailable) return "unavailable";
  if (!eligibleForChunkedBuild) return "idle";
  if (pending && colorsAvailable) return "stale-visible";
  if (pending) return "building";
  return colorsAvailable ? "ready" : "building";
}

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
