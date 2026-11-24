"use client";

import {
  Activity,
  ArrowRight,
  HelpCircle,
  Plus,
  Sliders,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactElement } from "react";

import { MODEL_PHYSICS_GRAPH_PATH } from "@/kernel/api/apiPaths";
import type {
  ObjectInteractionKind,
  ObjectInteractionPatchRequest,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import {
  resolveSceneResourceRevision,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  resolveActiveLaneOperation,
  useActiveLaneCapabilities,
  type ActiveLaneOperationId,
} from "@/kernel/resources/useActiveLaneCapabilities";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { normalizeInteractionDiscretization } from "@/shared/domain/physics/interactions";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { DisabledReason } from "@/shared/ui/DisabledReason";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  buildObjectSelection,
  buildRootSelection,
  InspectorShortcutCards,
  SpecInspectorHost,
} from "../../../panels/model-roots/SpecInspectorHost";
import { commitObjectInteractionMutation } from "../../../panels/PhysicsInteractionPanel.model";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../../template";
import { PhysicsInteractionHelpDialog } from "./PhysicsInteractionHelpDialog";
import { PhysicsModuleInspectorPanel } from "./PhysicsModuleSpec";
import {
  activeLaneOperationIdForModule,
  asJsonRecord,
  buildModuleHelpContent,
  commitObjectExchangeMutation,
  errorMessage,
  isRevisionConflict,
  readObjectInteractionState,
  resolveTargetStudyExchangeEnabled,
  ROTATED_DMI_EXCHANGE_ERROR,
  studyRotatedDmiNumber,
  type BackendWritableObjectInteractionKind,
  type ObjectInteractionToggleRow,
  type ObjectPhysicsMatrixDraft,
} from "./physicsShared";
import {
  buildObjectTransportAndSpinLinks,
  type ScopedModuleLink,
} from "./ThermalAndTransportPhysicsSpecs";

export function ObjectPhysicsInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const leafMatch = selection.nodeId?.match(
    /^model:(?:object:([^:]+):)?physics:([a-z0-9_]+)$/i,
  );
  if (leafMatch) {
    const [, nodeObjectId, interactionId] = leafMatch;
    const resolvedObjectId =
      selection.objectId ??
      (selection.ref?.type === "scene-object" ? selection.ref.objectId : null) ??
      nodeObjectId ??
      null;
    const regionId =
      selection.ref?.type === "scene-object"
        ? selection.ref.regionId
        : undefined;
    return (
      <PhysicsModuleInspectorPanel
        selection={{
          ...selection,
          kind: "physics.module",
          objectId: resolvedObjectId,
          ref: {
            kind: "physics.module",
            nodeId: selection.nodeId!,
            physicsModuleId: interactionId,
            physicsModuleKind: interactionId,
            physicsScopeKind: resolvedObjectId ? "object" : "global",
            ...(resolvedObjectId
              ? { physicsScopeObjectIds: [resolvedObjectId] }
              : {}),
            ...(regionId ? { regionId } : {}),
            type: "physics-module",
          },
        }}
      />
    );
  }
  return <ObjectPhysicsMatrixInspectorPanel selection={selection} />;
}

function ObjectPhysicsMatrixInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionDiscretization = useSessionStatusSelector((status) =>
    resolveSessionDiscretization(status.data),
  );
  const activeLane = useActiveLaneCapabilities();
  const interactionDiscretization = normalizeInteractionDiscretization(
    sessionDiscretization,
  );
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const [mutationFeedback, setMutationFeedback] = useState<{
    tone: "err" | "info";
    text: string;
  } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const matProps = useMemo(() => {
    const ref = sceneObj?.material_ref;
    const mat = ref
      ? scene.data?.materials?.find((m) => m.id === ref)
      : undefined;
    return (mat?.properties ?? {}) as Record<string, unknown>;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const studyRec = asJsonRecord(scene.data?.study);

  const resolveRowDisabledReason = useCallback(
    (
      kind: ObjectInteractionToggleRow["kind"],
    ): { writable: boolean; reason: string | null } => {
      if (kind === "magnetoelastic") {
        if (interactionDiscretization === "fdm") {
          return {
            writable: false,
            reason:
              "Magnetoelastic coupling is not applicable to the executable FDM lane; use a qualified FEM lane.",
          };
        }
        return {
          writable: false,
          reason:
            "Magnetoelastic coupling is backend-supported in FEM prescribed-strain plans, but browser strain-resource authoring is deferred.",
        };
      }
      if (interactionDiscretization === "unknown") {
        return {
          writable: false,
          reason:
            "Physics interaction lane is unresolved; resolve FDM or FEM before editing.",
        };
      }
      const opId = activeLaneOperationIdForModule(kind);
      if (opId && activeLane) {
        const op = resolveActiveLaneOperation(activeLane, opId);
        if (!op.enabled) {
          return { writable: false, reason: op.reason };
        }
      }
      if (
        (kind === "interfacial_dmi" || kind === "bulk_dmi") &&
        studyRotatedDmiNumber(studyRec) !== null
      ) {
        return {
          writable: true,
          reason: null,
        };
      }
      return { writable: true, reason: null };
    },
    [activeLane, interactionDiscretization, studyRec],
  );

  const interactions = useMemo<readonly ObjectInteractionToggleRow[]>(() => {
    const defs: readonly {
      kind: ObjectInteractionToggleRow["kind"];
      label: string;
      subtitle: string;
      required: boolean;
    }[] = [
      {
        kind: "exchange",
        label: "Symmetric exchange",
        subtitle: "Heisenberg continuum stiffness Aex (∇m)²",
        required: true,
      },
      {
        kind: "uniaxial_anisotropy",
        label: "Uniaxial anisotropy",
        subtitle: "Ku1 sin²θ + Ku2 sin⁴θ along easy/cone axis û",
        required: false,
      },
      {
        kind: "cubic_anisotropy",
        label: "Cubic anisotropy",
        subtitle: "Kc1, Kc2, Kc3 along orthogonal crystal axes (ĉ1, ĉ2)",
        required: false,
      },
      {
        kind: "interfacial_dmi",
        label: "Interfacial DMI",
        subtitle: "Néel-type chiral exchange Dind with interface normal n̂",
        required: false,
      },
      {
        kind: "bulk_dmi",
        label: "Bulk DMI",
        subtitle: "Bloch-type B20 chiral exchange Dbulk (m · ∇ × m)",
        required: false,
      },
      ...(interactionDiscretization === "fdm"
        ? []
        : [
            {
              kind: "magnetoelastic" as const,
              label: "Magnetoelastic coupling",
              subtitle:
                "Villari / magnetostrictive coupling B1, B2 & Voigt strain",
              required: false,
            },
          ]),
    ];

    return defs.map((def) => {
      const state = readObjectInteractionState(
        sceneObj,
        matProps,
        studyRec,
        def.kind,
      );
      const gate = resolveRowDisabledReason(def.kind);
      return {
        ...def,
        present: state.present,
        enabled: state.enabled,
        writable: gate.writable,
        disabledReason: gate.reason,
      };
    });
  }, [
    interactionDiscretization,
    matProps,
    resolveRowDisabledReason,
    sceneObj,
    studyRec,
  ]);

  const transportAndSpinLinks = useMemo<readonly ScopedModuleLink[]>(
    () =>
      buildObjectTransportAndSpinLinks(objectId, physicsGraph.data?.modules),
    [objectId, physicsGraph.data?.modules],
  );

  const baseline = useMemo<ObjectPhysicsMatrixDraft>(
    () => ({
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      exists: Boolean(sceneObj),
      interactions,
      transportAndSpinLinks,
      demagGlobalEnabled: studyRec?.demag_enabled !== false,
      discretization: interactionDiscretization,
    }),
    [
      interactionDiscretization,
      interactions,
      objectId,
      sceneObj,
      studyRec?.demag_enabled,
      transportAndSpinLinks,
    ],
  );

  const patchObjectStackState = useCallback(
    async (
      kind: BackendWritableObjectInteractionKind,
      label: string,
      next: { present: boolean; enabled?: boolean },
    ) => {
      if (!objectId) return;
      if (interactionDiscretization === "unknown") {
        setMutationFeedback({
          tone: "err",
          text: "Physics interaction lane is unresolved; resolve FDM or FEM before editing.",
        });
        return;
      }
      const opId = activeLaneOperationIdForModule(kind);
      if (opId && activeLane) {
        const op = resolveActiveLaneOperation(activeLane, opId);
        if (!op.enabled) {
          setMutationFeedback({ tone: "err", text: op.reason });
          return;
        }
      }
      if (
        (kind === "interfacial_dmi" || kind === "bulk_dmi") &&
        next.present &&
        next.enabled !== false &&
        studyRotatedDmiNumber(studyRec) !== null
      ) {
        setMutationFeedback({
          tone: "err",
          text: `Object-scoped ${kind} conflicts with active study-level rotated interfacial DMI. Disable or remove the study-level term before enabling the object-scoped DMI.`,
        });
        return;
      }
      if (
        kind === "exchange" &&
        next.enabled === false &&
        resolveTargetStudyExchangeEnabled({
          objectId,
          nextEnabled: false,
          studyRec,
          sceneObjects: scene.data?.objects,
          sceneMaterials: scene.data?.materials,
        }) === false
      ) {
        const rotVal = studyRotatedDmiNumber(studyRec);
        if (rotVal !== null && rotVal !== 0) {
          setMutationFeedback({
            tone: "err",
            text: ROTATED_DMI_EXCHANGE_ERROR,
          });
          return;
        }
      }

      const sceneRev = resolveSceneResourceRevision(scene.data);
      const numericSceneRev =
        sceneRev !== null && Number.isFinite(Number(sceneRev))
          ? Number(sceneRev)
          : null;

      try {
        setMutationFeedback(null);
        await runAuthoringMutationWithHistory(
          {
            api: kernel.api,
            authoringHistory: kernel.authoringHistory,
            sessionScopeKey,
          },
          `${label} interaction`,
          async ({ baseRevision }) => {
            if (kind === "exchange") {
              return commitObjectExchangeMutation({
                objectId,
                enabled: next.enabled !== false,
                baseRevision: baseRevision ?? numericSceneRev,
                studyRec,
                sceneObjects: scene.data?.objects,
                sceneMaterials: scene.data?.materials,
                sessionScopeKey,
                api: kernel.api,
                resources: kernel.resources,
              });
            }
            const patchPayload: ObjectInteractionPatchRequest = {
              base_revision: baseRevision ?? numericSceneRev,
              present: next.present,
              ...(next.enabled !== undefined ? { enabled: next.enabled } : {}),
            };
            const committedRev = await commitObjectInteractionMutation({
              interactionKind: kind as ObjectInteractionKind,
              objectId,
              patch: () =>
                kernel.api.model.patchObjectInteraction(
                  objectId,
                  kind as ObjectInteractionKind,
                  patchPayload,
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                ),
              resources: kernel.resources,
            });
            kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, committedRev);
            return committedRev;
          },
        );
      } catch (error) {
        if (isRevisionConflict(error)) {
          scene.refetch?.();
          setMutationFeedback({
            tone: "err",
            text: "Scene changed while updating this interaction. Scene refetched; review and retry.",
          });
          return;
        }
        setMutationFeedback({ tone: "err", text: errorMessage(error) });
      }
    },
    [
      activeLane,
      interactionDiscretization,
      kernel.api,
      kernel.authoringHistory,
      kernel.resources,
      objectId,
      scene,
      sessionScopeKey,
      studyRec,
    ],
  );

  const transportDisabledReason = useCallback(
    (opId: ActiveLaneOperationId): string | null => {
      if (interactionDiscretization === "unknown") {
        return "Physics interaction lane is unresolved; resolve FDM or FEM before creating resources.";
      }
      if (!activeLane) return null;
      const op = resolveActiveLaneOperation(activeLane, opId);
      return op.enabled ? null : op.reason;
    },
    [activeLane, interactionDiscretization],
  );

  const spec = useMemo<InspectorSpec<ObjectPhysicsMatrixDraft>>(
    () => ({
      id: "object.physics",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection(
              "objects.root",
              "model:objects",
              "Objects",
            ),
          },
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(
              objectId,
              "object.root",
              baseline.objectName,
            ),
          },
          { id: "physics", label: "Physics" },
        ],
        searchable: false,
        extraMenuActions: [
          {
            id: "interaction-help",
            label: "Interaction help",
            icon: HelpCircle,
            onSelect: () => setHelpOpen(true),
          },
        ],
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: (d) => `${d.objectName} · Physics`,
        kindLabel: "Object Hamiltonian & spintronics matrix",
        entityId: objectId ? `${objectId}:physics` : undefined,
        statePill: (d) =>
          d.discretization === "unknown"
            ? { tone: "warn", label: "Lane pending" }
            : {
                tone: "ok",
                label: `${d.interactions.filter((i) => i.enabled).length} active`,
              },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "lane",
          label: "Active lane",
          value:
            d.discretization === "unknown"
              ? "Pending"
              : d.discretization.toUpperCase(),
          tone: d.discretization === "unknown" ? "warn" : "info",
        },
        {
          id: "local",
          label: "Local terms",
          value: `${d.interactions.filter((i) => i.enabled).length} of ${d.interactions.length}`,
        },
        {
          id: "spintronics",
          label: "Transport / torque",
          value: String(d.transportAndSpinLinks.length),
        },
        {
          id: "demag",
          label: "Demag (global)",
          value: d.demagGlobalEnabled ? "Active" : "Off",
          tone: d.demagGlobalEnabled ? "ok" : undefined,
        },
      ],
      notices: (d): readonly InspectorNotice<ObjectPhysicsMatrixDraft>[] => {
        const list: InspectorNotice<ObjectPhysicsMatrixDraft>[] = [];
        if (d.discretization === "unknown") {
          list.push({
            id: "lane-unresolved",
            tone: "err",
            title: "Discretization lane not yet resolved",
            text: "Physics interaction lane is unresolved; resolve FDM or FEM before editing interactions.",
          });
        }
        if (mutationFeedback) {
          list.push({
            id: "mutation-feedback",
            tone: mutationFeedback.tone,
            text: mutationFeedback.text,
          });
        }
        return list;
      },
      sections: [
        {
          id: "object-physics-interactions",
          title: "Local Hamiltonian interactions",
          icon: Sliders,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div
                  className="flex flex-col gap-1.5"
                  data-slot="object-physics-matrix"
                >
                  {ctx.draft.interactions.map((row) => {
                    const nodeId = `model:object:${objectId}:physics:module:${row.kind}`;
                    const presentReason = !row.writable
                      ? row.disabledReason
                      : row.required
                        ? `${row.label} is required and cannot be removed from the object stack.`
                        : null;
                    const toggleReason = !row.writable
                      ? row.disabledReason
                      : null;

                    const presentControl = (
                      <label className="flex items-center gap-1 text-xs text-[var(--fm-text-muted)]">
                        <Checkbox
                          aria-label={`Present ${row.label}`}
                          checked={row.present}
                          disabled={Boolean(presentReason)}
                          onChange={(event) => {
                            if (!row.writable || row.kind === "magnetoelastic") {
                              return;
                            }
                            const nextPresent = event.target.checked;
                            void patchObjectStackState(row.kind, row.label, {
                              present: nextPresent,
                              ...(nextPresent ? { enabled: true } : {}),
                            });
                          }}
                        />
                        <span>Present</span>
                      </label>
                    );

                    const switchControl =
                      row.writable && row.kind !== "magnetoelastic" ? (
                        <Switch
                          aria-label={`Toggle ${row.label}`}
                          checked={row.enabled}
                          disabled={Boolean(toggleReason)}
                          onCheckedChange={(checked) => {
                            void patchObjectStackState(
                              row.kind as BackendWritableObjectInteractionKind,
                              row.label,
                              {
                                present: true,
                                enabled: checked,
                              },
                            );
                          }}
                        />
                      ) : (
                        <Badge variant="secondary">Deferred</Badge>
                      );

                    return (
                      <div
                        key={row.kind}
                        className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--fm-text)]">
                            {row.label}
                          </div>
                          <p className="truncate text-xs text-[var(--fm-text-muted)]">
                            {row.subtitle}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {presentReason ? (
                            <DisabledReason reason={presentReason}>
                              {presentControl}
                            </DisabledReason>
                          ) : (
                            presentControl
                          )}
                          {toggleReason ? (
                            <DisabledReason reason={toggleReason}>
                              <span>{switchControl}</span>
                            </DisabledReason>
                          ) : (
                            switchControl
                          )}
                          <Button
                            aria-label={`Configure ${row.label}`}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.selectNode({
                                kind: "physics.module",
                                label: row.label,
                                nodeId,
                                objectId,
                                ref: {
                                  kind: "physics.module",
                                  nodeId,
                                  physicsActivation: row.enabled
                                    ? "active"
                                    : "inactive",
                                  physicsModuleId: row.kind,
                                  physicsModuleKind: row.kind,
                                  physicsScopeKind: "object",
                                  type: "physics-module",
                                },
                              })
                            }
                          >
                            <ArrowRight aria-hidden="true" size={12} />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ),
            },
          ],
        },
        {
          id: "object-physics-transport-spin",
          title: "Charge transport, spin diffusion & torques",
          icon: Zap,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const ctReason = transportDisabledReason(
                  "interaction.current_transport",
                );
                const stReason = transportDisabledReason(
                  "interaction.spin_torque",
                );
                const oeReason = transportDisabledReason(
                  "interaction.oersted_field",
                );

                const wrapBtn = (reason: string | null, btn: ReactElement) =>
                  reason ? (
                    <DisabledReason reason={reason}>{btn}</DisabledReason>
                  ) : (
                    btn
                  );

                return (
                  <div className="flex flex-col gap-2">
                    {ctx.draft.transportAndSpinLinks.length > 0 ? (
                      <InspectorShortcutCards
                        items={ctx.draft.transportAndSpinLinks.map((l) => ({
                          id: l.id,
                          title: l.label,
                          subtitle: l.kind.replace(/_/g, " "),
                          selection: l.selection,
                        }))}
                        onSelect={ctx.selectNode}
                      />
                    ) : null}
                    <div className="grid grid-cols-2 gap-1.5">
                      {wrapBtn(
                        ctReason,
                        <Button
                          disabled={Boolean(ctReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:current-transport:draft`;
                            ctx.selectNode({
                              kind: "physics.current-transport",
                              label: "New charge transport",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                kind: "physics.current-transport",
                                nodeId: draftNodeId,
                                type: "current-transport",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Charge Transport</span>
                        </Button>,
                      )}
                      {wrapBtn(
                        stReason,
                        <Button
                          disabled={Boolean(stReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:spin-transport:draft`;
                            ctx.selectNode({
                              kind: "physics.spin-transport",
                              label: "New spin transport",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                draft: true,
                                kind: "physics.spin-transport",
                                nodeId: draftNodeId,
                                type: "spin-transport",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Spin Transport</span>
                        </Button>,
                      )}
                      {wrapBtn(
                        stReason,
                        <Button
                          disabled={Boolean(stReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:spin-torque:draft`;
                            ctx.selectNode({
                              kind: "physics.spin-torque",
                              label: "New transport torque",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                kind: "physics.spin-torque",
                                nodeId: draftNodeId,
                                type: "spin-torque",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Spin Torque</span>
                        </Button>,
                      )}
                      {wrapBtn(
                        oeReason,
                        <Button
                          disabled={Boolean(oeReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:oersted-field:draft`;
                            ctx.selectNode({
                              kind: "physics.oersted-field",
                              label: "New Oersted field",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                kind: "physics.oersted-field",
                                nodeId: draftNodeId,
                                type: "oersted-field",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Oersted Field</span>
                        </Button>,
                      )}
                    </div>
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "object-physics-global-summary",
          title: "Participating global physics",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards
                  items={[
                    {
                      id: "global-physics",
                      title: "Global Physics",
                      subtitle:
                        "Demagnetization, static Zeeman bias, thermal Brown & PBC",
                      badge: ctx.draft.demagGlobalEnabled
                        ? "Demag On"
                        : "Configure",
                      selection: buildRootSelection(
                        "physics.scope.global",
                        "model:physics:global",
                        "Global Physics",
                      ),
                    },
                  ]}
                  onSelect={ctx.selectNode}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () =>
          "Checkboxes and switches update the stack with full parameter preservation; click an arrow to configure parameters",
      },
    }),
    [
      baseline.objectName,
      mutationFeedback,
      objectId,
      patchObjectStackState,
      transportDisabledReason,
    ],
  );

  return (
    <>
      <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />
      <PhysicsInteractionHelpDialog
        content={buildModuleHelpContent("exchange", objectId)}
        open={helpOpen}
        onOpenChange={setHelpOpen}
      />
    </>
  );
}
