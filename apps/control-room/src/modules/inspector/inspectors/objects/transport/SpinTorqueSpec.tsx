"use client";

import { FileCode2, RefreshCw, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  SpinTorqueMutationRequest,
  TransportValidationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  useCurrentTransportsResource,
  useSpinTorquesResource,
  useSpinTransportsResource,
} from "@/kernel/resources/spinAuthoringResources";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import { currentSourceOptions } from "../../../panels/SpinAuthoringInspectorModel";
import { transportScopeOptions } from "../../../panels/TransportCollectionFieldsModel";
import {
  buildValidationDetails,
  buildValidationNotices,
  computeTransportLockReason,
  evaluateSpinM1Capability,
  executeAuthoringHistoryCommit,
  extractInitialRegionId,
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
} from "../../../panels/transport/transportShared";
import {
  useInspectorSpecController,
  type InspectorBreadcrumbItem,
  type InspectorSpec,
} from "../../../template";
import { buildSpinOrbitAndTransferSections } from "./SpinOrbitAndTransferSections";
import {
  buildMechanismAndDriveSections,
  buildTemporalModulationSection,
} from "./SpinTorqueCoreSections";
import { buildSpinTorqueResource } from "./transportResourceBuilder";
import {
  computeTorqueCoupledChange,
  hydrateTorquePanelDraft,
  isSupportedSpinTorqueRecord,
  reconcileTorquePanelDraft,
  type SpinTorquePanelDraft,
} from "./transportShared";

export function SpinTorqueInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const scene = useAuthoringSceneData();
  const torqueRes = useSpinTorquesResource();
  const currentRes = useCurrentTransportsResource();
  const spinRes = useSpinTransportsResource();

  const items = useMemo(
    () => torqueRes.data?.items ?? [],
    [torqueRes.data?.items],
  );
  const currents = useMemo(
    () => currentRes.data?.items ?? [],
    [currentRes.data?.items],
  );
  const spinTransports = useMemo(
    () => spinRes.data?.items ?? [],
    [spinRes.data?.items],
  );
  const sceneRevision = torqueRes.data?.scene_revision;

  const knownSpinIds = useMemo(
    () => spinTransports.filter(isEditableSpinTransport).map((st) => st.id),
    [spinTransports],
  );
  const currentOptsRaw = useMemo(
    () => currentSourceOptions(currents, ""),
    [currents],
  );
  const defaultCurrentId = currentOptsRaw[0]?.value ?? "";
  const defaultSolveId = knownSpinIds[0] ?? "";

  const ref = selection.ref;
  const isExplicitDraft = Boolean(
    ref && "draft" in ref && (ref as { draft?: boolean }).draft === true,
  );
  const pinnedByRef =
    ref?.type === "spin-torque" &&
    !isExplicitDraft &&
    (ref.spinTorqueId != null || ref.spinTorqueIndex != null);

  const [localResourceId, setLocalResourceId] = useState("");
  const [prevSelNodeId, setPrevSelNodeId] = useState(selection.nodeId);
  if (prevSelNodeId !== selection.nodeId) {
    setPrevSelNodeId(selection.nodeId);
    setLocalResourceId("");
  }

  // Positional index pinning guard
  const positionalOnly =
    pinnedByRef &&
    ref?.type === "spin-torque" &&
    !ref.spinTorqueId &&
    ref.spinTorqueIndex !== undefined;

  const selectedRecord = useMemo(() => {
    if (pinnedByRef && ref?.type === "spin-torque") {
      if (ref.spinTorqueId) {
        return (
          items.find(
            (item) => (item as Record<string, unknown>).id === ref.spinTorqueId,
          ) ?? null
        );
      }
      if (ref.spinTorqueIndex !== undefined) {
        return items[ref.spinTorqueIndex] ?? null;
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
    torqueRes.status === "ready" &&
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
      ? "Positional spin torque target changed identity after scene reorder. Reselect the target before applying."
      : null;

  const targetMissingMessage =
    (pinnedByRef || Boolean(localResourceId)) &&
    torqueRes.status === "ready" &&
    selectedRecord === null
      ? "The selected spin torque resource is no longer present in the scene."
      : positionalIdentityMismatch;

  const switcherOptions = useMemo(
    () =>
      items.map((item, idx) => {
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === "string" && rec.id.trim() ? rec.id : "";
        const supported = isSupportedSpinTorqueRecord(item);
        return {
          value: id || `position:${idx}`,
          label: id
            ? supported
              ? id
              : `${id} (read-only)`
            : `Opaque torque record #${idx + 1}`,
        };
      }),
    [items],
  );

  const isOpaqueSelected =
    selectedRecord !== null && !isSupportedSpinTorqueRecord(selectedRecord);
  const supportedSelected =
    selectedRecord !== null && !isOpaqueSelected ? selectedRecord : null;

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
      { id: "crumb-spin-torque", label: "Spin Torque" },
    ],
    [],
  );

  const draftIdentityKey = pinnedByRef
    ? `pinned:${ref?.type === "spin-torque" ? (ref.spinTorqueId ?? `pos:${ref.spinTorqueIndex ?? "none"}`) : selection.nodeId}`
    : `local:${localResourceId || "new"}:${initialScope?.objectId ?? ""}:${initialScope?.regionId ?? ""}`;

  const serverBaseline = useMemo(
    () =>
      hydrateTorquePanelDraft(
        supportedSelected,
        supportedSelected ? null : initialScope,
        supportedSelected !== null,
        defaultSolveId,
        defaultCurrentId,
      ),
    [defaultCurrentId, defaultSolveId, initialScope, supportedSelected],
  );

  const effectiveSelection = useMemo<Selection>(
    () => ({
      ...selection,
      nodeId: `${selection.nodeId}::${draftIdentityKey}`,
    }),
    [draftIdentityKey, selection],
  );

  const [liveDraft, setLiveDraft] =
    useState<SpinTorquePanelDraft>(serverBaseline);
  const [liveDirty, setLiveDirty] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const conflictState = useThreeWayConflictState({
    targetKey: draftIdentityKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraft,
    dirtyFields: liveDirty,
    reconcile: reconcileTorquePanelDraft,
  });

  const capability = useMemo(
    () => evaluateSpinM1Capability(session),
    [session],
  );

  const selectedPathId =
    supportedSelected &&
    typeof (supportedSelected as Record<string, unknown>).id === "string"
      ? String((supportedSelected as Record<string, unknown>).id)
      : "";

  const buildValidationReq = useCallback(
    (d: SpinTorquePanelDraft): TransportValidationRequest => {
      if (sceneRevision === undefined) {
        throw new Error("Spin torque catalog is still loading.");
      }
      const resource = buildSpinTorqueResource(d);
      return supportedSelected
        ? {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_torque",
              operation: "replace",
              path_id: selectedPathId || d.id.trim(),
              resource,
            },
          }
        : {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_torque",
              operation: "create",
              resource,
            },
          };
    },
    [sceneRevision, selectedPathId, supportedSelected],
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
    if (!supportedSelected || !selectedPathId || sceneRevision === undefined) {
      return;
    }
    if (!capability.authoring_allowed) {
      throw new Error(capability.reason);
    }
    await executeAuthoringHistoryCommit({
      kernel,
      sessionScopeKey: session.sessionScopeKey,
      label: `Delete spin torque ${selectedPathId}`,
      submittedRevision: sceneRevision,
      resourceKeys: RESOURCE_KEYS.spinTorque,
      onConflict409: conflictState.markHttpConflict,
      mutate: ({ committedRevision, requestOptions }) =>
        kernel.api.model.deleteSpinTorque(
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
    pinnedByRef,
    sceneRevision,
    selectedPathId,
    session.sessionScopeKey,
    supportedSelected,
  ]);

  const handleApply = useCallback(
    async (draft: SpinTorquePanelDraft) => {
      if (sceneRevision === undefined) {
        throw new Error("Spin torque catalog is still loading.");
      }
      if (!capability.authoring_allowed) {
        throw new Error(capability.reason);
      }
      const resource = buildSpinTorqueResource(draft);
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
        label: supportedSelected
          ? `Replace spin torque ${selectedPathId}`
          : `Create spin torque ${draft.id.trim()}`,
        submittedRevision: sceneRevision,
        resourceKeys: RESOURCE_KEYS.spinTorque,
        onConflict409: conflictState.markHttpConflict,
        mutate: ({ committedRevision, requestOptions }) => {
          const payload: SpinTorqueMutationRequest = {
            base_revision: committedRevision,
            resource,
          };
          return supportedSelected
            ? kernel.api.model.replaceSpinTorque(
                selectedPathId,
                payload,
                requestOptions,
              )
            : kernel.api.model.createSpinTorque(payload, requestOptions);
        },
      });
      conflictState.clearConflict();

      const committedRec = commit.resource as
        | Record<string, unknown>
        | undefined;
      const createdId =
        typeof committedRec?.id === "string" && committedRec.id.trim()
          ? committedRec.id
          : draft.id.trim();

      if (!supportedSelected && createdId) {
        setLocalResourceId(createdId);
        kernel.selection.set(
          {
            kind: "physics.spin-torque",
            label: createdId,
            nodeId: `model:physics:spin-torques:${createdId}`,
            objectId: selection.objectId,
            ref: {
              kind: "physics.spin-torque",
              nodeId: `model:physics:spin-torques:${createdId}`,
              spinTorqueId: createdId,
              type: "spin-torque",
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
      sceneRevision,
      selectedPathId,
      selection.objectId,
      session.sessionScopeKey,
      supportedSelected,
      validationState.setManualValidation,
      validationState.validationKey,
    ],
  );

  const scopes = useMemo(() => transportScopeOptions(scene), [scene]);
  const currentDropdownOptions = useMemo(
    () =>
      currentSourceOptions(currents, liveDraft.currentSource).map((opt) => ({
        value: opt.value,
        label: opt.label.replace(/\s*\(unavailable\)$/i, " (not in scene)"),
      })),
    [currents, liveDraft.currentSource],
  );

  const spec = useMemo<InspectorSpec<SpinTorquePanelDraft>>(
    () => ({
      id: "physics.spin-torque",
      header: {
        breadcrumbs,
        searchable: true,
        extraMenuActions: [
          {
            id: "refresh-spin-torques",
            label: "Refresh spin torques",
            icon: RefreshCw,
            onSelect: () => {
              torqueRes.refetch();
              currentRes.refetch();
              spinRes.refetch();
            },
          },
          {
            id: "view-spin-torque-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) => {
              try {
                const built = buildSpinTorqueResource(ctx.draft);
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
        ...(supportedSelected && selectedPathId && capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Delete Spin Torque",
                confirmTitle: () => `Delete "${selectedPathId}"?`,
                confirmDescription:
                  "Deleting this spin torque removes its current-induced damping-like and field-like torques from the magnetization dynamics.",
                onDelete: handleDelete,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Zap,
        title: (d) => d.id || "Spin Torque",
        kindLabel: "Current-Induced Spin Torque",
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
              ? d.torqueKind.replace(/_/g, " ")
              : "New draft",
        }),
      },
      facts: (d) => [
        {
          id: "kind",
          label: "Mechanism",
          value:
            d.torqueKind === "prescribed_sot"
              ? "Prescribed SOT"
              : d.torqueKind === "slonczewski"
                ? "Slonczewski"
                : d.torqueKind === "zhang_li"
                  ? "Zhang-Li"
                  : d.torqueKind === "drift_diffusion_spin_torque"
                    ? "Drift-Diffusion"
                    : "Interface CPP",
        },
        ...(d.torqueKind === "prescribed_sot"
          ? [
              {
                id: "sot-eff",
                label: "ξ_DL / ξ_FL",
                value: `${d.xiDl} / ${d.xiFl}`,
                mono: true,
              },
            ]
          : d.torqueKind === "drift_diffusion_spin_torque"
            ? [
                {
                  id: "solve",
                  label: "Spin solve",
                  value: d.solveId || "Unbound",
                  mono: true,
                },
              ]
            : [
                {
                  id: "pol",
                  label: "P",
                  value: String(d.degree),
                  mono: true,
                },
              ]),
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
        ...buildMechanismAndDriveSections({
          pinnedByRef,
          liveDirtySize: liveDirty.size,
          switcherOptions,
          localResourceId,
          onSelectLocalResource: setLocalResourceId,
          scopes,
          knownSpinIds,
          currentDropdownOptions,
        }),
        ...buildSpinOrbitAndTransferSections({ currentDropdownOptions }),
        buildTemporalModulationSection(),
      ],
      details: () =>
        buildValidationDetails(capability, validationState.validation),
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
      currentDropdownOptions,
      currentRes,
      handleApply,
      handleDelete,
      knownSpinIds,
      liveDirty.size,
      localResourceId,
      pinnedByRef,
      sceneRevision,
      scopes,
      selectedPathId,
      spinRes,
      supportedSelected,
      switcherOptions,
      targetMissingMessage,
      torqueRes,
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
    <K extends keyof SpinTorquePanelDraft & string>(
      key: K,
      value: SpinTorquePanelDraft[K],
      current: SpinTorquePanelDraft,
    ): Partial<SpinTorquePanelDraft> | null =>
      computeTorqueCoupledChange(key, value, current, {
        defaultCurrentId,
        defaultSolveId,
      }),
    [defaultCurrentId, defaultSolveId],
  );

  if (isOpaqueSelected) {
    const rec = selectedRecord as Record<string, unknown>;
    const opaqueId = typeof rec.id === "string" && rec.id ? rec.id : undefined;
    return (
      <>
        {session.probeElement}
        <ReadOnlyOpaqueInspector
          breadcrumbs={breadcrumbs}
          entityId={opaqueId}
          heading={opaqueId ?? "Opaque Spin Torque"}
          icon={Zap}
          kindLabel="Current-Induced Spin Torque"
          payload={selectedRecord}
          selection={selection}
          specId="physics.spin-torque"
          switcherNode={
            !pinnedByRef ? (
              <ResourceSwitcherBar
                label="Resource"
                newOptionLabel="New spin torque"
                options={switcherOptions}
                value={localResourceId}
                onChange={setLocalResourceId}
              />
            ) : undefined
          }
          warningText="Unrecognized spin torque variant is preserved losslessly and is read-only."
          onRefresh={() => torqueRes.refetch()}
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
