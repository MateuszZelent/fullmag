"use client";

import {
  Box,
  Eye,
  Layers,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useMeshSharedDomainManifestResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import {
  aggregateAirboxBounds,
  aggregateAirboxMeshParts,
  findAirboxParts,
  findCanonicalAirboxPart,
} from "../../panels/airbox/airboxMeshInspectorModel";
import {
  buildFdmAirboxFactsSections,
  formatTupleSmart,
  resolveFdmRoleEvidence,
  useSafeAirboxTargetVisualization,
  useSafeFdmRegionMembershipResource,
} from "../../panels/airbox/airboxSpecShared";

// ============================================================================
// 3.5 airbox.mesh.topology — AirboxMeshTopologyInspectorSpecPanel
// ============================================================================

interface AirboxTopologyLiveDraft {
  airboxVisible: boolean;
  wireframeVisible: boolean;
  boundsVisible: boolean;
}

export function AirboxMeshTopologyInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const femEnabled = lane !== "fdm";

  const manifestRes = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(femEnabled, runtimeStatus),
  });
  const scene = useSceneResource({ enabled: lane === "fdm" });
  const domainMeta = useDomainMetaResource({ enabled: lane === "fdm" });
  const fdmMembership = useSafeFdmRegionMembershipResource({
    enabled: lane === "fdm",
  });
  const multilayerLayout = useFdmMultilayerLayoutResource({
    enabled: lane === "fdm",
  });

  const viz = useSafeAirboxTargetVisualization();

  const topologyIdentityMatches = matchesAirboxTopologyIdentity(
    runtimeStatus,
    manifestRes.data,
  );
  const topologyMatches =
    (manifestRes.status === "ready" && topologyIdentityMatches) ||
    (runtimeStatus === null && manifestRes.data != null);
  const currentManifest = topologyMatches ? (manifestRes.data ?? null) : null;

  const airboxParts = useMemo(
    () => findAirboxParts(currentManifest?.mesh_parts),
    [currentManifest?.mesh_parts],
  );
  const aggregate = useMemo(
    () => aggregateAirboxMeshParts(airboxParts),
    [airboxParts],
  );
  const bounds = useMemo(
    () => aggregateAirboxBounds(airboxParts),
    [airboxParts],
  );
  const canonicalCarrier = useMemo(
    () => findCanonicalAirboxPart(currentManifest?.mesh_parts),
    [currentManifest?.mesh_parts],
  );

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

  const baseline = useMemo<AirboxTopologyLiveDraft>(
    () => ({
      airboxVisible: viz.settings.visible,
      boundsVisible: viz.settings.boundsVisible,
      wireframeVisible: viz.settings.wireframeVisible,
    }),
    [
      viz.settings.boundsVisible,
      viz.settings.visible,
      viz.settings.wireframeVisible,
    ],
  );

  const handleLiveFieldChange = useCallback(
    <K extends keyof AirboxTopologyLiveDraft & string>(
      key: K,
      value: AirboxTopologyLiveDraft[K],
    ) => {
      if (key === "airboxVisible") {
        viz.patchAirboxVisualization({ visible: Boolean(value) });
      } else if (key === "wireframeVisible") {
        viz.patchAirboxVisualization({
          visible: Boolean(value) ? true : viz.settings.visible,
          wireframeVisible: Boolean(value),
        });
      } else if (key === "boundsVisible") {
        viz.patchAirboxVisualization({ boundsVisible: Boolean(value) });
      }
    },
    [viz],
  );

  const spec = useMemo<InspectorSpec<AirboxTopologyLiveDraft>>(() => {
    const fdmSections =
      lane === "fdm"
        ? buildFdmAirboxFactsSections<AirboxTopologyLiveDraft>({
            domainRes: domainMeta,
            membership: fdmMembership.data,
            multilayerLayout: multilayerLayout.data,
            roleEvidence,
            view: "topology",
          })
        : [];

    const hasExplicitNodeIndices =
      airboxParts.length > 0 &&
      airboxParts.every((p) => Array.isArray(p.node_indices));
    const hasExplicitBoundaryIndices =
      airboxParts.length > 0 &&
      airboxParts.every((p) => Array.isArray(p.boundary_face_indices));

    return {
      id: "airbox.mesh.topology",
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
          { id: "topology", label: "Topology" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: selection.nodeId ?? "model:airbox:mesh:topology",
        icon: Layers,
        kindLabel:
          lane === "fdm"
            ? "FDM structured Airbox topology"
            : "Published shared-domain Airbox carrier topology",
        statePill: () =>
          lane === "fdm"
            ? {
                label: domainMeta.data ? "Structured" : "Not materialized",
                tone: domainMeta.data ? "ok" : "neutral",
              }
            : currentManifest
              ? {
                  label: `${aggregate.carrierCount} carrier${aggregate.carrierCount === 1 ? "" : "s"}`,
                  tone: "ok",
                }
              : manifestRes.status === "ready" && !topologyIdentityMatches
                ? { label: "Stale identity", tone: "stale" }
                : { label: "Not built", tone: "neutral" },
        title: () => "Airbox Mesh Topology",
      },
      facts: () => [
        {
          id: "carriers",
          label: "Carriers",
          value:
            lane !== "fdm" && currentManifest
              ? String(aggregate.carrierCount)
              : null,
        },
        {
          id: "nodes",
          label: "Unique nodes",
          value:
            lane !== "fdm" && aggregate.nodeCount !== null
              ? aggregate.nodeCount.toLocaleString("en-US")
              : null,
        },
        {
          id: "elems",
          label: "Elements",
          value:
            lane !== "fdm" && aggregate.elementCount !== null
              ? aggregate.elementCount.toLocaleString("en-US")
              : null,
        },
        {
          id: "bfaces",
          label: "Boundary faces",
          value:
            lane !== "fdm" && aggregate.boundaryFaceCount !== null
              ? aggregate.boundaryFaceCount.toLocaleString("en-US")
              : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Eye,
          id: "live-airbox-display",
          live: true,
          rows: [
            {
              key: "airboxVisible",
              label: "Show Airbox target in 3D",
              type: "switch",
            },
            {
              key: "wireframeVisible",
              label: "Highlight Airbox mesh edges & interfaces in 3D",
              type: "switch",
            },
            {
              key: "boundsVisible",
              label: "Show Airbox bounding box in 3D",
              type: "switch",
            },
          ],
          title: "3D Airbox & interface display",
        },
        ...fdmSections,
        {
          defaultOpen: true,
          icon: Layers,
          id: "manifest-carrier-provenance",
          rows: [
            {
              format: () => "airbox",
              label: "Canonical target",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                topologyMatches
                  ? "Matches current published FEM generation"
                  : manifestRes.status === "ready" && !topologyIdentityMatches
                    ? "Cached manifest does not match current FEM generation"
                    : manifestRes.status === "loading"
                      ? "Checking backend manifest"
                      : "No published FEM manifest",
              label: "Topology identity",
              type: "readonly",
            },
            {
              copyText: () => currentManifest?.mesh_id ?? null,
              format: () => currentManifest?.mesh_id ?? "Not published",
              label: "Mesh ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => currentManifest?.generation_id ?? null,
              format: () => currentManifest?.generation_id ?? "Not published",
              label: "Generation ID",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                currentManifest?.revision !== undefined
                  ? String(currentManifest.revision)
                  : "Not published",
              label: "Manifest revision",
              type: "readonly",
            },
            {
              format: () =>
                currentManifest?.geometry_realization_revision != null
                  ? String(currentManifest.geometry_realization_revision)
                  : "Not published",
              label: "Geometry realization revision",
              type: "readonly",
            },
            {
              format: () =>
                currentManifest?.source_scene_revision != null
                  ? String(currentManifest.source_scene_revision)
                  : "Not published",
              label: "Source scene revision",
              type: "readonly",
            },
            {
              copyText: () => currentManifest?.topology_fingerprint ?? null,
              format: () =>
                currentManifest?.topology_fingerprint ?? "Not published",
              label: "Topology fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => canonicalCarrier?.id ?? null,
              format: () => canonicalCarrier?.id ?? "Not published",
              label: "Primary carrier ID",
              mono: true,
              type: "readonly",
            },
            {
              format: () => canonicalCarrier?.role ?? "Not published",
              label: "Primary carrier role",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                bounds ? formatTupleSmart(bounds.min) : "Not published",
              label: "Bounds min (full Airbox extent)",
              type: "readonly",
            },
            {
              format: () =>
                bounds ? formatTupleSmart(bounds.max) : "Not published",
              label: "Bounds max (full Airbox extent)",
              type: "readonly",
            },
            {
              format: () =>
                hasExplicitNodeIndices
                  ? "Explicit node_indices (deduplicated carrier coverage)"
                  : aggregate.nodeCountExact
                    ? "Deduplicated published carrier coverage"
                    : "Published per-carrier counts",
              label: "Node-count source",
              type: "readonly",
            },
            {
              format: () =>
                hasExplicitBoundaryIndices
                  ? "Explicit boundary_face_indices"
                  : aggregate.boundaryFaceCount !== null
                    ? "Published per-carrier ranges"
                    : "Not published",
              label: "Boundary-face source",
              type: "readonly",
            },
            {
              format: () =>
                "Shared magnetic-to-air interface nodes remain conforming in the shared-domain mesh.",
              label: "Shared-interface conformity",
              type: "readonly",
            },
          ],
          showWhen: () => lane !== "fdm",
          title: "Manifest topology & carrier provenance",
        },
        ...(lane !== "fdm" && airboxParts.length > 0
          ? [
              {
                defaultOpen: true,
                icon: Box,
                id: "airbox-carriers-table",
                rows: [
                  {
                    columns: [
                      {
                        header: "Carrier ID",
                        id: "id",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof airboxParts)[number]).id,
                      },
                      {
                        header: "Role",
                        id: "role",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof airboxParts)[number]).role ?? "airbox",
                      },
                      {
                        align: "right" as const,
                        header: "Elements",
                        id: "elems",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (
                            r as (typeof airboxParts)[number]
                          ).element_count.toLocaleString("en-US"),
                      },
                      {
                        align: "right" as const,
                        header: "Boundary faces",
                        id: "bfaces",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (
                            r as (typeof airboxParts)[number]
                          ).boundary_face_count.toLocaleString("en-US"),
                      },
                    ],
                    label: "Published Airbox mesh parts",
                    rowKey: (r: unknown) =>
                      (r as (typeof airboxParts)[number]).id,
                    rows: () => airboxParts,
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Published Airbox carriers",
              },
            ]
          : []),
      ],
      commitBar: {
        hasOverrides: () => viz.hasOverrides,
        mode: "liveViewport",
        onResetDisplay: () => {
          viz.resetAirboxVisualization();
        },
        statusMessage: "Live 3D Airbox & conforming carrier topology",
      },
    };
  }, [
    aggregate,
    airboxParts,
    bounds,
    canonicalCarrier,
    currentManifest,
    domainMeta,
    fdmMembership.data,
    lane,
    manifestRes.status,
    multilayerLayout.data,
    roleEvidence,
    selection.nodeId,
    topologyIdentityMatches,
    topologyMatches,
    viz,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleLiveFieldChange}
    />
  );
}
