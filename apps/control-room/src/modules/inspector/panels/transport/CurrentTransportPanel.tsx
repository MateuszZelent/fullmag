"use client";

import {
  Activity,
  FileCode2,
  Gauge,
  Layers,
  Plus,
  RefreshCw,
  Sliders,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  CurrentTransportMutationRequest,
  KnownSceneCurrentTransport,
  SceneCurrentTransport,
  TransportValidationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useCurrentTransportsResource } from "@/kernel/resources/spinAuthoringResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  useInspectorSpecController,
  type InspectorBreadcrumbItem,
  type InspectorSpec,
} from "../../template";
import {
  CURRENT_DENSITY_UNITS,
  InspectorShortcutCards,
} from "../model-roots/SpecInspectorHost";
import {
  buildCurrentTransport,
  currentTransportClosurePatch,
  currentTransportDraft,
  currentTransportModelPatch,
  currentTransportSupportsPrescribedDensity,
  reconcileTransportDraft,
  resolveTransportRecord,
  transportIdentity,
  transportSelectionKey,
  type CurrentTransportDraft,
  type StructuredCurrentSourceCutDraft,
} from "../TransportAuthoringInspectorModel";
import { SceneTimeEnvelopeEditor } from "./TimeEnvelopeEditors";
import { TransportCollectionEditor } from "./TransportCollectionEditor";
import {
  buildValidationDetails,
  buildValidationNotices,
  computeTransportLockReason,
  evaluateTransportCapability,
  executeAuthoringHistoryCommit,
  extractInitialRegionId,
  isEditableCurrentTransport,
  ReadOnlyOpaqueInspector,
  RESOURCE_KEYS,
  ResourceSwitcherBar,
  runPreCommitTransportValidation,
  TRANSPORT_VALIDATION_VERSION,
  TransportTemplateRenderer,
  useAuthoringSceneData,
  useDebouncedTransportValidation,
  useThreeWayConflictState,
  useTransportSessionContext,
} from "./transportShared";

export interface CurrentTransportPanelDraft extends CurrentTransportDraft {
  exists: boolean;
  currentDensityVec: readonly [number, number, number];
}

function parseDensityTuple(jsonText: string): readonly [number, number, number] {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (
      Array.isArray(parsed) &&
      parsed.length >= 3 &&
      parsed.slice(0, 3).every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      return [parsed[0] as number, parsed[1] as number, parsed[2] as number];
    }
  } catch {
    // Fallback to zero vector on malformed JSON.
  }
  return [0, 0, 0];
}

function createPanelDraft(
  value: KnownSceneCurrentTransport | null,
  initialScope: { objectId: string; regionId?: string | null } | null,
  exists: boolean,
): CurrentTransportPanelDraft {
  const base = currentTransportDraft(value, initialScope);
  return {
    ...base,
    externalLeadPreparation: base.externalLeadPreparation ?? "{}",
    exists,
    currentDensityVec: parseDensityTuple(base.currentDensity),
  };
}

function buildCurrentTransportPreservingCutFrames(
  draft: CurrentTransportPanelDraft,
  existingRecord: KnownSceneCurrentTransport | null,
): SceneCurrentTransport {
  const normalizedDraft: CurrentTransportDraft = {
    ...draft,
    currentDensity: JSON.stringify([
      draft.currentDensityVec[0],
      draft.currentDensityVec[1],
      draft.currentDensityVec[2],
    ]),
  };
  const built = buildCurrentTransport(normalizedDraft);
  if (
    isEditableCurrentTransport(built) &&
    built.structured_current_closure &&
    existingRecord?.structured_current_closure
  ) {
    const prevByCutId = new Map(
      existingRecord.structured_current_closure.source_cuts.map((c) => [
        c.source_cut_id,
        c.plane.coordinate_frame,
      ]),
    );
    built.structured_current_closure = {
      ...built.structured_current_closure,
      source_cuts: built.structured_current_closure.source_cuts.map((cut) => {
        const frame = prevByCutId.get(cut.source_cut_id);
        return frame !== undefined && frame !== null
          ? { ...cut, plane: { ...cut.plane, coordinate_frame: frame } }
          : cut;
      }),
    };
  }
  return built;
}

function makeUniqueClosureSourceCut(
  existingCuts: readonly StructuredCurrentSourceCutDraft[],
  domainJson: string,
): StructuredCurrentSourceCutDraft {
  const usedCutIds = new Set(existingCuts.map((c) => c.sourceCutId.trim()));
  const usedCircuitIds = new Set(existingCuts.map((c) => c.circuitId.trim()));
  const usedDriveIds = new Set(existingCuts.map((c) => c.driveId.trim()));
  let ordinal = existingCuts.length + 1;
  while (
    usedCutIds.has(`cut-${ordinal}`) ||
    usedCutIds.has(`source-cut-${ordinal}`) ||
    usedCircuitIds.has(`loop-${ordinal}`) ||
    usedCircuitIds.has(`circuit-${ordinal}`) ||
    usedDriveIds.has(`drive-${ordinal}`)
  ) {
    ordinal += 1;
  }

  let defaultObjectId = existingCuts[0]?.objectId ?? "";
  let defaultRegionId = existingCuts[0]?.regionId ?? "";
  if (!defaultObjectId) {
    try {
      const parsed: unknown = JSON.parse(domainJson);
      if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") {
        const first = parsed[0] as Record<string, unknown>;
        if (typeof first.object_id === "string") defaultObjectId = first.object_id;
        if (typeof first.region_id === "string") defaultRegionId = first.region_id;
      }
    } catch {
      // Domain editor surfaces invalid JSON separately.
    }
  }

  return {
    rowId: `source:${ordinal}:cut-${ordinal}`,
    sourceCutId: `cut-${ordinal}`,
    circuitId: `loop-${ordinal}`,
    driveId: `drive-${ordinal}`,
    axis: "x",
    normal: "positive_axis",
    offsetM: "0",
    potentialJumpV: "0.1",
    objectId: defaultObjectId,
    regionId: defaultRegionId,
  };
}

export function CurrentTransportInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const scene = useAuthoringSceneData();
  const currentRes = useCurrentTransportsResource();
  const items = useMemo(() => currentRes.data?.items ?? [], [currentRes.data?.items]);
  const sceneRevision = currentRes.data?.scene_revision;

  const ref = selection.ref;
  const isExplicitDraft = Boolean(
    ref && "draft" in ref && (ref as { draft?: boolean }).draft === true,
  );
  const pinnedByRef =
    ref?.type === "current-transport" &&
    !isExplicitDraft &&
    (ref.currentTransportId != null || ref.currentTransportIndex != null);

  const [localSelectionKey, setLocalSelectionKey] = useState("");
  const [prevSelNodeId, setPrevSelNodeId] = useState(selection.nodeId);
  if (prevSelNodeId !== selection.nodeId) {
    setPrevSelNodeId(selection.nodeId);
    setLocalSelectionKey("");
  }

  const initialScope = useMemo(
    () =>
      !pinnedByRef && !localSelectionKey && selection.objectId
        ? {
            objectId: selection.objectId,
            regionId: extractInitialRegionId(selection),
          }
        : null,
    [localSelectionKey, pinnedByRef, selection],
  );

  const selectedRecord = useMemo(() => {
    if (pinnedByRef && ref?.type === "current-transport") {
      return resolveTransportRecord("current_transport", items, {
        resourceId: ref.currentTransportId ?? null,
        resourceIndex: ref.currentTransportIndex ?? null,
      });
    }
    if (!localSelectionKey) return null;
    return resolveTransportRecord("current_transport", items, {
      selectionKey: localSelectionKey,
    });
  }, [items, localSelectionKey, pinnedByRef, ref]);

  const targetMissingMessage =
    (pinnedByRef || Boolean(localSelectionKey)) &&
    currentRes.status === "ready" &&
    selectedRecord === null
      ? "The selected charge transport definition is no longer present in the scene."
      : null;

  const switcherOptions = useMemo(
    () =>
      items.map((item, idx) => {
        const key = transportSelectionKey("current_transport", item, idx);
        const identity = transportIdentity("current_transport", item);
        return {
          value: key,
          label: identity ?? `Opaque charge record #${idx + 1}`,
        };
      }),
    [items],
  );

  const knownSelected =
    selectedRecord && isEditableCurrentTransport(selectedRecord) ? selectedRecord : null;
  const isOpaqueSelected = selectedRecord !== null && knownSelected === null;

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
      { id: "crumb-charge-transport", label: "Charge Transport" },
    ],
    [],
  );

  const draftIdentityKey = pinnedByRef
    ? `pinned:${ref?.type === "current-transport" ? (ref.currentTransportId ?? `pos:${ref.currentTransportIndex ?? "none"}`) : selection.nodeId}`
    : `local:${localSelectionKey || "new"}:${initialScope?.objectId ?? ""}:${initialScope?.regionId ?? ""}`;

  const serverBaseline = useMemo(
    () =>
      createPanelDraft(
        knownSelected,
        knownSelected ? null : initialScope,
        knownSelected !== null,
      ),
    [initialScope, knownSelected],
  );

  const effectiveSelection = useMemo<Selection>(
    () => ({
      ...selection,
      nodeId: `${selection.nodeId}::${draftIdentityKey}`,
    }),
    [draftIdentityKey, selection],
  );

  const reconcilePanelDraft = useCallback(
    (
      server: CurrentTransportPanelDraft,
      local: CurrentTransportPanelDraft,
      base: CurrentTransportPanelDraft,
    ) => {
      const result = reconcileTransportDraft(server, local, base);
      return {
        draft: {
          ...result.draft,
          exists: server.exists,
          currentDensityVec: parseDensityTuple(result.draft.currentDensity),
        },
        conflicts: result.conflicts,
      };
    },
    [],
  );

  // Placeholder controller state bridge: build spec using live state refs/hooks
  const [liveDraftSnapshot, setLiveDraftSnapshot] =
    useState<CurrentTransportPanelDraft>(serverBaseline);
  const [liveDirtyFields, setLiveDirtyFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const conflictState = useThreeWayConflictState({
    targetKey: draftIdentityKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraftSnapshot,
    dirtyFields: liveDirtyFields,
    reconcile: reconcilePanelDraft,
  });

  const candidatePreview = useMemo(() => {
    try {
      return buildCurrentTransportPreservingCutFrames(liveDraftSnapshot, knownSelected);
    } catch {
      return knownSelected;
    }
  }, [knownSelected, liveDraftSnapshot]);

  const capability = useMemo(
    () =>
      evaluateTransportCapability(
        "current_transport",
        candidatePreview,
        scene,
        session,
      ),
    [candidatePreview, scene, session],
  );

  const buildValidationReq = useCallback(
    (d: CurrentTransportPanelDraft): TransportValidationRequest => {
      if (sceneRevision === undefined) {
        throw new Error("Scene revision is loading.");
      }
      const resource = buildCurrentTransportPreservingCutFrames(d, knownSelected);
      return knownSelected
        ? {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "current_transport",
              operation: "replace",
              path_id: knownSelected.name,
              resource,
            },
          }
        : {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "current_transport",
              operation: "create",
              resource,
            },
          };
    },
    [knownSelected, sceneRevision],
  );

  const validationState = useDebouncedTransportValidation({
    enabled: !isOpaqueSelected && targetMissingMessage === null,
    draftSerialized: JSON.stringify(liveDraftSnapshot),
    draftKey: draftIdentityKey,
    sceneRevision,
    sessionScopeKey: session.sessionScopeKey,
    buildRequest: () => buildValidationReq(liveDraftSnapshot),
  });

  const handleDelete = useCallback(async () => {
    if (!knownSelected || sceneRevision === undefined) return;
    if (!capability.authoring_allowed) {
      throw new Error(capability.reason);
    }
    await executeAuthoringHistoryCommit({
      kernel,
      sessionScopeKey: session.sessionScopeKey,
      label: `Delete current transport ${knownSelected.name}`,
      submittedRevision: sceneRevision,
      resourceKeys: RESOURCE_KEYS.currentTransport,
      onConflict409: conflictState.markHttpConflict,
      mutate: ({ committedRevision, requestOptions }) =>
        kernel.api.model.deleteCurrentTransport(
          knownSelected.name,
          { base_revision: committedRevision },
          requestOptions,
        ),
    });
    conflictState.clearConflict();
    if (!pinnedByRef) {
      setLocalSelectionKey("");
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
    session.sessionScopeKey,
  ]);

  const handleApply = useCallback(
    async (draft: CurrentTransportPanelDraft) => {
      if (sceneRevision === undefined) {
        throw new Error("Charge transport catalog is still loading.");
      }
      if (!capability.authoring_allowed) {
        throw new Error(capability.reason);
      }
      const resource = buildCurrentTransportPreservingCutFrames(draft, knownSelected);
      const validationRequest = buildValidationReq(draft);
      await runPreCommitTransportValidation({
        validateTransport: kernel.api.model.validateTransport,
        sessionScopeKey: session.sessionScopeKey,
        request: validationRequest,
        validationKey: validationState.validationKey,
        setManualValidation: validationState.setManualValidation,
      });

      const mutationPayload: CurrentTransportMutationRequest = {
        base_revision: sceneRevision,
        resource,
      };

      const commit = await executeAuthoringHistoryCommit({
        kernel,
        sessionScopeKey: session.sessionScopeKey,
        label: knownSelected
          ? `Replace current transport ${knownSelected.name}`
          : `Create current transport ${draft.name.trim()}`,
        submittedRevision: sceneRevision,
        resourceKeys: RESOURCE_KEYS.currentTransport,
        onConflict409: conflictState.markHttpConflict,
        mutate: ({ committedRevision, requestOptions }) => {
          const req: CurrentTransportMutationRequest = {
            ...mutationPayload,
            base_revision: committedRevision,
          };
          return knownSelected
            ? kernel.api.model.replaceCurrentTransport(
                knownSelected.name,
                req,
                requestOptions,
              )
            : kernel.api.model.createCurrentTransport(req, requestOptions);
        },
      });

      conflictState.clearConflict();
      const createdId =
        isEditableCurrentTransport(commit.resource)
          ? commit.resource.name
          : draft.name.trim();

      if (!knownSelected && createdId) {
        setLocalSelectionKey(`id:${createdId}`);
        kernel.selection.set(
          {
            kind: "physics.current-transport",
            label: createdId,
            nodeId: `model:physics:current-transports:${createdId}`,
            objectId: selection.objectId,
            ref: {
              currentTransportId: createdId,
              kind: "physics.current-transport",
              nodeId: `model:physics:current-transports:${createdId}`,
              type: "current-transport",
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
      selection.objectId,
      session.sessionScopeKey,
      validationState.setManualValidation,
      validationState.validationKey,
    ],
  );

  const spec = useMemo<InspectorSpec<CurrentTransportPanelDraft>>(
    () => ({
      id: "physics.current-transport",
      header: {
        breadcrumbs,
        searchable: true,
        extraMenuActions: [
          {
            id: "refresh-current-transports",
            label: "Refresh charge transports",
            icon: RefreshCw,
            onSelect: () => {
              currentRes.refetch();
            },
          },
          {
            id: "view-current-transport-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) => {
              try {
                const built = buildCurrentTransportPreservingCutFrames(
                  ctx.draft,
                  knownSelected,
                );
                ctx.openCodePreview(
                  `${ctx.draft.name || "current"} JSON`,
                  "json",
                  JSON.stringify(built, null, 2),
                );
              } catch {
                ctx.openCodePreview(
                  `${ctx.draft.name || "current"} Draft`,
                  "json",
                  JSON.stringify(ctx.draft, null, 2),
                );
              }
            },
          },
        ],
        ...(knownSelected && capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Delete Charge Transport",
                confirmTitle: () => `Delete "${knownSelected.name}"?`,
                confirmDescription:
                  "Deleting this charge transport removes its current source. Any spin transport, torque, or Oersted field referencing it will require rebinding.",
                onDelete: handleDelete,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Zap,
        title: (d) => d.name || "Charge Transport",
        kindLabel: "Charge Transport",
        entityId: knownSelected?.name,
        statePill: (d) => ({
          tone: !capability.authoring_allowed
            ? "warn"
            : d.exists
              ? "ok"
              : "info",
          label: !capability.authoring_allowed
            ? capability.status
            : d.exists
              ? d.model === "prescribed_density"
                ? "Prescribed J_c"
                : d.model === "magnetoresistive_poisson"
                  ? "MR Poisson"
                  : "Ohmic Poisson"
              : "New draft",
        }),
      },
      facts: (d) => {
        const jMag = Math.hypot(
          d.currentDensityVec[0],
          d.currentDensityVec[1],
          d.currentDensityVec[2],
        );
        let domainCount = 0;
        let boundaryCount = 0;
        try {
          const dom: unknown = JSON.parse(d.domain);
          if (Array.isArray(dom)) domainCount = dom.length;
          const bc: unknown = JSON.parse(d.boundaries);
          if (Array.isArray(bc)) boundaryCount = bc.length;
        } catch {
          // Handled by collection editor validation.
        }
        return [
          {
            id: "model",
            label: "Model",
            value:
              d.model === "prescribed_density"
                ? "Prescribed J_c"
                : d.model === "magnetoresistive_poisson"
                  ? "MR Poisson"
                  : "Ohmic Poisson",
          },
          {
            id: "coupling",
            label: "Coupling",
            value: d.coupling === "bidirectional" ? "Bidirectional" : "One-way",
          },
          ...(d.model === "prescribed_density"
            ? [
                {
                  id: "j-mag",
                  label: "|J_c|",
                  value: `${Number((jMag / 1e9).toPrecision(3))} GA/m²`,
                  mono: true,
                },
              ]
            : [
                {
                  id: "domain-count",
                  label: "Scopes / BCs",
                  value: `${domainCount} / ${boundaryCount}`,
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
      modeTabs: [
        { id: "model", label: "Model & Domain" },
        { id: "electrodes", label: "Boundaries & Closure" },
        { id: "solver", label: "Solver & Leads" },
      ],
      sections: [
        ...(!pinnedByRef
          ? [
              {
                id: "ct-resource-switcher",
                title: "Resource selection",
                icon: Zap,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <ResourceSwitcherBar
                        disabled={liveDirtyFields.size > 0}
                        label="Resource"
                        newOptionLabel="New charge transport"
                        options={switcherOptions}
                        value={localSelectionKey}
                        onChange={setLocalSelectionKey}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "ct-model",
          title: "Charge transport formulation",
          icon: Zap,
          defaultOpen: true,
          modeTabId: "model",
          rows: [
            {
              type: "text",
              key: "name",
              label: "Transport source ID",
              mono: true,
              disabledReason: (d) =>
                d.exists
                  ? "Committed charge transport IDs are immutable to preserve downstream torque and spin references."
                  : null,
              validate: (v) =>
                !v.trim() ? "Enter a non-empty charge transport ID." : null,
            },
            {
              type: "select",
              key: "model",
              label: "Conduction model",
              disabledReason: (d) =>
                d.structuredCurrentClosure
                  ? "Disable closed-geometry current closure before changing the conduction model."
                  : null,
              options: [
                {
                  value: "prescribed_density",
                  label: "Prescribed uniform current density J_c",
                  disabledReason: !currentTransportSupportsPrescribedDensity(
                    liveDraftSnapshot,
                  )
                    ? "Prescribed density supports at most one object-level domain without region sub-scopes."
                    : undefined,
                },
                {
                  value: "ohmic_poisson",
                  label: "Ohmic Poisson (∇·(σ∇V) = 0)",
                },
                {
                  value: "magnetoresistive_poisson",
                  label: "Magnetoresistive Poisson (AMR / AHE tensor)",
                },
              ],
            },
            {
              type: "select",
              key: "coupling",
              label: "Charge-magnetization coupling",
              disabledReason: (d) =>
                d.structuredCurrentClosure
                  ? "Structured current closure requires one-way coupling."
                  : null,
              options: [
                { value: "one_way", label: "One-way (steady / uncoupled charge)" },
                {
                  value: "bidirectional",
                  label: "Bidirectional (coupled magnetoresistive M2)",
                },
              ],
            },
            {
              type: "vector3",
              key: "currentDensityVec",
              label: "Prescribed current density",
              symbol: "J_c",
              units: CURRENT_DENSITY_UNITS,
              defaultDisplayUnit: "GA/m²",
              axisPresets: true,
              showWhen: (d) => d.model === "prescribed_density",
            },
            {
              type: "select",
              key: "gauge",
              label: "Potential gauge fixing",
              showWhen: (d) => d.model !== "prescribed_density",
              options: [
                {
                  value: "dirichlet_reference",
                  label: "Dirichlet reference (ground electrode V = 0)",
                },
                {
                  value: "zero_mean",
                  label: "Zero-mean potential (⟨V⟩_Ω = 0)",
                },
                {
                  value: "terminal_reference",
                  label: "Terminal reference potential",
                },
              ],
            },
          ],
        },
        {
          id: "ct-domain-materials",
          title: "Conduction domain & per-region materials",
          icon: Layers,
          defaultOpen: true,
          modeTabId: "model",
          showWhen: (d) => d.model !== "prescribed_density",
          rows: [
            {
              type: "custom",
              wide: true,
              label: "Conduction domain",
              render: (ctx) => (
                <TransportCollectionEditor
                  collection="domain"
                  disabled={Boolean(ctx.draft.structuredCurrentClosure)}
                  family="current_transport"
                  scene={scene}
                  value={ctx.draft.domain}
                  onChange={(nextDomain) => ctx.setField("domain", nextDomain)}
                />
              ),
            },
            {
              type: "custom",
              wide: true,
              label: "Per-region charge materials",
              render: (ctx) => (
                <TransportCollectionEditor
                  collection="materials"
                  family="current_transport"
                  scene={scene}
                  value={ctx.draft.materials}
                  onChange={(nextMaterials) =>
                    ctx.setField("materials", nextMaterials)
                  }
                />
              ),
            },
          ],
        },
        {
          id: "ct-time-envelope",
          title: "Temporal drive envelope (time_envelope)",
          icon: Activity,
          defaultOpen: true,
          modeTabId: "model",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <SceneTimeEnvelopeEditor
                  label="Current time envelope"
                  valueJson={ctx.draft.timeEnvelope}
                  onChangeJson={(nextJson) =>
                    ctx.setField("timeEnvelope", nextJson)
                  }
                />
              ),
            },
          ],
        },
        {
          id: "ct-boundaries",
          title: "Charge boundary conditions (boundaries)",
          icon: Gauge,
          defaultOpen: true,
          modeTabId: "electrodes",
          showWhen: (d) => d.model !== "prescribed_density",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <TransportCollectionEditor
                  collection="boundaries"
                  family="current_transport"
                  scene={scene}
                  value={ctx.draft.boundaries}
                  onChange={(nextBoundaries) =>
                    ctx.setField("boundaries", nextBoundaries)
                  }
                />
              ),
            },
          ],
        },
        {
          id: "ct-structured-closure",
          title: "Closed-geometry current closure",
          icon: Layers,
          defaultOpen: true,
          modeTabId: "electrodes",
          showWhen: (d) => d.model !== "prescribed_density",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const closure = ctx.draft.structuredCurrentClosure;
                const enabled = closure !== null;
                return (
                  <div className="flex flex-col gap-2.5" data-slot="ct-closure-section">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-[var(--fm-text)]">
                        Closed-geometry current closure
                      </span>
                      <Switch
                        aria-label="Closed-geometry current closure"
                        checked={enabled}
                        onCheckedChange={(checked) => {
                          const patch = currentTransportClosurePatch(
                            ctx.draft,
                            checked,
                          );
                          ctx.patchDraft(patch);
                        }}
                      />
                    </div>

                    {closure ? (
                      <div className="flex flex-col gap-2.5">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-[var(--fm-text-muted)]">
                            Closure ID
                          </span>
                          <Input
                            aria-label="Closure ID"
                            className="font-mono"
                            value={closure.closureId}
                            onChange={(e) =>
                              ctx.setField("structuredCurrentClosure", {
                                ...closure,
                                closureId: e.target.value,
                              })
                            }
                          />
                        </div>

                        {ctx.draft.exists ? (
                          <InspectorShortcutCards
                            items={[
                              {
                                id: closure.closureId,
                                title: closure.closureId || "Structured closure",
                                subtitle: `${closure.sourceCuts.length} source cut(s) · Open dedicated closure inspector`,
                                badge: "Closed loop",
                                selection: {
                                  kind: "physics.structured-current-closure",
                                  label: closure.closureId,
                                  nodeId: `model:physics:current-transports:${ctx.draft.name}:closure`,
                                  objectId: selection.objectId,
                                  ref: {
                                    currentTransportId: ctx.draft.name,
                                    kind: "physics.structured-current-closure",
                                    nodeId: `model:physics:current-transports:${ctx.draft.name}:closure`,
                                    structuredCurrentClosureId: closure.closureId,
                                    type: "structured-current-closure",
                                  },
                                },
                              },
                            ]}
                            onSelect={ctx.selectNode}
                          />
                        ) : null}

                        {closure.sourceCuts.map((cut, cutIdx) => (
                          <div
                            key={cut.rowId}
                            className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium text-[var(--fm-text)]">
                                Source cut {cutIdx + 1} ({cut.sourceCutId})
                              </span>
                              {closure.sourceCuts.length > 1 ? (
                                <Button
                                  aria-label={`Remove source cut ${cutIdx + 1}`}
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                  onClick={() =>
                                    ctx.setField("structuredCurrentClosure", {
                                      ...closure,
                                      sourceCuts: closure.sourceCuts.filter(
                                        (_, i) => i !== cutIdx,
                                      ),
                                    })
                                  }
                                >
                                  <Trash2 aria-hidden="true" size={12} />
                                  <span>Remove source cut</span>
                                </Button>
                              ) : null}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="flex flex-col gap-1">
                                <span className="text-xs text-[var(--fm-text-muted)]">
                                  Source cut ID
                                </span>
                                <Input
                                  aria-label={`Source cut ID ${cutIdx + 1}`}
                                  className="font-mono"
                                  value={cut.sourceCutId}
                                  onChange={(e) =>
                                    ctx.setField("structuredCurrentClosure", {
                                      ...closure,
                                      sourceCuts: closure.sourceCuts.map((c, i) =>
                                        i === cutIdx
                                          ? { ...c, sourceCutId: e.target.value }
                                          : c,
                                      ),
                                    })
                                  }
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-xs text-[var(--fm-text-muted)]">
                                  Circuit ID
                                </span>
                                <Input
                                  aria-label={`Circuit ID ${cutIdx + 1}`}
                                  className="font-mono"
                                  value={cut.circuitId}
                                  onChange={(e) =>
                                    ctx.setField("structuredCurrentClosure", {
                                      ...closure,
                                      sourceCuts: closure.sourceCuts.map((c, i) =>
                                        i === cutIdx
                                          ? { ...c, circuitId: e.target.value }
                                          : c,
                                      ),
                                    })
                                  }
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-xs text-[var(--fm-text-muted)]">
                                  Drive ID
                                </span>
                                <Input
                                  aria-label={`Drive ID ${cutIdx + 1}`}
                                  className="font-mono"
                                  value={cut.driveId}
                                  onChange={(e) =>
                                    ctx.setField("structuredCurrentClosure", {
                                      ...closure,
                                      sourceCuts: closure.sourceCuts.map((c, i) =>
                                        i === cutIdx
                                          ? { ...c, driveId: e.target.value }
                                          : c,
                                      ),
                                    })
                                  }
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-xs text-[var(--fm-text-muted)]">
                                  Potential jump ΔV (V)
                                </span>
                                <Input
                                  aria-label={`Potential jump ${cutIdx + 1}`}
                                  className="font-mono"
                                  value={cut.potentialJumpV}
                                  onChange={(e) =>
                                    ctx.setField("structuredCurrentClosure", {
                                      ...closure,
                                      sourceCuts: closure.sourceCuts.map((c, i) =>
                                        i === cutIdx
                                          ? { ...c, potentialJumpV: e.target.value }
                                          : c,
                                      ),
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </div>
                        ))}

                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const nextCut = makeUniqueClosureSourceCut(
                              closure.sourceCuts,
                              ctx.draft.domain,
                            );
                            ctx.setField("structuredCurrentClosure", {
                              ...closure,
                              sourceCuts: [...closure.sourceCuts, nextCut],
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Add source cut</span>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "ct-solver-leads",
          title: "Linear solver, legacy scope & RT0 conservation",
          icon: Sliders,
          defaultOpen: true,
          modeTabId: "solver",
          rows: [
            {
              type: "text",
              key: "solverEngine",
              label: "Solver engine",
              mono: true,
              showWhen: (d) => d.model !== "prescribed_density",
            },
            {
              type: "text",
              key: "solverRelativeTolerance",
              label: "Relative tolerance",
              mono: true,
              showWhen: (d) => d.model !== "prescribed_density",
              validate: (v) =>
                !v.trim() || !Number.isFinite(Number(v))
                  ? "Relative tolerance must be finite."
                  : null,
            },
            {
              type: "text",
              key: "solverAbsoluteTolerance",
              label: "Absolute tolerance",
              mono: true,
              showWhen: (d) => d.model !== "prescribed_density",
              validate: (v) =>
                !v.trim() || !Number.isFinite(Number(v))
                  ? "Absolute tolerance must be finite."
                  : null,
            },
            {
              type: "text",
              key: "solverMaxIterations",
              label: "Maximum iterations",
              mono: true,
              showWhen: (d) => d.model !== "prescribed_density",
              validate: (v) => {
                const n = Number(v);
                return !Number.isInteger(n) || n <= 0
                  ? "Maximum iterations must be a positive integer."
                  : null;
              },
            },
            {
              type: "text",
              key: "solverOperatorVersion",
              label: "Operator version",
              mono: true,
              showWhen: (d) => d.model !== "prescribed_density",
            },
            {
              type: "text",
              key: "solverPhysicalResidualVersion",
              label: "Physical residual version",
              mono: true,
              showWhen: (d) => d.model !== "prescribed_density",
            },
            {
              type: "text",
              key: "solveRegion",
              label: "Legacy solve region (solve_region)",
              mono: true,
              placeholder: "Optional legacy object/region ID",
            },
            {
              type: "text",
              key: "conductivity",
              label: "Legacy scalar conductivity (S/m)",
              mono: true,
              placeholder: "Optional legacy conductivity_s_per_m",
              showWhen: (d) => d.model !== "prescribed_density",
              validate: (v) =>
                v.trim() && !Number.isFinite(Number(v))
                  ? "Conductivity must be finite."
                  : null,
            },
            {
              type: "expression",
              key: "externalLeadPreparation",
              label: "External lead preparation (JSON)",
              placeholder: '{"mode":"extend_contacts"}',
              validate: (v) => {
                const raw = (v ?? "").trim();
                if (!raw || raw === "{}") return null;
                try {
                  const parsed: unknown = JSON.parse(raw);
                  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                    ? null
                    : "External lead preparation must be a JSON object.";
                } catch {
                  return "External lead preparation must be valid JSON.";
                }
              },
            },
            {
              type: "expression",
              key: "conservativeCurrentView",
              label: "Conservative RT0 current view (JSON)",
              placeholder: "{}",
              showWhen: (d) => !d.structuredCurrentClosure,
              validate: (v) => {
                const raw = v.trim();
                if (!raw || raw === "{}") return null;
                try {
                  const parsed: unknown = JSON.parse(raw);
                  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                    ? null
                    : "Conservative current view must be a JSON object.";
                } catch {
                  return "Conservative current view must be valid JSON.";
                }
              },
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
      liveDirtyFields.size,
      liveDraftSnapshot,
      localSelectionKey,
      pinnedByRef,
      scene,
      sceneRevision,
      selection.objectId,
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

  // Sync controller draft & dirtyFields into live observers without extra render loops
  if (
    JSON.stringify(controller.draft) !== JSON.stringify(liveDraftSnapshot)
  ) {
    setLiveDraftSnapshot(controller.draft);
  }
  if (controller.dirtyFields.size !== liveDirtyFields.size) {
    setLiveDirtyFields(new Set(controller.dirtyFields));
  }

  const handleCoupledChange = useCallback(
    <K extends keyof CurrentTransportPanelDraft & string>(
      key: K,
      value: CurrentTransportPanelDraft[K],
      current: CurrentTransportPanelDraft,
    ): Partial<CurrentTransportPanelDraft> | null => {
      if (key === "model") {
        const nextModel = value as CurrentTransportPanelDraft["model"];
        const patch = currentTransportModelPatch(current, nextModel);
        return {
          ...patch,
          ...(nextModel !== "magnetoresistive_poisson" &&
          current.coupling === "bidirectional"
            ? { coupling: "one_way" }
            : {}),
        };
      }
      if (key === "coupling") {
        const nextCoupling = value as CurrentTransportPanelDraft["coupling"];
        if (nextCoupling === "bidirectional") {
          return {
            coupling: "bidirectional",
            model: "magnetoresistive_poisson",
            solverEngine:
              current.solverEngine === "cg" ? "block_gmres" : current.solverEngine,
            solverOperatorVersion:
              current.solverOperatorVersion === "fv_charge_harmonic_v1"
                ? "fdm_coupled_charge_spin_fv_block_gmres.v1"
                : current.solverOperatorVersion,
            solverPhysicalResidualVersion:
              current.solverPhysicalResidualVersion ===
              "charge_balance_integrated_l2.v1"
                ? "transport_balance_integrated_l2.v1"
                : current.solverPhysicalResidualVersion,
          };
        }
        return { coupling: "one_way" };
      }
      if (key === "currentDensityVec") {
        const vec = value as readonly [number, number, number];
        return {
          currentDensityVec: vec,
          currentDensity: JSON.stringify([vec[0], vec[1], vec[2]]),
        };
      }
      return null;
    },
    [],
  );

  if (isOpaqueSelected) {
    return (
      <>
        {session.probeElement}
        <ReadOnlyOpaqueInspector
          breadcrumbs={breadcrumbs}
          entityId={transportIdentity("current_transport", selectedRecord!) ?? undefined}
          icon={Zap}
          kindLabel="Charge Transport"
          payload={selectedRecord}
          selection={selection}
          specId="physics.current-transport"
          switcherNode={
            !pinnedByRef ? (
              <ResourceSwitcherBar
                label="Resource"
                newOptionLabel="New charge transport"
                options={switcherOptions}
                value={localSelectionKey}
                onChange={setLocalSelectionKey}
              />
            ) : undefined
          }
          heading={
            transportIdentity("current_transport", selectedRecord!) ??
            "Opaque Charge Transport"
          }
          warningText="Unrecognized transport variant is preserved losslessly and is read-only."
          onRefresh={() => currentRes.refetch()}
        />
      </>
    );
  }

  return (
    <TransportTemplateRenderer
      controller={controller}
      selection={effectiveSelection}
      spec={spec}
      onCoupledFieldChange={handleCoupledChange}
    >
      {session.probeElement}
    </TransportTemplateRenderer>
  );
}
