"use client";

import {
  Layers,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useMeshSharedDomainManifestResource,
  useMeshUniverseQualityResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import { normalizeMeshQualityStatistics, type MeshQualityMetric } from "@/shared/domain/mesh/qualityStatistics";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec, InspectorTone } from "../../template";
import { resolveMixedCertificateQualityPresentation } from "../../panels/mesh-details/MeshQualityGatesSection.model";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import { buildAirboxMeshInspectorModel, currentAirboxQualityEvidence } from "../../panels/airbox/airboxMeshInspectorModel";
import {
  asNumber,
  asRecord,
  buildFdmAirboxFactsSections,
  resolveFdmRoleEvidence,
  sanitizeStatusText,
  useSafeFdmRegionMembershipResource,
  useSafeMeshSharedDomainQualityGatesResource,
} from "../../panels/airbox/airboxSpecShared";

// ============================================================================
// 3.3 airbox.mesh.quality-gates — AirboxMeshQualityGatesInspectorSpecPanel
// ============================================================================

export function AirboxMeshQualityGatesInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const femEnabled = lane !== "fdm";

  const qualityRes = useMeshUniverseQualityResource({
    enabled: femEnabled && shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const manifestRes = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(femEnabled, runtimeStatus),
  });
  const sharedGatesRes = useSafeMeshSharedDomainQualityGatesResource({
    enabled: femEnabled && shouldLoadAirboxMeshManifest(true, runtimeStatus),
  });
  const scene = useSceneResource();

  const domainMeta = useDomainMetaResource({ enabled: lane === "fdm" });
  const fdmMembership = useSafeFdmRegionMembershipResource({
    enabled: lane === "fdm",
  });
  const multilayerLayout = useFdmMultilayerLayoutResource({
    enabled: lane === "fdm",
  });

  const currentSceneRevision =
    asNumber(asRecord(scene.data)?.scene_revision) ??
    asNumber(asRecord(scene.data)?.revision);
  const topologyIdentityMatches = matchesAirboxTopologyIdentity(
    runtimeStatus,
    manifestRes.data,
  );
  const topologyMatches =
    (manifestRes.status === "ready" && topologyIdentityMatches) ||
    (runtimeStatus === null && qualityRes.data != null);
  const currentMeshRevision =
    runtimeStatus?.resources.mesh_revision ?? qualityRes.data?.revision ?? null;

  const qualityEvidence = currentAirboxQualityEvidence(
    qualityRes,
    topologyMatches,
    currentMeshRevision,
  );

  const model = useMemo(
    () =>
      buildAirboxMeshInspectorModel({
        currentSceneRevision,
        manifest: topologyMatches ? (manifestRes.data ?? null) : null,
        policy: {
          config: null,
          effective_config: null,
          revision: qualityRes.data?.revision ?? 0,
        },
        quality: qualityEvidence,
        report: null,
        summary: null,
      }),
    [
      currentSceneRevision,
      manifestRes.data,
      qualityEvidence,
      qualityRes.data?.revision,
      topologyMatches,
    ],
  );

  const statistics = useMemo(
    () => normalizeMeshQualityStatistics(qualityEvidence?.quality),
    [qualityEvidence?.quality],
  );
  const refinementState = useMemo(
    () => resolveMeshQualityRefinementState(statistics),
    [statistics],
  );

  const mixedCertificate = useMemo(() => {
    const rawSidecar = asRecord(asRecord(sharedGatesRes.data)?.mixed_certificate);
    if (!rawSidecar) return null;
    return resolveMixedCertificateQualityPresentation(rawSidecar);
  }, [sharedGatesRes.data]);

  const selectQualityMetric = useCallback(
    (metric: MeshQualityMetric["id"]) => {
      const nodeId = `model:mesh:quality:${metric}`;
      kernel.selection?.set?.(
        {
          kind: "mesh.quality",
          label: `Mesh quality ${metric.toUpperCase()}`,
          nodeId,
          objectId: null,
          ref: {
            kind: "mesh.quality.metric",
            metric,
            nodeId,
            type: "mesh-quality-metric",
            visualizationTargetId: `mesh:quality:metric:${metric}`,
          },
        },
        "mesh",
      );
      kernel.layout?.setActiveTab?.("mesh");
    },
    [kernel],
  );

  const refineWorstRegion = useCallback(async () => {
    if (!refinementState.plan) return;
    await kernel.commands.execute(
      "mesh.refine-worst-quality-element",
      createCommandContext("inspector", kernel, {
        resourceData: {
          [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
        },
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "airbox.mesh.quality-gates",
      }),
      {
        elementIndex: refinementState.plan.elementIndex,
        meshOptions: refinementState.plan.meshOptions,
      },
    );
  }, [kernel, refinementState.plan, runtimeStatus, sessionScopeKey]);

  const roleEvidence = useMemo(
    () =>
      lane === "fdm"
        ? resolveFdmRoleEvidence(
            domainMeta.data,
            fdmMembership.data,
            fdmMembership.error ? "error" : fdmMembership.status,
            scene.data?.objects,
          )
        : null,
    [
      domainMeta.data,
      fdmMembership.data,
      fdmMembership.error,
      fdmMembership.status,
      lane,
      scene.data?.objects,
    ],
  );

  const baseline = useMemo(() => ({ scope: "airbox" }), []);

  const spec = useMemo<InspectorSpec<{ scope: string }>>(() => {
    const fdmSections =
      lane === "fdm"
        ? buildFdmAirboxFactsSections<{ scope: string }>({
            domainRes: domainMeta,
            membership: fdmMembership.data,
            multilayerLayout: multilayerLayout.data,
            roleEvidence,
            view: "quality",
          })
        : [];

    const checks = model.qualityGates.checks;
    const statusLabel =
      model.qualityGates.status === "pass"
        ? "Passed"
        : model.qualityGates.status === "fail"
          ? "Failed"
          : "Unverified";
    const statusTone: InspectorTone =
      model.qualityGates.status === "pass"
        ? "ok"
        : model.qualityGates.status === "fail"
          ? "err"
          : "neutral";

    return {
      id: "airbox.mesh.quality-gates",
      header: {
        breadcrumbs: [
          {
            id: "airbox-mesh",
            label: "Airbox Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "gates", label: "Quality Gates" },
        ],
        ...(lane !== "fdm" && refinementState.plan
          ? {
              primaryHeaderAction: {
                icon: Wrench,
                label: "Refine worst region",
                onRun: refineWorstRegion,
              },
            }
          : {}),
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:quality-gates",
        icon: ShieldCheck,
        kindLabel:
          lane === "fdm"
            ? "FDM Airbox structured-grid checks"
            : "Exterior FEM marker-0 quality gates",
        statePill: () =>
          lane === "fdm"
            ? {
                label: domainMeta.data ? "Structured" : "Not materialized",
                tone: domainMeta.data ? "ok" : "neutral",
              }
            : { label: statusLabel, tone: statusTone },
        title: () => "Airbox Quality Gates",
      },
      facts: () => [
        {
          id: "status",
          label: "Gate status",
          value: lane === "fdm" ? "FDM grid" : statusLabel,
        },
        {
          id: "checks",
          label: "Published checks",
          value: lane === "fdm" ? null : String(checks.length),
        },
        {
          id: "failed",
          label: "Failed checks",
          value:
            lane === "fdm"
              ? null
              : String(checks.filter((c) => c.status === "fail").length),
        },
        {
          id: "marker",
          label: "Marker",
          value:
            lane === "fdm" || model.qualityGates.marker === null
              ? null
              : String(model.qualityGates.marker),
        },
      ],
      sections: [
        ...fdmSections,
        {
          defaultOpen: true,
          footer: () => (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => selectQualityMetric("sicn")}
              >
                Show heatmap (SICN)
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => selectQualityMetric("gamma")}
              >
                Show heatmap (Gamma)
              </Button>
              <Button
                disabled={!refinementState.plan}
                disabledReason={sanitizeStatusText(
                  refinementState.reason,
                  "Local refinement not required",
                )}
                size="sm"
                type="button"
                variant="primary"
                onClick={() => void refineWorstRegion()}
              >
                Refine worst region
              </Button>
            </div>
          ),
          icon: ShieldCheck,
          id: "gates-summary",
          rows: [
            {
              format: () => statusLabel,
              label: "Overall qualification",
              type: "readonly",
            },
            {
              format: () =>
                sanitizeStatusText(
                  model.qualityGates.reason,
                  "No Airbox quality-gate evidence published yet.",
                ),
              label: "Evidence summary",
              type: "readonly",
            },
            {
              format: () => model.qualityGates.scope ?? "Not published",
              label: "Evaluated scope",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                model.qualityGates.marker !== null
                  ? String(model.qualityGates.marker)
                  : "Not published",
              label: "Region marker",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                sanitizeStatusText(model.qualityGates.source, "Not published"),
              label: "Quality source",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                topologyMatches
                  ? "Matches current FEM generation"
                  : manifestRes.status === "loading"
                    ? "Checking backend manifest"
                    : "Not verified against current FEM generation",
              label: "Topology identity",
              type: "readonly",
            },
            ...(checks.length > 0
              ? [
                  {
                    columns: [
                      {
                        header: "Check",
                        id: "id",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof checks)[number]).id,
                      },
                      {
                        header: "Status",
                        id: "status",
                        renderCell: (r: unknown) => {
                          const st = (r as (typeof checks)[number]).status;
                          return st === "pass"
                            ? "Passed"
                            : st === "fail"
                              ? "Failed"
                              : "Unverified";
                        },
                      },
                      {
                        align: "right" as const,
                        header: "Measured / Threshold",
                        id: "val",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const item = r as (typeof checks)[number];
                          const unitSuffix = item.unit ? ` ${item.unit}` : "";
                          const measured =
                            item.value !== null
                              ? `${Number(item.value.toPrecision(4))}${unitSuffix}`
                              : "—";
                          if (item.threshold !== null) {
                            const cmp = item.comparison ? `${item.comparison} ` : "";
                            return `${measured} (${cmp}${Number(item.threshold.toPrecision(4))}${unitSuffix})`;
                          }
                          return measured;
                        },
                      },
                    ],
                    label: "Backend Airbox quality-gate checks",
                    rowKey: (r: unknown) => (r as (typeof checks)[number]).id,
                    rows: () => checks,
                    type: "table" as const,
                    wide: true,
                  },
                ]
              : [
                  {
                    format: () =>
                      "No per-gate Airbox check rows published yet — build shared-domain mesh to evaluate.",
                    label: "Published gate checks",
                    type: "readonly" as const,
                  },
                ]),
          ],
          showWhen: () => lane !== "fdm",
          title: "Airbox marker-0 quality gates",
        },
        ...(lane !== "fdm" &&
        mixedCertificate &&
        mixedCertificate.familyGates.length > 0
          ? [
              {
                defaultOpen: true,
                icon: Layers,
                id: "mixed-certificate-gates",
                rows: [
                  {
                    format: () =>
                      sanitizeStatusText(mixedCertificate.status, "Not published"),
                    label: "Certificate status",
                    type: "readonly" as const,
                  },
                  {
                    columns: [
                      {
                        header: "Family / metric",
                        id: "fam",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const g =
                            r as (typeof mixedCertificate.familyGates)[number];
                          return `${g.family} · ${g.metric}`;
                        },
                      },
                      {
                        align: "right" as const,
                        header: "p05 / threshold",
                        id: "p05",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const g =
                            r as (typeof mixedCertificate.familyGates)[number];
                          const p05 =
                            g.p05 !== null ? g.p05.toPrecision(3) : "—";
                          const thr =
                            g.threshold !== null
                              ? g.threshold.toPrecision(3)
                              : "—";
                          return `${p05} / ${thr} (${g.passed ? "Passed" : "Failed"})`;
                        },
                      },
                      {
                        align: "right" as const,
                        header: "Jacobian",
                        id: "jac",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const g =
                            r as (typeof mixedCertificate.familyGates)[number];
                          return g.positiveJacobian ? "Positive" : "Non-positive";
                        },
                      },
                    ],
                    label: "Mixed-topology family gates",
                    rowKey: (r: unknown) => {
                      const g =
                        r as (typeof mixedCertificate.familyGates)[number];
                      return `${g.family}:${g.metric}`;
                    },
                    rows: () => mixedCertificate.familyGates,
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Mixed-topology certificate gates",
              },
            ]
          : []),
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          lane === "fdm"
            ? "Structured FDM Airbox grid verification"
            : sanitizeStatusText(refinementState.reason, "Exterior transition & shell qualification"),
      },
    };
  }, [
    domainMeta,
    fdmMembership.data,
    lane,
    manifestRes.status,
    mixedCertificate,
    model.qualityGates,
    multilayerLayout.data,
    refineWorstRegion,
    refinementState.plan,
    refinementState.reason,
    roleEvidence,
    selectQualityMetric,
    topologyMatches,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
