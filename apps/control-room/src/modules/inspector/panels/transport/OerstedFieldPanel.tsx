"use client";

import {
  Activity,
  Compass,
  FileCode2,
  Magnet,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  OerstedFieldMutationRequest,
  SceneOerstedField,
  TransportValidationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  useCurrentTransportsResource,
  useOerstedFieldsResource,
} from "@/kernel/resources/spinAuthoringResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { isUnsupportedSpinAuthoringResource } from "@/shared/domain/physics/spinAuthoringRecognition";
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
  CURRENT_UNITS,
  LENGTH_UNITS,
  MU0_SI,
} from "../model-roots/SpecInspectorHost";
import { reconcileSpinAuthoringDraft } from "../spinAuthoringDraft";
import { resolveOerstedCurrentSource } from "../SpinAuthoringInspector.model";
import { currentSourceOptions } from "../SpinAuthoringInspectorModel";
import { OerstedTimeDependenceEditor } from "./TimeEnvelopeEditors";
import {
  buildValidationDetails,
  buildValidationNotices,
  computeTransportLockReason,
  EMPTY_SELECT_SENTINEL,
  evaluateSpinM1Capability,
  executeAuthoringHistoryCommit,
  extractInitialRegionId,
  type KnownSceneOerstedField,
  ReadOnlyOpaqueInspector,
  RESOURCE_KEYS,
  ResourceSwitcherBar,
  runPreCommitTransportValidation,
  type SceneOerstedTimeDependence,
  TRANSPORT_VALIDATION_VERSION,
  TransportTemplateRenderer,
  useDebouncedTransportValidation,
  useThreeWayConflictState,
  useTransportSessionContext,
} from "./transportShared";

export interface OerstedFieldPanelDraft {
  exists: boolean;
  id: string;
  kind: "oersted_cylinder" | "oersted_field";
  currentA: number;
  radiusM: number;
  centerVec: readonly [number, number, number];
  axisVec: readonly [number, number, number];
  timeDependenceJson: string;
  source: string;
  model: "from_current_solution";
}

function hydrateOerstedPanelDraft(
  record: KnownSceneOerstedField | null,
  autoSource: string | null,
  fallbackCurrentId: string,
  exists: boolean,
): OerstedFieldPanelDraft {
  if (!record) {
    if (autoSource) {
      return {
        exists: false,
        id: `oersted:${autoSource}`,
        kind: "oersted_field",
        currentA: 5e-3,
        radiusM: 50e-9,
        centerVec: [0, 0, 0],
        axisVec: [0, 0, 1],
        timeDependenceJson: "",
        source: autoSource,
        model: "from_current_solution",
      };
    }
    return {
      exists: false,
      id: "oersted-field",
      kind: "oersted_cylinder",
      currentA: 5e-3,
      radiusM: 50e-9,
      centerVec: [0, 0, 0],
      axisVec: [0, 0, 1],
      timeDependenceJson: "",
      source: fallbackCurrentId,
      model: "from_current_solution",
    };
  }

  if (record.kind === "oersted_field") {
    return {
      exists,
      id: record.id || "oersted-field",
      kind: "oersted_field",
      currentA: 5e-3,
      radiusM: 50e-9,
      centerVec: [0, 0, 0],
      axisVec: [0, 0, 1],
      timeDependenceJson: "",
      source: record.source,
      model: "from_current_solution",
    };
  }

  return {
    exists,
    id: record.id || "oersted-field",
    kind: "oersted_cylinder",
    currentA: record.current,
    radiusM: record.radius,
    centerVec: [
      record.center[0] ?? 0,
      record.center[1] ?? 0,
      record.center[2] ?? 0,
    ],
    axisVec: [
      record.axis[0] ?? 0,
      record.axis[1] ?? 0,
      record.axis[2] ?? 1,
    ],
    timeDependenceJson: record.time_dependence
      ? JSON.stringify(record.time_dependence, null, 2)
      : "",
    source: fallbackCurrentId,
    model: "from_current_solution",
  };
}

export function buildOerstedFieldResource(
  draft: OerstedFieldPanelDraft,
): SceneOerstedField {
  const id = draft.id.trim();
  if (!id) throw new Error("Oersted field ID is required.");

  if (draft.kind === "oersted_field") {
    const source = draft.source.trim();
    if (!source) {
      throw new Error("Select a driving charge transport source for Oersted field.");
    }
    const built: KnownSceneOerstedField = {
      kind: "oersted_field",
      id,
      source,
      model: "from_current_solution",
    };
    return built;
  }

  if (!Number.isFinite(draft.radiusM) || draft.radiusM <= 0) {
    throw new Error("Wire radius R must be strictly greater than zero.");
  }
  if (!Number.isFinite(draft.currentA)) {
    throw new Error("Wire current I must be finite.");
  }
  const axisNorm = Math.hypot(
    draft.axisVec[0],
    draft.axisVec[1],
    draft.axisVec[2],
  );
  if (axisNorm <= 0) {
    throw new Error("Wire axis vector must be non-zero.");
  }

  let timeDependence: SceneOerstedTimeDependence | undefined;
  const trimmedTime = draft.timeDependenceJson.trim();
  if (trimmedTime && trimmedTime !== "{}") {
    timeDependence = JSON.parse(trimmedTime) as SceneOerstedTimeDependence;
  }

  const built: KnownSceneOerstedField = {
    kind: "oersted_cylinder",
    id,
    current: draft.currentA,
    radius: draft.radiusM,
    center: [draft.centerVec[0], draft.centerVec[1], draft.centerVec[2]],
    axis: [draft.axisVec[0], draft.axisVec[1], draft.axisVec[2]],
    ...(timeDependence ? { time_dependence: timeDependence } : {}),
  };
  return built;
}

function computeCylinderSurfaceFieldTesla(
  currentA: number,
  radiusM: number,
): number {
  if (!Number.isFinite(currentA) || !Number.isFinite(radiusM) || radiusM <= 0) {
    return 0;
  }
  return (MU0_SI * Math.abs(currentA)) / (2 * Math.PI * radiusM);
}

function reconcileOerstedDraft(
  server: OerstedFieldPanelDraft,
  local: OerstedFieldPanelDraft,
  base: OerstedFieldPanelDraft,
): { draft: OerstedFieldPanelDraft; conflicts: string[] } {
  const serializeFields = (d: OerstedFieldPanelDraft): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  };
  const reconciled = reconcileSpinAuthoringDraft(
    serializeFields(server),
    serializeFields(local),
    serializeFields(base),
  );
  const next = { ...server };
  for (const key of Object.keys(server) as Array<keyof OerstedFieldPanelDraft>) {
    if (
      reconciled.draft[key] !== JSON.stringify(server[key]) &&
      reconciled.draft[key] !== String(server[key])
    ) {
      (next as Record<string, unknown>)[key] = local[key];
    }
  }
  return {
    draft: { ...next, exists: server.exists },
    conflicts: reconciled.conflicts.filter((k) => k !== "exists"),
  };
}

export function OerstedFieldInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const oerstedRes = useOerstedFieldsResource();
  const currentRes = useCurrentTransportsResource();

  const items = useMemo(
    () => oerstedRes.data?.items ?? [],
    [oerstedRes.data?.items],
  );
  const currents = useMemo(
    () => currentRes.data?.items ?? [],
    [currentRes.data?.items],
  );
  const sceneRevision = oerstedRes.data?.scene_revision;

  const ref = selection.ref;
  const isExplicitDraft = Boolean(
    ref && "draft" in ref && (ref as { draft?: boolean }).draft === true,
  );
  const pinnedByRef =
    ref?.type === "oersted-field" &&
    !isExplicitDraft &&
    (ref.oerstedFieldId != null || ref.oerstedFieldIndex != null);

  const [localResourceId, setLocalResourceId] = useState("");
  const [prevSelNodeId, setPrevSelNodeId] = useState(selection.nodeId);
  if (prevSelNodeId !== selection.nodeId) {
    setPrevSelNodeId(selection.nodeId);
    setLocalResourceId("");
  }

  const positionalOnly =
    pinnedByRef &&
    ref?.type === "oersted-field" &&
    !ref.oerstedFieldId &&
    ref.oerstedFieldIndex !== undefined;

  const selectedRecord = useMemo(() => {
    if (pinnedByRef && ref?.type === "oersted-field") {
      if (ref.oerstedFieldId) {
        return (
          items.find(
            (item) =>
              (item as Record<string, unknown>).id === ref.oerstedFieldId,
          ) ?? null
        );
      }
      if (ref.oerstedFieldIndex !== undefined) {
        return items[ref.oerstedFieldIndex] ?? null;
      }
    }
    if (!localResourceId) return null;
    if (localResourceId.startsWith("position:")) {
      const idx = Number.parseInt(
        localResourceId.slice("position:".length),
        10,
      );
      return Number.isInteger(idx) ? (items[idx] ?? null) : null;
    }
    return (
      items.find(
        (item) => (item as Record<string, unknown>).id === localResourceId,
      ) ?? null
    );
  }, [items, localResourceId, pinnedByRef, ref]);

  const [pinnedPositionalState, setPinnedPositionalState] = useState<{
    selKey: string | null;
    pinnedId: string | null;
  }>({ selKey: selection.nodeId, pinnedId: null });
  if (pinnedPositionalState.selKey !== selection.nodeId) {
    setPinnedPositionalState({ selKey: selection.nodeId, pinnedId: null });
  }
  const currentResolvedId =
    selectedRecord &&
    typeof (selectedRecord as Record<string, unknown>).id === "string"
      ? String((selectedRecord as Record<string, unknown>).id)
      : null;
  if (
    positionalOnly &&
    oerstedRes.status === "ready" &&
    currentResolvedId &&
    pinnedPositionalState.pinnedId === null
  ) {
    setPinnedPositionalState({
      selKey: selection.nodeId,
      pinnedId: currentResolvedId,
    });
  }
  const positionalIdentityMismatch =
    positionalOnly &&
    pinnedPositionalState.pinnedId !== null &&
    currentResolvedId !== pinnedPositionalState.pinnedId
      ? "Positional Oersted field target changed identity after scene reorder. Reselect the target before applying."
      : null;

  const targetMissingMessage =
    (pinnedByRef || Boolean(localResourceId)) &&
    oerstedRes.status === "ready" &&
    selectedRecord === null
      ? "The selected Oersted field resource is no longer present in the scene."
      : positionalIdentityMismatch;

  const isOpaqueSelected =
    selectedRecord !== null &&
    isUnsupportedSpinAuthoringResource("oersted_field", selectedRecord);
  const knownSelected =
    selectedRecord !== null && !isOpaqueSelected
      ? (selectedRecord as KnownSceneOerstedField)
      : null;

  const switcherOptions = useMemo(
    () =>
      items.map((item, idx) => {
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === "string" && rec.id.trim() ? rec.id : "";
        const unsupported = isUnsupportedSpinAuthoringResource(
          "oersted_field",
          item,
        );
        return {
          value: id || `position:${idx}`,
          label: id
            ? unsupported
              ? `${id} (read-only)`
              : id
            : `Opaque Oersted record #${idx + 1}`,
        };
      }),
    [items],
  );

  const initialScope = useMemo(
    () =>
      !pinnedByRef && !localResourceId && selection.objectId
        ? {
            objectId: selection.objectId,
            regionId: extractInitialRegionId(selection),
          }
        : null,
    [localResourceId, pinnedByRef, selection],
  );

  const autoResolvedSource = useMemo(
    () => resolveOerstedCurrentSource(currents, initialScope),
    [currents, initialScope],
  );
  const fallbackCurrentId = useMemo(
    () => currentSourceOptions(currents, "")[0]?.value ?? "",
    [currents],
  );

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
      { id: "crumb-physics", label: "Physics" },
      { id: "crumb-oersted", label: "Oersted Field" },
    ],
    [],
  );

  const draftIdentityKey = pinnedByRef
    ? `pinned:${ref?.type === "oersted-field" ? (ref.oerstedFieldId ?? `pos:${ref.oerstedFieldIndex ?? "none"}`) : selection.nodeId}`
    : `local:${localResourceId || "new"}:${initialScope?.objectId ?? ""}:${initialScope?.regionId ?? ""}:${autoResolvedSource ?? ""}`;

  const serverBaseline = useMemo(
    () =>
      hydrateOerstedPanelDraft(
        knownSelected,
        knownSelected ? null : autoResolvedSource,
        fallbackCurrentId,
        knownSelected !== null,
      ),
    [autoResolvedSource, fallbackCurrentId, knownSelected],
  );

  const effectiveSelection = useMemo<Selection>(
    () => ({
      ...selection,
      nodeId: `${selection.nodeId}::${draftIdentityKey}`,
    }),
    [draftIdentityKey, selection],
  );

  const [liveDraft, setLiveDraft] =
    useState<OerstedFieldPanelDraft>(serverBaseline);
  const [liveDirty, setLiveDirty] = useState<ReadonlySet<string>>(() => new Set());

  const conflictState = useThreeWayConflictState({
    targetKey: draftIdentityKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraft,
    dirtyFields: liveDirty,
    reconcile: reconcileOerstedDraft,
  });

  const capability = useMemo(
    () => evaluateSpinM1Capability(session),
    [session],
  );

  const selectedPathId = knownSelected?.id ?? "";

  const buildValidationReq = useCallback(
    (d: OerstedFieldPanelDraft): TransportValidationRequest => {
      if (sceneRevision === undefined) {
        throw new Error("Oersted field catalog is still loading.");
      }
      const resource = buildOerstedFieldResource(d);
      return knownSelected
        ? {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "oersted_field",
              operation: "replace",
              path_id: selectedPathId || d.id.trim(),
              resource,
            },
          }
        : {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "oersted_field",
              operation: "create",
              resource,
            },
          };
    },
    [knownSelected, sceneRevision, selectedPathId],
  );

  const validationState = useDebouncedTransportValidation({
    enabled: !isOpaqueSelected && targetMissingMessage === null,
    draftSerialized: JSON.stringify(liveDraft),
    draftKey: draftIdentityKey,
    sceneRevision,
    sessionScopeKey: session.sessionScopeKey,
    buildRequest: () => buildValidationReq(liveDraft),
  });

  const handleDelete = useCallback(async () => {
    if (!knownSelected || !selectedPathId || sceneRevision === undefined) return;
    if (!capability.authoring_allowed) {
      throw new Error(capability.reason);
    }
    await executeAuthoringHistoryCommit({
      kernel,
      sessionScopeKey: session.sessionScopeKey,
      label: `Delete Oersted field ${selectedPathId}`,
      submittedRevision: sceneRevision,
      resourceKeys: RESOURCE_KEYS.oerstedField,
      onConflict409: conflictState.markHttpConflict,
      mutate: ({ committedRevision, requestOptions }) =>
        kernel.api.model.deleteOerstedField(
          selectedPathId,
          { base_revision: committedRevision },
          requestOptions,
        ),
    });
    conflictState.clearConflict();
    if (!pinnedByRef) {
      setLocalResourceId("");
    } else {
      kernel.selection.set(
        {
          kind: "model.root",
          label: "Model",
          nodeId: "model:root",
          objectId: null,
          ref: null,
        },
        "inspector",
      );
    }
  }, [
    capability.authoring_allowed,
    capability.reason,
    conflictState,
    kernel,
    knownSelected,
    pinnedByRef,
    sceneRevision,
    selectedPathId,
    session.sessionScopeKey,
  ]);

  const handleApply = useCallback(
    async (draft: OerstedFieldPanelDraft) => {
      if (sceneRevision === undefined) {
        throw new Error("Oersted field catalog is still loading.");
      }
      if (!capability.authoring_allowed) {
        throw new Error(capability.reason);
      }
      const resource = buildOerstedFieldResource(draft);
      const valReq = buildValidationReq(draft);
      await runPreCommitTransportValidation({
        validateTransport: kernel.api.model.validateTransport,
        sessionScopeKey: session.sessionScopeKey,
        request: valReq,
        validationKey: validationState.validationKey,
        setManualValidation: validationState.setManualValidation,
      });

      const commit = await executeAuthoringHistoryCommit({
        kernel,
        sessionScopeKey: session.sessionScopeKey,
        label: knownSelected
          ? `Replace Oersted field ${selectedPathId}`
          : `Create Oersted field ${draft.id.trim()}`,
        submittedRevision: sceneRevision,
        resourceKeys: RESOURCE_KEYS.oerstedField,
        onConflict409: conflictState.markHttpConflict,
        mutate: ({ committedRevision, requestOptions }) => {
          const payload: OerstedFieldMutationRequest = {
            base_revision: committedRevision,
            resource,
          };
          return knownSelected
            ? kernel.api.model.replaceOerstedField(
                selectedPathId,
                payload,
                requestOptions,
              )
            : kernel.api.model.createOerstedField(payload, requestOptions);
        },
      });
      conflictState.clearConflict();

      const committedRec = commit.resource as Record<string, unknown> | undefined;
      const createdId =
        typeof committedRec?.id === "string" && committedRec.id.trim()
          ? committedRec.id
          : draft.id.trim();

      if (!knownSelected && createdId) {
        setLocalResourceId(createdId);
        kernel.selection.set(
          {
            kind: "physics.oersted-field",
            label: createdId,
            nodeId: `model:physics:oersted-fields:${createdId}`,
            objectId: selection.objectId,
            ref: {
              kind: "physics.oersted-field",
              nodeId: `model:physics:oersted-fields:${createdId}`,
              oerstedFieldId: createdId,
              type: "oersted-field",
            },
          },
          "inspector",
        );
      }
      return true;
    },
    [
      buildValidationReq,
      capability.authoring_allowed,
      capability.reason,
      conflictState,
      kernel,
      knownSelected,
      sceneRevision,
      selectedPathId,
      selection.objectId,
      session.sessionScopeKey,
      validationState.setManualValidation,
      validationState.validationKey,
    ],
  );

  const sourceDropdownOptions = useMemo(
    () =>
      currentSourceOptions(currents, liveDraft.source).map((opt) => ({
        value: opt.value,
        label: opt.label.replace(/\s*\(unavailable\)$/i, " (not in scene)"),
      })),
    [currents, liveDraft.source],
  );

  const spec = useMemo<InspectorSpec<OerstedFieldPanelDraft>>(
    () => ({
      id: "physics.oersted-field",
      header: {
        breadcrumbs,
        searchable: true,
        extraMenuActions: [
          {
            id: "refresh-oersted-fields",
            label: "Refresh Oersted fields",
            icon: RefreshCw,
            onSelect: () => {
              oerstedRes.refetch();
              currentRes.refetch();
            },
          },
          {
            id: "view-oersted-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) => {
              try {
                const built = buildOerstedFieldResource(ctx.draft);
                ctx.openCodePreview(
                  `${ctx.draft.id} JSON`,
                  "json",
                  JSON.stringify(built, null, 2),
                );
              } catch {
                ctx.openCodePreview(
                  `${ctx.draft.id} Draft`,
                  "json",
                  JSON.stringify(ctx.draft, null, 2),
                );
              }
            },
          },
        ],
        ...(knownSelected && selectedPathId && capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Delete Oersted Field",
                confirmTitle: () => `Delete "${selectedPathId}"?`,
                confirmDescription:
                  "Deleting this Oersted field removes its Ampère-Biot-Savart magnetic field contribution.",
                onDelete: handleDelete,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Magnet,
        title: (d) => d.id || "Oersted Field",
        kindLabel: "Ampère / Biot-Savart Oersted Field",
        entityId: selectedPathId || undefined,
        statePill: (d) => ({
          tone: !capability.authoring_allowed
            ? "warn"
            : d.exists
              ? "ok"
              : "info",
          label: !capability.authoring_allowed
            ? capability.status
            : d.exists
              ? d.kind === "oersted_cylinder"
                ? "Analytic Wire"
                : "Biot-Savart J_c"
              : "New draft",
        }),
      },
      facts: (d) => {
        const bSurfaceMt =
          computeCylinderSurfaceFieldTesla(d.currentA, d.radiusM) * 1e3;
        return [
          {
            id: "kind",
            label: "Evaluator",
            value:
              d.kind === "oersted_cylinder"
                ? "Cylindrical wire"
                : "From CurrentTransport",
          },
          ...(d.kind === "oersted_cylinder"
            ? [
                {
                  id: "b-surface",
                  label: "B_Oe(R)",
                  value: `${Number(bSurfaceMt.toPrecision(3))} mT`,
                  mono: true,
                },
              ]
            : [
                {
                  id: "source",
                  label: "Source",
                  value: d.source || "Unbound",
                  mono: true,
                },
              ]),
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
        ...(!pinnedByRef
          ? [
              {
                id: "oe-switcher",
                title: "Resource selection",
                icon: Magnet,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <ResourceSwitcherBar
                        disabled={liveDirty.size > 0}
                        label="Resource"
                        newOptionLabel="New Oersted field"
                        options={switcherOptions}
                        value={localResourceId}
                        onChange={setLocalResourceId}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "oe-formulation",
          title: "Oersted field formulation",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              type: "text",
              key: "id",
              label: "Oersted field ID",
              mono: true,
              disabledReason: (d) =>
                d.exists ? "Committed Oersted field IDs are immutable." : null,
              validate: (v) =>
                !v.trim() ? "Oersted field ID is required." : null,
            },
            {
              type: "segmented",
              key: "kind",
              label: "Field model",
              options: [
                { value: "oersted_cylinder", label: "Analytic Wire" },
                { value: "oersted_field", label: "Current Solution" },
              ],
            },
          ],
        },
        {
          id: "oe-current-source",
          title: "Biot-Savart charge current source",
          icon: Zap,
          defaultOpen: true,
          showWhen: (d) => d.kind === "oersted_field",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="oersted-source-select">
                  <span className="text-xs text-[var(--fm-text-muted)]">
                    Current source (source)
                  </span>
                  <Select
                    value={ctx.draft.source || EMPTY_SELECT_SENTINEL}
                    onValueChange={(nextVal) =>
                      ctx.setField(
                        "source",
                        nextVal === EMPTY_SELECT_SENTINEL ? "" : nextVal,
                      )
                    }
                  >
                    <SelectTrigger aria-label="Oersted current source">
                      <SelectValue placeholder="Select charge transport" />
                    </SelectTrigger>
                    <SelectContent align="start" position="popper">
                      <SelectGroup>
                        <SelectItem value={EMPTY_SELECT_SENTINEL}>
                          Select charge transport
                        </SelectItem>
                        {sourceDropdownOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              ),
            },
            {
              type: "readonly",
              label: "Evaluator model",
              mono: true,
              format: (d) => d.model,
            },
          ],
        },
        {
          id: "oe-cylinder",
          title: "Cylindrical conductor geometry & current",
          icon: Compass,
          defaultOpen: true,
          showWhen: (d) => d.kind === "oersted_cylinder",
          rows: [
            {
              type: "quantity",
              key: "currentA",
              label: "Total wire current",
              symbol: "I",
              units: CURRENT_UNITS,
              defaultDisplayUnit: "mA",
            },
            {
              type: "quantity",
              key: "radiusM",
              label: "Wire radius",
              symbol: "R",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
            },
            {
              type: "vector3",
              key: "centerVec",
              label: "Wire axis origin",
              symbol: "r_0",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
            },
            {
              type: "vector3",
              key: "axisVec",
              label: "Current axis unit vector",
              symbol: "e_I",
              axisPresets: true,
              normalizeAction: true,
              validate: (v) =>
                Math.hypot(v[0], v[1], v[2]) === 0
                  ? "Wire axis vector must be non-zero."
                  : null,
            },
            {
              type: "readonly",
              label: "Peak circumferential field at r = R",
              symbol: "B_Oe(R)",
              mono: true,
              format: (d) => {
                const mt =
                  computeCylinderSurfaceFieldTesla(d.currentA, d.radiusM) * 1e3;
                return `${Number(mt.toPrecision(4))} mT (${Number((mt * 1e-3).toPrecision(4))} T)`;
              },
            },
          ],
        },
        {
          id: "oe-time-dependence",
          title: "Temporal waveform (time_dependence)",
          icon: Activity,
          defaultOpen: true,
          showWhen: (d) => d.kind === "oersted_cylinder",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <OerstedTimeDependenceEditor
                  valueJson={ctx.draft.timeDependenceJson}
                  onChangeJson={(nextJson) =>
                    ctx.setField("timeDependenceJson", nextJson)
                  }
                />
              ),
            },
          ],
        },
      ],
      details: () => buildValidationDetails(capability, validationState.validation),
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => !d.exists,
        applyLabel: (d) => (d.exists ? "Apply" : "Create"),
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
        onApply: handleApply,
      },
    }),
    [
      breadcrumbs,
      capability,
      conflictState.conflicts,
      conflictState.hasConflict,
      conflictState.hasRevisionConflict,
      conflictState.rebaseDraft,
      currentRes,
      handleApply,
      handleDelete,
      knownSelected,
      liveDirty.size,
      localResourceId,
      oerstedRes,
      pinnedByRef,
      sceneRevision,
      selectedPathId,
      sourceDropdownOptions,
      switcherOptions,
      targetMissingMessage,
      validationState.buildError,
      validationState.validation,
      validationState.validationError,
    ],
  );

  const controller = useInspectorSpecController(
    spec,
    effectiveSelection,
    serverBaseline,
  );
  if (JSON.stringify(controller.draft) !== JSON.stringify(liveDraft)) {
    setLiveDraft(controller.draft);
  }
  if (controller.dirtyFields.size !== liveDirty.size) {
    setLiveDirty(new Set(controller.dirtyFields));
  }

  if (isOpaqueSelected) {
    const rec = selectedRecord as Record<string, unknown>;
    const opaqueId = typeof rec.id === "string" && rec.id ? rec.id : undefined;
    return (
      <>
        {session.probeElement}
        <ReadOnlyOpaqueInspector
          breadcrumbs={breadcrumbs}
          entityId={opaqueId}
          icon={Magnet}
          kindLabel="Ampère / Biot-Savart Oersted Field"
          payload={selectedRecord}
          selection={selection}
          specId="physics.oersted-field"
          switcherNode={
            !pinnedByRef ? (
              <ResourceSwitcherBar
                label="Resource"
                newOptionLabel="New Oersted field"
                options={switcherOptions}
                value={localResourceId}
                onChange={setLocalResourceId}
              />
            ) : undefined
          }
          heading={opaqueId ?? "Opaque Oersted Field"}
          warningText="Unrecognized Oersted field variant is preserved losslessly and is read-only."
          onRefresh={() => oerstedRes.refetch()}
        />
      </>
    );
  }

  return (
    <TransportTemplateRenderer
      controller={controller}
      selection={effectiveSelection}
      spec={spec}
    >
      {session.probeElement}
    </TransportTemplateRenderer>
  );
}
