"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildViewport3DFieldColorJobKey } from "../build-engine/viewport3dBuildJobKeys";
import { buildVertexScalarColorsOffMainThread } from "../viewport3dColorTransformScheduler";
import {
  fieldVectorUsesDirectNodeOrder,
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
import {
  resolveViewport3DTargetFieldInput,
  viewport3DTargetFieldBufferCanServeSurface,
  type Viewport3DTargetFieldBuffer,
} from "../model/viewport3DTargetFieldBuffer";
import type { Viewport3DTargetRenderPlan } from "../model/viewport3DFieldDataPlan";
import { resolveViewport3DFieldDomainCompatibility } from "../model/viewport3DFieldDomainCompatibility";
import { summarizeViewport3DTargetDiagnostics } from "../model/viewport3DTargetDiagnostics";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DRenderablePart,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";

interface ChunkedScalarColorState {
  buildKey: string;
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
  | {
      chunkedState: ChunkedScalarColorState;
      pending?: boolean;
      type: "success";
    };

export type Viewport3DChunkedScalarColorStatus =
  | "building"
  | "idle"
  | "ready"
  | "stale-visible"
  | "unavailable";

export interface Viewport3DChunkedScalarColorResult {
  colors: ReadonlyMap<string, ScalarColorBuffer>;
  colorsByPartAndMode: ReadonlyMap<string, ReadonlyMap<string, ScalarColorBuffer>>;
  status: Viewport3DChunkedScalarColorStatus;
}

type Viewport3DChunkedProjectionMode =
  Viewport3DTargetRenderPlan["shader"]["projectionMode"];

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
  domainGenerationId?: string | null;
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
const chunkedScalarColorBuffersByPartAndMode = new WeakMap<
  object,
  ReadonlyMap<string, ReadonlyMap<string, ScalarColorBuffer>>
>();
const chunkedFieldVectorIds = new WeakMap<object, number>();
let nextChunkedFieldVectorId = 1;

const CHUNKED_SCALAR_COLOR_INITIAL_STATE: ChunkedScalarColorReducerState = {
  chunkedState: null,
  pending: false,
};

export function createViewport3DFieldColorBuildReference({
  colorMode,
  colorPalette,
  colorRangeRevision,
  domainId,
  domainGenerationId,
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
    domainGenerationId,
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
      `mode=${colorMode}`,
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
    targetRevision: `topology=${resolvedTopologyRevision} field=${resolvedFieldRevision}`,
    topologyRevision: resolvedTopologyRevision,
  };
}

export function attachViewport3DFieldColorBuildReference(
  colors: ScalarColorBuffer | null,
  reference: Viewport3DFieldColorBuildReference | null,
  sourceIdentity?: {
    fieldBufferId: string | null;
    resourceKey: string | null;
  },
): ScalarColorBuffer | null {
  if (!colors || !reference) return colors;
  return {
    ...colors,
    buildKey: reference.buildKey,
    sourceFieldBufferId:
      colors.sourceFieldBufferId ?? sourceIdentity?.fieldBufferId ?? null,
    sourceResourceKey:
      colors.sourceResourceKey ?? sourceIdentity?.resourceKey ?? null,
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
        pending: action.pending ?? false,
      };
  }
}

export function chunkedScalarColorStateIsCompatible(
  current: ChunkedScalarColorState | null,
  request: ChunkedScalarColorCompatibilityRequest,
): boolean {
  if (
    current &&
    request.enabled &&
    request.topology &&
    current.topology === request.topology &&
    current.colorPalette === request.colorPalette &&
    (request.fieldPointCount === null || request.targetKind === null)
  ) {
    return true;
  }

  return Boolean(
    current &&
      request.enabled &&
      request.topology &&
      current.topology === request.topology &&
      current.colorPalette === request.colorPalette &&
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
  builtBuildKey,
  builtFieldVector,
  currentBuildKey,
  currentFieldVector,
  eligibleForChunkedBuild,
  pending,
}: {
  builtBuildKey?: string | null;
  builtFieldVector: object | null;
  currentBuildKey?: string | null;
  currentFieldVector: object | null;
  eligibleForChunkedBuild: boolean;
  pending: boolean;
}): boolean {
  if (
    (builtBuildKey !== undefined || currentBuildKey !== undefined) &&
    currentBuildKey
  ) {
    return Boolean(eligibleForChunkedBuild && !pending && builtBuildKey !== currentBuildKey);
  }
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
  chunkedColorsByPartAndMode: ReadonlyMap<
    string,
    ReadonlyMap<string, ScalarColorBuffer>
  > = EMPTY_PART_SCALAR_COLOR_MAP,
): Viewport3DFieldRenderModel | null {
  if (
    !base ||
    (chunkedColors.size === 0 && chunkedColorsByPartAndMode.size === 0)
  ) {
    return base;
  }

  const scalarColorsByMode = new Map(base.scalarColorsByMode);
  for (const [mode, colors] of chunkedColors) {
    scalarColorsByMode.set(mode, colors);
  }
  const scalarColorsByPartAndMode = new Map(base.scalarColorsByPartAndMode);
  const targetPasses = new Map(base.targetPasses);
  for (const [partId, colorsByMode] of chunkedColorsByPartAndMode) {
    scalarColorsByPartAndMode.set(
      partId,
      new Map([
        ...(scalarColorsByPartAndMode.get(partId) ?? new Map()),
        ...colorsByMode,
      ]),
    );
    const targetPass = targetPasses.get(partId);
    const targetSurfaceMode = targetPass?.surface.scalarColorMode ?? null;
    const targetSurfaceColors = targetSurfaceMode
      ? colorsByMode.get(targetSurfaceMode) ?? null
      : null;
    if (targetPass && targetSurfaceColors) {
      targetPasses.set(partId, {
        ...targetPass,
        surface: {
          ...targetPass.surface,
          degradation: null,
          scalarColors: targetSurfaceColors,
        },
      });
    }
  }

  return {
    ...base,
    scalarColors:
      scalarColorsByMode.get(vectorColorMode) ?? base.scalarColors,
    scalarColorsByPartAndMode,
    scalarColorsByMode,
    targetDiagnostics: summarizeViewport3DTargetDiagnostics({
      derivedWorkItems: base.derivedWorkItems,
      targetPasses,
    }),
    targetPasses,
  };
}

export function filterViewport3DChunkedScalarColorEntries({
  colors,
  colorsByPartAndMode,
  colorModes,
  partScalarColorModes,
}: {
  colors: ReadonlyMap<string, ScalarColorBuffer>;
  colorsByPartAndMode: ReadonlyMap<
    string,
    ReadonlyMap<string, ScalarColorBuffer>
  >;
  colorModes: readonly string[];
  partScalarColorModes?: ReadonlyMap<string, string>;
}): {
  colors: ReadonlyMap<string, ScalarColorBuffer>;
  colorsByPartAndMode: ReadonlyMap<
    string,
    ReadonlyMap<string, ScalarColorBuffer>
  >;
} {
  const requestedModes = new Set(colorModes);
  const nextColors = new Map<string, ScalarColorBuffer>();
  for (const [mode, buffer] of colors) {
    if (requestedModes.has(mode)) {
      nextColors.set(mode, buffer);
    }
  }

  const nextPartColors = new Map<string, ReadonlyMap<string, ScalarColorBuffer>>();
  for (const [partId, buffersByMode] of colorsByPartAndMode) {
    const requestedPartMode = partScalarColorModes?.get(partId);
    if (!requestedPartMode) continue;
    const buffer = buffersByMode.get(requestedPartMode);
    if (buffer) {
      nextPartColors.set(partId, new Map([[requestedPartMode, buffer]]));
    }
  }

  return {
    colors: nextColors,
    colorsByPartAndMode: nextPartColors,
  };
}

export function shouldBuildViewport3DPartChunkedScalarColor({
  explicitPartFieldVector,
  globalColorModes,
  globalColorPalette,
  globalFieldVector,
  globalScalarRange,
  mode,
  palette,
  partFieldVector,
  scalarRange,
}: {
  explicitPartFieldVector: boolean;
  globalColorModes: readonly string[];
  globalColorPalette: string;
  globalFieldVector: DecodedFieldVector | null | undefined;
  globalScalarRange: ScalarRange | null | undefined;
  mode: string;
  palette: string;
  partFieldVector: DecodedFieldVector;
  scalarRange: ScalarRange | null | undefined;
}): boolean {
  const globalChunkedColorAvailable =
    !explicitPartFieldVector &&
    partFieldVector === globalFieldVector &&
    globalColorModes.includes(mode) &&
    palette === globalColorPalette &&
    scalarRangesEqual(scalarRange, globalScalarRange);
  return !globalChunkedColorAvailable;
}

export function resolveViewport3DChunkedPartDisplayModesKey({
  colorPalette,
  partScalarColorModes,
  partScalarColorPalettes,
  targetRenderPlans,
  topology,
}: {
  colorPalette: string;
  partScalarColorModes?: ReadonlyMap<string, string>;
  partScalarColorPalettes?: ReadonlyMap<string, string>;
  targetRenderPlans?: ReadonlyMap<string, Viewport3DTargetRenderPlan>;
  topology:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined;
}): string {
  if (!topology || !partScalarColorModes) return "";
  return [...topology.magneticParts, ...topology.airboxParts]
    .map((partModel) => {
      const partId = partModel.part.id;
      const mode = partScalarColorModes.get(partId);
      if (!mode || mode === "monochrome") return null;
      const projectionMode =
        targetRenderPlans?.get(partId)?.shader.projectionMode ?? "raw_nodal";
      const entry = [
        partId,
        mode,
        partScalarColorPalettes?.get(partId) ?? colorPalette,
      ];
      if (projectionMode !== "raw_nodal") {
        entry.push(`projection=${projectionMode}`);
      }
      return entry.join(":");
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("|");
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
  partFieldVectors,
  partTargetFieldBuffers,
  partScalarColorModes,
  partScalarColorPalettes,
  partScalarRangesByMode,
  targetRenderPlans,
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
  partFieldVectors?: ReadonlyMap<string, DecodedFieldVector>;
  partTargetFieldBuffers?: ReadonlyMap<string, Viewport3DTargetFieldBuffer>;
  partScalarColorModes?: ReadonlyMap<string, string>;
  partScalarColorPalettes?: ReadonlyMap<string, string>;
  partScalarRangesByMode?: ReadonlyMap<string, ReadonlyMap<string, ScalarRange>>;
  targetRenderPlans?: ReadonlyMap<string, Viewport3DTargetRenderPlan>;
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
  const displayModesKey = useMemo(() => modes.join("|"), [modes]);
  const partBuildSpecs = useMemo(() => {
    if (!topology || !partScalarColorModes) return [];
    const specs: Array<{
      fieldBufferId: string | null;
      fieldVector: DecodedFieldVector;
      mode: string;
      partId: string;
      palette: string;
      scalarRange: ScalarRange | null | undefined;
      resourceKey: string | null;
      target: Viewport3DFieldColorBuildTarget;
      targetProjectionMode: Viewport3DChunkedProjectionMode;
    }> = [];
    for (const partModel of [...topology.magneticParts, ...topology.airboxParts]) {
      const partId = partModel.part.id;
      const mode = partScalarColorModes.get(partId);
      const {
        explicitPartFieldBuffer,
        explicitPartFieldVector,
        partFieldVector,
      } = resolveViewport3DChunkedPartFieldInput({
        fieldVector,
        partFieldVectors,
        partId,
        partTargetFieldBuffers,
      });
      if (!mode || mode === "monochrome" || !partFieldVector) continue;
      if (
        explicitPartFieldBuffer &&
        !viewport3DTargetFieldBufferCanServeSurface(
          explicitPartFieldBuffer,
          mode,
          partFieldVector.quantityId,
          targetRenderPlans?.get(partId)?.shader.projectionMode ?? "raw_nodal",
        )
      ) {
        continue;
      }
      const palette = partScalarColorPalettes?.get(partId) ?? colorPalette;
      const scalarRange =
        partScalarRangesByMode?.get(partId)?.get(mode) ??
        (partFieldVector === fieldVector
          ? fieldScalarRangesByMode?.get(mode)
          : undefined);
      const globalRange = fieldScalarRangesByMode?.get(mode);
      if (
        !shouldBuildViewport3DPartChunkedScalarColor({
          explicitPartFieldVector: Boolean(explicitPartFieldVector),
          globalColorModes: modes,
          globalColorPalette: colorPalette,
          globalFieldVector: fieldVector,
          globalScalarRange: globalRange,
          mode,
          palette,
          partFieldVector,
          scalarRange,
        })
      ) {
        continue;
      }
      if (
        !fieldTransformNeedsChunking(
          Math.max(partFieldVector.pointCount, topology.nodeCount),
        )
      ) {
        continue;
      }
      const targetProjectionMode =
        targetRenderPlans?.get(partId)?.shader.projectionMode ?? "raw_nodal";
      const target =
        targetProjectionMode === "raw_nodal"
          ? explicitPartFieldVector
            ? resolveViewport3DChunkedPartFieldColorTarget(
                topology,
                partModel,
                partFieldVector,
              )
            : resolveViewport3DChunkedFieldColorTarget(topology, partFieldVector)
          : resolveViewport3DChunkedPartProjectionTarget(
              topology,
              partModel,
              targetProjectionMode,
            );
      if (!target) continue;
      specs.push({
        fieldBufferId:
          explicitPartFieldBuffer?.bufferId ??
          `decoded:${partFieldVector.quantityId}:${partFieldVector.pointCount}:${partFieldVector.values.byteLength}`,
        fieldVector: partFieldVector,
        mode,
        partId,
        palette,
        scalarRange,
        resourceKey: explicitPartFieldBuffer?.resourceKey ?? null,
        target,
        targetProjectionMode,
      });
    }
    return specs;
  }, [
    colorPalette,
    modes,
    partFieldVectors,
    partTargetFieldBuffers,
    partScalarColorModes,
    partScalarColorPalettes,
    partScalarRangesByMode,
    targetRenderPlans,
    fieldScalarRangesByMode,
    fieldVector,
    topology,
  ]);
  const partModesKey = useMemo(
    () =>
      partBuildSpecs
        .map(
          ({
            fieldVector,
            mode,
            palette,
            partId,
            scalarRange,
            target,
            targetProjectionMode,
          }) =>
            `${partId}:${fieldVector.quantityId ?? "unknown"}:${chunkedFieldVectorObjectId(fieldVector)}:${fieldVector.pointCount}:${mode}:${palette}:${scalarRangeRevisionKey(scalarRange)}:${target.kind}:${targetProjectionMode}`,
        )
        .join("|"),
    [partBuildSpecs],
  );
  const requestedPartDisplayModesKey = useMemo(
    () =>
      resolveViewport3DChunkedPartDisplayModesKey({
        colorPalette,
        partScalarColorModes,
        partScalarColorPalettes,
        targetRenderPlans,
        topology,
      }),
    [
      colorPalette,
      partScalarColorModes,
      partScalarColorPalettes,
      targetRenderPlans,
      topology,
    ],
  );
  const combinedModesKey = partModesKey ? `${modesKey}||${partModesKey}` : modesKey;
  const combinedDisplayModesKey = requestedPartDisplayModesKey
    ? `${displayModesKey}||${requestedPartDisplayModesKey}`
    : displayModesKey;
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
  const buildTargetKind =
    fieldColorTarget?.kind ?? partBuildSpecs[0]?.target.kind ?? null;
  const primaryNeedsChunking = Boolean(
    fieldVector &&
      topology &&
      fieldTransformNeedsChunking(
        Math.max(fieldVector.pointCount, topology.nodeCount),
      ),
  );
  const needsChunking = primaryNeedsChunking || partBuildSpecs.length > 0;
  const buildIdentityFieldVector =
    fieldVector ?? partBuildSpecs[0]?.fieldVector ?? null;
  const eligibleForChunkedBuild =
    enabled &&
    ((Boolean(fieldVector) &&
      Boolean(fieldColorTarget) &&
      primaryNeedsChunking &&
      modes.length > 0) ||
      partBuildSpecs.length > 0);
  const compatibilityRequest = useMemo<ChunkedScalarColorCompatibilityRequest>(
    () => ({
      colorPalette,
      enabled,
      fieldPointCount: buildIdentityFieldVector?.pointCount ?? null,
      modesKey: combinedDisplayModesKey,
      needsChunking,
      targetKind: buildTargetKind,
      topology,
    }),
    [
      buildTargetKind,
      buildIdentityFieldVector?.pointCount,
      colorPalette,
      combinedDisplayModesKey,
      enabled,
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
        builtBuildKey: chunkedColorState.chunkedState?.buildKey ?? null,
        builtFieldVector: chunkedColorState.chunkedState?.fieldVector ?? null,
        currentBuildKey: combinedModesKey,
        currentFieldVector: buildIdentityFieldVector,
        eligibleForChunkedBuild,
        pending: chunkedColorState.pending,
      }) ||
      !topology ||
      !buildIdentityFieldVector ||
      !buildTargetKind
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
      const retainedEntries = filterViewport3DChunkedScalarColorEntries({
        colorModes: modes,
        colors: chunkedColorState.chunkedState
          ? (chunkedScalarColorBuffers.get(chunkedColorState.chunkedState.token) ??
            EMPTY_SCALAR_COLOR_MAP)
          : EMPTY_SCALAR_COLOR_MAP,
        colorsByPartAndMode: chunkedColorState.chunkedState
          ? (chunkedScalarColorBuffersByPartAndMode.get(
              chunkedColorState.chunkedState.token,
            ) ?? EMPTY_PART_SCALAR_COLOR_MAP)
          : EMPTY_PART_SCALAR_COLOR_MAP,
        partScalarColorModes,
      });
      const entries = new Map(retainedEntries.colors);
      const partEntries = new Map(
        [...retainedEntries.colorsByPartAndMode].map(([partId, colorsByMode]) => [
          partId,
          new Map(colorsByMode),
        ]),
      );
      const retiredTokens: object[] = [];
      let builtAnyEntry = false;
      const publishEntries = (pending: boolean) => {
        if (
          activeBuildIdRef.current !== buildId ||
          (entries.size === 0 && partEntries.size === 0)
        ) {
          return;
        }
        const token = {};
        chunkedScalarColorBuffers.set(token, new Map(entries));
        chunkedScalarColorBuffersByPartAndMode.set(
          token,
          new Map(
            [...partEntries].map(([partId, colorsByMode]) => [
              partId,
              new Map(colorsByMode),
            ]),
          ),
        );
        if (activeTokenRef.current) {
          retiredTokens.push(activeTokenRef.current);
        }
        activeTokenRef.current = token;
        dispatchChunkedColorState({
          chunkedState: {
            buildKey: combinedModesKey,
            colorPalette,
            fieldVector: buildIdentityFieldVector,
            modesKey: combinedDisplayModesKey,
            targetKind: buildTargetKind,
            token,
            topology,
          },
          pending,
          type: "success",
        });
      };

      const globalJobs =
        needsChunking && fieldColorTarget && fieldVector
          ? modes.map(async (mode) => {
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
                  domainGenerationId:
                    fieldVector.domainGenerationId ?? topology.meshGenerationId,
                  fieldRevision: fieldRevision ?? null,
                  quantityId: fieldVector.quantityId,
                  sessionId: buildSessionId ?? "current",
                  targetVisualizationRevision:
                    targetVisualizationRevision ?? null,
                  topologyRevision:
                    topologyRevision ?? topology.meshRevision ?? null,
                });
              if (
                fieldColorBuildReference &&
                entries.get(mode)?.buildKey === fieldColorBuildReference.buildKey
              ) {
                return;
              }
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
              const entry = [
                mode,
                attachViewport3DFieldColorBuildReference(
                  colors,
                  fieldColorBuildReference,
                  {
                    fieldBufferId: `decoded:${fieldVector.quantityId}:${fieldVector.pointCount}:${fieldVector.values.byteLength}`,
                    resourceKey: null,
                  },
                ),
              ] as const;
              if (entry[1] !== null) {
                builtAnyEntry = true;
                entries.set(entry[0], entry[1]);
                publishEntries(true);
              }
            })
          : [];
      const partJobs = partBuildSpecs.map(
        async ({
          fieldBufferId,
          fieldVector,
          mode,
          palette,
          partId,
          scalarRange,
          resourceKey,
          target,
        }) => {
          const fieldColorBuildReference =
            createViewport3DFieldColorBuildReference({
              colorMode: mode,
              colorPalette: palette,
              colorRangeRevision: scalarRangeRevisionKey(scalarRange),
              domainId:
                buildDomainId ??
                topology.meshGenerationId ??
                "viewport-3d",
              domainGenerationId:
                fieldVector.domainGenerationId ?? topology.meshGenerationId,
              fieldRevision:
                chunkedFieldVectorObjectId(fieldVector),
              samplingRevision: `target=${target.kind}`,
              quantityId: fieldVector.quantityId,
              sessionId: buildSessionId ?? "current",
              targetId: `surface/${partId}/${target.kind}`,
              targetScopeId: partId,
              targetScopeKind: "part",
              targetVisualizationRevision:
                targetVisualizationRevision ?? null,
              topologyRevision:
                topologyRevision ?? topology.meshRevision ?? null,
            });
          if (
            fieldColorBuildReference &&
            partEntries.get(partId)?.get(mode)?.buildKey ===
              fieldColorBuildReference.buildKey
          ) {
            return;
          }
          const colors = await buildVertexScalarColorsOffMainThread(
            fieldVector,
            {
              buildKey: fieldColorBuildReference?.buildKey,
              colorMode: mode,
              colorPalette: palette,
              groupKey: fieldColorBuildReference?.groupKey,
              latestWins: Boolean(fieldColorBuildReference),
              revisionSummary: fieldColorBuildReference?.revisionSummary,
              scalarRange,
              shaderOnly: true,
              signal: controller.signal,
              target,
              yieldToMain: yieldToViewport3DMainThread,
            },
          );
          const entry = attachViewport3DFieldColorBuildReference(
            colors,
            fieldColorBuildReference,
            { fieldBufferId, resourceKey },
          );
          if (entry !== null) {
            builtAnyEntry = true;
            const colorsByMode = partEntries.get(partId) ?? new Map();
            colorsByMode.set(mode, entry);
            partEntries.set(partId, colorsByMode);
            publishEntries(true);
          }
        },
      );

      await Promise.allSettled(
        [...globalJobs, ...partJobs],
      );

      if (activeBuildIdRef.current === buildId) {
        if (builtAnyEntry) {
          publishEntries(false);
        } else {
          dispatchChunkedColorState({ type: "finish" });
        }
      }
      for (const token of retiredTokens) {
        releaseChunkedScalarColorToken(token);
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
    chunkedColorState.chunkedState,
    chunkedColorState.chunkedState?.buildKey,
    chunkedColorState.chunkedState?.fieldVector,
    chunkedColorState.pending,
    buildDomainId,
    buildSessionId,
    buildIdentityFieldVector,
    colorPalette,
    combinedModesKey,
    combinedDisplayModesKey,
    eligibleForChunkedBuild,
    fieldRevision,
    fieldScalarRangesByMode,
    fieldVector,
    fieldColorTarget,
    buildTargetKind,
    modes,
    needsChunking,
    partBuildSpecs,
    partScalarColorModes,
    targetVisualizationRevision,
    topology,
    topologyRevision,
  ]);

  const compatible = chunkedScalarColorStateIsCompatible(
    chunkedColorState.chunkedState,
    compatibilityRequest,
  );
  const rawColors =
    compatible && chunkedColorState.chunkedState
      ? chunkedScalarColorBuffers.get(chunkedColorState.chunkedState.token) ??
        EMPTY_SCALAR_COLOR_MAP
      : EMPTY_SCALAR_COLOR_MAP;
  const rawColorsByPartAndMode =
    compatible && chunkedColorState.chunkedState
      ? chunkedScalarColorBuffersByPartAndMode.get(
          chunkedColorState.chunkedState.token,
        ) ?? EMPTY_PART_SCALAR_COLOR_MAP
      : EMPTY_PART_SCALAR_COLOR_MAP;
  const visibleEntries = useMemo(
    () =>
      filterViewport3DChunkedScalarColorEntries({
        colorModes: modes,
        colors: rawColors,
        colorsByPartAndMode: rawColorsByPartAndMode,
        partScalarColorModes,
      }),
    [modes, partScalarColorModes, rawColors, rawColorsByPartAndMode],
  );
  const colors = visibleEntries.colors;
  const colorsByPartAndMode = visibleEntries.colorsByPartAndMode;

  return {
    colors,
    colorsByPartAndMode,
    status: resolveChunkedScalarColorStatus({
      colorsAvailable: colors.size > 0 || colorsByPartAndMode.size > 0,
      eligibleForChunkedBuild,
      enabled,
      pending: chunkedColorState.pending,
      topologyAvailable: Boolean(topology),
    }),
  };
}

const EMPTY_SCALAR_COLOR_MAP = new Map<string, ScalarColorBuffer>();
const EMPTY_PART_SCALAR_COLOR_MAP = new Map<
  string,
  ReadonlyMap<string, ScalarColorBuffer>
>();

export function resolveViewport3DChunkedFieldColorTarget(
  topology:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined,
  fieldVector: DecodedFieldVector | null | undefined,
): Viewport3DFieldColorBuildTarget | null {
  if (!topology || !fieldVector) return null;
  if (!chunkedFieldVectorMatchesTopology(fieldVector, topology)) return null;
  if (fieldVectorUsesDirectNodeOrder(fieldVector, topology.nodeCount)) {
    return {
      kind: "full-domain",
      vertexCount: topology.nodeCount,
    };
  }

  const explicitNodeIndices = resolveChunkedFieldVectorNodeIndices(
    fieldVector,
    topology,
  );
  if (explicitNodeIndices) {
    return {
      kind: "mapped-vertices",
      targetNodeIndices: explicitNodeIndices,
      vertexCount: topology.nodeCount,
    };
  }

  if (
    fieldVector.indexing === "explicit_node_indices" ||
    fieldVector.indexing === "sampled_node_indices"
  ) {
    return null;
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

export function resolveViewport3DChunkedPartFieldInput({
  fieldVector,
  partFieldVectors,
  partId,
  partTargetFieldBuffers,
}: {
  fieldVector: DecodedFieldVector | null | undefined;
  partFieldVectors?: ReadonlyMap<string, DecodedFieldVector>;
  partId: string;
  partTargetFieldBuffers?: ReadonlyMap<string, Viewport3DTargetFieldBuffer>;
}): {
  explicitPartFieldBuffer: Viewport3DTargetFieldBuffer | null;
  explicitPartFieldVector: DecodedFieldVector | null;
  partFieldVector: DecodedFieldVector | null;
} {
  const input = resolveViewport3DTargetFieldInput({
    fallbackFieldVector: fieldVector,
    legacyPartFieldVectors: partFieldVectors,
    partId,
    targetFieldBuffers: partTargetFieldBuffers,
  });
  return {
    explicitPartFieldBuffer: input.explicitFieldBuffer,
    explicitPartFieldVector: input.explicitFieldVector,
    partFieldVector: input.fieldVector,
  };
}

export function resolveViewport3DChunkedPartFieldColorTarget(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector,
): Viewport3DFieldColorBuildTarget | null {
  if (!chunkedFieldVectorMatchesTopology(fieldVector, topology)) return null;
  if (fieldVectorUsesDirectNodeOrder(fieldVector, topology.nodeCount)) {
    return {
      kind: "full-domain",
      vertexCount: topology.nodeCount,
    };
  }

  const explicitNodeIndices = resolveChunkedFieldVectorNodeIndices(
    fieldVector,
    topology,
  );
  if (explicitNodeIndices) {
    return {
      kind: "mapped-vertices",
      targetNodeIndices: explicitNodeIndices,
      vertexCount: topology.nodeCount,
    };
  }

  if (
    fieldVector.indexing === "explicit_node_indices" ||
    fieldVector.indexing === "sampled_node_indices"
  ) {
    return null;
  }

  const count = resolveNodeSelectionCount(partModel.part, topology);
  if (count !== fieldVector.pointCount) return null;
  const targetNodeIndices = new Uint32Array(count);
  for (let offset = 0; offset < count; offset += 1) {
    const nodeIndex = resolveNodeSelectionIndex(partModel.part, offset);
    if (
      nodeIndex === null ||
      !Number.isInteger(nodeIndex) ||
      nodeIndex < 0 ||
      nodeIndex >= topology.nodeCount
    ) {
      return null;
    }
    targetNodeIndices[offset] = nodeIndex;
  }
  return {
    kind: "mapped-vertices",
    targetNodeIndices,
    vertexCount: topology.nodeCount,
  };
}

export function resolveViewport3DChunkedPartProjectionTarget(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  projectionMode: Viewport3DChunkedProjectionMode,
): Viewport3DFieldColorBuildTarget | null {
  if (projectionMode === "raw_nodal") return null;
  const surfaceIndices = partModel.surfaceIndices;
  if (!surfaceIndices || surfaceIndices.length === 0) return null;

  if (projectionMode === "surface_faces") {
    return {
      kind: "surface-faces",
      surfaceIndices,
      vertexCount: topology.nodeCount,
    };
  }

  if (
    projectionMode === "thickness_average_z" &&
    topology.positions.length >= topology.nodeCount * 3
  ) {
    return {
      kind: "thickness-average-z",
      positions: topology.positions,
      surfaceIndices,
      vertexCount: topology.nodeCount,
    };
  }

  return null;
}

function chunkedFieldVectorMatchesTopology(
  fieldVector: DecodedFieldVector,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
): boolean {
  return resolveViewport3DFieldDomainCompatibility({
    domain: {
      domainGenerationId: topology.meshGenerationId,
      meshTopologyHash: topology.meshTopologyHash,
      meshTopologyRevision: revisionToString(topology.meshRevision),
      pointCount: topology.nodeCount,
    },
    field: fieldVector,
  }).status !== "mismatch";
}

function resolveChunkedFieldVectorNodeIndices(
  fieldVector: DecodedFieldVector,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
): Uint32Array | null {
  if (
    fieldVector.indexing === "sampled_node_indices" ||
    fieldVector.pointCount <= 0
  ) {
    return null;
  }

  const nodeIndices = fieldVector.nodeIndices;
  if (!nodeIndices || nodeIndices.length !== fieldVector.pointCount) return null;

  const resolved = new Uint32Array(nodeIndices.length);
  for (let index = 0; index < nodeIndices.length; index += 1) {
    const nodeIndex = nodeIndices[index];
    if (
      nodeIndex === undefined ||
      !Number.isInteger(nodeIndex) ||
      nodeIndex < 0 ||
      nodeIndex >= topology.nodeCount
    ) {
      return null;
    }
    resolved[index] = nodeIndex;
  }
  return resolved;
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
    chunkedScalarColorBuffersByPartAndMode.delete(token);
  }
}

function chunkedFieldVectorObjectId(fieldVector: object): number {
  const current = chunkedFieldVectorIds.get(fieldVector);
  if (current !== undefined) return current;
  const next = nextChunkedFieldVectorId++;
  chunkedFieldVectorIds.set(fieldVector, next);
  return next;
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

function scalarRangesEqual(
  left: ScalarRange | null | undefined,
  right: ScalarRange | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return left.min === right.min && left.max === right.max;
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
