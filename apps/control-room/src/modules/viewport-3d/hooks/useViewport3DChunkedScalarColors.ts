"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildVertexScalarColorsOffMainThread } from "../viewport3dColorTransformScheduler";
import {
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
  fieldVector: object;
  modesKey: string;
  token: object;
  topology: object;
}

interface ChunkedScalarColorReducerState {
  chunkedState: ChunkedScalarColorState | null;
  pending: boolean;
}

type ChunkedScalarColorAction =
  | { type: "finish" }
  | { type: "reset" }
  | { type: "start" }
  | { chunkedState: ChunkedScalarColorState; type: "success" };

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

const CHUNKED_SCALAR_COLOR_INITIAL_STATE: ChunkedScalarColorReducerState = {
  chunkedState: null,
  pending: false,
};

function chunkedScalarColorReducer(
  state: ChunkedScalarColorReducerState,
  action: ChunkedScalarColorAction,
): ChunkedScalarColorReducerState {
  switch (action.type) {
    case "finish":
      return state.pending ? { ...state, pending: false } : state;
    case "reset":
      return state.chunkedState || state.pending
        ? CHUNKED_SCALAR_COLOR_INITIAL_STATE
        : state;
    case "start":
      return state.pending ? state : { ...state, pending: true };
    case "success":
      return {
        chunkedState: action.chunkedState,
        pending: false,
      };
  }
}

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

export function shouldStartChunkedScalarColorBuild({
  builtFieldVector,
  currentFieldVector,
  eligibleForChunkedBuild,
  pending,
}: {
  builtFieldVector: object | null;
  currentFieldVector: object | null;
  eligibleForChunkedBuild: boolean;
  pending: boolean;
}): boolean {
  return Boolean(
    eligibleForChunkedBuild &&
      !pending &&
      currentFieldVector &&
      builtFieldVector !== currentFieldVector,
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
  const [chunkedColorState, dispatchChunkedColorState] = useReducer(
    chunkedScalarColorReducer,
    CHUNKED_SCALAR_COLOR_INITIAL_STATE,
  );
  const activeBuildIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
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
      activeBuildIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      releaseChunkedScalarColorToken(activeTokenRef.current);
      activeTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (
      chunkedScalarColorStateIsCompatible(
        chunkedColorState.chunkedState,
        compatibilityRequest,
      )
    ) {
      return;
    }
    releaseChunkedScalarColorToken(activeTokenRef.current);
    activeTokenRef.current = null;
    activeBuildIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    dispatchChunkedColorState({ type: "reset" });
  }, [chunkedColorState.chunkedState, compatibilityRequest]);

  useEffect(() => {
    if (
      !shouldStartChunkedScalarColorBuild({
        builtFieldVector: chunkedColorState.chunkedState?.fieldVector ?? null,
        currentFieldVector: fieldVector ?? null,
        eligibleForChunkedBuild,
        pending: chunkedColorState.pending,
      }) ||
      !topology ||
      !fieldVector
    ) {
      return undefined;
    }

    const controller = new AbortController();
    const buildId = activeBuildIdRef.current + 1;
    activeBuildIdRef.current = buildId;
    activeControllerRef.current = controller;
    void Promise.resolve().then(() => {
      if (activeBuildIdRef.current === buildId) {
        dispatchChunkedColorState({ type: "start" });
      }
    });

    void (async () => {
      const entries = await Promise.all(
        modes.map(async (mode) => [
          mode,
          await buildVertexScalarColorsOffMainThread(fieldVector, {
            colorMode: mode,
            colorPalette,
            shaderOnly: true,
            signal: controller.signal,
            yieldToMain: yieldToViewport3DMainThread,
          }),
        ] as const),
      );

      if (activeBuildIdRef.current === buildId) {
        const token = {};
        chunkedScalarColorBuffers.set(token, new Map(entries));
        releaseChunkedScalarColorToken(activeTokenRef.current);
        activeTokenRef.current = token;
        dispatchChunkedColorState({
          chunkedState: {
            colorPalette,
            fieldVector,
            modesKey,
            token,
            topology,
          },
          type: "success",
        });
      }
    })().catch(() => {
      if (activeBuildIdRef.current === buildId) {
        dispatchChunkedColorState({ type: "finish" });
      }
      return undefined;
    }).finally(() => {
      if (activeBuildIdRef.current === buildId) {
        activeControllerRef.current = null;
      }
    });

    return undefined;
  }, [
    chunkedColorState.chunkedState?.fieldVector,
    chunkedColorState.pending,
    colorPalette,
    eligibleForChunkedBuild,
    fieldVector,
    modes,
    modesKey,
    topology,
  ]);

  const compatible = chunkedScalarColorStateIsCompatible(
    chunkedColorState.chunkedState,
    compatibilityRequest,
  );
  const colors =
    compatible && chunkedColorState.chunkedState
      ? chunkedScalarColorBuffers.get(chunkedColorState.chunkedState.token) ??
        EMPTY_SCALAR_COLOR_MAP
      : EMPTY_SCALAR_COLOR_MAP;

  return {
    colors,
    status: resolveChunkedScalarColorStatus({
      colorsAvailable: colors.size > 0,
      eligibleForChunkedBuild,
      enabled,
      pending: chunkedColorState.pending,
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
