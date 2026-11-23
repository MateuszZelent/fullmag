"use client";

import {
  Activity,
  Eye,
  Layers,
  SlidersHorizontal,
  SquareDashed,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useKernel } from "@/kernel/KernelContext";
import {
  SCENE_RESOURCE_KEY,
  useDomainMetaResource,
  useMeshSharedDomainManifestResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { isUniverseOuterBoundaryCarrier } from "@/kernel/selection/semanticRenderTargetCatalog";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import { aggregateAirboxBounds, findAirboxParts } from "../../panels/airbox/airboxMeshInspectorModel";
import {
  asNumber,
  asRecord,
  asTuple3,
  commitStudyMergePatchWithHistory,
  isConflictApiError,
  sanitizeStatusText,
  useSafeAirboxTargetVisualization,
} from "../../panels/airbox/airboxSpecShared";
import {
  type StudyBoundarySlice,
  readStudyBoundarySlice,
  formatDemagFormulationLabel,
  buildStudyBoundaryMergePatch,
} from "./universeShared";

// ============================================================================
// 4. boundary-faces.root — BoundaryFacesRootInspectorSpecPanel
// ============================================================================

interface BoundaryFacesDraft extends StudyBoundarySlice {
  boundsVisible: boolean;
  wireframeVisible: boolean;
  areaUnit: "nm²" | "µm²" | "mm²" | "m²";
  selectedFaceId: string;
}

const AREA_SCALE: Readonly<Record<BoundaryFacesDraft["areaUnit"], number>> = {
  "m²": 1,
  "mm²": 1e6,
  "nm²": 1e18,
  "µm²": 1e12,
};

function revisionsMatch(
  currentRevision: unknown,
  sourceRevision: unknown,
): boolean {
  const isRev = (v: unknown) =>
    (typeof v === "number" && Number.isFinite(v)) ||
    (typeof v === "string" && v.length > 0);
  return (
    isRev(currentRevision) &&
    isRev(sourceRevision) &&
    String(currentRevision) === String(sourceRevision)
  );
}

export function BoundaryFacesRootInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const authoringLane = resolveAirboxInspectorAuthoringLane(
    selection,
    runtimeStatus,
  );
  const runtimeLane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const effectiveLane: "fdm" | "fem" =
    authoringLane === "fdm" || runtimeLane === "fdm" ? "fdm" : "fem";

  const meshEnabled = shouldLoadAirboxMeshManifest(true, runtimeStatus);
  const domainMeta = useDomainMetaResource();
  const scene = useSceneResource();
  const policyRes = useUniverseMeshPolicyResource();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: meshEnabled,
  });
  const viz = useSafeAirboxTargetVisualization();

  const [selectedFaceId, setSelectedFaceId] = useState("-x");
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const currentSceneRevision =
    asNumber(asRecord(scene.data)?.revision) ??
    asNumber(asRecord(scene.data)?.scene_revision);

  const carrierInventoryAvailable =
    manifest.status === "ready" &&
    scene.status === "ready" &&
    revisionsMatch(currentSceneRevision, manifest.data?.source_scene_revision) &&
    (matchesAirboxTopologyIdentity(runtimeStatus, manifest.data) ||
      runtimeStatus === null) &&
    Array.isArray(manifest.data?.mesh_parts);

  const outerBoundaryCarriers = useMemo(
    () =>
      carrierInventoryAvailable
        ? (manifest.data?.mesh_parts?.filter(isUniverseOuterBoundaryCarrier) ??
          [])
        : null,
    [carrierInventoryAvailable, manifest.data?.mesh_parts],
  );

  const boundaryFaceCount = useMemo(
    () =>
      outerBoundaryCarriers?.reduce(
        (count, carrier) => count + carrier.boundary_face_count,
        0,
      ) ?? null,
    [outerBoundaryCarriers],
  );

  const spans = useMemo<[number, number, number] | null>(() => {
    const b = domainMeta.data?.bounds;
    if (b) {
      return [
        Math.max(1e-12, b.max[0] - b.min[0]),
        Math.max(1e-12, b.max[1] - b.min[1]),
        Math.max(1e-12, b.max[2] - b.min[2]),
      ];
    }
    const mb = aggregateAirboxBounds(findAirboxParts(manifest.data?.mesh_parts));
    if (mb) {
      return [
        Math.max(1e-12, mb.max[0]! - mb.min[0]!),
        Math.max(1e-12, mb.max[1]! - mb.min[1]!),
        Math.max(1e-12, mb.max[2]! - mb.min[2]!),
      ];
    }
    const manualSz = asTuple3(asRecord(policyRes.data?.config)?.size);
    if (manualSz) {
      return [
        Math.max(1e-12, manualSz[0]),
        Math.max(1e-12, manualSz[1]),
        Math.max(1e-12, manualSz[2]),
      ];
    }
    return null;
  }, [domainMeta.data?.bounds, manifest.data?.mesh_parts, policyRes.data?.config]);

  const baseline = useMemo<BoundaryFacesDraft>(() => {
    const studySlice = readStudyBoundarySlice(scene.data, effectiveLane);
    return {
      ...studySlice,
      areaUnit: "µm²",
      boundsVisible: viz.settings.boundsVisible,
      selectedFaceId,
      wireframeVisible: viz.settings.wireframeVisible,
    };
  }, [
    effectiveLane,
    scene.data,
    selectedFaceId,
    viz.settings.boundsVisible,
    viz.settings.wireframeVisible,
  ]);

  const handleLiveFieldChange = useCallback(
    <K extends keyof BoundaryFacesDraft & string>(
      key: K,
      value: BoundaryFacesDraft[K],
    ) => {
      if (key === "boundsVisible") {
        viz.patchAirboxVisualization({ boundsVisible: Boolean(value) });
      } else if (key === "wireframeVisible") {
        viz.patchAirboxVisualization({
          visible: Boolean(value) ? true : viz.settings.visible,
          wireframeVisible: Boolean(value),
        });
      }
    },
    [viz],
  );

  const spec = useMemo<InspectorSpec<BoundaryFacesDraft>>(() => {
    const buildPatches = (draft: BoundaryFacesDraft) => {
      const [lx, ly, lz] = spans ?? [0, 0, 0];
      const baseBcLabel = formatDemagFormulationLabel(
        draft.demagFormulation,
        [],
      );
      const bcForAxis = (axis: "x" | "y" | "z") =>
        draft.periodicAxes.includes(axis)
          ? `Periodic (±${axis.toUpperCase()})`
          : baseBcLabel;

      return [
        {
          areaM2: spans ? ly * lz : null,
          axis: "x" as const,
          bc: bcForAxis("x"),
          id: "-x",
          label: "−X",
          normal: "(−1, 0, 0)",
        },
        {
          areaM2: spans ? ly * lz : null,
          axis: "x" as const,
          bc: bcForAxis("x"),
          id: "+x",
          label: "+X",
          normal: "(+1, 0, 0)",
        },
        {
          areaM2: spans ? lx * lz : null,
          axis: "y" as const,
          bc: bcForAxis("y"),
          id: "-y",
          label: "−Y",
          normal: "(0, −1, 0)",
        },
        {
          areaM2: spans ? lx * lz : null,
          axis: "y" as const,
          bc: bcForAxis("y"),
          id: "+y",
          label: "+Y",
          normal: "(0, +1, 0)",
        },
        {
          areaM2: spans ? lx * ly : null,
          axis: "z" as const,
          bc: bcForAxis("z"),
          id: "-z",
          label: "−Z",
          normal: "(0, 0, −1)",
        },
        {
          areaM2: spans ? lx * ly : null,
          axis: "z" as const,
          bc: bcForAxis("z"),
          id: "+z",
          label: "+Z",
          normal: "(0, 0, +1)",
        },
      ];
    };

    const formatArea = (
      areaM2: number | null,
      unit: BoundaryFacesDraft["areaUnit"],
    ): string => {
      if (areaM2 === null) return "Pending bounds";
      const scaled = areaM2 * AREA_SCALE[unit];
      return `${Number(scaled.toPrecision(4))} ${unit}`;
    };

    return {
      id: "boundary-faces.root",
      header: {
        breadcrumbs: [
          {
            id: "universe",
            label: "Universe",
            selection: {
              kind: "universe.root",
              label: "Universe",
              nodeId: "model:universe",
              objectId: null,
              ref: null,
            },
          },
          { id: "faces", label: "Boundary Faces" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:boundary-faces",
        icon: SquareDashed,
        kindLabel: "Universe outer boundary carriers & patches",
        statePill: () =>
          outerBoundaryCarriers !== null && outerBoundaryCarriers.length > 0
            ? { label: "Realized", tone: "ok" }
            : spans
              ? { label: "6 box patches", tone: "ok" }
              : { label: "Configured", tone: "info" },
        title: () => "Boundary Faces",
      },
      facts: (d) => {
        const patches = buildPatches(d);
        const totalAreaM2 = spans
          ? patches.reduce((acc, p) => acc + (p.areaM2 ?? 0), 0)
          : null;
        return [
          {
            id: "patches",
            label: "Patch count",
            value:
              boundaryFaceCount !== null && boundaryFaceCount > 0
                ? `6 patches (${boundaryFaceCount.toLocaleString("en-US")} facets)`
                : "6 box patches",
          },
          {
            id: "area",
            label: "Total area",
            value:
              totalAreaM2 !== null ? formatArea(totalAreaM2, d.areaUnit) : null,
          },
          {
            id: "bc",
            label: "Airbox boundary mode",
            value: formatDemagFormulationLabel(
              d.demagFormulation,
              d.periodicAxes,
            ),
          },
          {
            id: "carriers",
            label: "Outer carriers",
            value:
              outerBoundaryCarriers !== null
                ? String(outerBoundaryCarriers.length)
                : null,
          },
        ];
      },
      notices: () =>
        conflictNotice
          ? [
              {
                id: "boundary-conflict",
                quickFix: {
                  label: "Reload Scene",
                  onApply: () => {
                    scene.refetch?.();
                    setConflictNotice(null);
                  },
                },
                text: conflictNotice,
                title: "Scene revision conflict",
                tone: "err",
              },
            ]
          : [],
      modeTabs: [
        { id: "exterior", label: "Exterior Faces" },
        { id: "contacts", label: "Internal Contacts & Electrodes" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "outer-boundary-overview",
          modeTabId: "exterior",
          rows: [
            {
              render: (ctx) => (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">Patch count: 6 box faces</Badge>
                  <Badge variant="accent">
                    Airbox boundary mode:{" "}
                    {formatDemagFormulationLabel(
                      ctx.draft.demagFormulation,
                      ctx.draft.periodicAxes,
                    )}
                  </Badge>
                  {boundaryFaceCount !== null ? (
                    <Badge variant="secondary">
                      {boundaryFaceCount.toLocaleString("en-US")} mesh facets
                    </Badge>
                  ) : null}
                </div>
              ),
              type: "custom",
              wide: true,
            },
            {
              format: () => "model:boundary-faces",
              label: "Explorer address",
              mono: true,
              type: "readonly",
            },
            {
              format: () => "outer_boundary",
              label: "Semantic role",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                outerBoundaryCarriers === null
                  ? "Not built for current scene"
                  : outerBoundaryCarriers.length.toLocaleString("en-US"),
              label: "Realized outer carriers",
              type: "readonly",
            },
            {
              format: () =>
                outerBoundaryCarriers === null
                  ? "Not built for current scene"
                  : outerBoundaryCarriers.length > 0 &&
                      boundaryFaceCount !== null
                    ? boundaryFaceCount.toLocaleString("en-US")
                    : "None in published manifest",
              label: "Published boundary facets",
              type: "readonly",
            },
            {
              format: () => sanitizeStatusText(manifest.status, "Idle"),
              label: "Manifest state",
              type: "readonly",
            },
            {
              format: () =>
                "Universe outer boundary; distinct from Airbox volume and unassigned mesh parts",
              label: "Scope",
              type: "readonly",
            },
          ],
          title: "Outer boundary carrier overview",
        },
        {
          defaultOpen: true,
          footer: () =>
            viz.hasOverrides ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => viz.resetAirboxVisualization()}
              >
                Reset 3D Boundary Display
              </Button>
            ) : null,
          icon: Eye,
          id: "viewport-overlay",
          live: true,
          modeTabId: "exterior",
          rows: [
            {
              key: "boundsVisible",
              label: "Show outer boundary box in 3D",
              type: "switch",
            },
            {
              key: "wireframeVisible",
              label: "Show boundary mesh wireframe in 3D",
              type: "switch",
            },
            {
              key: "areaUnit",
              label: "Area display unit",
              options: [
                { label: "nm²", value: "nm²" },
                { label: "µm²", value: "µm²" },
                { label: "mm²", value: "mm²" },
                { label: "m²", value: "m²" },
              ],
              type: "segmented",
            },
          ],
          title: "3D boundary display & units",
        },
        {
          defaultOpen: true,
          icon: SquareDashed,
          id: "faces-table",
          modeTabId: "exterior",
          rows: [
            {
              columns: [
                {
                  header: "Face",
                  id: "face",
                  mono: true,
                  renderCell: (r) =>
                    (r as { label: string }).label,
                },
                {
                  header: "Outward n̂",
                  id: "normal",
                  mono: true,
                  renderCell: (r) =>
                    (r as { normal: string }).normal,
                },
                {
                  align: "right",
                  header: "Area",
                  id: "area",
                  mono: true,
                  renderCell: (r) =>
                    (r as { areaText: string }).areaText,
                },
                {
                  header: "Assigned BC",
                  id: "bc",
                  renderCell: (r) =>
                    (r as { bc: string }).bc,
                },
              ],
              label: "Boundary patches",
              onSelectRow: (r) => {
                setSelectedFaceId((r as { id: string }).id);
              },
              rowKey: (r) => (r as { id: string }).id,
              rows: (d) =>
                buildPatches(d).map((p) => ({
                  ...p,
                  areaText: formatArea(p.areaM2, d.areaUnit),
                })),
              type: "table",
              wide: true,
            },
          ],
          title: "Boundary patches",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "boundary-authoring",
          modeTabId: "exterior",
          rows: [
            {
              key: "demagFormulation",
              label: `Exterior boundary formulation (selected ${selectedFaceId.toUpperCase()})`,
              options:
                effectiveLane === "fdm"
                  ? [
                      { label: "Auto (Open / FFT)", value: "auto" },
                      {
                        label: "Single-grid zero-padded FFT",
                        value: "single_grid",
                      },
                      {
                        label: "Multilayer dipole convolution",
                        value: "multilayer_convolution",
                      },
                    ]
                  : [
                      { label: "Auto (Open / Asymptotic)", value: "auto" },
                      {
                        label: "Poisson Robin (1/r asymptotic decay)",
                        value: "poisson_robin",
                      },
                      {
                        label: "Poisson Dirichlet (Zero scalar potential φ_m = 0)",
                        value: "poisson_dirichlet",
                      },
                      {
                        label: "Fredkin-Koehler Hybrid FEM/BEM",
                        value: "fredkin_koehler",
                      },
                      { label: "Boundary Element (BEM)", value: "bem" },
                      { label: "Fast Multipole (FMM)", value: "fmm" },
                    ],
              type: "select",
            },
            {
              key: "periodicAxes",
              label: "Paired periodic face axes (±X, ±Y, ±Z)",
              options: [
                { label: "±X Periodic", value: "x" },
                { label: "±Y Periodic", value: "y" },
                { label: "±Z Periodic", value: "z" },
              ],
              structural: true,
              type: "toggles",
            },
            {
              key: "pbcDemag",
              label: "Periodic demagnetization kernel",
              options: [
                { label: "Open demag", value: "open" },
                { label: "Truncated periodic images", value: "truncated_images" },
                { label: "Periodic Airbox k = 0", value: "periodic_airbox_k0" },
              ],
              showWhen: (d) => d.periodicAxes.length > 0,
              structural: true,
              type: "select",
            },
            {
              integer: true,
              key: "periodicImagesX",
              label: "Macro-image count X",
              max: 64,
              min: 0,
              showWhen: (d) =>
                d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
              type: "number",
            },
            {
              integer: true,
              key: "periodicImagesY",
              label: "Macro-image count Y",
              max: 64,
              min: 0,
              showWhen: (d) =>
                d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
              type: "number",
            },
            {
              integer: true,
              key: "periodicImagesZ",
              label: "Macro-image count Z",
              max: 64,
              min: 0,
              showWhen: (d) =>
                d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
              type: "number",
            },
          ],
          title: `Exterior boundary policy (selected: ${selectedFaceId.toUpperCase()})`,
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "internal-contacts",
          modeTabId: "contacts",
          rows: [
            {
              format: () =>
                "Configure conductor terminal caps under Antenna › Terminals or Current Transport",
              label: "Electrode terminal patches",
              type: "readonly",
            },
          ],
          title: "Internal contacts & electrodes",
        },
      ],
      commitBar: {
        cleanMessage: () =>
          "Exterior boundary conditions match committed Study policy",
        mode: "staged",
        onApply: async (draft) => {
          setConflictNotice(null);
          const studyPatch = buildStudyBoundaryMergePatch(draft);
          try {
            await commitStudyMergePatchWithHistory({
              fallbackBaseRevision: currentSceneRevision ?? 0,
              kernel,
              label: "Update Universe boundary faces policy",
              runtimeStatus,
              sceneData: scene.data,
              sessionScopeKey,
              studyPatch,
            });
            return true;
          } catch (err) {
            if (isConflictApiError(err)) {
              scene.refetch?.();
              kernel.resources?.invalidate?.(
                SCENE_RESOURCE_KEY,
                `conflict:${Date.now()}`,
              );
              setConflictNotice(
                "Scene changed concurrently (HTTP 409). Latest scene fetched — review and apply again.",
              );
            }
            throw err;
          }
        },
        onRevert: () => setConflictNotice(null),
      },
    };
  }, [
    boundaryFaceCount,
    conflictNotice,
    currentSceneRevision,
    effectiveLane,
    kernel,
    manifest.status,
    outerBoundaryCarriers,
    runtimeStatus,
    scene,
    selectedFaceId,
    sessionScopeKey,
    spans,
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
