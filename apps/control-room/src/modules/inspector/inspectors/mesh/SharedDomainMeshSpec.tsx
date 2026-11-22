"use client";

import {
  Activity,
  Box,
  Layers,
  Ruler,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import * as meshPolicyResourceCache from "@/kernel/resources/meshPolicyResourceCache";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import {
  SpecInspectorHost,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";
import { resolveMeshEditorCapabilities } from "@/shared/domain/mesh/meshEditorCapabilityModel";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { Button } from "@/shared/ui/Button";

import {
  formatCountClean,
  MeshEditorCapabilitiesSpecView,
  MixedTopologyProvenanceSpecView,
  sanitizeMeshDisplayText,
} from "../../panels/mesh-details/MeshQualityAndHistorySpecViews";
import { resolveMeshTopologyCounts } from "../../panels/mesh-details/meshTopologyCounts";
import { resolveMixedTopologyPresentation } from "../../panels/mesh-details/MixedTopologyProvenanceSection.model";
import {
  buildSharedDomainPolicyConfig,
  draftFromEffectiveSharedDomainResource,
  draftFromSharedDomainResource,
  formatPolicyJson,
  type SharedDomainPolicyDraft,
} from "../../panels/mesh-details/sharedDomainMeshPolicyDraft";
import { recordField } from "../../panels/MeshResourceView";
import {
  asNumber,
  asRecord,
  formatLengthSmart,
  SESSION_STATUS_KEY,
  useSafeMeshCapabilitiesResource,
} from "./meshShared";

export interface SharedDomainSpecDraft {
  hMax: string;
  hMin: string;
  growthRate: string;
  curvatureFactor: string;
  narrowRegionResolution: string;
  optimize: boolean;
  optimizeMethod: string;
  configText: string;
}

export function MeshSharedDomainInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;
  const sessionStatusData = sessionStatusHooks.useSessionStatusSelector((s) => s.data);

  const scene = geometryLifecycleResources.useSceneResource();
  const policy = geometryLifecycleResources.useMeshSharedDomainPolicyResource();
  const manifest = geometryLifecycleResources.useMeshSharedDomainManifestResource();
  const summary = geometryLifecycleResources.useMeshSummaryResource();
  const semantics = geometryLifecycleResources.useMeshSemanticsResource();
  const activeBuild = geometryLifecycleResources.useMeshBuildCurrent();
  const sharedReport = geometryLifecycleResources.useMeshSharedDomainReportResource();
  const capabilities = useSafeMeshCapabilitiesResource();

  const baseline = useMemo<SharedDomainSpecDraft>(() => {
    const parsed = draftFromSharedDomainResource(policy.data ?? null);
    return {
      configText: parsed.configText,
      curvatureFactor: parsed.curvatureFactor,
      growthRate: parsed.growthRate,
      hMax: parsed.hMax,
      hMin: parsed.hMin,
      narrowRegionResolution: parsed.narrowRegionResolution,
      optimize: parsed.optimize,
      optimizeMethod: parsed.optimizeMethod || "Netgen",
    };
  }, [policy.data]);

  const counts = useMemo(
    () => resolveMeshTopologyCounts(manifest.data?.topology_counts),
    [manifest.data?.topology_counts],
  );

  const meshStatistics =
    asRecord(asRecord(semantics.data)?.mesh_build_diagnostics)?.mesh_statistics ??
    asRecord(asRecord(sharedReport.data)?.report)?.mesh_statistics ??
    null;
  const qualityStats = useMemo(
    () => normalizeMeshQualityStatistics(meshStatistics),
    [meshStatistics],
  );

  const mixedTopology = useMemo(
    () =>
      resolveMixedTopologyPresentation({
        buildReport:
          activeBuild.data?.shared_domain_build_report ??
          asRecord(asRecord(semantics.data)?.solver_mesh)?.build_report ??
          asRecord(sharedReport.data)?.report,
        manifest: manifest.data,
        rejectionEvidence: activeBuild.data?.mixed_layer_topology_rejection,
      }),
    [activeBuild.data, manifest.data, semantics.data, sharedReport.data],
  );

  const editorCapabilities = useMemo(
    () => resolveMeshEditorCapabilities(capabilities.data),
    [capabilities.data],
  );

  const handleAfterFieldChange = useCallback(
    <K extends keyof SharedDomainSpecDraft & string>(
      key: K,
      value: SharedDomainSpecDraft[K],
      helpers: {
        draft: SharedDomainSpecDraft;
        patchDraft: (partial: Partial<SharedDomainSpecDraft>) => void;
      },
    ) => {
      if (key === "configText") return;
      const merged: SharedDomainPolicyDraft = {
        authoredPresent: true,
        configText: helpers.draft.configText,
        curvatureFactor: helpers.draft.curvatureFactor,
        growthRate: helpers.draft.growthRate,
        hMax: helpers.draft.hMax,
        hMin: helpers.draft.hMin,
        narrowRegionResolution: helpers.draft.narrowRegionResolution,
        optimize: helpers.draft.optimize,
        optimizeMethod: helpers.draft.optimizeMethod,
        [key]: value,
      };
      const built = buildSharedDomainPolicyConfig(merged);
      if (built.ok) {
        helpers.patchDraft({ configText: formatPolicyJson(built.config) });
      }
    },
    [],
  );

  const spec = useMemo<InspectorSpec<SharedDomainSpecDraft>>(() => {
    const manifestRec = manifest.data;
    return {
      id: "mesh.shared-domain",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "shared", label: "Shared Domain" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:shared-domain",
        icon: Layers,
        kindLabel: "Shared-domain FEM assembly",
        statePill: () =>
          manifestRec
            ? { label: "Realized", tone: "ok" }
            : { label: "Not built", tone: "neutral" },
        title: () => "Shared-Domain Mesh",
      },
      facts: (d) => [
        {
          id: "hmax",
          label: "Global h_max",
          value: d.hMax === "auto" ? "Auto" : formatLengthSmart(asNumber(d.hMax)),
        },
        {
          id: "nodes",
          label: "Nodes",
          value:
            counts?.node_count != null
              ? counts.node_count.toLocaleString("en-US")
              : null,
        },
        {
          id: "elements",
          label: "Elements",
          value:
            counts?.element_count != null
              ? counts.element_count.toLocaleString("en-US")
              : null,
        },
        {
          id: "parts",
          label: "Mesh parts",
          value:
            manifestRec?.mesh_parts != null
              ? String(manifestRec.mesh_parts.length)
              : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          footer: (ctx) => (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  const policyEffective = asRecord(
                    asRecord(policy.data)?.effective_config,
                  );
                  const eff = draftFromEffectiveSharedDomainResource(
                    policy.data
                      ? {
                          config: policyEffective ?? policy.data.config ?? null,
                          effective_config: policyEffective ?? null,
                          revision: policy.data.revision,
                        }
                      : null,
                  );
                  ctx.patchDraft({
                    configText: eff.configText,
                    curvatureFactor: eff.curvatureFactor,
                    growthRate: eff.growthRate,
                    hMax: eff.hMax,
                    hMin: eff.hMin,
                    narrowRegionResolution: eff.narrowRegionResolution,
                    optimize: eff.optimize,
                    optimizeMethod: eff.optimizeMethod || "Netgen",
                  });
                }}
              >
                Load Effective Defaults
              </Button>
              <Button
                size="sm"
                type="button"
                variant="primary"
                onClick={() => {
                  void kernel.commands.execute(
                    "mesh.build-shared-domain",
                    createCommandContext("inspector", kernel, {
                      resourceData: {
                        ...(sessionStatusData ? { [SESSION_STATUS_KEY]: sessionStatusData } : {}),
                        ...(scene.data
                          ? { [geometryLifecycleResources.SCENE_RESOURCE_KEY]: scene.data }
                          : {}),
                        ...(capabilities.data
                          ? {
                              [geometryLifecycleResources.MESH_CAPABILITIES_RESOURCE_KEY]:
                                capabilities.data,
                            }
                          : {}),
                      },
                      sessionScopeKey: sessionScopeKey ?? null,
                      sourceDetail: "mesh.shared-domain.footer",
                    }),
                  );
                }}
              >
                Build Shared-Domain Mesh
              </Button>
            </div>
          ),
          icon: Ruler,
          id: "shared-domain-policy",
          rows: [
            {
              hint: "Positive length in meters or 'auto'",
              key: "hMax",
              label: "Global max element size (m)",
              mono: true,
              placeholder: "e.g. 5e-9 or auto",
              symbol: (
                <>
                  h<sub>max</sub>
                </>
              ),
              type: "text",
            },
            {
              key: "hMin",
              label: "Global min element size (m)",
              mono: true,
              placeholder: "e.g. 1e-9",
              symbol: (
                <>
                  h<sub>min</sub>
                </>
              ),
              type: "text",
            },
            {
              key: "growthRate",
              label: "Element growth rate",
              mono: true,
              placeholder: "e.g. 1.3",
              symbol: <>g</>,
              type: "text",
            },
            {
              key: "curvatureFactor",
              label: "Curvature factor",
              mono: true,
              placeholder: "e.g. 0.2",
              symbol: <>&kappa;</>,
              type: "text",
            },
            {
              key: "narrowRegionResolution",
              label: "Narrow region resolution",
              mono: true,
              placeholder: "e.g. 2",
              type: "text",
            },
            {
              key: "optimize",
              label: "Optimize tetrahedral quality",
              structural: true,
              type: "switch",
            },
            {
              key: "optimizeMethod",
              label: "Gmsh optimizer",
              options: [
                { label: "Netgen", value: "Netgen" },
                { label: "HighOrder", value: "HighOrder" },
                { label: "Relocate3D", value: "Relocate3D" },
              ],
              showWhen: (d) => d.optimize,
              type: "select",
            },
          ],
          title: "Shared-domain mesh policy",
        },
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "solver-mesh-identity",
          rows: [
            {
              format: () => manifestRec?.mesh_name ?? "Not built",
              label: "Mesh name",
              type: "readonly",
            },
            {
              format: () => manifestRec?.mesh_id ?? "None",
              label: "Mesh ID",
              mono: true,
              type: "readonly",
            },
            {
              format: () => manifestRec?.generation_id ?? "No generation",
              label: "Generation",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                sanitizeMeshDisplayText(manifestRec?.domain_mesh_mode, "shared-domain"),
              label: "Domain mode",
              type: "readonly",
            },
            {
              format: () =>
                manifestRec?.source_scene_revision != null
                  ? String(manifestRec.source_scene_revision)
                  : "Not published",
              label: "Source scene revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                manifestRec?.geometry_realization_revision != null
                  ? String(manifestRec.geometry_realization_revision)
                  : "Not published",
              label: "Geometry realization revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () => String(manifestRec?.mesh_parts?.length ?? 0),
              label: "Mesh parts",
              mono: true,
              type: "readonly",
            },
            {
              format: () => String(manifestRec?.object_segments?.length ?? 0),
              label: "Object segments",
              mono: true,
              type: "readonly",
            },
            {
              format: () => String(manifestRec?.regions?.length ?? 0),
              label: "Regions",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Solver mesh identity",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "mesh-counts-extents",
          rows: [
            {
              format: () => formatCountClean(counts?.node_count),
              label: "Nodes",
              mono: true,
              type: "readonly",
            },
            {
              format: () => formatCountClean(counts?.element_count),
              label: "Elements",
              mono: true,
              type: "readonly",
            },
            {
              format: () => formatCountClean(counts?.boundary_face_count),
              label: "Boundary faces",
              mono: true,
              type: "readonly",
            },
            {
              format: () => (counts ? "Shared-domain manifest" : "Not published"),
              label: "Count source",
              type: "readonly",
            },
            {
              format: () =>
                formatLengthSmart(
                  qualityStats?.edgeLength?.min ??
                    asNumber(recordField(asRecord(meshStatistics), "min_edge_length")),
                ) ?? "Not published",
              label: "Min edge",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                formatLengthSmart(
                  qualityStats?.edgeLength?.max ??
                    asNumber(recordField(asRecord(meshStatistics), "max_edge_length")),
                ) ?? "Not published",
              label: "Max edge",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                formatLengthSmart(
                  qualityStats?.edgeLength?.mean ??
                    asNumber(recordField(asRecord(meshStatistics), "mean_edge_length")),
                ) ?? "Not published",
              label: "Mean edge",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Counts & extents",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "mixed-topology-provenance",
          rows: [
            {
              render: () => <MixedTopologyProvenanceSpecView model={mixedTopology} />,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => mixedTopology.visible,
          title: "Mixed-topology provenance",
        },
        {
          defaultOpen: false,
          icon: Box,
          id: "viewport-delivery",
          rows: [
            {
              format: () =>
                summary.data?.revision != null
                  ? String(summary.data.revision)
                  : "Not published",
              label: "Backend mesh revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () => manifestRec?.generation_id ?? "Not published",
              label: "Generation",
              mono: true,
              type: "readonly",
            },
            {
              format: () => sanitizeMeshDisplayText(manifest.status, "ready"),
              label: "Manifest state",
              type: "readonly",
            },
            {
              format: () => "Tracked in Mesh Jobs",
              label: "Viewport acknowledgement",
              type: "readonly",
            },
          ],
          title: "Viewport delivery",
        },
        {
          defaultOpen: false,
          icon: Settings2,
          id: "editor-capabilities",
          rows: [
            {
              render: () => <MeshEditorCapabilitiesSpecView model={editorCapabilities} />,
              type: "custom",
              wide: true,
            },
          ],
          title: "Mesh editor capabilities",
        },
      ],
      commitBar: {
        cleanMessage: () => "Shared-domain mesh policy is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const built = buildSharedDomainPolicyConfig({
            authoredPresent: true,
            configText: draft.configText,
            curvatureFactor: draft.curvatureFactor,
            growthRate: draft.growthRate,
            hMax: draft.hMax,
            hMin: draft.hMin,
            narrowRegionResolution: draft.narrowRegionResolution,
            optimize: draft.optimize,
            optimizeMethod: draft.optimizeMethod || "Netgen",
          });
          if (!built.ok) {
            throw new Error(built.error);
          }
          const next = await kernel.api.meshing.sharedDomain.replacePolicy(
            { config: built.config },
            sessionScopeKey ? { sessionScopeKey } : undefined,
          );
          const nextRev =
            typeof next?.revision === "number" ? next.revision : `w5:${Date.now()}`;
          if (sessionScopeKey && next && typeof next.revision === "number") {
            meshPolicyResourceCache.publishCommittedMeshPolicyResource?.(
              kernel.resources,
              geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
              sessionScopeKey,
              next,
              kernel.api.resourceCacheScope,
            );
          }
          kernel.resources.invalidate(
            geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
            nextRev,
          );
          kernel.resources.invalidate(
            geometryLifecycleResources.MESH_SEMANTICS_RESOURCE_KEY,
            nextRev,
          );
          kernel.resources.invalidate(
            geometryLifecycleResources.SCENE_RESOURCE_KEY,
            `mesh-policy:shared-domain:${String(nextRev)}`,
          );
          kernel.resources.invalidate(
            SESSION_STATUS_KEY,
            `mesh-policy:shared-domain:${String(nextRev)}`,
          );
          return true;
        },
      },
    };
  }, [
    capabilities.data,
    counts,
    editorCapabilities,
    kernel,
    manifest.data,
    manifest.status,
    meshStatistics,
    mixedTopology,
    policy.data,
    qualityStats,
    scene.data,
    sessionScopeKey,
    sessionStatusData,
    summary.data,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}
