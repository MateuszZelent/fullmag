"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildViewport3DFieldColorJobKey } from "../build-engine/viewport3dBuildJobKeys";
import { buildVertexScalarColorsOffMainThread } from "../viewport3dColorTransformScheduler";
import {
  fieldTransformNeedsChunking,
  type ScalarColorBuffer,
  type ScalarRange,
} from "../viewport3dFieldMapping";
import type {
  Viewport3DFieldColorBuildTarget,
} from "../field-colors/viewport3dFieldColorBuildModel";
import {
  resolveNodeSelectionCount,
  resolveNodeSelectionIndex,
} from "../viewport3dRenderModel";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DRenderablePart,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";

interface ChunkedScalarColorState {
  colorPalette: string;
  fieldVector: object;
  modesKey: string;
  targetKind: Viewport3DFieldColorBuildTarget["kind"];
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

export interface Viewport3DFieldColorBuildReference {
  buildKey: string;
  groupKey: string;
  revisionSummary: string;
  targetRevision: string;
  topologyRevision: string;
}

export interface Viewport3DFieldColorBuildReferenceInput {
  cameraRevision?: string | number | null;
  colorMode: string;
  colorPalette: string;
  colorRangeRevision?: string | number | null;
  domainId: string;
  fieldRevision: string | number | null;
  quantityId: string | null | undefined;
  samplingRevision?: string | number | null;
  sessionId: string;
  targetId?: string | number | null;
  targetScopeId?: string | number | null;
  targetScopeKind?: string | number | null;
  targetVisualizationRevision: string | number | null;
  topologyRevision: string | number | null;
}

export interface ChunkedScalarColorCompatibilityRequest {
  colorPalette: string;
  enabled: boolean;
  fieldPointCount: number | null;
  modesKey: string;
  needsChunking: boolean;
  targetKind: Viewport3DFieldColorBuildTarget["kind"] | null;
  topology: object | null | undefined;
}

const VIEWPORT_3D_FIELD_COLOR_DATA_REVISION = "field-color-data";

const chunkedScalarColorBuffers = new WeakMap<
  object,
  ReadonlyMap<string, ScalarColorBuffer>
>();

const CHUNKED_SCALAR_COLOR_INITIAL_STATE: ChunkedScalarColorReducerState = {
  chunkedState: null,
  pending: false,
};

export function createViewport3DFieldColorBuildReference({
  colorMode,
  colorPalette,
  colorRangeRevision,
  domainId,
  fieldRevision,
  quantityId,
  samplingRevision,
  sessionId,
  targetId,
  targetScopeId,
  targetScopeKind,
  topologyRevision,
}: Viewport3DFieldColorBuildReferenceInput): Viewport3DFieldColorBuildReference | null {
  const resolvedTopologyRevision = revisionToString(topologyRevision);
  const resolvedFieldRevision = revisionToString(fieldRevision);
  if (!resolvedTopologyRevision || !resolvedFieldRevision || !quantityId) {
    return null;
  }
  const resolvedColorRangeRevision =
    revisionToString(colorRangeRevision) ?? "auto";
  const resolvedSamplingRevision =
    revisionToString(samplingRevision) ?? "full-domain";
  const resolvedTargetId = revisionToString(targetId) ?? "surface/full";
  const resolvedTargetScopeId = revisionToString(targetScopeId) ?? "full";
  const resolvedTargetScopeKind =
    revisionToString(targetScopeKind) ?? "full";
  const buildKey = buildViewport3DFieldColorJobKey({
    algorithmVersion: 1,
    component: colorMode,
    domainId,
    fieldRevision: resolvedFieldRevision,
    quantityId,
    samplingRevision: resolvedSamplingRevision,
    scopeId: resolvedTargetScopeId,
    scopeKind: resolvedTargetScopeKind,
    sessionId,
    styleRevision: [
      `palette=${colorPalette}`,
      `range=${resolvedColorRangeRevision}`,
      `target=${resolvedTargetId}`,
    ].join("|"),
    targetVisualizationRevision: VIEWPORT_3D_FIELD_COLOR_DATA_REVISION,
    topologyRevision: resolvedTopologyRevision,
  });

  return {
    buildKey,
    groupKey: [
      "field-color",
      `session=${sessionId}`,
      `domain=${domainId}`,
      `quantity=${quantityId}`,
      `scope=${resolvedTargetScopeKind}:${resolvedTargetScopeId}`,
      `target=${resolvedTargetId}`,
    ].join(":"),
    revisionSummary: [
      `topology=${resolvedTopologyRevision}`,
      `field=${resolvedFieldRevision}`,
      `quantity=${quantityId}`,
      `mode=${colorMode}`,
      `palette=${colorPalette}`,
      `range=${resolvedColorRangeRevision}`,
      `target=${resolvedTargetId}`,
      `sampling=${resolvedSamplingRevision}`,
    ].join(" "),
    targetRevision: `field=${resolvedFieldRevision}`,
    topologyRevision: resolvedTopologyRevision,
  };
}

export function attachViewport3DFieldColorBuildReference(
  colors: ScalarColorBuffer | null,
  reference: Viewport3DFieldColorBuildReference | null,
): ScalarColorBuffer | null {
  if (!colors || !reference) return colors;
  return {
    ...colors,
    buildKey: reference.buildKey,
    targetRevision: reference.targetRevision,
    topologyRevision: reference.topologyRevision,
  };
}

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
      current.targetKind === request.targetKind &&
      request.fieldPointCount !== null &&
      (request.targetKind === "full-domain"
        ? request.fieldPointCount ===
          (request.topology as { nodeCount?: number }).nodeCount
        : true) &&
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
  buildDomainId,
  buildSessionId,
  colorModes,
  colorPalette = "viridis",
  enabled,
  fieldRevision,
  fieldScalarRangesByMode,
  fieldVector,
  targetVisualizationRevision,
  topology,
  topologyRevision,
}: {
  buildDomainId?: string;
  buildSessionId?: string;
  colorModes: ReadonlySet<string> | null | undefined;
  colorPalette?: string;
  enabled: boolean;
  fieldRevision?: string | number | null;
  fieldScalarRangesByMode?: ReadonlyMap<string, ScalarRange>;
  fieldVector: DecodedFieldVector | null | undefined;
  targetVisualizationRevision?: string | number | null;
  topology:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined;
  topologyRevision?: string | number | null;
}): Viewport3DChunkedScalarColorResult {
  const modes = useMemo(
    () =>
      [...(colorModes ?? [])]
        .filter((mode) => mode !== "monochrome")
        .sort(),
    [colorModes],
  );
  const modesKey = useMemo(
    () =>
      modes
        .map(
          (mode) =>
            `${mode}:${scalarRangeRevisionKey(fieldScalarRangesByMode?.get(mode))}`,
        )
        .join("|"),
    [fieldScalarRangesByMode, modes],
  );
  const [chunkedColorState, dispatchChunkedColorState] = useReducer(
    chunkedScalarColorReducer,
    CHUNKED_SCALAR_COLOR_INITIAL_STATE,
  );
  const activeBuildIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeTokenRef = useRef<object | null>(null);
  const fieldColorTarget = useMemo(
    () => resolveViewport3DChunkedFieldColorTarget(topology, fieldVector),
    [fieldVector, topology],
  );
  const needsChunking = Boolean(
    fieldVector &&
      topology &&
      fieldTransformNeedsChunking(
        Math.max(fieldVector.pointCount, topology.nodeCount),
      ),
  );
  const eligibleForChunkedBuild =
    enabled &&
    Boolean(fieldVector) &&
    Boolean(fieldColorTarget) &&
    needsChunking &&
    modes.length > 0;
  const compatibilityRequest = useMemo<ChunkedScalarColorCompatibilityRequest>(
    () => ({
      colorPalette,
      enabled,
      fieldPointCount: fieldVector?.pointCount ?? null,
      modesKey,
      needsChunking,
      targetKind: fieldColorTarget?.kind ?? null,
      topology,
    }),
    [
      colorPalette,
      enabled,
      fieldVector?.pointCount,
      fieldColorTarget?.kind,
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
      !fieldColorTarget ||
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
      const entries = (await Promise.all(
        modes.map(async (mode) => {
          const fieldColorBuildReference =
            createViewport3DFieldColorBuildReference({
              colorMode: mode,
              colorPalette,
              colorRangeRevision: scalarRangeRevisionKey(
                fieldScalarRangesByMode?.get(mode),
              ),
              domainId:
                buildDomainId ??
                topology.meshGenerationId ??
                "viewport-3d",
              fieldRevision: fieldRevision ?? null,
              quantityId: fieldVector.quantityId,
              sessionId: buildSessionId ?? "current",
              targetVisualizationRevision:
                targetVisualizationRevision ?? null,
              topologyRevision:
                topologyRevision ?? topology.meshRevision ?? null,
            });
          const colors = await buildVertexScalarColorsOffMainThread(
            fieldVector,
            {
              buildKey: fieldColorBuildReference?.buildKey,
              colorMode: mode,
              colorPalette,
              groupKey: fieldColorBuildReference?.groupKey,
              latestWins: Boolean(fieldColorBuildReference),
              revisionSummary: fieldColorBuildReference?.revisionSummary,
              scalarRange: fieldScalarRangesByMode?.get(mode),
              shaderOnly: true,
              signal: controller.signal,
              target: fieldColorTarget,
              yieldToMain: yieldToViewport3DMainThread,
            },
          );
          return [
            mode,
            attachViewport3DFieldColorBuildReference(
              colors,
              fieldColorBuildReference,
            ),
          ] as const;
        }),
      )).filter(
        (entry): entry is readonly [string, ScalarColorBuffer] =>
          entry[1] !== null,
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
            targetKind: fieldColorTarget.kind,
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
    buildDomainId,
    buildSessionId,
    colorPalette,
    eligibleForChunkedBuild,
    fieldRevision,
    fieldScalarRangesByMode,
    fieldVector,
    fieldColorTarget,
    modes,
    modesKey,
    targetVisualizationRevision,
    topology,
    topologyRevision,
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

export function resolveViewport3DChunkedFieldColorTarget(
  topology:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined,
  fieldVector: DecodedFieldVector | null | undefined,
): Viewport3DFieldColorBuildTarget | null {
  if (!topology || !fieldVector) return null;
  if (fieldVector.pointCount === topology.nodeCount) {
    return {
      kind: "full-domain",
      vertexCount: topology.nodeCount,
    };
  }

  const targetNodeIndices = resolveMagneticFieldTargetNodeIndices(
    topology,
    fieldVector.pointCount,
  );
  if (!targetNodeIndices) return null;
  return {
    kind: "mapped-vertices",
    targetNodeIndices,
    vertexCount: topology.nodeCount,
  };
}

function resolveMagneticFieldTargetNodeIndices(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  pointCount: number,
): Uint32Array | null {
  if (pointCount <= 0 || pointCount > topology.nodeCount) return null;

  const nodeIndices = new Set<number>();
  for (const partModel of topology.magneticParts) {
    const count = resolveNodeSelectionCount(partModel.part, topology);
    for (let offset = 0; offset < count; offset += 1) {
      const nodeIndex = resolveNodeSelectionIndex(partModel.part, offset);
      if (
        nodeIndex !== null &&
        Number.isInteger(nodeIndex) &&
        nodeIndex >= 0 &&
        nodeIndex < topology.nodeCount
      ) {
        nodeIndices.add(nodeIndex);
      }
    }
  }

  if (nodeIndices.size !== pointCount) return null;
  return Uint32Array.from(
    [...nodeIndices].toSorted((left, right) => left - right),
  );
}

function releaseChunkedScalarColorToken(token: object | null): void {
  if (token) {
    chunkedScalarColorBuffers.delete(token);
  }
}

function revisionToString(
  revision: string | number | null | undefined,
): string | null {
  if (typeof revision === "number" && Number.isFinite(revision)) {
    return String(revision);
  }
  if (typeof revision === "string" && revision.length > 0) {
    return revision;
  }
  return null;
}

function scalarRangeRevisionKey(
  range: ScalarRange | null | undefined,
): string {
  if (
    !range ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max)
  ) {
    return "auto";
  }
  return `min=${range.min}:max=${range.max}`;
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
