"use client";

import {
  CheckCircle2,
  Compass,
  FileCode2,
  GitBranch,
  Layers,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  KnownSceneSpinTransport,
  SpinTransportMutationRequest,
  TransportValidationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  useSpinInterfaceMeshEvidenceResource,
  useSpinInterfacesResource,
  useSpinTransportsResource,
} from "@/kernel/resources/spinAuthoringResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
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
  type InspectorNotice,
  type InspectorSpec,
} from "../../template";
import {
  bindInterfaceTraces,
  buildInterface,
  canBindInterfaceTraces,
  INTERFACE_TRACE_DIRECTIONS,
  interfaceDraft,
  interfaceTraceSelection,
  reconcileInterfaceDraft,
  record as asObjRecord,
  type InterfaceDraft,
} from "../SpinInterfaceInspectorModel";
import { verifySpinInterfaceMeshOrientation } from "../SpinInterfaceMeshEvidenceModel";
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
  isEditableSpinTransport,
  ReadOnlyOpaqueInspector,
  RESOURCE_KEYS,
  ResourceSwitcherBar,
  runPreCommitTransportValidation,
  type SceneSpinInterface,
  TRANSPORT_VALIDATION_VERSION,
  TransportTemplateRenderer,
  useAuthoringSceneData,
  useDebouncedTransportValidation,
  useThreeWayConflictState,
  useTransportSessionContext,
} from "./transportShared";

const UNBOUND_TRACE_SENTINEL = "__fm_trace_unbound__";
const STORED_TRACE_SENTINEL = "__fm_trace_stored__";

export interface SpinInterfacePanelDraft extends InterfaceDraft {
  exists: boolean;
  ownerId: string;
}

function hydrateInterfacePanelDraft(
  value: unknown,
  ownerId: string,
  exists: boolean,
): SpinInterfacePanelDraft {
  const base = interfaceDraft(value);
  const raw = asObjRecord(value);
  const fallbackGr =
    !base.gR && raw?.re_g_mix_Spm2 !== undefined
      ? String(raw.re_g_mix_Spm2)
      : base.gR;
  const fallbackGi =
    !base.gI && raw?.im_g_mix_Spm2 !== undefined
      ? String(raw.im_g_mix_Spm2)
      : base.gI;

  if (!exists && !raw) {
    return {
      ...base,
      kind: "mixing_conductance",
      normalToFerromagnet: base.normalToFerromagnet || "0, 0, 1",
      normalAToB: base.normalAToB || "0, 0, 1",
      gUp: base.gUp || "1e15",
      gDown: base.gDown || "1e14",
      gR: base.gR || "5e14",
      gI: base.gI || "5e13",
      exists: false,
      ownerId,
    };
  }

  return {
    ...base,
    gR: fallbackGr,
    gI: fallbackGi,
    exists,
    ownerId,
  };
}

function parseNormalVector(text: string): number[] | null {
  const parts = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

export function SpinInterfaceInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const scene = useAuthoringSceneData();
  const projectedRes = useSpinInterfacesResource();
  const transportsRes = useSpinTransportsResource();

  const projectedItems = useMemo(
    () => projectedRes.data?.items ?? [],
    [projectedRes.data?.items],
  );
  const spinTransportItems = useMemo(
    () => transportsRes.data?.items ?? [],
    [transportsRes.data?.items],
  );
  const sceneRevision =
    transportsRes.data?.scene_revision ?? projectedRes.data?.scene_revision;

  const ref = selection.ref?.type === "spin-interface" ? selection.ref : null;
  const pinnedByRef = Boolean(
    ref &&
      !ref.draft &&
      (Boolean(ref.spinInterfaceId) || ref.spinInterfaceIndex !== undefined),
  );

  const initialOwnerFromRef = ref?.spinInterfaceOwnerId ?? "";
  const [localOwnerId, setLocalOwnerId] = useState(initialOwnerFromRef);
  const [localInterfaceId, setLocalInterfaceId] = useState("");
  const [prevSelNodeId, setPrevSelNodeId] = useState(selection.nodeId);
  if (prevSelNodeId !== selection.nodeId) {
    setPrevSelNodeId(selection.nodeId);
    setLocalOwnerId(initialOwnerFromRef);
    setLocalInterfaceId("");
  }

  const selectedProjected = useMemo(() => {
    if (pinnedByRef && ref) {
      if (ref.spinInterfaceId) {
        return (
          projectedItems.find(
            (item) =>
              item.interface_id === ref.spinInterfaceId &&
              (!ref.spinInterfaceOwnerId ||
                item.owner_spin_transport_id === ref.spinInterfaceOwnerId),
          ) ?? null
        );
      }
      if (ref.spinInterfaceIndex !== undefined) {
        return projectedItems[ref.spinInterfaceIndex] ?? null;
      }
    }
    if (!localInterfaceId) return null;
    return (
      projectedItems.find(
        (item) =>
          item.interface_id === localInterfaceId &&
          (!localOwnerId || item.owner_spin_transport_id === localOwnerId),
      ) ?? null
    );
  }, [localInterfaceId, localOwnerId, pinnedByRef, projectedItems, ref]);

  const effectiveOwnerId =
    selectedProjected?.owner_spin_transport_id ??
    (pinnedByRef ? (ref?.spinInterfaceOwnerId ?? "") : localOwnerId);

  const rawOwnerRecord = useMemo(
    () =>
      spinTransportItems.find((st) => {
        if (isEditableSpinTransport(st)) return st.id === effectiveOwnerId;
        const rec = asObjRecord(st);
        return Boolean(effectiveOwnerId && rec?.id === effectiveOwnerId);
      }) ?? null,
    [effectiveOwnerId, spinTransportItems],
  );

  const knownOwner =
    rawOwnerRecord && isEditableSpinTransport(rawOwnerRecord) ? rawOwnerRecord : null;

  const isOpaqueInterface =
    (selectedProjected !== null && !selectedProjected.known) ||
    (rawOwnerRecord !== null && knownOwner === null);

  const targetMissingMessage =
    (pinnedByRef || Boolean(localInterfaceId)) &&
    projectedRes.status === "ready" &&
    selectedProjected === null
      ? "The selected spin interface is no longer present on its owning spin transport."
      : null;

  const knownSpinOwners = useMemo(
    () => spinTransportItems.filter(isEditableSpinTransport),
    [spinTransportItems],
  );

  const switcherInterfaces = useMemo(
    () =>
      projectedItems
        .filter(
          (item) =>
            !effectiveOwnerId || item.owner_spin_transport_id === effectiveOwnerId,
        )
        .map((item, idx) => ({
          value: item.interface_id || `iface-${idx + 1}`,
          label: item.known
            ? `${item.interface_id} (${item.owner_spin_transport_id})`
            : `${item.interface_id || `Interface #${idx + 1}`} (read-only)`,
        })),
    [effectiveOwnerId, projectedItems],
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
      {
        id: "crumb-owner",
        label: effectiveOwnerId || "Spin Transport",
        selection: effectiveOwnerId
          ? {
              kind: "physics.spin-transport",
              label: effectiveOwnerId,
              nodeId: `model:physics:spin-transports:${effectiveOwnerId}`,
              objectId: selection.objectId,
              ref: {
                kind: "physics.spin-transport",
                nodeId: `model:physics:spin-transports:${effectiveOwnerId}`,
                spinTransportId: effectiveOwnerId,
                type: "spin-transport",
              },
            }
          : undefined,
      },
      { id: "crumb-spin-interface", label: "HM/FM Spin Interface" },
    ],
    [effectiveOwnerId, selection.objectId],
  );

  const draftIdentityKey = pinnedByRef
    ? `pinned:${ref?.spinInterfaceOwnerId ?? ""}:${ref?.spinInterfaceId ?? `idx:${ref?.spinInterfaceIndex ?? "none"}`}`
    : `local:${effectiveOwnerId || "no-owner"}:${localInterfaceId || "new"}`;

  const serverBaseline = useMemo(
    () =>
      hydrateInterfacePanelDraft(
        selectedProjected?.interface ?? null,
        effectiveOwnerId,
        selectedProjected !== null,
      ),
    [effectiveOwnerId, selectedProjected],
  );

  const effectiveSelection = useMemo<Selection>(
    () => ({
      ...selection,
      nodeId: `${selection.nodeId}::${draftIdentityKey}`,
    }),
    [draftIdentityKey, selection],
  );

  const [liveDraft, setLiveDraft] =
    useState<SpinInterfacePanelDraft>(serverBaseline);
  const [liveDirty, setLiveDirty] = useState<ReadonlySet<string>>(() => new Set());

  const reconcilePanel = useCallback(
    (
      server: SpinInterfacePanelDraft,
      local: SpinInterfacePanelDraft,
      base: SpinInterfacePanelDraft,
    ) => {
      const res = reconcileInterfaceDraft(server, local, base);
      const ownerChanged =
        local.ownerId !== base.ownerId ? local.ownerId : server.ownerId;
      return {
        draft: {
          ...res.draft,
          exists: server.exists,
          ownerId: ownerChanged,
        },
        conflicts: res.conflicts,
      };
    },
    [],
  );

  const conflictState = useThreeWayConflictState({
    targetKey: draftIdentityKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraft,
    dirtyFields: liveDirty,
    reconcile: reconcilePanel,
  });

  // Live mesh evidence bound to LIVE draft (not baseline!)
  const liveSideA = useMemo(
    () =>
      liveDraft.kind === "transparent"
        ? { objectId: liveDraft.sideAObject, regionId: liveDraft.sideARegion }
        : { objectId: liveDraft.normalObject, regionId: liveDraft.normalRegion },
    [
      liveDraft.kind,
      liveDraft.normalObject,
      liveDraft.normalRegion,
      liveDraft.sideAObject,
      liveDraft.sideARegion,
    ],
  );
  const liveSideB = useMemo(
    () =>
      liveDraft.kind === "transparent"
        ? { objectId: liveDraft.sideBObject, regionId: liveDraft.sideBRegion }
        : {
            objectId: liveDraft.ferromagnetObject,
            regionId: liveDraft.ferromagnetRegion,
          },
    [
      liveDraft.ferromagnetObject,
      liveDraft.ferromagnetRegion,
      liveDraft.kind,
      liveDraft.sideBObject,
      liveDraft.sideBRegion,
    ],
  );

  const meshEvidence = useSpinInterfaceMeshEvidenceResource(liveSideA, liveSideB);

  const meshVerification = useMemo(() => {
    const normalStr =
      liveDraft.kind === "transparent"
        ? liveDraft.normalAToB
        : liveDraft.normalToFerromagnet;
    const parsedNormal = parseNormalVector(normalStr);

    if (!liveSideA.objectId || !liveSideB.objectId) {
      return {
        verified: false,
        summary: "Select both adjacent scopes to evaluate shared mesh facets.",
        errorText: null as string | null,
      };
    }
    if (!liveSideA.regionId || !liveSideB.regionId) {
      return {
        verified: false,
        summary:
          "Shared-facet mesh certification requires explicit region sub-scopes on both sides.",
        errorText: null as string | null,
      };
    }
    if (meshEvidence.error) {
      const msg =
        meshEvidence.error instanceof Error
          ? meshEvidence.error.message
          : String(meshEvidence.error);
      return {
        verified: false,
        summary: msg,
        errorText: msg,
      };
    }
    if (!meshEvidence.data) {
      return {
        verified: false,
        summary:
          meshEvidence.status === "loading"
            ? "Loading accepted shared-domain mesh topology and memberships..."
            : "Geometry and mesh adjacency/orientation are not verified until an accepted shared-domain mesh is built.",
        errorText: null as string | null,
      };
    }
    if (!parsedNormal) {
      return {
        verified: false,
        summary: "Enter three finite orientation components to verify mesh normal.",
        errorText: "Interface orientation requires three finite components.",
      };
    }
    try {
      const res = verifySpinInterfaceMeshOrientation(
        meshEvidence.data,
        parsedNormal,
      );
      return {
        verified: true,
        summary: `Mesh verified: ${res.sharedFacetCount} shared tet4 facets · area ${res.interfaceAreaM2.toExponential(3)} m²`,
        errorText: null as string | null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        summary: msg,
        errorText: msg,
      };
    }
  }, [
    liveDraft.kind,
    liveDraft.normalAToB,
    liveDraft.normalToFerromagnet,
    liveSideA.objectId,
    liveSideA.regionId,
    liveSideB.objectId,
    liveSideB.regionId,
    meshEvidence.data,
    meshEvidence.error,
    meshEvidence.status,
  ]);

  const activeOwnerForDraft = useMemo(
    () =>
      knownSpinOwners.find((st) => st.id === liveDraft.ownerId) ?? knownOwner,
    [knownOwner, knownSpinOwners, liveDraft.ownerId],
  );

  const buildNextOwnerRecord = useCallback(
    (d: SpinInterfacePanelDraft): {
      builtInterface: SceneSpinInterface;
      nextOwner: KnownSceneSpinTransport;
    } => {
      const owner = knownSpinOwners.find((st) => st.id === d.ownerId);
      if (!owner) {
        throw new Error("Select the owning spin transport before applying.");
      }
      const builtInterface = buildInterface(d) as SceneSpinInterface;
      const existingList = owner.interfaces ?? [];
      const originalId = selectedProjected?.interface_id ?? "";
      const nextInterfaces = selectedProjected
        ? existingList.map((iface) =>
            iface.id === originalId ? builtInterface : iface,
          )
        : [...existingList, builtInterface];

      if (
        new Set(nextInterfaces.map((iface) => iface.id.trim())).size !==
        nextInterfaces.length
      ) {
        throw new Error(
          `Spin interface ID "${builtInterface.id}" already exists on ${owner.id}.`,
        );
      }

      return {
        builtInterface,
        nextOwner: {
          ...owner,
          interfaces: nextInterfaces,
        },
      };
    },
    [knownSpinOwners, selectedProjected],
  );

  const candidateOwnerPreview = useMemo(() => {
    try {
      return buildNextOwnerRecord(liveDraft).nextOwner;
    } catch {
      return activeOwnerForDraft;
    }
  }, [activeOwnerForDraft, buildNextOwnerRecord, liveDraft]);

  const capability = useMemo(
    () =>
      evaluateTransportCapability(
        "spin_transport",
        candidateOwnerPreview,
        scene,
        session,
      ),
    [candidateOwnerPreview, scene, session],
  );

  const buildInterfaceValidationReq = useCallback(
    (d: SpinInterfacePanelDraft): TransportValidationRequest => {
      if (sceneRevision === undefined) {
        throw new Error("Scene revision is loading.");
      }
      const { builtInterface } = buildNextOwnerRecord(d);
      return selectedProjected
        ? {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_interface",
              operation: "replace",
              owner_spin_transport_id: d.ownerId,
              interface_id: selectedProjected.interface_id,
              resource: builtInterface,
            },
          }
        : {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_interface",
              operation: "create",
              owner_spin_transport_id: d.ownerId,
              resource: builtInterface,
            },
          };
    },
    [buildNextOwnerRecord, sceneRevision, selectedProjected],
  );

  const validationState = useDebouncedTransportValidation({
    enabled:
      !isOpaqueInterface &&
      targetMissingMessage === null &&
      Boolean(liveDraft.ownerId.trim()),
    draftSerialized: JSON.stringify(liveDraft),
    draftKey: draftIdentityKey,
    sceneRevision,
    sessionScopeKey: session.sessionScopeKey,
    buildRequest: () => buildInterfaceValidationReq(liveDraft),
  });

  const handleRefreshAll = useCallback(() => {
    projectedRes.refetch();
    transportsRes.refetch();
    meshEvidence.refetch?.();
  }, [meshEvidence, projectedRes, transportsRes]);

  const handleDeleteInterface = useCallback(async () => {
    if (!selectedProjected || !knownOwner || sceneRevision === undefined) return;
    if (!capability.authoring_allowed) {
      throw new Error(capability.reason);
    }
    const nextOwner: KnownSceneSpinTransport = {
      ...knownOwner,
      interfaces: (knownOwner.interfaces ?? []).filter(
        (iface) => iface.id !== selectedProjected.interface_id,
      ),
    };
    const ownerReplaceReq: TransportValidationRequest = {
      validation_version: TRANSPORT_VALIDATION_VERSION,
      base_revision: sceneRevision,
      candidate: {
        kind: "spin_transport",
        operation: "replace",
        path_id: knownOwner.id,
        resource: nextOwner,
      },
    };
    await runPreCommitTransportValidation({
      validateTransport: kernel.api.model.validateTransport,
      sessionScopeKey: session.sessionScopeKey,
      request: ownerReplaceReq,
    });

    await executeAuthoringHistoryCommit({
      kernel,
      sessionScopeKey: session.sessionScopeKey,
      label: `Delete spin interface ${selectedProjected.interface_id} on ${knownOwner.id}`,
      submittedRevision: sceneRevision,
      resourceKeys: RESOURCE_KEYS.spinTransport,
      onConflict409: conflictState.markHttpConflict,
      mutate: ({ committedRevision, requestOptions }) => {
        const payload: SpinTransportMutationRequest = {
          base_revision: committedRevision,
          resource: nextOwner,
        };
        return kernel.api.model.replaceSpinTransport(
          knownOwner.id,
          payload,
          requestOptions,
        );
      },
    });
    conflictState.clearConflict();
    if (!pinnedByRef) {
      setLocalInterfaceId("");
    } else {
      kernel.selection.set(
        {
          kind: "physics.spin-transport",
          label: knownOwner.id,
          nodeId: `model:physics:spin-transports:${knownOwner.id}`,
          objectId: selection.objectId,
          ref: {
            kind: "physics.spin-transport",
            nodeId: `model:physics:spin-transports:${knownOwner.id}`,
            spinTransportId: knownOwner.id,
            type: "spin-transport",
          },
        },
        "inspector",
      );
    }
  }, [
    capability.authoring_allowed,
    capability.reason,
    conflictState,
    kernel,
    knownOwner,
    pinnedByRef,
    sceneRevision,
    selectedProjected,
    selection.objectId,
    session.sessionScopeKey,
  ]);

  const handleApply = useCallback(
    async (draft: SpinInterfacePanelDraft) => {
      if (sceneRevision === undefined) {
        throw new Error("Spin interface catalog is still loading.");
      }
      if (!capability.authoring_allowed) {
        throw new Error(capability.reason);
      }
      const { builtInterface, nextOwner } = buildNextOwnerRecord(draft);
      const ifaceReq = buildInterfaceValidationReq(draft);
      const ownerReq: TransportValidationRequest = {
        validation_version: TRANSPORT_VALIDATION_VERSION,
        base_revision: sceneRevision,
        candidate: {
          kind: "spin_transport",
          operation: "replace",
          path_id: nextOwner.id,
          resource: nextOwner,
        },
      };
      await runPreCommitTransportValidation({
        validateTransport: kernel.api.model.validateTransport,
        sessionScopeKey: session.sessionScopeKey,
        request: ifaceReq,
        validationKey: validationState.validationKey,
        setManualValidation: validationState.setManualValidation,
      });
      await runPreCommitTransportValidation({
        validateTransport: kernel.api.model.validateTransport,
        sessionScopeKey: session.sessionScopeKey,
        request: ownerReq,
      });

      await executeAuthoringHistoryCommit({
        kernel,
        sessionScopeKey: session.sessionScopeKey,
        label: `${selectedProjected ? "Replace" : "Create"} spin interface ${builtInterface.id}`,
        submittedRevision: sceneRevision,
        resourceKeys: RESOURCE_KEYS.spinTransport,
        onConflict409: conflictState.markHttpConflict,
        mutate: ({ committedRevision, requestOptions }) => {
          const payload: SpinTransportMutationRequest = {
            base_revision: committedRevision,
            resource: nextOwner,
          };
          return kernel.api.model.replaceSpinTransport(
            nextOwner.id,
            payload,
            requestOptions,
          );
        },
      });
      conflictState.clearConflict();

      if (!selectedProjected) {
        setLocalOwnerId(nextOwner.id);
        setLocalInterfaceId(builtInterface.id);
        kernel.selection.set(
          {
            kind: "physics.spin-interface",
            label: builtInterface.id,
            nodeId: `model:physics:spin-interface:${nextOwner.id}:${builtInterface.id}`,
            objectId: selection.objectId,
            ref: {
              kind: "physics.spin-interface",
              nodeId: `model:physics:spin-interface:${nextOwner.id}:${builtInterface.id}`,
              spinInterfaceId: builtInterface.id,
              spinInterfaceOwnerId: nextOwner.id,
              type: "spin-interface",
            },
          },
          "inspector",
        );
      }
      return true;
    },
    [
      buildInterfaceValidationReq,
      buildNextOwnerRecord,
      capability.authoring_allowed,
      capability.reason,
      conflictState,
      kernel,
      sceneRevision,
      selectedProjected,
      selection.objectId,
      session.sessionScopeKey,
      validationState.setManualValidation,
      validationState.validationKey,
    ],
  );

  const scopes = useMemo(() => transportScopeOptions(scene), [scene]);

  const ownerMissingLock = !liveDraft.ownerId.trim()
    ? "Select the owning spin transport before applying."
    : null;

  const spec = useMemo<InspectorSpec<SpinInterfacePanelDraft>>(
    () => ({
      id: "physics.spin-interface",
      header: {
        breadcrumbs,
        searchable: true,
        extraMenuActions: [
          {
            id: "refresh-spin-interface",
            label: "Refresh interface and mesh evidence",
            icon: RefreshCw,
            onSelect: handleRefreshAll,
          },
          {
            id: "view-spin-interface-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) => {
              try {
                const built = buildInterface(ctx.draft);
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
        ...(selectedProjected && knownOwner && capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Delete Spin Interface",
                confirmTitle: () =>
                  `Remove interface "${selectedProjected.interface_id}"?`,
                confirmDescription:
                  "Removing this interface deletes its boundary condition between adjacent layers on the parent spin transport.",
                onDelete: handleDeleteInterface,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: GitBranch,
        title: (d) => d.id || "HM/FM Spin Interface",
        kindLabel: "Magnetoelectronic Spin Interface",
        entityId: selectedProjected?.interface_id ?? undefined,
        statePill: (d) => ({
          tone: !capability.authoring_allowed
            ? "warn"
            : meshVerification.verified
              ? "ok"
              : d.exists
                ? "info"
                : "info",
          label: !capability.authoring_allowed
            ? capability.status
            : meshVerification.verified
              ? "Mesh verified"
              : d.exists
                ? d.kind === "transparent"
                  ? "Transparent"
                  : "G↑↓ Mixing"
                : "New draft",
        }),
      },
      facts: (d) => [
        {
          id: "owner",
          label: "Owner",
          value: d.ownerId || "Not selected",
          mono: true,
        },
        {
          id: "kind",
          label: "Model",
          value: d.kind === "transparent" ? "Transparent" : "Mixing G↑↓",
        },
        ...(d.kind === "mixing_conductance"
          ? [
              {
                id: "gr",
                label: "Re(G↑↓)",
                value: `${d.gR || "0"} S/m²`,
                mono: true,
              },
            ]
          : []),
      ],
      notices: () => {
        const base = buildValidationNotices<SpinInterfacePanelDraft>({
          capability,
          validation: validationState.validation,
          validationError: validationState.validationError,
          buildError: liveDraft.ownerId.trim() ? validationState.buildError : null,
          conflicts: conflictState.conflicts,
          hasRevisionConflict: conflictState.hasRevisionConflict,
          onRebase: conflictState.rebaseDraft,
          targetMissingMessage,
        });
        const extra: InspectorNotice<SpinInterfacePanelDraft>[] = [];
        if (meshVerification.errorText) {
          extra.push({
            id: "mesh-orientation-issue",
            tone: "warn",
            title: "Mesh adjacency / orientation diagnostic",
            text: meshVerification.errorText,
          });
        }
        return [...base, ...extra];
      },
      sections: [
        ...(!pinnedByRef
          ? [
              {
                id: "si-switcher",
                title: "Owning spin transport & interface selection",
                icon: GitBranch,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: (ctx: {
                      draft: SpinInterfacePanelDraft;
                      setField: <K extends keyof SpinInterfacePanelDraft & string>(
                        k: K,
                        v: SpinInterfacePanelDraft[K],
                      ) => void;
                    }) => (
                      <div className="flex flex-col gap-2.5">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-[var(--fm-text-muted)]">
                            Owning spin transport
                          </span>
                          <Select
                            disabled={liveDirty.size > 0 && Boolean(selectedProjected)}
                            value={ctx.draft.ownerId || EMPTY_SELECT_SENTINEL}
                            onValueChange={(nextOwner) => {
                              const resolved =
                                nextOwner === EMPTY_SELECT_SENTINEL ? "" : nextOwner;
                              setLocalOwnerId(resolved);
                              setLocalInterfaceId("");
                              ctx.setField("ownerId", resolved);
                            }}
                          >
                            <SelectTrigger aria-label="Owning spin transport">
                              <SelectValue placeholder="Select owning spin transport" />
                            </SelectTrigger>
                            <SelectContent align="start" position="popper">
                              <SelectGroup>
                                <SelectItem value={EMPTY_SELECT_SENTINEL}>
                                  Select owning spin transport
                                </SelectItem>
                                {knownSpinOwners.map((st) => (
                                  <SelectItem key={st.id} value={st.id}>
                                    {st.id}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>

                        <ResourceSwitcherBar
                          disabled={liveDirty.size > 0}
                          label="Interface"
                          newOptionLabel="New spin interface"
                          options={switcherInterfaces}
                          value={localInterfaceId}
                          onChange={setLocalInterfaceId}
                        />
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "si-topology",
          title: "Interface identity, adjacent scopes & trace binding",
          icon: Compass,
          defaultOpen: true,
          rows: [
            {
              type: "text",
              key: "id",
              label: "Interface ID",
              mono: true,
              disabledReason: (d) =>
                d.exists ? "Committed spin interface IDs are immutable." : null,
              validate: (v) =>
                !v.trim() ? "Interface ID is required." : null,
            },
            {
              type: "segmented",
              key: "kind",
              label: "Interface physics model",
              options: [
                { value: "mixing_conductance", label: "Mixing G↑↓" },
                { value: "transparent", label: "Transparent" },
              ],
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.kind === "transparent",
              render: (ctx) => {
                const sideAVal = ctx.draft.sideAObject
                  ? encodeTransportScopeOption(
                      ctx.draft.sideAObject,
                      ctx.draft.sideARegion,
                    )
                  : EMPTY_SELECT_SENTINEL;
                const sideBVal = ctx.draft.sideBObject
                  ? encodeTransportScopeOption(
                      ctx.draft.sideBObject,
                      ctx.draft.sideBRegion,
                    )
                  : EMPTY_SELECT_SENTINEL;
                const missingA =
                  Boolean(ctx.draft.sideAObject) &&
                  !scopes.some(
                    (s) =>
                      s.objectId === ctx.draft.sideAObject &&
                      s.regionId === ctx.draft.sideARegion,
                  );
                const missingB =
                  Boolean(ctx.draft.sideBObject) &&
                  !scopes.some(
                    (s) =>
                      s.objectId === ctx.draft.sideBObject &&
                      s.regionId === ctx.draft.sideBRegion,
                  );
                return (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-[var(--fm-text-muted)]">
                        Source scope (side_a)
                      </span>
                      <Select
                        value={sideAVal}
                        onValueChange={(nextVal) => {
                          if (nextVal === EMPTY_SELECT_SENTINEL) {
                            ctx.patchDraft({ sideAObject: "", sideARegion: "" });
                            return;
                          }
                          const parsed = parseTransportScopeOption(nextVal);
                          if (parsed) {
                            ctx.patchDraft({
                              sideAObject: parsed[0],
                              sideARegion: parsed[1],
                            });
                          }
                        }}
                      >
                        <SelectTrigger aria-label="Source scope">
                          <SelectValue placeholder="Select source scope" />
                        </SelectTrigger>
                        <SelectContent align="start" position="popper">
                          <SelectGroup>
                            <SelectItem value={EMPTY_SELECT_SENTINEL}>
                              Select source scope
                            </SelectItem>
                            {missingA ? (
                              <SelectItem value={sideAVal}>
                                {ctx.draft.sideARegion
                                  ? `${ctx.draft.sideAObject} / ${ctx.draft.sideARegion} (not in scene)`
                                  : `${ctx.draft.sideAObject} (not in scene)`}
                              </SelectItem>
                            ) : null}
                            {scopes.map((s) => (
                              <SelectItem
                                key={`a:${s.objectId}:${s.regionId}`}
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
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-[var(--fm-text-muted)]">
                        Target scope (side_b)
                      </span>
                      <Select
                        value={sideBVal}
                        onValueChange={(nextVal) => {
                          if (nextVal === EMPTY_SELECT_SENTINEL) {
                            ctx.patchDraft({ sideBObject: "", sideBRegion: "" });
                            return;
                          }
                          const parsed = parseTransportScopeOption(nextVal);
                          if (parsed) {
                            ctx.patchDraft({
                              sideBObject: parsed[0],
                              sideBRegion: parsed[1],
                            });
                          }
                        }}
                      >
                        <SelectTrigger aria-label="Target scope">
                          <SelectValue placeholder="Select target scope" />
                        </SelectTrigger>
                        <SelectContent align="start" position="popper">
                          <SelectGroup>
                            <SelectItem value={EMPTY_SELECT_SENTINEL}>
                              Select target scope
                            </SelectItem>
                            {missingB ? (
                              <SelectItem value={sideBVal}>
                                {ctx.draft.sideBRegion
                                  ? `${ctx.draft.sideBObject} / ${ctx.draft.sideBRegion} (not in scene)`
                                  : `${ctx.draft.sideBObject} (not in scene)`}
                              </SelectItem>
                            ) : null}
                            {scopes.map((s) => (
                              <SelectItem
                                key={`b:${s.objectId}:${s.regionId}`}
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
                  </div>
                );
              },
            },
            {
              type: "text",
              key: "normalAToB",
              label: "Source-to-target orientation (nx, ny, nz)",
              mono: true,
              showWhen: (d) => d.kind === "transparent",
              validate: (v) =>
                !parseNormalVector(v)
                  ? "Orientation requires three finite components."
                  : null,
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.kind === "mixing_conductance",
              render: (ctx) => {
                const nmVal = ctx.draft.normalObject
                  ? encodeTransportScopeOption(
                      ctx.draft.normalObject,
                      ctx.draft.normalRegion,
                    )
                  : EMPTY_SELECT_SENTINEL;
                const fmVal = ctx.draft.ferromagnetObject
                  ? encodeTransportScopeOption(
                      ctx.draft.ferromagnetObject,
                      ctx.draft.ferromagnetRegion,
                    )
                  : EMPTY_SELECT_SENTINEL;
                const missingNm =
                  Boolean(ctx.draft.normalObject) &&
                  !scopes.some(
                    (s) =>
                      s.objectId === ctx.draft.normalObject &&
                      s.regionId === ctx.draft.normalRegion,
                  );
                const missingFm =
                  Boolean(ctx.draft.ferromagnetObject) &&
                  !scopes.some(
                    (s) =>
                      s.objectId === ctx.draft.ferromagnetObject &&
                      s.regionId === ctx.draft.ferromagnetRegion,
                  );

                const rawTraceSel = interfaceTraceSelection(ctx.draft);
                const selectTraceVal =
                  rawTraceSel === ""
                    ? UNBOUND_TRACE_SENTINEL
                    : rawTraceSel === "stored"
                      ? STORED_TRACE_SENTINEL
                      : rawTraceSel;
                const canBind = canBindInterfaceTraces(ctx.draft);

                return (
                  <div className="flex flex-col gap-2.5" data-slot="mixing-trace-bindings">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-[var(--fm-text-muted)]">
                        Normal-metal scope (normal_side)
                      </span>
                      <Select
                        value={nmVal}
                        onValueChange={(nextVal) => {
                          const parsed =
                            nextVal === EMPTY_SELECT_SENTINEL
                              ? (["", ""] as const)
                              : parseTransportScopeOption(nextVal);
                          if (!parsed) return;
                          ctx.patchDraft({
                            normalObject: parsed[0],
                            normalRegion: parsed[1],
                            ...(parsed[0] !== ctx.draft.normalObject
                              ? { normalSurface: null, ferromagnetSurface: null }
                              : {}),
                          });
                        }}
                      >
                        <SelectTrigger aria-label="Normal-metal scope">
                          <SelectValue placeholder="Select normal-metal scope" />
                        </SelectTrigger>
                        <SelectContent align="start" position="popper">
                          <SelectGroup>
                            <SelectItem value={EMPTY_SELECT_SENTINEL}>
                              Select normal-metal scope
                            </SelectItem>
                            {missingNm ? (
                              <SelectItem value={nmVal}>
                                {ctx.draft.normalRegion
                                  ? `${ctx.draft.normalObject} / ${ctx.draft.normalRegion} (not in scene)`
                                  : `${ctx.draft.normalObject} (not in scene)`}
                              </SelectItem>
                            ) : null}
                            {scopes.map((s) => (
                              <SelectItem
                                key={`nm:${s.objectId}:${s.regionId}`}
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

                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-[var(--fm-text-muted)]">
                        Ferromagnet scope (ferromagnet_side)
                      </span>
                      <Select
                        value={fmVal}
                        onValueChange={(nextVal) => {
                          const parsed =
                            nextVal === EMPTY_SELECT_SENTINEL
                              ? (["", ""] as const)
                              : parseTransportScopeOption(nextVal);
                          if (!parsed) return;
                          ctx.patchDraft({
                            ferromagnetObject: parsed[0],
                            ferromagnetRegion: parsed[1],
                            ...(parsed[0] !== ctx.draft.ferromagnetObject
                              ? { normalSurface: null, ferromagnetSurface: null }
                              : {}),
                          });
                        }}
                      >
                        <SelectTrigger aria-label="Ferromagnet scope">
                          <SelectValue placeholder="Select ferromagnet scope" />
                        </SelectTrigger>
                        <SelectContent align="start" position="popper">
                          <SelectGroup>
                            <SelectItem value={EMPTY_SELECT_SENTINEL}>
                              Select ferromagnet scope
                            </SelectItem>
                            {missingFm ? (
                              <SelectItem value={fmVal}>
                                {ctx.draft.ferromagnetRegion
                                  ? `${ctx.draft.ferromagnetObject} / ${ctx.draft.ferromagnetRegion} (not in scene)`
                                  : `${ctx.draft.ferromagnetObject} (not in scene)`}
                              </SelectItem>
                            ) : null}
                            {scopes.map((s) => (
                              <SelectItem
                                key={`fm:${s.objectId}:${s.regionId}`}
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

                    <div className="flex flex-col gap-1.5 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5">
                      <span className="text-xs font-medium text-[var(--fm-text)]">
                        Oriented trace pair (normal metal → ferromagnet)
                      </span>
                      <Select
                        disabled={!canBind}
                        value={selectTraceVal}
                        onValueChange={(nextDir) => {
                          if (
                            nextDir === UNBOUND_TRACE_SENTINEL ||
                            nextDir === STORED_TRACE_SENTINEL
                          ) {
                            return;
                          }
                          ctx.patchDraft(bindInterfaceTraces(ctx.draft, nextDir));
                        }}
                      >
                        <SelectTrigger aria-label="Oriented trace pair (normal metal → ferromagnet)">
                          <SelectValue placeholder="Choose explicit region trace direction" />
                        </SelectTrigger>
                        <SelectContent align="start" position="popper">
                          <SelectGroup>
                            <SelectItem value={UNBOUND_TRACE_SENTINEL}>
                              Unbound (manual orientation only)
                            </SelectItem>
                            {rawTraceSel === "stored" ? (
                              <SelectItem value={STORED_TRACE_SENTINEL}>
                                Stored custom surface trace binding
                              </SelectItem>
                            ) : null}
                            {INTERFACE_TRACE_DIRECTIONS.map((dir) => (
                              <SelectItem key={dir.surfaceId} value={dir.surfaceId}>
                                {dir.surfaceId} → {dir.oppositeId} (
                                {dir.normal.join(", ")})
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>

                      <div className="flex flex-col gap-0.5 font-mono text-xs text-[var(--fm-text-muted)]">
                        <span>
                          Normal-metal trace:{" "}
                          {ctx.draft.normalSurface
                            ? `${ctx.draft.normalSurface.objectId}:${ctx.draft.normalSurface.surfaceId}; outward [${ctx.draft.normalSurface.orientation}]`
                            : "not bound"}
                        </span>
                        <span>
                          Ferromagnet trace:{" "}
                          {ctx.draft.ferromagnetSurface
                            ? `${ctx.draft.ferromagnetSurface.objectId}:${ctx.draft.ferromagnetSurface.surfaceId}; outward [${ctx.draft.ferromagnetSurface.orientation}]`
                            : "not bound"}
                        </span>
                      </div>

                      <Button
                        disabled={
                          !ctx.draft.normalSurface && !ctx.draft.ferromagnetSurface
                        }
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          ctx.patchDraft({
                            normalSurface: null,
                            ferromagnetSurface: null,
                          })
                        }
                      >
                        Clear both trace bindings
                      </Button>
                    </div>
                  </div>
                );
              },
            },
            {
              type: "text",
              key: "normalToFerromagnet",
              label: "Normal-to-ferromagnet orientation (nx, ny, nz)",
              mono: true,
              showWhen: (d) => d.kind === "mixing_conductance",
              disabledReason: (d) =>
                d.normalSurface && d.ferromagnetSurface
                  ? "Orientation is locked by explicit trace bindings. Clear both trace bindings to edit manually."
                  : null,
              validate: (v) =>
                !parseNormalVector(v)
                  ? "Orientation requires three finite components."
                  : null,
            },
          ],
        },
        {
          id: "si-conductances",
          title: "Magnetoelectronic conductances & spin-memory loss",
          icon: Layers,
          defaultOpen: true,
          showWhen: (d) => d.kind === "mixing_conductance",
          rows: [
            {
              type: "text",
              key: "gUp",
              label: "Majority conductance g_up (S/m²)",
              mono: true,
              validate: (v) =>
                !v.trim() || !Number.isFinite(Number(v))
                  ? "g_up must be finite."
                  : null,
            },
            {
              type: "text",
              key: "gDown",
              label: "Minority conductance g_down (S/m²)",
              mono: true,
              validate: (v) =>
                !v.trim() || !Number.isFinite(Number(v))
                  ? "g_down must be finite."
                  : null,
            },
            {
              type: "text",
              key: "gR",
              label: "Real mixing conductance g_r (S/m²)",
              mono: true,
              validate: (v) =>
                !v.trim() || !Number.isFinite(Number(v))
                  ? "g_r must be finite."
                  : null,
            },
            {
              type: "text",
              key: "gI",
              label: "Imaginary mixing conductance g_i (S/m²)",
              mono: true,
              validate: (v) =>
                !v.trim() || !Number.isFinite(Number(v))
                  ? "g_i must be finite."
                  : null,
            },
            {
              type: "text",
              key: "gSml",
              label: "Scalar SML conductance g_sml_Spm2 (optional S/m²)",
              mono: true,
              placeholder: "Optional scalar g_sml_Spm2",
              validate: (v) =>
                v.trim() && !Number.isFinite(Number(v))
                  ? "g_sml must be finite when provided."
                  : null,
            },
            {
              type: "text",
              key: "formulaVersion",
              label: "Interface formula version",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Formula version is required." : null,
            },
            {
              type: "text",
              key: "absorption",
              label: "Transverse spin absorption policy",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Absorption policy is required." : null,
            },
            {
              type: "text",
              key: "smlFormulaVersion",
              label: "Reservoir SML formula version",
              mono: true,
              placeholder: "sml_reservoir.fullmag.v2",
            },
            {
              type: "text",
              key: "gN",
              label: "Reservoir SML g_n (S/m²)",
              mono: true,
              placeholder: "Optional reservoir g_n_Spm2",
              validate: (v) =>
                v.trim() && !Number.isFinite(Number(v))
                  ? "g_n must be finite."
                  : null,
            },
            {
              type: "text",
              key: "gF",
              label: "Reservoir SML g_f (S/m²)",
              mono: true,
              placeholder: "Optional reservoir g_f_Spm2",
              validate: (v) =>
                v.trim() && !Number.isFinite(Number(v))
                  ? "g_f must be finite."
                  : null,
            },
            {
              type: "text",
              key: "gLattice",
              label: "Reservoir SML g_lattice (S/m²)",
              mono: true,
              placeholder: "Optional reservoir g_lattice_Spm2",
              validate: (v) =>
                v.trim() && !Number.isFinite(Number(v))
                  ? "g_lattice must be finite."
                  : null,
            },
          ],
        },
        {
          id: "si-mesh-evidence",
          title: "Shared mesh facet & orientation evidence",
          icon: meshVerification.verified ? CheckCircle2 : ShieldAlert,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div
                  className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5"
                  data-slot="spin-interface-mesh-verification"
                >
                  <span className="text-xs text-[var(--fm-text)]">
                    {meshVerification.summary}
                  </span>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={handleRefreshAll}
                  >
                    <RefreshCw aria-hidden="true" size={12} />
                    <span>Refresh mesh evidence</span>
                  </Button>
                </div>
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
            extraLockReason: ownerMissingLock,
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
      handleApply,
      handleDeleteInterface,
      handleRefreshAll,
      knownOwner,
      knownSpinOwners,
      liveDirty.size,
      liveDraft.ownerId,
      localInterfaceId,
      meshVerification.errorText,
      meshVerification.summary,
      meshVerification.verified,
      ownerMissingLock,
      pinnedByRef,
      sceneRevision,
      scopes,
      selectedProjected,
      switcherInterfaces,
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

  if (isOpaqueInterface) {
    return (
      <>
        {session.probeElement}
        <ReadOnlyOpaqueInspector
          breadcrumbs={breadcrumbs}
          entityId={selectedProjected?.interface_id ?? undefined}
          heading={selectedProjected?.interface_id ?? "Opaque Spin Interface"}
          icon={GitBranch}
          kindLabel="Magnetoelectronic Spin Interface"
          payload={selectedProjected?.interface ?? rawOwnerRecord}
          selection={selection}
          specId="physics.spin-interface"
          switcherNode={
            !pinnedByRef ? (
              <ResourceSwitcherBar
                label="Interface"
                newOptionLabel="New spin interface"
                options={switcherInterfaces}
                value={localInterfaceId}
                onChange={setLocalInterfaceId}
              />
            ) : undefined
          }
          warningText="Unrecognized spin interface variant is preserved losslessly and is read-only."
          onRefresh={handleRefreshAll}
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
