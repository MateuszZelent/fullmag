"use client";

import {
  Layers,
  Link2,
} from "lucide-react";
import {
  useMemo,
  type ReactNode,
} from "react";
import type { JsonObject } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { antennaResourceOwner } from "@/shared/domain/physics/antennaResourceOwner";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import { RadixRelatedResources } from "../../../panels/antenna/AntennaExcitationComposers";
import {
  antennaResourceDependents,
  buildAntennaResourceTransaction,
  createAntennaResourceDraft,
} from "../../../panels/antenna/AntennaResourceEditorModel";
import {
  antennaSolveTargetKey,
  antennaSolveTargetOptions,
} from "../../../panels/antenna/AntennaSolveTargetsEditorModel";
import {
  asNumber,
  asRecord,
  asString,
  canonicalResourceSelection,
  executeAntennaMergePatchTransaction,
  resolveSelectedAntennaResourceId,
  resolveSelectedObjectId,
} from "./antennaExcitationShared";

interface AntennaProjectionDraft {
  targetKey: string;
  rebindStageId: string;
}

export function AntennaProjectionInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const requestedProjId = resolveSelectedAntennaResourceId(
    selection,
    "projectionId",
    ":projection:",
  );

  const projectionRec = useMemo(() => {
    const list = scene.data?.antenna_target_projections ?? [];
    if (requestedProjId) {
      return list.find((p) => p.id === requestedProjId) ?? null;
    }
    return (
      list.find(
        (p) =>
          scene.data &&
          antennaResourceOwner(scene.data, "projection", p.id) === objectId,
      ) ??
      list[0] ??
      null
    );
  }, [objectId, requestedProjId, scene.data]);

  const projId = projectionRec?.id ?? requestedProjId ?? "proj_1";
  const targetOptions = useMemo(
    () => antennaSolveTargetOptions(scene.data),
    [scene.data],
  );
  const stageOptions = useMemo(
    () => [
      {
        label: "Keep exact current reference and asset pins",
        value: "__keep__",
      },
      ...(scene.data?.antenna_field_solve_stages ?? []).map((stage) => ({
        label: `Rebind explicitly to stage output: ${stage.id}`,
        value: stage.id,
      })),
    ],
    [scene.data],
  );

  const baseline = useMemo<AntennaProjectionDraft>(() => {
    const targetKey = projectionRec?.target
      ? antennaSolveTargetKey(projectionRec.target)
      : (targetOptions[0]?.key ?? antennaSolveTargetKey({ kind: "global" }));
    return {
      rebindStageId: "__keep__",
      targetKey,
    };
  }, [projectionRec, targetOptions]);

  const dependents = useMemo(
    () =>
      scene.data
        ? antennaResourceDependents(scene.data, "projection", projId)
        : [],
    [projId, scene.data],
  );

  const relatedSelection = useMemo(
    () => canonicalResourceSelection(selection, objectId, "projection", projId),
    [objectId, projId, selection],
  );

  const spec = useMemo<InspectorSpec<AntennaProjectionDraft>>(
    () => ({
      id: "object.antenna.projection",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "proj", label: `Projection (${projId})` },
        ],
        deleteAction: projectionRec
          ? {
              confirmDescription:
                dependents.length > 0
                  ? `Cannot remove while referenced by: ${dependents.join(", ")}.`
                  : "Removes this target projection without cascading deletion.",
              confirmTitle: () => `Remove projection ${projId}?`,
              label: "Remove projection (no cascade)",
              onDelete: async () => {
                const baseRev =
                  asNumber(sceneRec?.revision) ??
                  asNumber(sceneRec?.scene_revision) ??
                  0;
                if (scene.data && typeof scene.data.revision === "number") {
                  const baseDraft = createAntennaResourceDraft(
                    scene.data,
                    "projection",
                    projId,
                    `rm:${projId}`,
                  );
                  const tx = buildAntennaResourceTransaction(
                    scene.data,
                    "projection",
                    projId,
                    baseDraft,
                    true,
                  );
                  await executeAntennaMergePatchTransaction({
                    baseRevision: tx.base_revision ?? baseRev,
                    kernel,
                    label: `Remove antenna projection ${projId}`,
                    mergePatch: tx.merge_patch as JsonObject,
                    scene: scene.data,
                    sessionScopeKey,
                  });
                } else {
                  if (dependents.length > 0) {
                    throw new Error(
                      `Removal refused. Rebind or remove dependents first: ${dependents.join(", ")}.`,
                    );
                  }
                  const remaining = (
                    scene.data?.antenna_target_projections ?? []
                  ).filter((p) => p.id !== projId);
                  await executeAntennaMergePatchTransaction({
                    baseRevision: baseRev,
                    kernel,
                    label: `Remove antenna projection ${projId}`,
                    mergePatch: {
                      antenna_target_projections:
                        remaining as unknown as JsonObject[],
                    },
                    scene: scene.data ?? null,
                    sessionScopeKey,
                  });
                }
              },
            }
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `proj:${projId}`,
        icon: Layers,
        kindLabel: "Target carrier B_ant basis projection",
        statePill: () =>
          projectionRec
            ? { label: "Configured", tone: "ok" }
            : { label: "Missing", tone: "warn" },
        title: () => `Target Projection (${projId})`,
      },
      facts: (d) => {
        const targetLabel =
          targetOptions.find((o) => o.key === d.targetKey)?.label ?? "Global";
        const refKind =
          projectionRec &&
          "kind" in projectionRec.solution &&
          projectionRec.solution.kind === "stage_output"
            ? "Stage output"
            : "Published asset";
        return [
          { id: "target", label: "Target", value: targetLabel },
          {
            id: "stage",
            label: "Solve stage",
            value: projectionRec?.solution.stage_id ?? null,
          },
          { id: "ref", label: "Reference", value: refKind },
        ];
      },
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "projection-mapping",
          rows: [
            {
              key: "targetKey",
              label: "Target",
              options: targetOptions.map((o) => ({
                label: o.label,
                value: o.key,
              })),
              type: "select",
            },
            {
              hint: "Keeping the reference preserves its asset ID and content digest. Explicit rebind switches to a stage-output reference.",
              key: "rebindStageId",
              label: "Source binding",
              options: stageOptions,
              type: "select",
            },
          ],
          title: "Target & field-solve binding",
        },
        {
          defaultOpen: false,
          icon: Link2,
          id: "related-resources",
          live: true,
          rows: [
            {
              render: () => (
                <RadixRelatedResources
                  available={scene.status === "ready"}
                  scene={scene.data ?? null}
                  scope={scene.sessionScopeKey ?? scope}
                  selection={relatedSelection}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Related antenna resources",
        },
      ],
      details: () => [
        { label: "Projection ID", mono: true, value: projId },
        {
          label: "Output ID",
          mono: true,
          value: projectionRec?.output_id ?? null,
        },
        {
          label: "Solve stage",
          mono: true,
          value: projectionRec?.solution.stage_id ?? null,
        },
        {
          label: "Asset ID",
          mono: true,
          value:
            projectionRec && "asset_id" in projectionRec.solution
              ? projectionRec.solution.asset_id
              : null,
        },
        {
          label: "Content digest",
          mono: true,
          value:
            projectionRec && "content_digest" in projectionRec.solution
              ? projectionRec.solution.content_digest
              : null,
        },
      ],
      commitBar: {
        cleanMessage: () => "Target projection binding matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;
          const rebind =
            draft.rebindStageId === "__keep__" ? "" : draft.rebindStageId;
          if (
            scene.data &&
            projectionRec &&
            typeof scene.data.revision === "number"
          ) {
            const resourceDraft = {
              baseRevision: scene.data.revision,
              branches: [],
              key: `edit:${projId}`,
              values: { rebind, target: draft.targetKey },
            };
            const tx = buildAntennaResourceTransaction(
              scene.data,
              "projection",
              projId,
              resourceDraft,
              false,
            );
            await executeAntennaMergePatchTransaction({
              baseRevision: tx.base_revision ?? baseRev,
              kernel,
              label: `Edit antenna projection ${projId}`,
              mergePatch: tx.merge_patch as JsonObject,
              scene: scene.data,
              sessionScopeKey,
            });
            return true;
          }
          const target =
            targetOptions.find((o) => o.key === draft.targetKey)?.target ??
            ({ kind: "global" } as const);
          const existing = Array.isArray(sceneRec?.antenna_target_projections)
            ? sceneRec.antenna_target_projections
            : [];
          const nextProj = {
            ...(asRecord(projectionRec) ?? {
              id: projId,
              output_id: `${projId}:output`,
              solution: {
                kind: "stage_output",
                output_id: `${objectId}:field-solution`,
                stage_id: rebind || `${objectId}:solve-field`,
              },
            }),
            target,
          };
          const patched = projectionRec
            ? existing.map((p) =>
                asString(asRecord(p)?.id) === projId ? nextProj : p,
              )
            : [...existing, nextProj];
          await executeAntennaMergePatchTransaction({
            baseRevision: baseRev,
            kernel,
            label: `Edit antenna projection ${projId}`,
            mergePatch: {
              antenna_target_projections: patched as JsonObject[],
            },
            scene: scene.data ?? null,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      dependents,
      kernel,
      objectId,
      projId,
      projectionRec,
      relatedSelection,
      scene.data,
      scene.sessionScopeKey,
      scene.status,
      sceneRec,
      scope,
      sessionScopeKey,
      stageOptions,
      targetOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
