"use client";

import { Link2, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { MODEL_PHYSICS_GRAPH_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject } from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { acknowledgedAuthoringSceneRevision } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import {
  MODEL_COUPLINGS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  publishCommittedSceneResource,
  resolveSceneResourceRevision,
  useModelCouplingsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  validateInteractionDraftForDiscretization,
  type InteractionDiscretization,
} from "@/shared/domain/physics/interactions";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import { resolveCouplingInspectorModel } from "../../../panels/CouplingInspectorPanelModel";
import {
  buildRootSelection,
  SpecInspectorHost,
} from "../../../panels/model-roots/SpecInspectorHost";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorRowSpec,
  InspectorSpec,
} from "../../../template";
import {
  buildCouplingDiagnosticsSection,
  COUPLING_PARAMETERS_SECTION,
  hydrateCouplingBaseline,
} from "./couplingShared";
import {
  asJsonRecord,
  decodeEndpointKey,
  endpointSignature,
  errorMessage,
  isRevisionConflict,
  uniqueCouplingId,
  type CouplingSpecDraft,
  type PhysicsModuleDraft,
  type SceneCoupling,
  type SceneCouplingParameters,
  type SceneCouplingPatch,
} from "./physicsShared";

export function buildDemagRows(
  demagOptions: readonly { value: string; label: string }[],
  interactionDiscretization: InteractionDiscretization,
): InspectorRowSpec<PhysicsModuleDraft>[] {
  return [
    {
      key: "demagRealization",
      type: "select",
      label: "Magnetostatic realization",
      showWhen: (d: PhysicsModuleDraft) =>
        d.moduleKind === "demag" && d.scopeKind === "global",
      options: demagOptions,
      validate: (val: string, d: PhysicsModuleDraft) => {
        if (interactionDiscretization === "unknown") return null;
        const res = validateInteractionDraftForDiscretization(
          {
            id: "demag",
            enabled: d.enabled,
            present: true,
            values: { method: val },
          },
          interactionDiscretization,
        );
        return res?.error ?? null;
      },
    },
  ];
}

export function applyDemagStudyPatch(
  draft: PhysicsModuleDraft,
  studyPatch: JsonObject,
): boolean {
  if (draft.moduleKind === "demag") {
    studyPatch.demag_enabled = draft.enabled;
    studyPatch.demag_realization =
      draft.demagRealization === "auto" ? null : draft.demagRealization;
    return true;
  }
  return false;
}

/* ── CouplingInspectorPanel (`physics.coupling` — RKKY, Interlayer J1+J2, Direct Exchange) ── */

export function CouplingInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const scene = useSceneResource();
  const couplingsResource = useModelCouplingsResource();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const isDraftRoute = Boolean(
    selection.nodeId?.endsWith(":draft") ||
      (selection.ref?.type === "physics-coupling" && !selection.ref.couplingId),
  );

  const existingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of couplingsResource.data?.couplings ?? []) {
      if (item.coupling_id) ids.add(item.coupling_id);
    }
    for (const item of scene.data?.couplings ?? []) {
      const rec = asJsonRecord(item);
      const id =
        typeof rec?.coupling_id === "string"
          ? rec.coupling_id
          : typeof rec?.id === "string"
            ? rec.id
            : null;
      if (id) ids.add(id);
    }
    return ids;
  }, [couplingsResource.data?.couplings, scene.data?.couplings]);

  const requestedCouplingId = useMemo(() => {
    if (isDraftRoute) return uniqueCouplingId(existingIds);
    if (selection.ref?.type === "physics-coupling" && selection.ref.couplingId) {
      return selection.ref.couplingId;
    }
    const tail = selection.nodeId?.split(":").at(-1);
    return tail && tail !== "couplings" ? tail : uniqueCouplingId(existingIds);
  }, [existingIds, isDraftRoute, selection.nodeId, selection.ref]);

  const diagModel = useMemo(
    () =>
      resolveCouplingInspectorModel(
        selection.ref?.type === "physics-coupling"
          ? selection
          : {
              ...selection,
              ref: {
                couplingId: requestedCouplingId,
                kind: "physics.coupling",
                nodeId:
                  selection.nodeId ??
                  `model:physics:couplings:${requestedCouplingId}`,
                type: "physics-coupling",
              },
            },
        couplingsResource.data ?? null,
      ),
    [couplingsResource.data, requestedCouplingId, selection],
  );

  const endpointOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const obj of scene.data?.objects ?? []) {
      if (
        obj.role === "airbox" ||
        obj.role === "air" ||
        obj.role === "antenna"
      ) {
        continue;
      }
      const objLabel = obj.name ?? obj.id;
      opts.push({
        value: `object::${obj.id}`,
        label: `${objLabel} (whole object)`,
      });
      for (const reg of obj.regions ?? []) {
        opts.push({
          value: `region::${obj.id}::${reg.region_id}`,
          label: `${objLabel} / ${reg.name ?? reg.region_id}`,
        });
      }
      opts.push({
        value: `surface::${obj.id}`,
        label: `${objLabel} (surface selector)`,
      });
    }
    return opts;
  }, [scene.data?.objects]);

  const matchedSceneRecord = useMemo(() => {
    for (const item of scene.data?.couplings ?? []) {
      const rec = asJsonRecord(item);
      if (
        rec &&
        (rec.coupling_id === requestedCouplingId ||
          rec.id === requestedCouplingId)
      ) {
        return rec;
      }
    }
    return null;
  }, [requestedCouplingId, scene.data?.couplings]);

  const matchedResourceRecord = useMemo(() => {
    const list =
      couplingsResource.data?.couplings ??
      (couplingsResource.data as { items?: unknown[] } | null)?.items ??
      [];
    for (const item of list) {
      const rec = asJsonRecord(item);
      if (
        rec &&
        (rec.coupling_id === requestedCouplingId ||
          rec.id === requestedCouplingId)
      ) {
        return rec;
      }
    }
    return null;
  }, [couplingsResource.data, requestedCouplingId]);

  const baseline = useMemo<CouplingSpecDraft>(
    () =>
      hydrateCouplingBaseline({
        endpointOptions,
        isDraftRoute,
        matchedResourceRecord,
        matchedSceneRecord,
        requestedCouplingId,
      }),
    [
      endpointOptions,
      isDraftRoute,
      matchedResourceRecord,
      matchedSceneRecord,
      requestedCouplingId,
    ],
  );

  const allEndpointOptionsFor = useCallback(
    (currentKey: string) => {
      if (endpointOptions.some((o) => o.value === currentKey)) {
        return endpointOptions;
      }
      const fallbackList =
        endpointOptions.length > 0
          ? endpointOptions
          : [
              { value: "object::layer-a", label: "Layer A (whole object)" },
              { value: "object::layer-b", label: "Layer B (whole object)" },
            ];
      if (fallbackList.some((o) => o.value === currentKey)) return fallbackList;
      return [
        ...fallbackList,
        { value: currentKey, label: currentKey.replace(/::/g, " / ") },
      ];
    },
    [endpointOptions],
  );

  const spec = useMemo<InspectorSpec<CouplingSpecDraft>>(
    () => ({
      id: "physics.coupling",
      header: {
        breadcrumbs: [
          {
            id: "couplings",
            label: "Couplings",
            selection: buildRootSelection(
              "physics.couplings",
              "model:physics:couplings",
              "Couplings",
            ),
          },
          {
            id: "coupling",
            label: baseline.exists ? baseline.couplingId : "New coupling",
          },
        ],
        searchable: false,
        extraMenuActions: [
          {
            id: "refresh-couplings",
            label: "Refresh coupling diagnostics",
            icon: RefreshCw,
            onSelect: () => {
              scene.refetch?.();
              couplingsResource.refetch?.();
              setMutationError(null);
            },
          },
        ],
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Coupling",
                confirmTitle: (d) => `Delete coupling "${d.couplingId}"?`,
                confirmDescription:
                  "This removes the surface exchange / RKKY coupling between the two endpoints.",
                onDelete: async (ctx) => {
                  const rawRev =
                    couplingsResource.data?.scene_revision ??
                    resolveSceneResourceRevision(scene.data);
                  const numericRev =
                    rawRev !== null &&
                    rawRev !== undefined &&
                    Number.isFinite(Number(rawRev))
                      ? Number(rawRev)
                      : undefined;
                  const response = await runAuthoringMutationWithHistory(
                    {
                      api: kernel.api,
                      authoringHistory: kernel.authoringHistory,
                      sessionScopeKey,
                    },
                    `Delete coupling ${baseline.couplingId}`,
                    async ({ baseRevision }) => {
                      const opts = authoringWriteOptions(
                        baseRevision ?? numericRev,
                        sessionScopeKey,
                      );
                      return opts
                        ? kernel.api.model.deleteCoupling(
                            baseline.couplingId,
                            opts,
                          )
                        : kernel.api.model.deleteCoupling(baseline.couplingId);
                    },
                  );
                  const rev = acknowledgedAuthoringSceneRevision(response);
                  publishCommittedSceneResource(
                    kernel.resources,
                    response.committed_scene,
                    rev,
                    undefined,
                    true,
                    sessionScopeKey,
                    kernel.api.resourceCacheScope,
                  );
                  kernel.resources.invalidate(MODEL_COUPLINGS_RESOURCE_KEY, rev);
                  kernel.resources.invalidate(
                    MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
                    rev,
                  );
                  kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
                  ctx.selectNode(
                    buildRootSelection(
                      "physics.couplings",
                      "model:physics:couplings",
                      "Couplings",
                    ),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Link2,
        title: (d) =>
          d.exists ? `${d.couplingId}` : `New coupling (${d.couplingId})`,
        kindLabel: "Inter-surface magnetic coupling",
        entityId: baseline.couplingId,
        statePill: (d) => {
          if (!d.exists) return { tone: "info", label: "New draft" };
          if (diagModel.blockerReason) return { tone: "err", label: "Blocked" };
          return d.enabled
            ? { tone: "ok", label: "Active" }
            : { tone: "degraded", label: "Disabled" };
        },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "kind",
          label: "Model",
          value:
            d.kind === "rkky"
              ? "RKKY"
              : d.kind === "interlayer_exchange"
                ? "Interlayer J1 + J2"
                : "Direct exchange",
        },
        {
          id: "regime",
          label: "Character",
          value:
            d.kind === "rkky"
              ? d.jRkky < 0
                ? "Antiferromagnetic (AF)"
                : d.jRkky > 0
                  ? "Ferromagnetic (FM)"
                  : "Uncoupled"
              : d.kind === "interlayer_exchange"
                ? d.j1 < 0
                  ? "Antiferromagnetic J1"
                  : d.j1 > 0
                    ? "Ferromagnetic J1"
                    : "Biquadratic J2"
                : d.exchangeMode.replace(/_/g, " "),
        },
        ...(d.exists && diagModel.mode === "found"
          ? [
              {
                id: "status",
                label: "Realization",
                value: diagModel.realizationStatus.replace(/_/g, " "),
                tone: diagModel.blockerReason
                  ? ("err" as const)
                  : ("info" as const),
              },
            ]
          : []),
      ],
      notices: (d): readonly InspectorNotice<CouplingSpecDraft>[] => {
        const list: InspectorNotice<CouplingSpecDraft>[] = [];
        if (
          endpointSignature(d.endpointAKey, d.endpointASurfaceSelector) ===
          endpointSignature(d.endpointBKey, d.endpointBSurfaceSelector)
        ) {
          list.push({
            id: "identical-endpoints",
            tone: "err",
            title: "Distinct endpoints required",
            text: "Endpoint A and Endpoint B must reference two distinct magnetic objects, regions, or surface selectors.",
          });
        }
        if (d.exists && diagModel.blockerReason) {
          list.push({
            id: "coupling-blocker",
            tone: "err",
            title: "Coupling realization blocked",
            text: diagModel.blockerReason,
          });
        }
        if (
          !isDraftRoute &&
          !d.exists &&
          couplingsResource.status === "ready"
        ) {
          list.push({
            id: "missing-coupling",
            tone: "warn",
            text: "Selected coupling is not present in the current model resource; applying will create it.",
          });
        }
        if (mutationError) {
          list.push({
            id: "coupling-mutation-error",
            tone: "err",
            text: mutationError,
            quickFix: {
              label: "Refresh couplings",
              onApply: () => {
                scene.refetch?.();
                couplingsResource.refetch?.();
                setMutationError(null);
              },
            },
          });
        }
        return list;
      },
      sections: [
        {
          id: "coupling-endpoints",
          title: "Coupled magnetic endpoints",
          icon: Link2,
          defaultOpen: true,
          rows: [
            {
              key: "couplingId",
              type: "text",
              mono: true,
              label: "Coupling ID",
              showWhen: (d) => !d.exists,
              validate: (v, d) => {
                if (d.exists) return null;
                if (!v.trim()) return "Coupling ID is required.";
                if (existingIds.has(v.trim())) {
                  return `Coupling '${v.trim()}' already exists.`;
                }
                return null;
              },
            },
            {
              key: "enabled",
              type: "switch",
              label: "Coupling active",
            },
            {
              key: "kind",
              type: "segmented",
              label: "Coupling Hamiltonian",
              structural: true,
              options: [
                { value: "rkky", label: "RKKY" },
                { value: "interlayer_exchange", label: "J1 + J2" },
                { value: "exchange", label: "Direct" },
              ],
            },
            {
              key: "capabilityPolicy",
              type: "select",
              label: "Runtime capability policy",
              options: [
                { value: "", label: "Default runtime policy" },
                {
                  value: "require_runtime",
                  label: "Require runtime capability",
                },
                { value: "authored_only", label: "Authored intent only" },
              ],
            },
            {
              key: "endpointAKey",
              type: "select",
              label: "Source endpoint (A)",
              structural: true,
              options: allEndpointOptionsFor(baseline.endpointAKey),
              validate: (v, d) =>
                endpointSignature(v, d.endpointASurfaceSelector) ===
                endpointSignature(d.endpointBKey, d.endpointBSurfaceSelector)
                  ? "Source endpoint must differ from Target endpoint."
                  : null,
            },
            {
              key: "endpointASurfaceSelector",
              type: "text",
              mono: true,
              label: "Source surface selector",
              placeholder: "+z",
              showWhen: (d) => d.endpointAKey.startsWith("surface::"),
              validate: (v, d) =>
                d.endpointAKey.startsWith("surface::") && !v.trim()
                  ? "Surface selector is required for surface endpoints."
                  : null,
            },
            {
              key: "endpointBKey",
              type: "select",
              label: "Target endpoint (B)",
              structural: true,
              options: allEndpointOptionsFor(baseline.endpointBKey),
              validate: (v, d) =>
                endpointSignature(d.endpointAKey, d.endpointASurfaceSelector) ===
                endpointSignature(v, d.endpointBSurfaceSelector)
                  ? "Target endpoint must differ from Source endpoint."
                  : null,
            },
            {
              key: "endpointBSurfaceSelector",
              type: "text",
              mono: true,
              label: "Target surface selector",
              placeholder: "-z",
              showWhen: (d) => d.endpointBKey.startsWith("surface::"),
              validate: (v, d) =>
                d.endpointBKey.startsWith("surface::") && !v.trim()
                  ? "Surface selector is required for surface endpoints."
                  : null,
            },
          ],
        },
        COUPLING_PARAMETERS_SECTION,
        buildCouplingDiagnosticsSection(diagModel),
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => !d.exists,
        applyLabel: (d) => (d.exists ? "Apply" : "Create Coupling"),
        cleanMessage: () => "Surface coupling matches committed SceneDocument",
        onApply: async (draft) => {
          setMutationError(null);
          const source = decodeEndpointKey(
            draft.endpointAKey,
            draft.endpointASurfaceSelector,
          );
          const target = decodeEndpointKey(
            draft.endpointBKey,
            draft.endpointBSurfaceSelector,
          );
          const parameters: SceneCouplingParameters =
            draft.kind === "rkky"
              ? { kind: "rkky", j1: draft.jRkky }
              : draft.kind === "interlayer_exchange"
                ? { kind: "interlayer_exchange", j1: draft.j1, j2: draft.j2 }
                : {
                    kind: "exchange",
                    mode: draft.exchangeMode,
                    ...(draft.exchangeMode === "explicit"
                      ? { inter_exchange: draft.explicitAex }
                      : {}),
                    ...(draft.exchangeMode !== "disabled" &&
                    draft.hasExchangeScale
                      ? { scale: draft.exchangeScale }
                      : {}),
                  };

          const rawRev =
            couplingsResource.data?.scene_revision ??
            resolveSceneResourceRevision(scene.data);
          const numericRev =
            rawRev !== null &&
            rawRev !== undefined &&
            Number.isFinite(Number(rawRev))
              ? Number(rawRev)
              : undefined;

          try {
            if (draft.exists) {
              const patchPayload: SceneCouplingPatch = {
                enabled: draft.enabled,
                kind: draft.kind,
                source,
                target,
                parameters,
                capability_policy: draft.capabilityPolicy || null,
              };
              const tx = await runAuthoringMutationWithHistory(
                {
                  api: kernel.api,
                  authoringHistory: kernel.authoringHistory,
                  sessionScopeKey,
                },
                `Update coupling ${baseline.couplingId}`,
                async ({ baseRevision }) => {
                  const opts = authoringWriteOptions(
                    baseRevision ?? numericRev,
                    sessionScopeKey,
                  );
                  return opts
                    ? kernel.api.model.patchCoupling(
                        baseline.couplingId,
                        patchPayload,
                        opts,
                      )
                    : kernel.api.model.patchCoupling(
                        baseline.couplingId,
                        patchPayload,
                      );
                },
              );
              const rev = acknowledgedAuthoringSceneRevision(tx);
              publishCommittedSceneResource(
                kernel.resources,
                tx.committed_scene,
                rev,
                undefined,
                true,
                sessionScopeKey,
                kernel.api.resourceCacheScope,
              );
              kernel.resources.invalidate(MODEL_COUPLINGS_RESOURCE_KEY, rev);
              kernel.resources.invalidate(
                MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
                rev,
              );
              kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
            } else {
              const nextId = draft.couplingId.trim();
              const createPayload: SceneCoupling = {
                coupling_id: nextId,
                enabled: draft.enabled,
                kind: draft.kind,
                source,
                target,
                parameters,
                ...(draft.capabilityPolicy
                  ? { capability_policy: draft.capabilityPolicy }
                  : {}),
              };
              const tx = await runAuthoringMutationWithHistory(
                {
                  api: kernel.api,
                  authoringHistory: kernel.authoringHistory,
                  sessionScopeKey,
                },
                `Create coupling ${nextId}`,
                async ({ baseRevision }) => {
                  const opts = authoringWriteOptions(
                    baseRevision ?? numericRev,
                    sessionScopeKey,
                  );
                  return opts
                    ? kernel.api.model.createCoupling(createPayload, opts)
                    : kernel.api.model.createCoupling(createPayload);
                },
              );
              const rev = acknowledgedAuthoringSceneRevision(tx);
              publishCommittedSceneResource(
                kernel.resources,
                tx.committed_scene,
                rev,
                undefined,
                true,
                sessionScopeKey,
                kernel.api.resourceCacheScope,
              );
              kernel.resources.invalidate(MODEL_COUPLINGS_RESOURCE_KEY, rev);
              kernel.resources.invalidate(
                MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
                rev,
              );
              kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
              const createdNodeId = `model:physics:couplings:${nextId}`;
              kernel.selection.set(
                {
                  kind: "physics.coupling",
                  label: nextId,
                  nodeId: createdNodeId,
                  objectId: null,
                  ref: {
                    couplingId: nextId,
                    kind: "physics.coupling",
                    nodeId: createdNodeId,
                    type: "physics-coupling",
                  },
                },
                "inspector",
              );
            }
            return true;
          } catch (error) {
            if (isRevisionConflict(error)) {
              scene.refetch?.();
              couplingsResource.refetch?.();
              setMutationError(
                "Scene changed while applying this coupling. Draft preserved; scene refetched. Review and retry.",
              );
              return false;
            }
            setMutationError(errorMessage(error));
            return false;
          }
        },
        onRevert: () => setMutationError(null),
      },
    }),
    [
      allEndpointOptionsFor,
      baseline.couplingId,
      baseline.endpointAKey,
      baseline.endpointBKey,
      baseline.exists,
      couplingsResource,
      diagModel,
      existingIds,
      isDraftRoute,
      kernel.api,
      kernel.authoringHistory,
      kernel.resources,
      kernel.selection,
      mutationError,
      scene,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />
  );
}
