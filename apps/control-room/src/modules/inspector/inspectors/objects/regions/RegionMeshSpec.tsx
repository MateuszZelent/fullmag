"use client";

import {
  Gauge,
  Grid3x3,
  Hammer,
  RotateCcw,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
} from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { resolveRegionMeshLifecycle } from "@/shared/domain/mesh/regionMeshLifecycle";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DisabledReason } from "@/shared/ui/DisabledReason";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../../template";
import {
  resolveFdmObjectMeshInspectorModel,
  type FdmObjectMeshInspectorResources,
} from "../../../panels/fdmMeshInspectorModel";
import type { MeshSizeDistributionHoverBin } from "../../../panels/MeshQualityChart";
import { MeshQualityStatisticsView } from "../../../panels/MeshQualityStatisticsView";
import { emitMeshSizeHistogramHover } from "../../../panels/meshSizeHistogramHover";
import {
  buildObjectSelection,
  buildRegionSelection,
  formatLengthAuto,
  LENGTH_UNITS,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  executeRegionMutationWithHistory,
  extractSelectionTarget,
  finalizeRegionAuthoringCommit,
  resolveCanonicalRegionMeshLane,
  useDomainMetaResourceSafe,
  useFdmRegionMembershipBinaryResourceSafe,
  useFdmRegionMembershipResourceSafe,
  useMeshBuildCurrentSafe,
  useMeshRegionMembershipResourceSafe,
  useMeshRegionQualityResourceSafe,
  useRegionSessionScopeKey,
  type SceneObjectRegionPatch,
  type SceneRegionRealizationPolicy,
} from "../../../panels/region/regionInspectorHelpers";
import { formatVectorSpanAuto } from "./regionShared";

interface RegionMeshPolicyDraft {
  objectId: string;
  objectName: string;
  regionId: string;
  regionName: string;
  exists: boolean;
  realizationMode: SceneRegionRealizationPolicy;
  enableMeshPolicy: boolean;
  maxElementSize: number;
  minElementSize: number;
  transitionDistance: number;
  order: number;
}

export function ObjectRegionMeshInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const activeLane = useActiveLaneCapabilities();
  const sessionScopeKey = useRegionSessionScopeKey(kernel);
  const [buildPending, setBuildPending] = useState(false);

  const { objectId, regionId } = extractSelectionTarget(selection);

  const sceneObj: SceneObject | undefined = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const regionRec = useMemo(
    () =>
      (sceneObj?.regions?.find((r) => r.region_id === regionId) ?? null) as Record<
        string,
        unknown
      > | null,
    [regionId, sceneObj?.regions],
  );

  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const meshLaneInfo = useMemo(
    () =>
      resolveCanonicalRegionMeshLane(
        activeLaneKind === "fem" || activeLaneKind === "fdm" ? activeLaneKind : null,
        scene.data,
      ),
    [activeLaneKind, scene.data],
  );

  const femLane = meshLaneInfo.lane === "fem";
  const fdmLane = meshLaneInfo.lane === "fdm";

  const fdmDomain = useDomainMetaResourceSafe({ enabled: fdmLane });
  const fdmMembership = useFdmRegionMembershipResourceSafe({ enabled: fdmLane });
  const fdmMembershipBinary = useFdmRegionMembershipBinaryResourceSafe(regionId || null, {
    enabled: fdmLane && Boolean(regionRec) && Boolean(regionId),
    ownerObjectId: objectId,
  });
  const fdmResources = useMemo<FdmObjectMeshInspectorResources>(
    () => ({
      binary: fdmMembershipBinary,
      domain: fdmDomain,
      membership: fdmMembership,
    }),
    [fdmDomain, fdmMembership, fdmMembershipBinary],
  );
  const fdmModel = useMemo(
    () =>
      resolveFdmObjectMeshInspectorModel({
        lane: fdmLane ? "fdm" : femLane ? "fem" : "unknown",
        objectId,
        regionId: regionId || null,
        resources: fdmResources,
      }),
    [fdmLane, fdmResources, femLane, objectId, regionId],
  );

  const femMembership = useMeshRegionMembershipResourceSafe(objectId, regionId, {
    enabled: femLane && Boolean(regionRec) && Boolean(regionId),
  });
  const femActiveBuild = useMeshBuildCurrentSafe({
    enabled: femLane && Boolean(regionRec),
  });
  const femQuality = useMeshRegionQualityResourceSafe(regionId, {
    enabled: femLane && Boolean(regionRec) && Boolean(regionId),
  });
  const qualityStatistics = useMemo(
    () => normalizeMeshQualityStatistics(femQuality.data?.quality),
    [femQuality.data?.quality],
  );

  const hoverSizeDistributionBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: {
          kind: "region",
          meshPartIds: femMembership.data?.mesh_part_ids ?? [],
          objectId,
          regionId,
        },
      });
    },
    [femMembership.data?.mesh_part_ids, kernel, objectId, regionId],
  );

  const baseline = useMemo<RegionMeshPolicyDraft>(() => {
    const policy = (regionRec?.mesh_policy ?? null) as Record<string, unknown> | null;
    const topLevelPolicy =
      typeof regionRec?.realization_policy === "string"
        ? regionRec.realization_policy
        : null;
    const rawMode =
      topLevelPolicy ??
      (typeof policy?.realization_policy === "string"
        ? policy.realization_policy
        : "inherit");
    const realizationMode: SceneRegionRealizationPolicy =
      rawMode === "conformal" || rawMode === "project" ? rawMode : "inherit";

    const resolvedMax =
      typeof policy?.maximum_element_size === "number" && policy.maximum_element_size > 0
        ? policy.maximum_element_size
        : 10e-9;
    const defaultMin = Math.min(1e-9, resolvedMax * 0.5);
    const resolvedMin =
      typeof policy?.minimum_element_size === "number" && policy.minimum_element_size > 0
        ? policy.minimum_element_size
        : defaultMin;
    const resolvedTransition =
      typeof policy?.transition_distance === "number" && policy.transition_distance > 0
        ? policy.transition_distance
        : 50e-9;
    const resolvedOrder =
      typeof policy?.order === "number" && Number.isFinite(policy.order) && policy.order >= 1
        ? Math.round(policy.order)
        : 1;

    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      regionName: String(regionRec?.name ?? (regionId || "Region")),
      exists: Boolean(regionRec),
      realizationMode,
      enableMeshPolicy: Boolean(policy),
      maxElementSize: resolvedMax,
      minElementSize: resolvedMin,
      transitionDistance: resolvedTransition,
      order: resolvedOrder,
    };
  }, [objectId, regionId, regionRec, sceneObj?.name]);

  const applyMeshDraft = useCallback(
    async (draft: RegionMeshPolicyDraft): Promise<boolean> => {
      const regionPatch: SceneObjectRegionPatch = {
        realization_policy: draft.realizationMode,
        mesh_policy: draft.enableMeshPolicy
          ? {
              maximum_element_size: draft.maxElementSize,
              minimum_element_size: draft.minElementSize,
              transition_distance: draft.transitionDistance,
              order: Math.max(1, Math.round(draft.order)),
            }
          : null,
      };
      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Update mesh policy on ${draft.regionName}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-region-mesh-apply",
        mutation: async (_prep, writeOpts) =>
          kernel.api.model.patchObjectRegion(objectId, regionId, regionPatch, writeOpts),
      });
      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
      return true;
    },
    [kernel, objectId, regionId, scene.data, sessionScopeKey],
  );

  const handleBuildRegionMesh = useCallback(
    async (draft: RegionMeshPolicyDraft) => {
      if (!objectId || !regionId || buildPending) return;
      setBuildPending(true);
      try {
        if (JSON.stringify(draft) !== JSON.stringify(baseline)) {
          await applyMeshDraft(draft);
        }
        await kernel.commands.execute(
          "mesh.build-shared-domain",
          createCommandContext("inspector", kernel, {
            input: { object_id: objectId, region_id: regionId },
            sessionScopeKey: sessionScopeKey ?? undefined,
            sourceDetail: "object-region-mesh-build",
          }),
        );
      } finally {
        setBuildPending(false);
      }
    },
    [applyMeshDraft, baseline, buildPending, kernel, objectId, regionId, sessionScopeKey],
  );

  const meshPolicySupported = useMemo(() => {
    if (!femLane) return true;
    const rawLane = activeLane as unknown as Record<string, unknown> | null | undefined;
    const capabilities =
      rawLane && typeof rawLane.capabilities === "object"
        ? (rawLane.capabilities as Record<string, unknown>)
        : null;
    const gates = capabilities?.capability_gates;
    if (!gates || typeof gates !== "object") return true;
    const gate = (gates as Record<string, { status?: string } | undefined>)[
      "regions.mesh_policy"
    ];
    return !gate || gate.status !== "unsupported";
  }, [activeLane, femLane]);

  const spec = useMemo<InspectorSpec<RegionMeshPolicyDraft>>(
    () => ({
      id: "object.region.mesh",
      header: {
        breadcrumbs: [
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          {
            id: "region",
            label: baseline.regionName,
            selection: buildRegionSelection(
              objectId,
              regionId,
              "object.region",
              baseline.regionName,
            ),
          },
          { id: "mesh", label: "Mesh Policy" },
        ],
        searchable: false,
        ...(baseline.exists && femLane
          ? {
              primaryHeaderAction: {
                label: buildPending ? "Waiting for mesh build\u2026" : "Build Mesh",
                icon: Hammer,
                disabledReason: !meshPolicySupported
                  ? "Region mesh policy is not supported by the resolved backend capability."
                  : buildPending
                    ? "Mesh build is in progress."
                    : undefined,
                onRun: async (ctx) => {
                  await handleBuildRegionMesh(ctx.draft);
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "mesh",
        icon: Grid3x3,
        title: (d) => `${d.regionName} \u00b7 Mesh`,
        kindLabel: "Regional discretization policy",
        entityId: regionId || undefined,
        statePill: (d) =>
          fdmLane
            ? {
                tone: fdmModel.status === "ready" ? "ok" : "info",
                label: fdmModel.status === "ready" ? "FDM Mask" : fdmModel.status,
              }
            : d.enableMeshPolicy || d.realizationMode !== "inherit"
              ? { tone: "ok", label: "Override" }
              : { tone: "neutral", label: "Inherited" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "support", label: "Support", value: meshLaneInfo.factValue, tone: "info" },
        ...(fdmLane
          ? [
              {
                id: "fdm-cells",
                label: "Active cells",
                value:
                  fdmModel.activeCellCount !== null
                    ? fdmModel.activeCellCount.toLocaleString("en-US")
                    : null,
              },
            ]
          : [
              {
                id: "hmax",
                label: "Local h_max",
                value: d.enableMeshPolicy
                  ? formatLengthAuto(d.maxElementSize)
                  : "Inherits Object",
              },
            ]),
      ],
      notices: (): readonly InspectorNotice<RegionMeshPolicyDraft>[] => {
        const list: InspectorNotice<RegionMeshPolicyDraft>[] = [];
        if (meshLaneInfo.lane === "pending") {
          list.push({
            id: "pending-mesh-lane",
            tone: "info",
            title: "Pending study discretization",
            text: "Authored region mesh overrides are saved in ProblemIR and realized once FEM or FDM discretization is selected on Study.",
          });
        }
        if (fdmLane && fdmModel.notice) {
          list.push({
            id: "fdm-region-mesh-notice",
            tone: fdmModel.status === "error" ? "err" : "warn",
            title: "Structured-grid membership",
            text: fdmModel.notice,
          });
        }
        return list;
      },
      sections: [
        {
          id: "region-fdm-membership",
          title: "FDM structured-grid region membership",
          icon: Grid3x3,
          defaultOpen: true,
          showWhen: () => fdmLane,
          summary: () => fdmModel.status,
          rows: [
            {
              type: "readonly",
              label: "Mesh policy",
              format: () => "Execution-plan owned (read-only)",
            },
            {
              type: "readonly",
              label: "Mesh status",
              format: () => fdmModel.status,
            },
            {
              type: "readonly",
              label: "Grid origin",
              format: () =>
                fdmModel.origin ? formatVectorSpanAuto(fdmModel.origin) : "Not materialized",
            },
            {
              type: "readonly",
              label: "Grid spacing",
              format: () =>
                fdmModel.spacing
                  ? formatVectorSpanAuto(fdmModel.spacing)
                  : "Not materialized",
            },
            {
              type: "readonly",
              label: "Grid shape",
              format: () => fdmModel.shape?.join(" \u00d7 ") ?? "Not materialized",
            },
            {
              type: "readonly",
              label: "Total grid cells",
              format: () =>
                fdmModel.totalCells !== null
                  ? fdmModel.totalCells.toLocaleString("en-US")
                  : "Not materialized",
            },
            {
              type: "readonly",
              label: "Cell participation",
              format: () => {
                if (fdmModel.participation === "canonical-mask") {
                  const active = fdmModel.activeCellCount ?? 0;
                  const inactive = fdmModel.inactiveCellCount ?? 0;
                  const total = fdmModel.totalCells ?? 0;
                  const pct =
                    total > 0 ? ` (${((active / total) * 100).toPrecision(3)}%)` : "";
                  return `${active.toLocaleString("en-US")} active${pct} \u00b7 ${inactive.toLocaleString("en-US")} outside support`;
                }
                if (fdmModel.participation === "legacy-ambiguous") {
                  return "Legacy mask is ambiguous; classification withheld";
                }
                if (fdmModel.participation === "descriptor-only") {
                  return "Canonical mask descriptor available; binary mask not loaded";
                }
                return "Not materialized";
              },
            },
            {
              type: "readonly",
              label: "Region metadata",
              format: () =>
                fdmModel.metadata.length > 0
                  ? fdmModel.metadata
                      .map((entry) => `${entry.regionId} (#${entry.numericId})`)
                      .join(", ")
                  : "None for selected region",
            },
            {
              type: "readonly",
              label: "Grid fingerprint",
              mono: true,
              format: () => fdmModel.gridFingerprint ?? "Not materialized",
            },
          ],
        },
        {
          id: "region-mesh-policy",
          title: "Boundary realization & local sizing",
          icon: Grid3x3,
          defaultOpen: true,
          showWhen: () => !fdmLane,
          rows: [
            {
              key: "realizationMode",
              type: "segmented",
              label: "Interface realization",
              options: [
                { value: "inherit", label: "Inherit" },
                { value: "conformal", label: "Conformal" },
                { value: "project", label: "Project" },
              ],
            },
            {
              key: "enableMeshPolicy",
              type: "switch",
              label: "Override regional FEM mesh sizing",
              structural: true,
            },
            {
              key: "maxElementSize",
              type: "quantity",
              label: "Maximum element size",
              symbol: (
                <>
                  h<sub>max</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v) => (v > 0 ? null : "h_max must be strictly positive."),
            },
            {
              key: "minElementSize",
              type: "quantity",
              label: "Minimum element size",
              symbol: (
                <>
                  h<sub>min</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v, d) => {
                if (v <= 0) return "h_min must be strictly positive.";
                if (v > d.maxElementSize) {
                  return "Minimum element size cannot exceed maximum element size.";
                }
                return null;
              },
            },
            {
              key: "transitionDistance",
              type: "quantity",
              label: "Transition distance",
              symbol: (
                <>
                  d<sub>trans</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v) =>
                v > 0 ? null : "Transition distance must be strictly positive.",
            },
            {
              key: "order",
              type: "number",
              label: "Element order",
              integer: true,
              min: 1,
              step: 1,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v) =>
                Number.isInteger(v) && v >= 1
                  ? null
                  : "Element order must be a positive integer.",
            },
            ...(femLane
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: (ctx: { draft: RegionMeshPolicyDraft; baseline: RegionMeshPolicyDraft }) => {
                      const isDirty =
                        JSON.stringify(ctx.draft) !== JSON.stringify(ctx.baseline);
                      const lifecycle = resolveRegionMeshLifecycle({
                        build: femActiveBuild.data,
                        draftDirty: isDirty,
                        membership: femMembership.data,
                        policyEnabled: ctx.draft.enableMeshPolicy,
                        supported: meshPolicySupported,
                      });
                      const buildLabel =
                        buildPending || lifecycle.status === "pending"
                          ? "Waiting for mesh build\u2026"
                          : isDirty
                            ? "Apply & Build Mesh"
                            : "Build Mesh";
                      const disabledReason = !meshPolicySupported
                        ? lifecycle.reason
                        : buildPending || lifecycle.status === "pending"
                          ? "A mesh build is currently pending."
                          : null;

                      const buttonEl = (
                        <Button
                          disabled={Boolean(disabledReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => void handleBuildRegionMesh(ctx.draft)}
                        >
                          <Hammer aria-hidden="true" size={12} />
                          <span>{buildLabel}</span>
                        </Button>
                      );

                      return (
                        <div
                          className="flex flex-col gap-1.5 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5 text-xs"
                          data-slot="region-fem-mesh-lifecycle"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[var(--fm-text-muted)]">Mesh realization</span>
                            <Badge
                              data-tone={
                                lifecycle.status === "current"
                                  ? "ok"
                                  : lifecycle.status === "failed"
                                    ? "err"
                                    : lifecycle.status === "stale"
                                      ? "warn"
                                      : "info"
                              }
                            >
                              {lifecycle.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-[var(--fm-text-muted)]">
                            {lifecycle.reason}
                          </p>
                          {lifecycle.generationId ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[var(--fm-text-muted)]">Mesh generation</span>
                              <span className="font-mono text-[var(--fm-text)]">
                                {lifecycle.generationId}
                              </span>
                            </div>
                          ) : null}
                          {lifecycle.topologyFingerprint ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[var(--fm-text-muted)]">
                                Topology fingerprint
                              </span>
                              <span className="font-mono text-[var(--fm-text)]">
                                {lifecycle.topologyFingerprint}
                              </span>
                            </div>
                          ) : null}
                          <div className="pt-1">
                            {disabledReason ? (
                              <DisabledReason reason={disabledReason}>
                                {buttonEl}
                              </DisabledReason>
                            ) : (
                              buttonEl
                            )}
                          </div>
                        </div>
                      );
                    },
                  },
                ]
              : []),
          ],
          footer: (ctx) =>
            ctx.draft.enableMeshPolicy || ctx.draft.realizationMode !== "inherit" ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  ctx.patchDraft({
                    realizationMode: "inherit",
                    enableMeshPolicy: false,
                  })
                }
              >
                <RotateCcw aria-hidden="true" size={12} />
                <span>Reset to Inherited</span>
              </Button>
            ) : null,
        },
        {
          id: "region-fem-quality-distributions",
          title: "Region Quality Distributions",
          icon: Gauge,
          defaultOpen: true,
          showWhen: () => femLane,
          summary: () =>
            qualityStatistics?.elementCount != null
              ? `${qualityStatistics.elementCount.toLocaleString("en-US")} elements`
              : femQuality.status,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div data-slot="region-mesh-quality-statistics">
                  <MeshQualityStatisticsView
                    statistics={qualityStatistics}
                    onHoverSizeDistributionBin={hoverSizeDistributionBin}
                  />
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: fdmLane
        ? {
            mode: "readOnly",
            statusMessage: () =>
              "FDM structured-grid region membership is derived from the execution plan",
          }
        : {
            mode: "staged",
            cleanMessage: () => "Regional mesh policy matches SceneDocument",
            lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
            onApply: applyMeshDraft,
          },
    }),
    [
      applyMeshDraft,
      baseline.exists,
      baseline.objectName,
      baseline.regionName,
      buildPending,
      fdmLane,
      fdmModel,
      femActiveBuild.data,
      femLane,
      femMembership.data,
      femQuality.status,
      handleBuildRegionMesh,
      hoverSizeDistributionBin,
      meshLaneInfo.factValue,
      meshLaneInfo.lane,
      meshPolicySupported,
      objectId,
      qualityStatistics,
      regionId,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
