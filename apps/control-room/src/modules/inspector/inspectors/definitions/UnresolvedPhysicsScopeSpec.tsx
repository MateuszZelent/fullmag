"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  MODEL_COUPLINGS_PATH,
  MODEL_FIELD_DRIVES_PATH,
  MODEL_FROZEN_SPINS_PATH,
  MODEL_MASK_FIELD_DRIVES_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  JsonObject,
  MaskFieldDriveResource,
  RegionalFieldDriveResource,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import { useFrozenSpinsCollectionResource } from "@/kernel/resources/frozenSpinsResources";
import {
  publishCommittedSceneResource,
  useModelCouplingsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useMaskFieldDrivesResource } from "@/kernel/resources/maskAntennaResources";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/AlertDialog";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../template";
import {
  buildRootSelection,
  fallbackRevision,
  SpecInspectorHost,
} from "../../panels/model-roots/SpecInspectorHost";
import {
  isAirboxSceneObject,
  buildModelScopeMutationContext,
  extractFieldDriveItems,
  type SceneCouplingPatch,
} from "./modelScopeShared";

/* ── 9. UnresolvedPhysicsScopeInspectorPanel (`physics.scope.unresolved`) ── */

interface UnresolvedItem {
  id: string;
  kind: string;
  reason: string;
}

interface UnresolvedPhysicsDraft {
  targetObjectId: string;
  items: readonly UnresolvedItem[];
  graphStatus: string;
}

export function UnresolvedPhysicsScopeInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const fieldDrivesRes = useFieldDrivesResource();
  const maskDrivesRes = useMaskFieldDrivesResource();
  const couplingsRes = useModelCouplingsResource();
  const frozenSpinsRes = useFrozenSpinsCollectionResource({ enabled: true });
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const objects = useMemo(
    () => (scene.data?.objects ?? []).filter((o) => !isAirboxSceneObject(o)),
    [scene.data?.objects],
  );
  const objectIds = useMemo(() => new Set(objects.map((o) => o.id)), [objects]);

  const unresolvedItems = useMemo<readonly UnresolvedItem[]>(() => {
    const g = (physicsGraph.data ?? null) as Record<string, unknown> | null;
    const mods = Array.isArray(g?.modules) ? (g.modules as Record<string, unknown>[]) : [];
    const found: UnresolvedItem[] = [];
    for (const mod of mods) {
      const id = String(mod.id ?? "");
      const kind = String(mod.kind ?? "module");
      const scopes = Array.isArray(mod.applies_to)
        ? (mod.applies_to as Record<string, unknown>[])
        : [];
      if (scopes.length === 0) {
        found.push({ id, kind, reason: "Module has no target scope assigned." });
        continue;
      }
      for (const sc of scopes) {
        if (sc.kind === "unresolved") {
          found.push({
            id,
            kind,
            reason: String(sc.reason ?? "Target scope could not be resolved."),
          });
        } else if (
          (sc.kind === "object" || sc.kind === "region") &&
          typeof sc.object_id === "string" &&
          objects.length > 0 &&
          !objectIds.has(sc.object_id)
        ) {
          found.push({
            id,
            kind,
            reason: `Target object "${sc.object_id}" is absent from the scene.`,
          });
        }
      }
    }
    return found;
  }, [objectIds, objects.length, physicsGraph.data]);

  const baseline = useMemo<UnresolvedPhysicsDraft>(
    () => ({
      targetObjectId: objects[0]?.id ?? "",
      items: unresolvedItems,
      graphStatus: physicsGraph.status,
    }),
    [objects, physicsGraph.status, unresolvedItems],
  );

  const objectOptions = useMemo(
    () =>
      objects.map((obj) => ({
        value: obj.id,
        label: `${obj.name ?? obj.id} (${obj.id})`,
      })),
    [objects],
  );

  const handleDeleteOrphanDrives = useCallback(async () => {
    setConfirmClearOpen(false);
    const { context } = buildModelScopeMutationContext(
      kernel,
      scene.data,
      scene.sessionScopeKey,
    );
    await runAuthoringMutationWithHistory(
      context,
      "Delete orphaned physics modules",
      async ({ baseRevision: capturedRev }) => {
        let rev = capturedRev ?? scene.data?.revision ?? null;
        for (const item of unresolvedItems) {
          if (item.kind === "regional_field_drive") {
            const res = await kernel.api.model
              .deleteFieldDrive(item.id, { base_revision: rev })
              .catch(() => null);
            if (res && typeof res.scene_revision === "number") rev = res.scene_revision;
          } else if (item.kind === "mask_field_drive") {
            const res = await kernel.api.model
              .deleteMaskFieldDrive(item.id, { base_revision: rev })
              .catch(() => null);
            if (res && typeof res.scene_revision === "number") rev = res.scene_revision;
          } else if (item.kind === "coupling") {
            const res = await kernel.api.model
              .deleteCoupling(item.id, { baseRevision: rev ?? undefined })
              .catch(() => null);
            if (res && typeof res.scene_revision === "number") rev = res.scene_revision;
          } else if (item.kind === "frozen_spins" || item.kind === "magnetization_constraint") {
            await kernel.api.model.frozenSpins
              .delete?.(item.id, {
                expected_revision: frozenSpinsRes.data?.revision ?? rev ?? 0,
              })
              ?.catch(() => null);
          }
        }
        return rev;
      },
    );
    const rev = fallbackRevision(null);
    kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
    kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
    kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, rev);
    kernel.resources.invalidate(MODEL_COUPLINGS_PATH, rev);
    kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, rev);
    kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
  }, [
    frozenSpinsRes.data?.revision,
    kernel,
    scene.data,
    scene.sessionScopeKey,
    unresolvedItems,
  ]);

  const spec = useMemo<InspectorSpec<UnresolvedPhysicsDraft>>(
    () => ({
      id: "physics.scope.unresolved",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "unresolved", label: "Unresolved Physics" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: AlertTriangle,
        title: () => "Unresolved Physics",
        kindLabel: "Diagnostic scope recovery",
        entityId: "model:physics:unresolved",
        statePill: (draft) =>
          draft.items.length > 0
            ? { tone: "err", label: `${draft.items.length} unresolved` }
            : draft.graphStatus === "loading"
              ? { tone: "info", label: "Loading graph" }
              : { tone: "warn", label: "Graph diagnostic" },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "count", label: "Orphaned modules", value: String(draft.items.length), tone: "err" },
        { id: "objects", label: "Candidate targets", value: String(objectOptions.length) },
      ],
      notices: (draft): readonly InspectorNotice<UnresolvedPhysicsDraft>[] =>
        draft.items.length > 0
          ? draft.items.map((item) => ({
              id: `unresolved-${item.id}`,
              tone: "err",
              title: `${item.kind} \u00b7 ${item.id}`,
              text: item.reason,
            }))
          : [
              {
                id: "physics-graph-refresh",
                tone: "warn",
                title: "Physics graph synchronization",
                text: "Refresh the canonical physics graph resource or inspect object-level physics switches.",
                quickFix: {
                  label: "Refresh physics graph",
                  onApply: () => {
                    kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(null));
                  },
                },
              },
            ],
      sections: [
        {
          id: "unresolved-repair",
          title: "Rebind or remove orphaned modules",
          icon: AlertTriangle,
          defaultOpen: true,
          rows: [
            {
              key: "targetObjectId",
              type: "select",
              label: "Replacement target object",
              options:
                objectOptions.length > 0
                  ? objectOptions
                  : [
                      {
                        value: "",
                        label: "No scene objects available",
                        disabledReason: "Create a scene object first.",
                      },
                    ],
              disabledReason: () =>
                objectOptions.length === 0
                  ? "Create a scene object before rebinding orphaned physics modules."
                  : null,
            },
          ],
          footer: () => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() =>
                  kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(null))
                }
              >
                Refresh Graph
              </Button>
              {unresolvedItems.length > 0 ? (
                <Button
                  size="sm"
                  type="button"
                  variant="danger"
                  onClick={() => setConfirmClearOpen(true)}
                >
                  <Trash2 aria-hidden="true" size={12} />
                  <span>Delete Orphaned Modules</span>
                </Button>
              ) : null}
            </div>
          ),
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (draft) => Boolean(draft.targetObjectId) && draft.items.length > 0,
        applyLabel: "Rebind Orphaned Modules",
        cleanMessage: () => "Choose a replacement object to rebind unresolved modules",
        lockReason: (draft) =>
          !draft.targetObjectId
            ? "Select a valid target object to rebind."
            : draft.items.length === 0
              ? "No unresolved physics modules require rebinding."
              : null,
        onApply: async (draft) => {
          if (!draft.targetObjectId || draft.items.length === 0) return false;
          const { context } = buildModelScopeMutationContext(
            kernel,
            scene.data,
            scene.sessionScopeKey,
          );
          const reqOptions = scene.sessionScopeKey
            ? { sessionScopeKey: scene.sessionScopeKey }
            : undefined;

          const cachedRegional = extractFieldDriveItems(fieldDrivesRes.data);
          const sceneRegional = extractFieldDriveItems(scene.data?.field_drives);
          const cachedMask = extractFieldDriveItems(maskDrivesRes.data);
          const sceneMask = Array.isArray(
            (scene.data?.field_drives as Record<string, unknown> | undefined)?.mask_drives,
          )
            ? ((scene.data!.field_drives as Record<string, unknown>).mask_drives as Record<
                string,
                unknown
              >[])
            : [];
          const cachedCouplings =
            (couplingsRes.data as { couplings?: unknown[]; items?: unknown[] } | null)
              ?.couplings ??
            (couplingsRes.data as { items?: unknown[] } | null)?.items ??
            scene.data?.couplings ??
            [];

          let latestRev: number | null = scene.data?.revision ?? null;

          await runAuthoringMutationWithHistory(
            context,
            `Rebind unresolved physics to ${draft.targetObjectId}`,
            async ({ baseRevision: capturedRev }) => {
              latestRev = capturedRev ?? latestRev;
              const mergePatch: Record<string, unknown> = {};

              for (const item of draft.items) {
                if (item.kind === "regional_field_drive") {
                  let found =
                    cachedRegional.find((d) => String(d.id ?? "") === item.id) ??
                    sceneRegional.find((d) => String(d.id ?? "") === item.id);
                  if (!found && typeof kernel.api.model.fieldDrives === "function") {
                    const listRes = await kernel.api.model.fieldDrives().catch(() => null);
                    found = (listRes?.drives?.find((d) => d.id === item.id) ?? undefined) as
                      | Record<string, unknown>
                      | undefined;
                  }
                  if (found) {
                    const payload = {
                      base_revision: latestRev,
                      drive: {
                        ...(found as unknown as RegionalFieldDriveResource),
                        target: { kind: "object" as const, object_id: draft.targetObjectId },
                      },
                    };
                    const res = reqOptions
                      ? await kernel.api.model.replaceFieldDrive(item.id, payload, reqOptions)
                      : await kernel.api.model.replaceFieldDrive(item.id, payload);
                    latestRev = res.scene_revision;
                    publishCommittedSceneResource(
                      kernel.resources,
                      res.committed_scene,
                      res.scene_revision,
                    );
                  }
                } else if (item.kind === "mask_field_drive") {
                  let found =
                    cachedMask.find((d) => String(d.id ?? "") === item.id) ??
                    sceneMask.find((d) => String(d.id ?? "") === item.id);
                  const modelRec = kernel.api.model as unknown as Record<string, unknown>;
                  if (!found && typeof modelRec.maskFieldDrives === "function") {
                    const listRes = (await (
                      modelRec.maskFieldDrives as () => Promise<{
                        drives?: Record<string, unknown>[];
                        items?: Record<string, unknown>[];
                      }>
                    )().catch(() => null));
                    found = (listRes?.drives ?? listRes?.items ?? []).find(
                      (d) => String(d.id ?? "") === item.id,
                    );
                  }
                  if (found) {
                    const payload = {
                      base_revision: latestRev,
                      drive: {
                        ...(found as unknown as MaskFieldDriveResource),
                        target: { kind: "object" as const, object_id: draft.targetObjectId },
                      },
                    };
                    const res = reqOptions
                      ? await kernel.api.model.replaceMaskFieldDrive(item.id, payload, reqOptions)
                      : await kernel.api.model.replaceMaskFieldDrive(item.id, payload);
                    latestRev = res.scene_revision;
                    publishCommittedSceneResource(
                      kernel.resources,
                      res.committed_scene,
                      res.scene_revision,
                    );
                  }
                } else if (item.kind === "coupling") {
                  const found = cachedCouplings.find((entry) => {
                    const rec = entry as Record<string, unknown>;
                    return String(rec.coupling_id ?? rec.id ?? "") === item.id;
                  }) as Record<string, unknown> | undefined;
                  const epA = (found?.source ?? found?.endpoint_a ?? null) as Record<
                    string,
                    unknown
                  > | null;
                  const epB = (found?.target ?? found?.endpoint_b ?? null) as Record<
                    string,
                    unknown
                  > | null;
                  const aId = String(epA?.object ?? epA?.object_id ?? "");
                  const bId = String(epB?.object ?? epB?.object_id ?? "");
                  const aMissing = !aId || !objectIds.has(aId);
                  const bMissing = !bId || !objectIds.has(bId);
                  const couplingPatch: SceneCouplingPatch = {
                    ...(aMissing || (!aMissing && !bMissing)
                      ? { source: { kind: "object", object: draft.targetObjectId } }
                      : {}),
                    ...(bMissing
                      ? { target: { kind: "object", object: draft.targetObjectId } }
                      : {}),
                  };
                  const res = await kernel.api.model.patchCoupling(item.id, couplingPatch, {
                    baseRevision: latestRev ?? undefined,
                    ...(reqOptions ?? {}),
                  });
                  latestRev = res.scene_revision;
                  publishCommittedSceneResource(
                    kernel.resources,
                    res.committed_scene,
                    res.scene_revision,
                  );
                } else if (
                  item.kind === "frozen_spins" ||
                  item.kind === "magnetization_constraint"
                ) {
                  const found = (frozenSpinsRes.data?.definitions ?? []).find(
                    (d) => d.id === item.id,
                  );
                  if (found) {
                    const payload = {
                      expected_revision: frozenSpinsRes.data?.revision ?? latestRev ?? 0,
                      definition: {
                        ...found,
                        selector: { kind: "in_object" as const, object_id: draft.targetObjectId },
                      },
                    };
                    if (reqOptions) {
                      await kernel.api.model.frozenSpins.patch(item.id, payload, reqOptions);
                    } else {
                      await kernel.api.model.frozenSpins.patch(item.id, payload);
                    }
                  }
                } else {
                  const collectionKey =
                    item.kind === "spin_torque"
                      ? "spin_torques"
                      : item.kind === "oersted_field"
                        ? "oersted_fields"
                        : item.kind === "current_transport"
                          ? "current_transports"
                          : item.kind === "spin_transport"
                            ? "spin_transports"
                            : null;
                  if (collectionKey && scene.data) {
                    const sceneRec = scene.data as unknown as Record<string, unknown>;
                    const list = Array.isArray(sceneRec[collectionKey])
                      ? (sceneRec[collectionKey] as Record<string, unknown>[])
                      : [];
                    if (list.some((entry) => String(entry.id ?? "") === item.id)) {
                      mergePatch[collectionKey] = list.map((entry) =>
                        String(entry.id ?? "") === item.id
                          ? { ...entry, object_id: draft.targetObjectId }
                          : entry,
                      );
                    }
                  }
                }
              }

              if (Object.keys(mergePatch).length > 0) {
                const payload = {
                  kind: "merge_patch" as const,
                  base_revision: latestRev ?? 0,
                  merge_patch: mergePatch as JsonObject,
                };
                const tx = reqOptions
                  ? await kernel.api.model.commitTransaction(payload, reqOptions)
                  : await kernel.api.model.commitTransaction(payload);
                latestRev = tx.scene_revision;
                publishCommittedSceneResource(
                  kernel.resources,
                  tx.committed_scene,
                  tx.scene_revision,
                );
              }
              return latestRev;
            },
          );

          const rev = fallbackRevision(latestRev);
          kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
          kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
          kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, rev);
          kernel.resources.invalidate(MODEL_COUPLINGS_PATH, rev);
          kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, rev);
          kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
          return true;
        },
      },
    }),
    [
      couplingsRes.data,
      fieldDrivesRes.data,
      frozenSpinsRes.data?.definitions,
      frozenSpinsRes.data?.revision,
      kernel,
      maskDrivesRes.data,
      objectIds,
      objectOptions,
      scene.data,
      scene.sessionScopeKey,
      unresolvedItems.length,
    ],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete orphaned physics modules?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes unresolved physics modules whose target object was deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteOrphanDrives()}>
              Delete modules
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}
