"use client";

import {
  Cpu,
  FileCode2,
  GitBranch,
  Layers,
  Plus,
  RefreshCw,
  Sliders,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  KnownSceneSpinTransport,
  SceneSpinTransport,
  SpinTransportMutationRequest,
  TransportValidationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  useCurrentTransportsResource,
  useSpinTransportsResource,
} from "@/kernel/resources/spinAuthoringResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
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
import { InspectorShortcutCards } from "../model-roots/SpecInspectorHost";
import {
  buildSpinTransport,
  reconcileTransportDraft,
  resolveTransportRecord,
  spinTransportDraft,
  transportIdentity,
  transportSelectionKey,
  type SpinTransportDraft,
} from "../TransportAuthoringInspectorModel";
import { TransportCollectionEditor } from "./TransportCollectionEditor";
import {
  buildValidationDetails,
  buildValidationNotices,
  computeTransportLockReason,
  EMPTY_SELECT_SENTINEL,
  evaluateTransportCapability,
  executeAuthoringHistoryCommit,
  extractInitialRegionId,
  isEditableCurrentTransport,
  isEditableSpinTransport,
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

export interface SpinTransportPanelDraft extends SpinTransportDraft {
  exists: boolean;
}

function createSpinPanelDraft(
  value: KnownSceneSpinTransport | null,
  initialScope: { objectId: string; regionId?: string | null } | null,
  exists: boolean,
  fallbackCurrentSource = "current",
): SpinTransportPanelDraft {
  const base = spinTransportDraft(value, initialScope);
  return {
    ...base,
    currentSourceId: value?.current_source_id ?? fallbackCurrentSource,
    exists,
  };
}

function parseInterfaceSummaries(interfacesJson: string): Array<{
  id: string;
  kind: string;
  label: string;
}> {
  try {
    const parsed: unknown = JSON.parse(interfacesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry, idx) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const rec = entry as Record<string, unknown>;
      const id =
        typeof rec.id === "string" && rec.id.trim()
          ? rec.id
          : `interface-${idx + 1}`;
      const kind = typeof rec.kind === "string" ? rec.kind : "custom";
      const readScope = (side: unknown): string => {
        if (!side || typeof side !== "object" || Array.isArray(side)) return "";
        const s = side as Record<string, unknown>;
        const obj = typeof s.object_id === "string" ? s.object_id : "";
        const reg = typeof s.region_id === "string" ? s.region_id : "";
        return reg ? `${obj}/${reg}` : obj;
      };
      const left = readScope(rec.normal_side ?? rec.side_a) || "Side A";
      const right = readScope(rec.ferromagnet_side ?? rec.side_b) || "Side B";
      return [{ id, kind, label: `${left} ↔ ${right}` }];
    });
  } catch {
    return [];
  }
}

function parseReciprocalObject(jsonText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Handled by validation.
  }
  return {};
}

export function SpinTransportInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const scene = useAuthoringSceneData();
  const spinRes = useSpinTransportsResource();
  const currentRes = useCurrentTransportsResource();

  const items = useMemo(() => spinRes.data?.items ?? [], [spinRes.data?.items]);
  const currentItems = useMemo(
    () => currentRes.data?.items ?? [],
    [currentRes.data?.items],
  );
  const sceneRevision = spinRes.data?.scene_revision;

  const availableCurrentIds = useMemo(
    () =>
      Array.from(
        new Set(
          currentItems.flatMap((c) =>
            isEditableCurrentTransport(c) && c.name.trim() ? [c.name.trim()] : [],
          ),
        ),
      ),
    [currentItems],
  );

  const ref = selection.ref;
  const pinnedByRef =
    ref?.type === "spin-transport" &&
    !ref.draft &&
    (ref.spinTransportId != null || ref.spinTransportIndex != null);

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
    if (pinnedByRef && ref?.type === "spin-transport") {
      return resolveTransportRecord("spin_transport", items, {
        resourceId: ref.spinTransportId ?? null,
        resourceIndex: ref.spinTransportIndex ?? null,
      });
    }
    if (!localSelectionKey) return null;
    return resolveTransportRecord("spin_transport", items, {
      selectionKey: localSelectionKey,
    });
  }, [items, localSelectionKey, pinnedByRef, ref]);

  const targetMissingMessage =
    (pinnedByRef || Boolean(localSelectionKey)) &&
    spinRes.status === "ready" &&
    selectedRecord === null
      ? "The selected spin transport definition is no longer present in the scene."
      : null;

  const switcherOptions = useMemo(
    () =>
      items.map((item, idx) => {
        const key = transportSelectionKey("spin_transport", item, idx);
        const identity = transportIdentity("spin_transport", item);
        return {
          value: key,
          label: identity ?? `Opaque spin record #${idx + 1}`,
        };
      }),
    [items],
  );

  const knownSelected =
    selectedRecord && isEditableSpinTransport(selectedRecord) ? selectedRecord : null;
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
      { id: "crumb-spin-transport", label: "Spin Transport" },
    ],
    [],
  );

  const draftIdentityKey = pinnedByRef
    ? `pinned:${ref?.type === "spin-transport" ? (ref.spinTransportId ?? `pos:${ref.spinTransportIndex ?? "none"}`) : selection.nodeId}`
    : `local:${localSelectionKey || "new"}:${initialScope?.objectId ?? ""}:${initialScope?.regionId ?? ""}`;

  const defaultCurrentSource = availableCurrentIds[0] ?? "current";
  const serverBaseline = useMemo(
    () =>
      createSpinPanelDraft(
        knownSelected,
        knownSelected ? null : initialScope,
        knownSelected !== null,
        defaultCurrentSource,
      ),
    [defaultCurrentSource, initialScope, knownSelected],
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
      server: SpinTransportPanelDraft,
      local: SpinTransportPanelDraft,
      base: SpinTransportPanelDraft,
    ) => {
      const res = reconcileTransportDraft(server, local, base);
      return {
        draft: { ...res.draft, exists: server.exists },
        conflicts: res.conflicts,
      };
    },
    [],
  );

  const [liveDraft, setLiveDraft] =
    useState<SpinTransportPanelDraft>(serverBaseline);
  const [liveDirty, setLiveDirty] = useState<ReadonlySet<string>>(() => new Set());

  const conflictState = useThreeWayConflictState({
    targetKey: draftIdentityKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraft,
    dirtyFields: liveDirty,
    reconcile: reconcilePanelDraft,
  });

  const candidatePreview = useMemo<SceneSpinTransport | null>(() => {
    try {
      return buildSpinTransport(liveDraft);
    } catch {
      return knownSelected;
    }
  }, [knownSelected, liveDraft]);

  const capability = useMemo(
    () =>
      evaluateTransportCapability(
        "spin_transport",
        candidatePreview,
        scene,
        session,
      ),
    [candidatePreview, scene, session],
  );

  const buildValidationReq = useCallback(
    (d: SpinTransportPanelDraft): TransportValidationRequest => {
      if (sceneRevision === undefined) {
        throw new Error("Scene revision is loading.");
      }
      const resource = buildSpinTransport(d);
      return knownSelected
        ? {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_transport",
              operation: "replace",
              path_id: knownSelected.id,
              resource,
            },
          }
        : {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_transport",
              operation: "create",
              resource,
            },
          };
    },
    [knownSelected, sceneRevision],
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
    if (!knownSelected || sceneRevision === undefined) return;
    if (!capability.authoring_allowed) {
      throw new Error(capability.reason);
    }
    await executeAuthoringHistoryCommit({
      kernel,
      sessionScopeKey: session.sessionScopeKey,
      label: `Delete spin transport ${knownSelected.id}`,
      submittedRevision: sceneRevision,
      resourceKeys: RESOURCE_KEYS.spinTransport,
      onConflict409: conflictState.markHttpConflict,
      mutate: ({ committedRevision, requestOptions }) =>
        kernel.api.model.deleteSpinTransport(
          knownSelected.id,
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
    async (draft: SpinTransportPanelDraft) => {
      if (sceneRevision === undefined) {
        throw new Error("Spin transport catalog is still loading.");
      }
      if (!capability.authoring_allowed) {
        throw new Error(capability.reason);
      }
      const resource = buildSpinTransport(draft);
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
          ? `Replace spin transport ${knownSelected.id}`
          : `Create spin transport ${draft.id.trim()}`,
        submittedRevision: sceneRevision,
        resourceKeys: RESOURCE_KEYS.spinTransport,
        onConflict409: conflictState.markHttpConflict,
        mutate: ({ committedRevision, requestOptions }) => {
          const payload: SpinTransportMutationRequest = {
            base_revision: committedRevision,
            resource,
          };
          return knownSelected
            ? kernel.api.model.replaceSpinTransport(
                knownSelected.id,
                payload,
                requestOptions,
              )
            : kernel.api.model.createSpinTransport(payload, requestOptions);
        },
      });

      conflictState.clearConflict();
      const createdId = isEditableSpinTransport(commit.resource)
        ? commit.resource.id
        : draft.id.trim();

      if (!knownSelected && createdId) {
        setLocalSelectionKey(`id:${createdId}`);
        kernel.selection.set(
          {
            kind: "physics.spin-transport",
            label: createdId,
            nodeId: `model:physics:spin-transports:${createdId}`,
            objectId: selection.objectId,
            ref: {
              kind: "physics.spin-transport",
              nodeId: `model:physics:spin-transports:${createdId}`,
              spinTransportId: createdId,
              type: "spin-transport",
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

  const gpuDisabledReason =
    session.capabilities?.gpu && !session.capabilities.gpu.authoring_allowed
      ? session.capabilities.gpu.reason || "GPU spin transport authoring is disabled."
      : undefined;

  const singlePrecisionDisabledReason =
    session.capabilities?.single_precision &&
    !session.capabilities.single_precision.authoring_allowed
      ? session.capabilities.single_precision.reason ||
        "Single-precision spin transport authoring is disabled."
      : undefined;

  const spec = useMemo<InspectorSpec<SpinTransportPanelDraft>>(
    () => ({
      id: "physics.spin-transport",
      header: {
        breadcrumbs,
        searchable: true,
        extraMenuActions: [
          {
            id: "refresh-spin-transports",
            label: "Refresh spin transports",
            icon: RefreshCw,
            onSelect: () => {
              spinRes.refetch();
              currentRes.refetch();
            },
          },
          {
            id: "view-spin-transport-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) => {
              try {
                const built = buildSpinTransport(ctx.draft);
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
        ...(knownSelected && capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Delete Spin Transport",
                confirmTitle: () => `Delete "${knownSelected.id}"?`,
                confirmDescription:
                  "Deleting this spin transport removes its 3D spin accumulation solve and all owned HM/FM spin interfaces.",
                onDelete: handleDelete,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: GitBranch,
        title: (d) => d.id || "Spin Transport",
        kindLabel: "3D Spin Drift-Diffusion",
        entityId: knownSelected?.id,
        statePill: (d) => ({
          tone: !capability.authoring_allowed
            ? "warn"
            : d.exists
              ? "ok"
              : "info",
          label: !capability.authoring_allowed
            ? capability.status
            : d.exists
              ? d.mode === "transient"
                ? "Transient M3"
                : "Steady SDD"
              : "New draft",
        }),
      },
      facts: (d) => {
        const ifaceCount = parseInterfaceSummaries(d.interfaces).length;
        return [
          {
            id: "source",
            label: "Charge source",
            value: d.currentSourceId || "Unbound",
            mono: true,
          },
          {
            id: "mode",
            label: "Mode",
            value: d.mode === "transient" ? "Transient" : "Steady",
          },
          {
            id: "ifaces",
            label: "Interfaces",
            value: String(ifaceCount),
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
      modeTabs: [
        { id: "layers", label: "Layers & Materials" },
        { id: "interfaces", label: "Interfaces & BC" },
        { id: "solver", label: "Execution & Solver" },
      ],
      sections: [
        ...(!pinnedByRef
          ? [
              {
                id: "st-resource-switcher",
                title: "Resource selection",
                icon: GitBranch,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <ResourceSwitcherBar
                        disabled={liveDirty.size > 0}
                        label="Resource"
                        newOptionLabel="New spin transport"
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
          id: "st-identity",
          title: "Spin solve identity, mode & charge source",
          icon: GitBranch,
          defaultOpen: true,
          modeTabId: "layers",
          rows: [
            {
              type: "text",
              key: "id",
              label: "Spin transport ID",
              mono: true,
              disabledReason: (d) =>
                d.exists ? "Committed spin transport IDs are immutable." : null,
              validate: (v) =>
                !v.trim() ? "Spin transport ID is required." : null,
            },
            {
              type: "text",
              key: "schemaVersion",
              label: "Schema version",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Schema version is required." : null,
            },
            {
              type: "segmented",
              key: "mode",
              label: "Spin dynamics mode",
              options: [
                { value: "steady", label: "Steady-state" },
                { value: "transient", label: "Transient (M3)" },
              ],
            },
            {
              type: "custom",
              wide: true,
              label: "Driving charge transport",
              render: (ctx) => {
                const curId = ctx.draft.currentSourceId.trim();
                const isMissing =
                  Boolean(curId) && !availableCurrentIds.includes(curId);
                return (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      Driving charge transport (current_source_id)
                    </span>
                    <Select
                      value={curId || EMPTY_SELECT_SENTINEL}
                      onValueChange={(nextVal) =>
                        ctx.setField(
                          "currentSourceId",
                          nextVal === EMPTY_SELECT_SENTINEL ? "" : nextVal,
                        )
                      }
                    >
                      <SelectTrigger aria-label="Current source ID">
                        <SelectValue placeholder="Select charge transport" />
                      </SelectTrigger>
                      <SelectContent align="start" position="popper">
                        <SelectGroup>
                          <SelectItem value={EMPTY_SELECT_SENTINEL}>
                            Select charge transport
                          </SelectItem>
                          {isMissing ? (
                            <SelectItem value={curId}>
                              {curId} (not in scene)
                            </SelectItem>
                          ) : null}
                          {availableCurrentIds.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label="Current source ID text"
                      className="font-mono"
                      placeholder="Charge transport source ID"
                      value={ctx.draft.currentSourceId}
                      onChange={(e) =>
                        ctx.setField("currentSourceId", e.target.value)
                      }
                    />
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "st-domain-materials",
          title: "Multi-layer spin domain & material parameters",
          icon: Layers,
          defaultOpen: true,
          modeTabId: "layers",
          rows: [
            {
              type: "custom",
              wide: true,
              label: "Spin solve domain",
              render: (ctx) => (
                <TransportCollectionEditor
                  collection="domain"
                  family="spin_transport"
                  scene={scene}
                  spinMode={ctx.draft.mode}
                  value={ctx.draft.domain}
                  onChange={(nextDomain) => ctx.setField("domain", nextDomain)}
                />
              ),
            },
            {
              type: "custom",
              wide: true,
              label: "Per-layer spin transport materials",
              render: (ctx) => (
                <TransportCollectionEditor
                  collection="materials"
                  family="spin_transport"
                  scene={scene}
                  spinMode={ctx.draft.mode}
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
          id: "st-interfaces",
          title: "Owned HM/FM spin interfaces",
          icon: GitBranch,
          defaultOpen: true,
          modeTabId: "interfaces",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const summaries = parseInterfaceSummaries(ctx.draft.interfaces);
                return (
                  <div className="flex flex-col gap-2.5" data-slot="st-interfaces-list">
                    {summaries.length > 0 ? (
                      <InspectorShortcutCards
                        items={summaries.map((item) => ({
                          id: item.id,
                          title: `${item.id} · ${item.label}`,
                          subtitle: item.kind.replace(/_/g, " "),
                          badge:
                            item.kind === "transparent"
                              ? "Transparent"
                              : "G↑↓ Mixing",
                          selection: {
                            kind: "physics.spin-interface",
                            label: item.id,
                            nodeId: `model:physics:spin-interface:${ctx.draft.id}:${item.id}`,
                            objectId: selection.objectId,
                            ref: {
                              kind: "physics.spin-interface",
                              nodeId: `model:physics:spin-interface:${ctx.draft.id}:${item.id}`,
                              spinInterfaceId: item.id,
                              spinInterfaceOwnerId: ctx.draft.id,
                              type: "spin-interface",
                            },
                          },
                        }))}
                        onSelect={ctx.selectNode}
                      />
                    ) : (
                      <p className="text-xs text-[var(--fm-text-muted)]">
                        No spin interfaces authored on this solve.
                      </p>
                    )}

                    <Button
                      disabled={!ctx.draft.exists}
                      disabledReason={
                        !ctx.draft.exists
                          ? "Commit the owning spin transport before authoring its interfaces."
                          : undefined
                      }
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.selectNode({
                          kind: "physics.spin-interface",
                          label: "New HM/FM interface",
                          nodeId: `model:physics:spin-interface:${ctx.draft.id}:draft`,
                          objectId: selection.objectId,
                          ref: {
                            draft: true,
                            kind: "physics.spin-interface",
                            nodeId: `model:physics:spin-interface:${ctx.draft.id}:draft`,
                            spinInterfaceOwnerId: ctx.draft.id,
                            type: "spin-interface",
                          },
                        })
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span>Add HM/FM Spin Interface</span>
                    </Button>
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "st-boundaries",
          title: "Explicit spin boundary conditions (boundaries)",
          icon: Layers,
          defaultOpen: true,
          modeTabId: "interfaces",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <TransportCollectionEditor
                  collection="boundaries"
                  family="spin_transport"
                  scene={scene}
                  spinMode={ctx.draft.mode}
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
          id: "st-execution",
          title: "Requested execution lane",
          icon: Cpu,
          defaultOpen: true,
          modeTabId: "solver",
          rows: [
            {
              type: "segmented",
              key: "executionDiscretization",
              label: "Discretization",
              options: [
                { value: "auto", label: "Auto" },
                { value: "fdm", label: "FDM" },
                { value: "fem", label: "FEM" },
              ],
            },
            {
              type: "select",
              key: "executionDevice",
              label: "Compute device",
              options: [
                { value: "auto", label: "Auto" },
                { value: "cpu", label: "CPU" },
                {
                  value: "gpu",
                  label: "GPU",
                  disabledReason: gpuDisabledReason,
                },
              ],
            },
            {
              type: "select",
              key: "executionPrecision",
              label: "Floating-point precision",
              options: [
                { value: "double", label: "FP64 (Double)" },
                {
                  value: "single",
                  label: "FP32 (Single)",
                  disabledReason: singlePrecisionDisabledReason,
                },
              ],
            },
            {
              type: "segmented",
              key: "executionMode",
              label: "Execution policy",
              options: [
                { value: "strict", label: "Strict" },
                { value: "extended", label: "Extended" },
              ],
            },
          ],
        },
        {
          id: "st-solver",
          title: "Constitutive & linear / reciprocal nonlinear solver",
          icon: Sliders,
          defaultOpen: true,
          modeTabId: "solver",
          rows: [
            {
              type: "select",
              key: "constitutiveVersion",
              label: "Constitutive version",
              options: [
                {
                  value: "transport_constitutive.one_way.fullmag.v1",
                  label: "One-way steady / M1 (transport_constitutive.one_way.fullmag.v1)",
                },
                {
                  value: "transport_constitutive.reciprocal.fullmag.v1",
                  label: "Reciprocal M2 (transport_constitutive.reciprocal.fullmag.v1)",
                },
              ],
            },
            {
              type: "text",
              key: "solverDefaultExternalBoundary",
              label: "Default external spin boundary",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Default external boundary is required." : null,
            },
            {
              type: "text",
              key: "solverEngine",
              label: "Linear solver engine",
              mono: true,
              validate: (v) => (!v.trim() ? "Solver engine is required." : null),
            },
            {
              type: "text",
              key: "solverRelativeTolerance",
              label: "Relative tolerance",
              mono: true,
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
              validate: (v) =>
                !v.trim() ? "Operator version is required." : null,
            },
            {
              type: "text",
              key: "solverPhysicalResidualVersion",
              label: "Physical residual version",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Physical residual version is required." : null,
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) =>
                d.constitutiveVersion ===
                "transport_constitutive.reciprocal.fullmag.v1",
              render: (ctx) => {
                const rec = parseReciprocalObject(ctx.draft.reciprocalNonlinear);
                const updateRecKey = (k: string, rawVal: string) => {
                  const next = { ...rec };
                  const parsed = Number(rawVal);
                  if (rawVal.trim() && Number.isFinite(parsed)) {
                    next[k] = parsed;
                  } else if (!rawVal.trim()) {
                    delete next[k];
                  } else {
                    next[k] = rawVal;
                  }
                  ctx.setField(
                    "reciprocalNonlinear",
                    JSON.stringify(next, null, 2),
                  );
                };
                return (
                  <div
                    className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5"
                    data-slot="reciprocal-nonlinear-editor"
                  >
                    <span className="text-xs font-medium text-[var(--fm-text)]">
                      Reciprocal nonlinear solver policy (reciprocal_nonlinear)
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          GMRES restart
                        </span>
                        <Input
                          aria-label="GMRES restart"
                          className="font-mono"
                          value={
                            rec.gmres_restart !== undefined
                              ? String(rec.gmres_restart)
                              : ""
                          }
                          onChange={(e) =>
                            updateRecKey("gmres_restart", e.target.value)
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          Max Picard iterations
                        </span>
                        <Input
                          aria-label="Max Picard iterations"
                          className="font-mono"
                          value={
                            rec.max_picard_iterations !== undefined
                              ? String(rec.max_picard_iterations)
                              : ""
                          }
                          onChange={(e) =>
                            updateRecKey("max_picard_iterations", e.target.value)
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          Relative update tolerance
                        </span>
                        <Input
                          aria-label="Relative update tolerance"
                          className="font-mono"
                          value={
                            rec.relative_update_tolerance !== undefined
                              ? String(rec.relative_update_tolerance)
                              : ""
                          }
                          onChange={(e) =>
                            updateRecKey(
                              "relative_update_tolerance",
                              e.target.value,
                            )
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          Relaxation η_transport (0, 1]
                        </span>
                        <Input
                          aria-label="Relaxation eta_transport"
                          className="font-mono"
                          value={
                            rec.eta_transport !== undefined
                              ? String(rec.eta_transport)
                              : ""
                          }
                          onChange={(e) =>
                            updateRecKey("eta_transport", e.target.value)
                          }
                        />
                      </div>
                    </div>
                  </div>
                );
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
      availableCurrentIds,
      breadcrumbs,
      capability,
      conflictState.conflicts,
      conflictState.hasConflict,
      conflictState.hasRevisionConflict,
      conflictState.rebaseDraft,
      currentRes,
      gpuDisabledReason,
      handleApply,
      handleDelete,
      knownSelected,
      liveDirty.size,
      localSelectionKey,
      pinnedByRef,
      scene,
      sceneRevision,
      selection.objectId,
      singlePrecisionDisabledReason,
      spinRes,
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

  const handleCoupledChange = useCallback(
    <K extends keyof SpinTransportPanelDraft & string>(
      key: K,
      value: SpinTransportPanelDraft[K],
      current: SpinTransportPanelDraft,
    ): Partial<SpinTransportPanelDraft> | null => {
      if (key === "constitutiveVersion") {
        const nextVer = String(value);
        if (nextVer === "transport_constitutive.reciprocal.fullmag.v1") {
          const existingRec = parseReciprocalObject(current.reciprocalNonlinear);
          const nextRec =
            Object.keys(existingRec).length > 0
              ? existingRec
              : {
                  gmres_restart: 20,
                  max_picard_iterations: 25,
                  relative_update_tolerance: 1e-8,
                  eta_transport: 0.5,
                };
          return {
            constitutiveVersion: nextVer,
            solverEngine:
              current.solverEngine === "gmres"
                ? "block_gmres"
                : current.solverEngine,
            solverOperatorVersion:
              current.solverOperatorVersion === "fv_spin_upwind_v1"
                ? "fdm_coupled_charge_spin_fv_block_gmres.v1"
                : current.solverOperatorVersion,
            reciprocalNonlinear: JSON.stringify(nextRec, null, 2),
          };
        }
        return {
          constitutiveVersion: nextVer,
          solverOperatorVersion:
            current.solverOperatorVersion ===
            "fdm_coupled_charge_spin_fv_block_gmres.v1"
              ? "fv_spin_upwind_v1"
              : current.solverOperatorVersion,
          reciprocalNonlinear: "{}",
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
          entityId={transportIdentity("spin_transport", selectedRecord!) ?? undefined}
          icon={GitBranch}
          kindLabel="3D Spin Drift-Diffusion"
          payload={selectedRecord}
          selection={selection}
          specId="physics.spin-transport"
          switcherNode={
            !pinnedByRef ? (
              <ResourceSwitcherBar
                label="Resource"
                newOptionLabel="New spin transport"
                options={switcherOptions}
                value={localSelectionKey}
                onChange={setLocalSelectionKey}
              />
            ) : undefined
          }
          heading={
            transportIdentity("spin_transport", selectedRecord!) ??
            "Opaque Spin Transport"
          }
          warningText="Unrecognized transport variant is preserved losslessly and is read-only."
          onRefresh={() => spinRes.refetch()}
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
