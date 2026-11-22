"use client";

import {
  FileCode2,
  Gauge,
  Layers,
  Plus,
  RefreshCw,
  Scissors,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  CurrentTransportMutationRequest,
  KnownSceneCurrentTransport,
  SceneStructuredCurrentSourceCut,
  SceneStructuredCutPlane,
  TransportValidationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useCurrentTransportsResource } from "@/kernel/resources/spinAuthoringResources";
import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  useInspectorSpecController,
  type InspectorBreadcrumbItem,
  type InspectorSpec,
} from "../../template";
import {
  LENGTH_UNITS,
  VOLTAGE_UNITS,
} from "../model-roots/SpecInspectorHost";
import {
  encodeTransportScopeOption,
  parseTransportScopeOption,
  transportScopeOptions,
} from "../TransportCollectionFieldsModel";
import {
  buildValidationDetails,
  buildValidationNotices,
  computeTransportLockReason,
  EMPTY_SELECT_SENTINEL,
  evaluateTransportCapability,
  executeAuthoringHistoryCommit,
  isEditableCurrentTransport,
  ReadOnlyOpaqueInspector,
  RESOURCE_KEYS,
  runPreCommitTransportValidation,
  TRANSPORT_VALIDATION_VERSION,
  TransportTemplateRenderer,
  useAuthoringSceneData,
  useDebouncedTransportValidation,
  useThreeWayConflictState,
  useTransportSessionContext,
} from "./transportShared";

const OMITTED_FRAME_SENTINEL = "__fm_cut_frame_omitted__";

function createUniqueSceneSourceCut(
  existingCuts: readonly SceneStructuredCurrentSourceCut[],
  ownerRecord: KnownSceneCurrentTransport | null,
): SceneStructuredCurrentSourceCut {
  const usedCuts = new Set(existingCuts.map((c) => c.source_cut_id.trim()));
  const usedCircuits = new Set(existingCuts.map((c) => c.circuit_id.trim()));
  const usedDrives = new Set(existingCuts.map((c) => c.drive.drive_id.trim()));

  let ordinal = existingCuts.length + 1;
  while (
    usedCuts.has(`cut-${ordinal}`) ||
    usedCuts.has(`source-cut-${ordinal}`) ||
    usedCircuits.has(`loop-${ordinal}`) ||
    usedCircuits.has(`circuit-${ordinal}`) ||
    usedDrives.has(`drive-${ordinal}`)
  ) {
    ordinal += 1;
  }

  const fallbackRegion = existingCuts[0]?.region ??
    ownerRecord?.domain?.[0] ?? { object_id: ownerRecord?.solve_region || "ring" };

  return {
    source_cut_id: `cut-${ordinal}`,
    circuit_id: `loop-${ordinal}`,
    region: {
      object_id: fallbackRegion.object_id,
      ...(fallbackRegion.region_id ? { region_id: fallbackRegion.region_id } : {}),
    },
    plane: {
      axis: "x",
      normal: "positive_axis",
      offset_m: 0,
    },
    drive: {
      kind: "impressed_potential_jump",
      drive_id: `drive-${ordinal}`,
      potential_jump_V: 0.1,
      schema_version: "impressed_potential_jump.v1",
    },
  };
}

function reconcileJsonFields<T extends object>(
  server: T,
  local: T,
  baseline: T,
): { draft: T; conflicts: string[] } {
  const draft = { ...server };
  const conflicts: string[] = [];
  for (const key of Object.keys(server) as Array<keyof T>) {
    if (JSON.stringify(local[key]) === JSON.stringify(baseline[key])) continue;
    draft[key] = local[key];
    if (
      JSON.stringify(server[key]) !== JSON.stringify(baseline[key]) &&
      JSON.stringify(server[key]) !== JSON.stringify(local[key])
    ) {
      conflicts.push(String(key));
    }
  }
  return { draft, conflicts };
}

/* ============================================================================
 * Route 2: StructuredCurrentClosureInspectorPanel (`physics.structured-current-closure`)
 * ============================================================================ */

interface StructuredClosureDraft {
  exists: boolean;
  ownerId: string;
  closureId: string;
  schemaVersion: string;
  cutsJson: string;
}

function buildOwnerWithClosure(
  ownerRecord: KnownSceneCurrentTransport,
  draft: StructuredClosureDraft,
): KnownSceneCurrentTransport {
  const closureId = draft.closureId.trim();
  if (!closureId) throw new Error("Closure ID is required.");
  const cuts = JSON.parse(draft.cutsJson) as SceneStructuredCurrentSourceCut[];
  if (!Array.isArray(cuts) || cuts.length === 0) {
    throw new Error("Structured current closure requires at least one source cut.");
  }
  const cutIds = cuts.map((c) => c.source_cut_id.trim());
  const circuitIds = cuts.map((c) => c.circuit_id.trim());
  const driveIds = cuts.map((c) => c.drive.drive_id.trim());
  if (new Set(cutIds).size !== cutIds.length) {
    throw new Error("Source cut IDs must be unique within the closure.");
  }
  if (new Set(circuitIds).size !== circuitIds.length) {
    throw new Error("Circuit IDs must be unique within the closure.");
  }
  if (new Set(driveIds).size !== driveIds.length) {
    throw new Error("Drive IDs must be unique within the closure.");
  }
  return {
    ...ownerRecord,
    structured_current_closure: {
      kind: "closed_geometry",
      closure_id: closureId,
      schema_version: draft.schemaVersion.trim() || "structured_current_closure.v1",
      source_cuts: cuts,
    },
  };
}

export function StructuredCurrentClosureInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const scene = useAuthoringSceneData();
  const currentRes = useCurrentTransportsResource();
  const items = useMemo(() => currentRes.data?.items ?? [], [currentRes.data?.items]);
  const sceneRevision = currentRes.data?.scene_revision;

  const ref =
    selection.ref?.type === "structured-current-closure" ? selection.ref : null;
  const requestedOwnerId = ref?.currentTransportId ?? "";
  const requestedClosureId = ref?.structuredCurrentClosureId ?? selection.label;

  const matchedRawOwner = useMemo(
    () =>
      items.find((item) => {
        if (isEditableCurrentTransport(item)) {
          if (requestedOwnerId) return item.name === requestedOwnerId;
          return item.structured_current_closure?.closure_id === requestedClosureId;
        }
        const rec = item as Record<string, unknown>;
        return Boolean(requestedOwnerId && rec.name === requestedOwnerId);
      }) ?? null,
    [items, requestedClosureId, requestedOwnerId],
  );

  const knownOwner =
    matchedRawOwner && isEditableCurrentTransport(matchedRawOwner)
      ? matchedRawOwner
      : null;
  const isOpaqueOwner = matchedRawOwner !== null && knownOwner === null;
  const closure = knownOwner?.structured_current_closure ?? null;
  const ownerId = knownOwner?.name ?? requestedOwnerId;

  const targetMissingMessage =
    currentRes.status === "ready" && (!knownOwner || !closure)
      ? "The owning charge transport or structured current closure is no longer present in the scene."
      : null;

  const breadcrumbs = useMemo<InspectorBreadcrumbItem[]>(
    () => [
      {
        id: "crumb-model",
        label: "Model",
        selection: {
          kind: "model.root",
          label: "Model",
          nodeId: "model:root",
          objectId: null,
          ref: null,
        },
      },
      {
        id: "crumb-owner",
        label: ownerId || "Charge Transport",
        selection: ownerId
          ? {
              kind: "physics.current-transport",
              label: ownerId,
              nodeId: `model:physics:current-transports:${ownerId}`,
              objectId: selection.objectId,
              ref: {
                currentTransportId: ownerId,
                kind: "physics.current-transport",
                nodeId: `model:physics:current-transports:${ownerId}`,
                type: "current-transport",
              },
            }
          : undefined,
      },
      { id: "crumb-closure", label: "Structured Closure" },
    ],
    [ownerId, selection.objectId],
  );

  const serverBaseline = useMemo<StructuredClosureDraft>(
    () => ({
      exists: Boolean(knownOwner && closure),
      ownerId,
      closureId: closure?.closure_id ?? requestedClosureId ?? "closed-geometry-1",
      schemaVersion: closure?.schema_version ?? "structured_current_closure.v1",
      cutsJson: JSON.stringify(closure?.source_cuts ?? [], null, 2),
    }),
    [closure, knownOwner, ownerId, requestedClosureId],
  );

  const [liveDraft, setLiveDraft] = useState<StructuredClosureDraft>(serverBaseline);
  const [liveDirty, setLiveDirty] = useState<ReadonlySet<string>>(() => new Set());

  const targetKey = `closure:${ownerId}:${closure?.closure_id ?? requestedClosureId}`;
  const conflictState = useThreeWayConflictState({
    targetKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraft,
    dirtyFields: liveDirty,
    reconcile: reconcileJsonFields,
  });

  const candidateOwner = useMemo(() => {
    if (!knownOwner) return null;
    try {
      return buildOwnerWithClosure(knownOwner, liveDraft);
    } catch {
      return knownOwner;
    }
  }, [knownOwner, liveDraft]);

  const capability = useMemo(
    () =>
      evaluateTransportCapability(
        "current_transport",
        candidateOwner,
        scene,
        session,
      ),
    [candidateOwner, scene, session],
  );

  const buildValidationReq = useCallback(
    (d: StructuredClosureDraft): TransportValidationRequest => {
      if (!knownOwner || sceneRevision === undefined) {
        throw new Error("Owning charge transport is not available.");
      }
      const nextOwner = buildOwnerWithClosure(knownOwner, d);
      return {
        validation_version: TRANSPORT_VALIDATION_VERSION,
        base_revision: sceneRevision,
        candidate: {
          kind: "current_transport",
          operation: "replace",
          path_id: knownOwner.name,
          resource: nextOwner,
        },
      };
    },
    [knownOwner, sceneRevision],
  );

  const validationState = useDebouncedTransportValidation({
    enabled: Boolean(knownOwner && closure),
    draftSerialized: JSON.stringify(liveDraft),
    draftKey: targetKey,
    sceneRevision,
    sessionScopeKey: session.sessionScopeKey,
    buildRequest: () => buildValidationReq(liveDraft),
  });

  const commitOwnerReplacement = useCallback(
    async (
      nextOwner: KnownSceneCurrentTransport,
      historyLabel: string,
    ) => {
      if (!knownOwner || sceneRevision === undefined) {
        throw new Error("Charge transport catalog is still loading.");
      }
      if (!capability.authoring_allowed) {
        throw new Error(capability.reason);
      }
      const valReq: TransportValidationRequest = {
        validation_version: TRANSPORT_VALIDATION_VERSION,
        base_revision: sceneRevision,
        candidate: {
          kind: "current_transport",
          operation: "replace",
          path_id: knownOwner.name,
          resource: nextOwner,
        },
      };
      await runPreCommitTransportValidation({
        validateTransport: kernel.api.model.validateTransport,
        sessionScopeKey: session.sessionScopeKey,
        request: valReq,
        validationKey: validationState.validationKey,
        setManualValidation: validationState.setManualValidation,
      });

      await executeAuthoringHistoryCommit({
        kernel,
        sessionScopeKey: session.sessionScopeKey,
        label: historyLabel,
        submittedRevision: sceneRevision,
        resourceKeys: RESOURCE_KEYS.currentTransport,
        onConflict409: conflictState.markHttpConflict,
        mutate: ({ committedRevision, requestOptions }) => {
          const payload: CurrentTransportMutationRequest = {
            base_revision: committedRevision,
            resource: nextOwner,
          };
          return kernel.api.model.replaceCurrentTransport(
            knownOwner.name,
            payload,
            requestOptions,
          );
        },
      });
      conflictState.clearConflict();
    },
    [
      capability.authoring_allowed,
      capability.reason,
      conflictState,
      kernel,
      knownOwner,
      sceneRevision,
      session.sessionScopeKey,
      validationState.setManualValidation,
      validationState.validationKey,
    ],
  );

  const handleDeleteClosure = useCallback(async () => {
    if (!knownOwner) return;
    const withoutClosure: KnownSceneCurrentTransport = {
      ...knownOwner,
      structured_current_closure: undefined,
      ...(knownOwner.solver
        ? {
            solver: {
              ...knownOwner.solver,
              operator_version:
                knownOwner.solver.operator_version ===
                "fv_charge_harmonic_source_cut_v1"
                  ? "fv_charge_harmonic_v1"
                  : knownOwner.solver.operator_version,
            },
          }
        : {}),
    };
    await commitOwnerReplacement(
      withoutClosure,
      `Remove structured current closure from ${knownOwner.name}`,
    );
    kernel.selection.set(
      {
        kind: "physics.current-transport",
        label: knownOwner.name,
        nodeId: `model:physics:current-transports:${knownOwner.name}`,
        objectId: selection.objectId,
        ref: {
          currentTransportId: knownOwner.name,
          kind: "physics.current-transport",
          nodeId: `model:physics:current-transports:${knownOwner.name}`,
          type: "current-transport",
        },
      },
      "inspector",
    );
  }, [commitOwnerReplacement, kernel.selection, knownOwner, selection.objectId]);

  const spec = useMemo<InspectorSpec<StructuredClosureDraft>>(
    () => ({
      id: "physics.structured-current-closure",
      header: {
        breadcrumbs,
        searchable: false,
        extraMenuActions: [
          {
            id: "refresh-closure",
            label: "Refresh closure",
            icon: RefreshCw,
            onSelect: () => {
              currentRes.refetch();
            },
          },
          {
            id: "view-closure-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) =>
              ctx.openCodePreview(
                `${ctx.draft.closureId} JSON`,
                "json",
                JSON.stringify(closure ?? ctx.draft, null, 2),
              ),
          },
        ],
        ...(knownOwner && closure && capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Delete Structured Closure",
                confirmTitle: () =>
                  `Remove structured closure "${closure.closure_id}"?`,
                confirmDescription:
                  "Removing structured current closure clears all impressed source cuts and restores standard harmonic operator evaluation on the parent charge transport.",
                onDelete: handleDeleteClosure,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Layers,
        title: (d) => d.closureId || "Structured Current Closure",
        kindLabel: "Closed-Loop Current Closure",
        entityId: closure?.closure_id,
        statePill: () => ({
          tone: !capability.authoring_allowed
            ? "warn"
            : closure
              ? "ok"
              : "err",
          label: !capability.authoring_allowed
            ? capability.status
            : closure
              ? "Closed geometry"
              : "Missing",
        }),
      },
      facts: (d) => {
        let parsedCuts: SceneStructuredCurrentSourceCut[] = [];
        try {
          parsedCuts = JSON.parse(d.cutsJson) as SceneStructuredCurrentSourceCut[];
        } catch {
          parsedCuts = [];
        }
        return [
          { id: "owner", label: "Owner", value: d.ownerId || "Unbound", mono: true },
          {
            id: "cuts",
            label: "Source cuts",
            value: String(parsedCuts.length),
            mono: true,
          },
        ];
      },
      notices: () =>
        buildValidationNotices({
          capability,
          validation: validationState.validation,
          validationError: validationState.validationError,
          buildError: validationState.buildError,
          conflicts: conflictState.conflicts,
          hasRevisionConflict: conflictState.hasRevisionConflict,
          onRebase: conflictState.rebaseDraft,
          targetMissingMessage,
        }),
      sections: [
        {
          id: "scc-identity",
          title: "Closure topology & schema",
          icon: Layers,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Owning charge transport",
              mono: true,
              format: (d) => d.ownerId || "Unbound",
            },
            {
              type: "text",
              key: "closureId",
              label: "Closure ID",
              mono: true,
              validate: (v) => (!v.trim() ? "Enter a non-empty closure ID." : null),
            },
            {
              type: "readonly",
              label: "Schema version",
              mono: true,
              format: (d) => d.schemaVersion,
            },
          ],
        },
        {
          id: "scc-cuts",
          title: "Impressed potential-jump source cuts",
          icon: Scissors,
          defaultOpen: true,
          rows: [
            {
              type: "table",
              wide: true,
              columns: [
                {
                  id: "cut",
                  header: "Cut ID",
                  mono: true,
                  renderCell: (entry) =>
                    (entry as SceneStructuredCurrentSourceCut).source_cut_id,
                },
                {
                  id: "circuit",
                  header: "Circuit",
                  mono: true,
                  renderCell: (entry) =>
                    (entry as SceneStructuredCurrentSourceCut).circuit_id,
                },
                {
                  id: "region",
                  header: "Region",
                  mono: true,
                  renderCell: (entry) => {
                    const row = entry as SceneStructuredCurrentSourceCut;
                    return row.region.region_id
                      ? `${row.region.object_id}/${row.region.region_id}`
                      : row.region.object_id;
                  },
                },
                {
                  id: "drive",
                  header: "Plane / ΔV",
                  align: "right",
                  mono: true,
                  renderCell: (entry) => {
                    const row = entry as SceneStructuredCurrentSourceCut;
                    return `${row.plane.axis.toUpperCase()} · ${row.drive.potential_jump_V} V`;
                  },
                },
              ],
              rows: (d) => {
                try {
                  const parsed: unknown = JSON.parse(d.cutsJson);
                  return Array.isArray(parsed)
                    ? (parsed as SceneStructuredCurrentSourceCut[])
                    : [];
                } catch {
                  return [];
                }
              },
              rowKey: (entry) =>
                (entry as SceneStructuredCurrentSourceCut).source_cut_id,
              onSelectRow: (entry, ctx) => {
                const row = entry as SceneStructuredCurrentSourceCut;
                ctx.selectNode({
                  kind: "physics.structured-current-source-cut",
                  label: row.source_cut_id,
                  nodeId: `model:physics:current-transports:${ctx.draft.ownerId}:cut:${row.source_cut_id}`,
                  objectId: selection.objectId,
                  ref: {
                    currentTransportId: ctx.draft.ownerId,
                    kind: "physics.structured-current-source-cut",
                    nodeId: `model:physics:current-transports:${ctx.draft.ownerId}:cut:${row.source_cut_id}`,
                    structuredCurrentClosureId: ctx.draft.closureId,
                    structuredCurrentSourceCutId: row.source_cut_id,
                    type: "structured-current-source-cut",
                  },
                });
              },
              onRemoveRow: (cutKey, ctx) => {
                try {
                  const currentCuts = JSON.parse(
                    ctx.draft.cutsJson,
                  ) as SceneStructuredCurrentSourceCut[];
                  if (currentCuts.length <= 1) {
                    ctx.notify(
                      "At least one source cut required",
                      "Use Delete Structured Closure in the header menu to remove the entire closure.",
                    );
                    return;
                  }
                  const filtered = currentCuts.filter(
                    (c) => c.source_cut_id !== cutKey,
                  );
                  ctx.setField("cutsJson", JSON.stringify(filtered, null, 2));
                } catch {
                  // Malformed JSON reported by validation.
                }
              },
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <Button
                  disabled={!knownOwner || !capability.authoring_allowed}
                  disabledReason={
                    !capability.authoring_allowed ? capability.reason : undefined
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={async () => {
                    let currentCuts: SceneStructuredCurrentSourceCut[] = [];
                    try {
                      currentCuts = JSON.parse(
                        ctx.draft.cutsJson,
                      ) as SceneStructuredCurrentSourceCut[];
                    } catch {
                      currentCuts = closure?.source_cuts ?? [];
                    }
                    const nextCut = createUniqueSceneSourceCut(
                      currentCuts,
                      knownOwner,
                    );
                    const nextCuts = [...currentCuts, nextCut];
                    if (liveDirty.size > 0 || !knownOwner || !closure) {
                      ctx.setField("cutsJson", JSON.stringify(nextCuts, null, 2));
                      return;
                    }
                    const nextOwner: KnownSceneCurrentTransport = {
                      ...knownOwner,
                      structured_current_closure: {
                        ...closure,
                        closure_id: ctx.draft.closureId.trim() || closure.closure_id,
                        source_cuts: nextCuts,
                      },
                    };
                    await commitOwnerReplacement(
                      nextOwner,
                      `Add source cut ${nextCut.source_cut_id} to ${knownOwner.name}`,
                    );
                    ctx.selectNode({
                      kind: "physics.structured-current-source-cut",
                      label: nextCut.source_cut_id,
                      nodeId: `model:physics:current-transports:${knownOwner.name}:cut:${nextCut.source_cut_id}`,
                      objectId: selection.objectId,
                      ref: {
                        currentTransportId: knownOwner.name,
                        kind: "physics.structured-current-source-cut",
                        nodeId: `model:physics:current-transports:${knownOwner.name}:cut:${nextCut.source_cut_id}`,
                        structuredCurrentClosureId:
                          ctx.draft.closureId.trim() || closure.closure_id,
                        structuredCurrentSourceCutId: nextCut.source_cut_id,
                        type: "structured-current-source-cut",
                      },
                    });
                  }}
                >
                  <Plus aria-hidden="true" size={12} />
                  <span>Add Source Cut</span>
                </Button>
              ),
            },
          ],
        },
      ],
      details: () => buildValidationDetails(capability, validationState.validation),
      commitBar: {
        mode: "staged",
        cleanMessage: () =>
          sceneRevision !== undefined
            ? `Up to date with scene revision ${sceneRevision}`
            : "Up to date",
        lockReason: () =>
          computeTransportLockReason({
            capability,
            validation: validationState.validation,
            validationError: validationState.validationError,
            buildError: validationState.buildError,
            hasConflict: conflictState.hasConflict,
            targetMissingMessage,
          }),
        onApply: async (draft) => {
          if (!knownOwner) {
            throw new Error("Owning charge transport is not available.");
          }
          const nextOwner = buildOwnerWithClosure(knownOwner, draft);
          await commitOwnerReplacement(
            nextOwner,
            `Replace structured current closure ${draft.closureId.trim()}`,
          );
          return true;
        },
      },
    }),
    [
      breadcrumbs,
      capability,
      closure,
      commitOwnerReplacement,
      conflictState.conflicts,
      conflictState.hasConflict,
      conflictState.hasRevisionConflict,
      conflictState.rebaseDraft,
      currentRes,
      handleDeleteClosure,
      knownOwner,
      liveDirty.size,
      sceneRevision,
      selection.objectId,
      targetMissingMessage,
      validationState.buildError,
      validationState.validation,
      validationState.validationError,
    ],
  );

  const controller = useInspectorSpecController(spec, selection, serverBaseline);
  if (JSON.stringify(controller.draft) !== JSON.stringify(liveDraft)) {
    setLiveDraft(controller.draft);
  }
  if (controller.dirtyFields.size !== liveDirty.size) {
    setLiveDirty(new Set(controller.dirtyFields));
  }

  if (isOpaqueOwner) {
    return (
      <>
        {session.probeElement}
        <ReadOnlyOpaqueInspector
          breadcrumbs={breadcrumbs}
          icon={Layers}
          kindLabel="Closed-Loop Current Closure"
          payload={matchedRawOwner}
          selection={selection}
          specId="physics.structured-current-closure"
          heading={requestedClosureId || "Opaque Current Closure"}
          warningText="Owning charge transport uses an unrecognized variant and is preserved read-only."
          onRefresh={() => currentRes.refetch()}
        />
      </>
    );
  }

  return (
    <TransportTemplateRenderer
      controller={controller}
      selection={selection}
      spec={spec}
    >
      {session.probeElement}
    </TransportTemplateRenderer>
  );
}

/* ============================================================================
 * Route 3: StructuredCurrentSourceCutInspectorPanel (`physics.structured-current-source-cut`)
 * ============================================================================ */

interface StructuredSourceCutDraft {
  exists: boolean;
  ownerId: string;
  closureId: string;
  sourceCutId: string;
  circuitId: string;
  objectId: string;
  regionId: string;
  coordinateFrame: "" | "world" | "object";
  axis: SceneStructuredCutPlane["axis"];
  normal: SceneStructuredCutPlane["normal"];
  offsetM: number;
  driveId: string;
  potentialJumpV: number;
  driveSchemaVersion: string;
}

function buildOwnerWithUpdatedCut(
  ownerRecord: KnownSceneCurrentTransport,
  originalCutId: string,
  draft: StructuredSourceCutDraft,
): KnownSceneCurrentTransport {
  const closure = ownerRecord.structured_current_closure;
  if (!closure) {
    throw new Error("Owning charge transport has no structured current closure.");
  }
  const sourceCutId = draft.sourceCutId.trim();
  const circuitId = draft.circuitId.trim();
  const driveId = draft.driveId.trim();
  const objectId = draft.objectId.trim();
  if (!sourceCutId) throw new Error("Source cut ID is required.");
  if (!circuitId) throw new Error("Circuit ID is required.");
  if (!driveId) throw new Error("Drive ID is required.");
  if (!objectId) throw new Error("Cut region object ID is required.");
  if (!Number.isFinite(draft.potentialJumpV) || draft.potentialJumpV === 0) {
    throw new Error("Impressed potential jump ΔV must be finite and non-zero.");
  }
  if (!Number.isFinite(draft.offsetM)) {
    throw new Error("Plane offset must be finite.");
  }

  const nextPlane: SceneStructuredCutPlane = {
    axis: draft.axis,
    normal: draft.normal,
    offset_m: draft.offsetM,
    ...(draft.coordinateFrame
      ? { coordinate_frame: draft.coordinateFrame }
      : {}),
  };

  const nextCut: SceneStructuredCurrentSourceCut = {
    source_cut_id: sourceCutId,
    circuit_id: circuitId,
    region: {
      object_id: objectId,
      ...(draft.regionId.trim() ? { region_id: draft.regionId.trim() } : {}),
    },
    plane: nextPlane,
    drive: {
      kind: "impressed_potential_jump",
      drive_id: driveId,
      potential_jump_V: draft.potentialJumpV,
      schema_version: draft.driveSchemaVersion.trim() || "impressed_potential_jump.v1",
    },
  };

  const existingCuts = closure.source_cuts;
  const found = existingCuts.some((c) => c.source_cut_id === originalCutId);
  const nextCuts = found
    ? existingCuts.map((c) => (c.source_cut_id === originalCutId ? nextCut : c))
    : [...existingCuts, nextCut];

  if (new Set(nextCuts.map((c) => c.source_cut_id.trim())).size !== nextCuts.length) {
    throw new Error("Source cut IDs must be unique across sibling cuts.");
  }
  if (new Set(nextCuts.map((c) => c.circuit_id.trim())).size !== nextCuts.length) {
    throw new Error("Circuit IDs must be unique across sibling cuts.");
  }
  if (new Set(nextCuts.map((c) => c.drive.drive_id.trim())).size !== nextCuts.length) {
    throw new Error("Drive IDs must be unique across sibling cuts.");
  }

  return {
    ...ownerRecord,
    structured_current_closure: {
      ...closure,
      source_cuts: nextCuts,
    },
  };
}

export function StructuredCurrentSourceCutInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const scene = useAuthoringSceneData();
  const currentRes = useCurrentTransportsResource();
  const items = useMemo(() => currentRes.data?.items ?? [], [currentRes.data?.items]);
  const sceneRevision = currentRes.data?.scene_revision;

  const ref =
    selection.ref?.type === "structured-current-source-cut" ? selection.ref : null;
  const requestedOwnerId = ref?.currentTransportId ?? "";
  const requestedClosureId = ref?.structuredCurrentClosureId ?? "";
  const requestedCutId = ref?.structuredCurrentSourceCutId ?? selection.label;

  const matchedRawOwner = useMemo(
    () =>
      items.find((item) => {
        if (isEditableCurrentTransport(item)) {
          if (requestedOwnerId) return item.name === requestedOwnerId;
          return (
            item.structured_current_closure?.source_cuts.some(
              (c) => c.source_cut_id === requestedCutId,
            ) ?? false
          );
        }
        const rec = item as Record<string, unknown>;
        return Boolean(requestedOwnerId && rec.name === requestedOwnerId);
      }) ?? null,
    [items, requestedCutId, requestedOwnerId],
  );

  const knownOwner =
    matchedRawOwner && isEditableCurrentTransport(matchedRawOwner)
      ? matchedRawOwner
      : null;
  const isOpaqueOwner = matchedRawOwner !== null && knownOwner === null;
  const closure = knownOwner?.structured_current_closure ?? null;
  const matchedCut = useMemo(
    () =>
      closure?.source_cuts.find((c) => c.source_cut_id === requestedCutId) ??
      null,
    [closure?.source_cuts, requestedCutId],
  );

  const ownerId = knownOwner?.name ?? requestedOwnerId;
  const closureId = closure?.closure_id ?? requestedClosureId;
  const existingCutCount = closure?.source_cuts.length ?? 0;

  const targetMissingMessage =
    currentRes.status === "ready" && (!knownOwner || !closure || !matchedCut)
      ? "The selected structured current source cut is no longer present in the scene."
      : null;

  const breadcrumbs = useMemo<InspectorBreadcrumbItem[]>(
    () => [
      {
        id: "crumb-model",
        label: "Model",
        selection: {
          kind: "model.root",
          label: "Model",
          nodeId: "model:root",
          objectId: null,
          ref: null,
        },
      },
      {
        id: "crumb-owner",
        label: ownerId || "Charge Transport",
        selection: ownerId
          ? {
              kind: "physics.current-transport",
              label: ownerId,
              nodeId: `model:physics:current-transports:${ownerId}`,
              objectId: selection.objectId,
              ref: {
                currentTransportId: ownerId,
                kind: "physics.current-transport",
                nodeId: `model:physics:current-transports:${ownerId}`,
                type: "current-transport",
              },
            }
          : undefined,
      },
      {
        id: "crumb-closure",
        label: closureId || "Closure",
        selection:
          ownerId && closureId
            ? {
                kind: "physics.structured-current-closure",
                label: closureId,
                nodeId: `model:physics:current-transports:${ownerId}:closure`,
                objectId: selection.objectId,
                ref: {
                  currentTransportId: ownerId,
                  kind: "physics.structured-current-closure",
                  nodeId: `model:physics:current-transports:${ownerId}:closure`,
                  structuredCurrentClosureId: closureId,
                  type: "structured-current-closure",
                },
              }
            : undefined,
      },
      { id: "crumb-cut", label: matchedCut?.source_cut_id ?? requestedCutId ?? "Source Cut" },
    ],
    [closureId, matchedCut?.source_cut_id, ownerId, requestedCutId, selection.objectId],
  );

  const serverBaseline = useMemo<StructuredSourceCutDraft>(
    () => ({
      exists: Boolean(knownOwner && closure && matchedCut),
      ownerId,
      closureId,
      sourceCutId: matchedCut?.source_cut_id ?? requestedCutId ?? "cut-1",
      circuitId: matchedCut?.circuit_id ?? "loop-1",
      objectId:
        matchedCut?.region.object_id ?? knownOwner?.domain?.[0]?.object_id ?? "",
      regionId:
        matchedCut?.region.region_id ?? knownOwner?.domain?.[0]?.region_id ?? "",
      coordinateFrame: matchedCut?.plane.coordinate_frame ?? "",
      axis: matchedCut?.plane.axis ?? "x",
      normal: matchedCut?.plane.normal ?? "positive_axis",
      offsetM: matchedCut?.plane.offset_m ?? 0,
      driveId: matchedCut?.drive.drive_id ?? "drive-1",
      potentialJumpV: matchedCut?.drive.potential_jump_V ?? 0.1,
      driveSchemaVersion:
        matchedCut?.drive.schema_version ?? "impressed_potential_jump.v1",
    }),
    [closure, closureId, knownOwner, matchedCut, ownerId, requestedCutId],
  );

  const [liveDraft, setLiveDraft] =
    useState<StructuredSourceCutDraft>(serverBaseline);
  const [liveDirty, setLiveDirty] = useState<ReadonlySet<string>>(() => new Set());

  const targetKey = `cut:${ownerId}:${closureId}:${matchedCut?.source_cut_id ?? requestedCutId}`;
  const conflictState = useThreeWayConflictState({
    targetKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraft,
    dirtyFields: liveDirty,
    reconcile: reconcileJsonFields,
  });

  const candidateOwner = useMemo(() => {
    if (!knownOwner || !matchedCut) return knownOwner;
    try {
      return buildOwnerWithUpdatedCut(
        knownOwner,
        matchedCut.source_cut_id,
        liveDraft,
      );
    } catch {
      return knownOwner;
    }
  }, [knownOwner, liveDraft, matchedCut]);

  const capability = useMemo(
    () =>
      evaluateTransportCapability(
        "current_transport",
        candidateOwner,
        scene,
        session,
      ),
    [candidateOwner, scene, session],
  );

  const buildValidationReq = useCallback(
    (d: StructuredSourceCutDraft): TransportValidationRequest => {
      if (!knownOwner || !matchedCut || sceneRevision === undefined) {
        throw new Error("Selected source cut is not available.");
      }
      const nextOwner = buildOwnerWithUpdatedCut(
        knownOwner,
        matchedCut.source_cut_id,
        d,
      );
      return {
        validation_version: TRANSPORT_VALIDATION_VERSION,
        base_revision: sceneRevision,
        candidate: {
          kind: "current_transport",
          operation: "replace",
          path_id: knownOwner.name,
          resource: nextOwner,
        },
      };
    },
    [knownOwner, matchedCut, sceneRevision],
  );

  const validationState = useDebouncedTransportValidation({
    enabled: Boolean(knownOwner && closure && matchedCut),
    draftSerialized: JSON.stringify(liveDraft),
    draftKey: targetKey,
    sceneRevision,
    sessionScopeKey: session.sessionScopeKey,
    buildRequest: () => buildValidationReq(liveDraft),
  });

  const handleRemoveCut = useCallback(async () => {
    if (!knownOwner || !closure || !matchedCut || sceneRevision === undefined) return;
    if (closure.source_cuts.length <= 1) {
      throw new Error(
        "A closed-geometry current closure requires at least one source cut.",
      );
    }
    if (!capability.authoring_allowed) {
      throw new Error(capability.reason);
    }
    const nextOwner: KnownSceneCurrentTransport = {
      ...knownOwner,
      structured_current_closure: {
        ...closure,
        source_cuts: closure.source_cuts.filter(
          (c) => c.source_cut_id !== matchedCut.source_cut_id,
        ),
      },
    };
    const valReq: TransportValidationRequest = {
      validation_version: TRANSPORT_VALIDATION_VERSION,
      base_revision: sceneRevision,
      candidate: {
        kind: "current_transport",
        operation: "replace",
        path_id: knownOwner.name,
        resource: nextOwner,
      },
    };
    await runPreCommitTransportValidation({
      validateTransport: kernel.api.model.validateTransport,
      sessionScopeKey: session.sessionScopeKey,
      request: valReq,
    });

    await executeAuthoringHistoryCommit({
      kernel,
      sessionScopeKey: session.sessionScopeKey,
      label: `Remove source cut ${matchedCut.source_cut_id} from ${knownOwner.name}`,
      submittedRevision: sceneRevision,
      resourceKeys: RESOURCE_KEYS.currentTransport,
      onConflict409: conflictState.markHttpConflict,
      mutate: ({ committedRevision, requestOptions }) =>
        kernel.api.model.replaceCurrentTransport(
          knownOwner.name,
          { base_revision: committedRevision, resource: nextOwner },
          requestOptions,
        ),
    });

    conflictState.clearConflict();
    kernel.selection.set(
      {
        kind: "physics.structured-current-closure",
        label: closure.closure_id,
        nodeId: `model:physics:current-transports:${knownOwner.name}:closure`,
        objectId: selection.objectId,
        ref: {
          currentTransportId: knownOwner.name,
          kind: "physics.structured-current-closure",
          nodeId: `model:physics:current-transports:${knownOwner.name}:closure`,
          structuredCurrentClosureId: closure.closure_id,
          type: "structured-current-closure",
        },
      },
      "inspector",
    );
  }, [
    capability.authoring_allowed,
    capability.reason,
    closure,
    conflictState,
    kernel,
    knownOwner,
    matchedCut,
    sceneRevision,
    selection.objectId,
    session.sessionScopeKey,
  ]);

  const scopes = useMemo(() => transportScopeOptions(scene), [scene]);

  const spec = useMemo<InspectorSpec<StructuredSourceCutDraft>>(
    () => ({
      id: "physics.structured-current-source-cut",
      header: {
        breadcrumbs,
        searchable: false,
        extraMenuActions: [
          {
            id: "refresh-source-cut",
            label: "Refresh source cut",
            icon: RefreshCw,
            onSelect: () => {
              currentRes.refetch();
            },
          },
          {
            id: "view-source-cut-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) =>
              ctx.openCodePreview(
                `${ctx.draft.sourceCutId} JSON`,
                "json",
                JSON.stringify(matchedCut ?? ctx.draft, null, 2),
              ),
          },
        ],
        ...(knownOwner &&
        matchedCut &&
        existingCutCount > 1 &&
        capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Remove Source Cut",
                confirmTitle: () =>
                  `Remove source cut "${matchedCut.source_cut_id}"?`,
                confirmDescription:
                  "Removing this source cut deletes its impressed potential jump from the parent closed-geometry current closure.",
                onDelete: handleRemoveCut,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Scissors,
        title: (d) => d.sourceCutId || "Source Cut",
        kindLabel: "Structured Current Source Cut",
        entityId: matchedCut?.source_cut_id,
        statePill: (d) => ({
          tone: !capability.authoring_allowed
            ? "warn"
            : d.exists
              ? "ok"
              : "err",
          label: !capability.authoring_allowed
            ? capability.status
            : `Axis ${d.axis.toUpperCase()}`,
        }),
      },
      facts: (d) => [
        { id: "circuit", label: "Circuit", value: d.circuitId, mono: true },
        {
          id: "region",
          label: "Region",
          value: d.regionId ? `${d.objectId}/${d.regionId}` : d.objectId || "Unbound",
          mono: true,
        },
        {
          id: "jump",
          label: "ΔV",
          value: `${Number((d.potentialJumpV * 1e3).toPrecision(4))} mV`,
          mono: true,
        },
      ],
      notices: () =>
        buildValidationNotices({
          capability,
          validation: validationState.validation,
          validationError: validationState.validationError,
          buildError: validationState.buildError,
          conflicts: conflictState.conflicts,
          hasRevisionConflict: conflictState.hasRevisionConflict,
          onRebase: conflictState.rebaseDraft,
          targetMissingMessage,
        }),
      sections: [
        {
          id: "scsc-region-identity",
          title: "Cut identity & target region",
          icon: Layers,
          defaultOpen: true,
          rows: [
            {
              type: "text",
              key: "sourceCutId",
              label: "Source cut ID",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Source cut ID is required." : null,
            },
            {
              type: "text",
              key: "circuitId",
              label: "Circuit ID",
              mono: true,
              validate: (v) => (!v.trim() ? "Circuit ID is required." : null),
            },
            {
              type: "custom",
              wide: true,
              label: "Target object / region scope",
              render: (ctx) => {
                const currentEncoded = ctx.draft.objectId
                  ? encodeTransportScopeOption(
                      ctx.draft.objectId,
                      ctx.draft.regionId,
                    )
                  : EMPTY_SELECT_SENTINEL;
                const missingScope =
                  Boolean(ctx.draft.objectId) &&
                  !scopes.some(
                    (s) =>
                      s.objectId === ctx.draft.objectId &&
                      s.regionId === ctx.draft.regionId,
                  );
                return (
                  <div className="flex flex-col gap-1.5" data-slot="cut-region-selector">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      Target object / region (region)
                    </span>
                    <Select
                      value={currentEncoded}
                      onValueChange={(nextVal) => {
                        if (nextVal === EMPTY_SELECT_SENTINEL) {
                          ctx.patchDraft({ objectId: "", regionId: "" });
                          return;
                        }
                        const parsed = parseTransportScopeOption(nextVal);
                        if (parsed) {
                          ctx.patchDraft({
                            objectId: parsed[0],
                            regionId: parsed[1],
                          });
                        }
                      }}
                    >
                      <SelectTrigger aria-label="Source cut region scope">
                        <SelectValue placeholder="Select object or region" />
                      </SelectTrigger>
                      <SelectContent align="start" position="popper">
                        <SelectGroup>
                          <SelectItem value={EMPTY_SELECT_SENTINEL}>
                            Select object or region
                          </SelectItem>
                          {missingScope ? (
                            <SelectItem value={currentEncoded}>
                              {ctx.draft.regionId
                                ? `${ctx.draft.objectId} / ${ctx.draft.regionId} (not in scene)`
                                : `${ctx.draft.objectId} (not in scene)`}
                            </SelectItem>
                          ) : null}
                          {scopes.map((s) => (
                            <SelectItem
                              key={`${s.objectId}:${s.regionId}`}
                              value={encodeTransportScopeOption(
                                s.objectId,
                                s.regionId,
                              )}
                            >
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                );
              },
            },
            {
              type: "text",
              key: "objectId",
              label: "Region object_id",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Region object_id is required." : null,
            },
            {
              type: "text",
              key: "regionId",
              label: "Optional region_id",
              mono: true,
              placeholder: "Omit for whole-object scope",
            },
          ],
        },
        {
          id: "scsc-plane",
          title: "Structured cut plane",
          icon: Scissors,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              label: "Plane coordinate frame",
              render: (ctx) => (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--fm-text-muted)]">
                    Coordinate frame (plane.coordinate_frame)
                  </span>
                  <Select
                    value={ctx.draft.coordinateFrame || OMITTED_FRAME_SENTINEL}
                    onValueChange={(nextVal) =>
                      ctx.setField(
                        "coordinateFrame",
                        nextVal === OMITTED_FRAME_SENTINEL
                          ? ""
                          : (nextVal as "world" | "object"),
                      )
                    }
                  >
                    <SelectTrigger aria-label="Plane coordinate frame">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start" position="popper">
                      <SelectGroup>
                        <SelectItem value={OMITTED_FRAME_SENTINEL}>
                          Default (omitted / world contract)
                        </SelectItem>
                        <SelectItem value="world">Explicit world frame</SelectItem>
                        <SelectItem value="object">Object local frame</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              ),
            },
            {
              type: "segmented",
              key: "axis",
              label: "Cut axis",
              options: [
                { value: "x", label: "X" },
                { value: "y", label: "Y" },
                { value: "z", label: "Z" },
              ],
            },
            {
              type: "segmented",
              key: "normal",
              label: "Cut normal",
              options: [
                { value: "positive_axis", label: "+Axis" },
                { value: "negative_axis", label: "−Axis" },
              ],
            },
            {
              type: "quantity",
              key: "offsetM",
              label: "Plane offset",
              symbol: "s_0",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
            },
          ],
        },
        {
          id: "scsc-drive",
          title: "Impressed potential jump",
          icon: Gauge,
          defaultOpen: true,
          rows: [
            {
              type: "text",
              key: "driveId",
              label: "Drive ID",
              mono: true,
              validate: (v) => (!v.trim() ? "Drive ID is required." : null),
            },
            {
              type: "quantity",
              key: "potentialJumpV",
              label: "Impressed potential jump",
              symbol: "ΔV",
              units: VOLTAGE_UNITS,
              defaultDisplayUnit: "mV",
              validate: (v) =>
                v === 0 ? "Potential jump ΔV must be non-zero." : null,
            },
          ],
        },
      ],
      details: () => buildValidationDetails(capability, validationState.validation),
      commitBar: {
        mode: "staged",
        cleanMessage: () =>
          sceneRevision !== undefined
            ? `Up to date with scene revision ${sceneRevision}`
            : "Up to date",
        lockReason: () =>
          computeTransportLockReason({
            capability,
            validation: validationState.validation,
            validationError: validationState.validationError,
            buildError: validationState.buildError,
            hasConflict: conflictState.hasConflict,
            targetMissingMessage,
          }),
        onApply: async (draft) => {
          if (!knownOwner || !matchedCut || sceneRevision === undefined) {
            throw new Error("Selected source cut is not available.");
          }
          if (!capability.authoring_allowed) {
            throw new Error(capability.reason);
          }
          const originalId = matchedCut.source_cut_id;
          const nextOwner = buildOwnerWithUpdatedCut(
            knownOwner,
            originalId,
            draft,
          );
          const valReq = buildValidationReq(draft);
          await runPreCommitTransportValidation({
            validateTransport: kernel.api.model.validateTransport,
            sessionScopeKey: session.sessionScopeKey,
            request: valReq,
            validationKey: validationState.validationKey,
            setManualValidation: validationState.setManualValidation,
          });

          await executeAuthoringHistoryCommit({
            kernel,
            sessionScopeKey: session.sessionScopeKey,
            label: `Replace source cut ${draft.sourceCutId.trim()} on ${knownOwner.name}`,
            submittedRevision: sceneRevision,
            resourceKeys: RESOURCE_KEYS.currentTransport,
            onConflict409: conflictState.markHttpConflict,
            mutate: ({ committedRevision, requestOptions }) =>
              kernel.api.model.replaceCurrentTransport(
                knownOwner.name,
                { base_revision: committedRevision, resource: nextOwner },
                requestOptions,
              ),
          });
          conflictState.clearConflict();

          const nextCutId = draft.sourceCutId.trim();
          if (nextCutId !== originalId) {
            kernel.selection.set(
              {
                kind: "physics.structured-current-source-cut",
                label: nextCutId,
                nodeId: `model:physics:current-transports:${knownOwner.name}:cut:${nextCutId}`,
                objectId: selection.objectId,
                ref: {
                  currentTransportId: knownOwner.name,
                  kind: "physics.structured-current-source-cut",
                  nodeId: `model:physics:current-transports:${knownOwner.name}:cut:${nextCutId}`,
                  structuredCurrentClosureId: draft.closureId,
                  structuredCurrentSourceCutId: nextCutId,
                  type: "structured-current-source-cut",
                },
              },
              "inspector",
            );
          }
          return true;
        },
      },
    }),
    [
      breadcrumbs,
      buildValidationReq,
      capability,
      conflictState,
      currentRes,
      existingCutCount,
      handleRemoveCut,
      kernel,
      knownOwner,
      matchedCut,
      sceneRevision,
      scopes,
      selection.objectId,
      session.sessionScopeKey,
      targetMissingMessage,
      validationState.buildError,
      validationState.setManualValidation,
      validationState.validation,
      validationState.validationError,
      validationState.validationKey,
    ],
  );

  const controller = useInspectorSpecController(spec, selection, serverBaseline);
  if (JSON.stringify(controller.draft) !== JSON.stringify(liveDraft)) {
    setLiveDraft(controller.draft);
  }
  if (controller.dirtyFields.size !== liveDirty.size) {
    setLiveDirty(new Set(controller.dirtyFields));
  }

  if (isOpaqueOwner) {
    return (
      <>
        {session.probeElement}
        <ReadOnlyOpaqueInspector
          breadcrumbs={breadcrumbs}
          icon={Scissors}
          kindLabel="Structured Current Source Cut"
          payload={matchedRawOwner}
          selection={selection}
          specId="physics.structured-current-source-cut"
          heading={requestedCutId || "Opaque Source Cut"}
          warningText="Owning charge transport uses an unrecognized variant and is preserved read-only."
          onRefresh={() => currentRes.refetch()}
        />
      </>
    );
  }

  return (
    <TransportTemplateRenderer
      controller={controller}
      selection={selection}
      spec={spec}
    >
      {session.probeElement}
    </TransportTemplateRenderer>
  );
}
