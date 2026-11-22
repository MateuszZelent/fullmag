"use client";

import {
  Activity,
  AlertTriangle,
  Box,
  Compass,
  Eye,
  Grid3x3,
  Layers,
  Radar,
  Ruler,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useMeshSharedDomainManifestResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { shouldLoadRuntimeMeshBuild } from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionResourceIdentity,
} from "@/kernel/resources/useSessionStatus";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { isUniverseOuterBoundaryCarrier } from "@/kernel/selection/semanticRenderTargetCatalog";
import { buildUniverseDomainPolicyPresentation } from "@/shared/domain/mesh/domainPresentation";
import { resolveFdmMultilayerAirboxTarget } from "@/shared/domain/mesh/fdmMultilayerAirboxTarget";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";
import {
  aggregateAirboxBounds,
  aggregateAirboxMeshParts,
  findAirboxParts,
  findCanonicalAirboxPart,
} from "./airboxMeshInspectorModel";
import {
  draftFromEffectiveUniverseMeshPolicyResource,
  formatUniverseMeshPolicyConfig,
  type AirboxMeshPolicyLane,
} from "./airboxMeshPolicyDraft";
import {
  asNumber,
  asRecord,
  asString,
  asTuple3,
  commitStudyMergePatchWithHistory,
  computeSceneObjectsEnvelope,
  formatLengthSmart,
  formatTupleSmart,
  isConflictApiError,
  LENGTH_UNITS,
  resolveFdmRoleEvidence,
  sanitizeStatusText,
  submitCanonicalUniversePolicy,
  useSafeAirboxTargetVisualization,
  useSafeFdmRegionMembershipResource,
  useSafeFieldMetaResource,
  useSafeGeometryDiagnosticsResource,
  useSafeMeshBuildCurrent,
  type JsonRecord,
} from "./airboxSpecShared";
import { resolveFdmUniverseExtentModel } from "./fdmUniverseExtentModel";

export {
  AirboxMeshBuildInspectorSpecPanel,
  AirboxMeshInspectorSpecPanel,
  AirboxMeshParametersInspectorSpecPanel,
  AirboxMeshQualityGatesInspectorSpecPanel,
  AirboxMeshStatisticsInspectorSpecPanel,
  AirboxMeshTopologyInspectorSpecPanel,
} from "./airboxMeshSubSpecs";

const FEM_ONLY_POLICY_KEYS = [
  "airbox_grading",
  "airbox_growth_rate",
  "airbox_hmax",
  "airbox_hmin",
  "airbox_curvature_factor",
  "airbox_narrow_region_resolution",
  "curvature_factor",
  "narrow_region_resolution",
  "maximum_element_size",
  "minimum_element_size",
] as const;

type DemagFormulationChoice =
  | "auto"
  | "poisson_robin"
  | "poisson_dirichlet"
  | "fredkin_koehler"
  | "bem"
  | "fmm"
  | "single_grid"
  | "multilayer_convolution";

type PbcDemagChoice = "open" | "truncated_images" | "periodic_airbox_k0";

interface StudyBoundarySlice {
  demagFormulation: DemagFormulationChoice;
  periodicAxes: readonly string[];
  pbcDemag: PbcDemagChoice;
  periodicImagesX: number;
  periodicImagesY: number;
  periodicImagesZ: number;
}

function readStudyBoundarySlice(
  sceneData: unknown,
  lane: "fdm" | "fem",
): StudyBoundarySlice {
  const study = asRecord(asRecord(sceneData)?.study);
  const rawDemag = asString(study?.demag_realization) ?? "auto";
  const allowedFem: readonly DemagFormulationChoice[] = [
    "auto",
    "poisson_robin",
    "poisson_dirichlet",
    "fredkin_koehler",
    "bem",
    "fmm",
  ];
  const allowedFdm: readonly DemagFormulationChoice[] = [
    "auto",
    "single_grid",
    "multilayer_convolution",
  ];
  const allowed = lane === "fdm" ? allowedFdm : allowedFem;
  const demagFormulation: DemagFormulationChoice = (
    allowed as readonly string[]
  ).includes(rawDemag)
    ? (rawDemag as DemagFormulationChoice)
    : "auto";

  const pbc = asRecord(study?.pbc);
  const axesRaw = Array.isArray(pbc?.axes) ? pbc.axes : ["open", "open", "open"];
  const axisNames = ["x", "y", "z"] as const;
  const periodicAxes: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    if (asString(axesRaw[i]) === "periodic") {
      periodicAxes.push(axisNames[i]!);
    }
  }

  const rawPbcDemag = asString(pbc?.demag) ?? "open";
  const pbcDemag: PbcDemagChoice =
    rawPbcDemag === "truncated_images" || rawPbcDemag === "periodic_airbox_k0"
      ? rawPbcDemag
      : "open";

  const imgCounts = asTuple3(pbc?.image_counts) ?? [4, 4, 1];
  return {
    demagFormulation,
    pbcDemag,
    periodicAxes,
    periodicImagesX: Math.max(0, Math.round(imgCounts[0])),
    periodicImagesY: Math.max(0, Math.round(imgCounts[1])),
    periodicImagesZ: Math.max(0, Math.round(imgCounts[2])),
  };
}

function buildStudyBoundaryMergePatch(slice: StudyBoundarySlice): JsonObject {
  const hasPeriodicAxis = slice.periodicAxes.length > 0;
  const pbcValue = hasPeriodicAxis
    ? {
        axes: (["x", "y", "z"] as const).map((ax) =>
          slice.periodicAxes.includes(ax) ? "periodic" : "open",
        ),
        demag: slice.pbcDemag,
        ...(slice.pbcDemag === "truncated_images"
          ? {
              image_counts: [
                Math.max(0, Math.round(slice.periodicImagesX)),
                Math.max(0, Math.round(slice.periodicImagesY)),
                Math.max(0, Math.round(slice.periodicImagesZ)),
              ],
            }
          : {}),
      }
    : null;

  return {
    demag_realization:
      slice.demagFormulation === "auto" ? null : slice.demagFormulation,
    pbc: pbcValue,
  } as JsonObject;
}

function studyBoundaryEquals(
  a: StudyBoundarySlice,
  b: StudyBoundarySlice,
): boolean {
  return (
    a.demagFormulation === b.demagFormulation &&
    a.pbcDemag === b.pbcDemag &&
    a.periodicImagesX === b.periodicImagesX &&
    a.periodicImagesY === b.periodicImagesY &&
    a.periodicImagesZ === b.periodicImagesZ &&
    a.periodicAxes.length === b.periodicAxes.length &&
    a.periodicAxes.every((ax) => b.periodicAxes.includes(ax))
  );
}

function formatDemagFormulationLabel(
  formulation: DemagFormulationChoice,
  periodicAxes: readonly string[],
): string {
  const periodicSuffix =
    periodicAxes.length > 0
      ? ` · Periodic (${periodicAxes.map((a) => a.toUpperCase()).join(", ")})`
      : "";
  switch (formulation) {
    case "poisson_robin":
      return `Poisson Robin (1/r asymptotic)${periodicSuffix}`;
    case "poisson_dirichlet":
      return `Poisson Dirichlet (φ = 0)${periodicSuffix}`;
    case "fredkin_koehler":
      return `Fredkin-Koehler Hybrid FEM/BEM${periodicSuffix}`;
    case "bem":
      return `Boundary Element (BEM)${periodicSuffix}`;
    case "fmm":
      return `Fast Multipole (FMM)${periodicSuffix}`;
    case "single_grid":
      return `FDM Single-Grid Convolution${periodicSuffix}`;
    case "multilayer_convolution":
      return `FDM Multilayer Convolution${periodicSuffix}`;
    default:
      return periodicAxes.length > 0
        ? `Periodic (${periodicAxes.map((a) => a.toUpperCase()).join(", ")})`
        : "Open / Asymptotic (Auto)";
  }
}

// ============================================================================
// 1. airbox.root — AirboxRootInspectorSpecPanel (100% Canonical Schema Parity)
// ============================================================================

interface AirboxRootDraft extends StudyBoundarySlice {
  extentMode: "auto" | "manual";
  hasPadding: boolean;
  paddingM: readonly [number, number, number];
  manualSizeM: readonly [number, number, number];
  hasManualCenter: boolean;
  manualCenterM: readonly [number, number, number];
  airboxVisible: boolean;
  boundsVisible: boolean;
  wireframeVisible: boolean;
}

function buildUniverseConfigFromRootDraft(
  draft: AirboxRootDraft,
  existingConfig: JsonRecord | null | undefined,
  lane: AirboxMeshPolicyLane,
): JsonObject {
  const next: Record<string, unknown> = {
    ...(existingConfig ?? {}),
    mode: draft.extentMode,
  };

  // Padding is valid and preserved in BOTH auto and manual modes
  if (draft.hasPadding) {
    next.padding = [draft.paddingM[0], draft.paddingM[1], draft.paddingM[2]];
  } else {
    delete next.padding;
  }

  if (draft.extentMode === "manual") {
    next.size = [
      draft.manualSizeM[0],
      draft.manualSizeM[1],
      draft.manualSizeM[2],
    ];
    if (draft.hasManualCenter) {
      next.center = [
        draft.manualCenterM[0],
        draft.manualCenterM[1],
        draft.manualCenterM[2],
      ];
    } else {
      delete next.center;
    }
  } else {
    // Switching back to auto clears manual size and center
    delete next.size;
    delete next.center;
  }

  if (lane === "fdm") {
    for (const key of FEM_ONLY_POLICY_KEYS) {
      delete next[key];
    }
  }

  return next as JsonObject;
}

function universeExtentEquals(a: AirboxRootDraft, b: AirboxRootDraft): boolean {
  return (
    a.extentMode === b.extentMode &&
    a.hasPadding === b.hasPadding &&
    a.paddingM[0] === b.paddingM[0] &&
    a.paddingM[1] === b.paddingM[1] &&
    a.paddingM[2] === b.paddingM[2] &&
    (a.extentMode !== "manual" ||
      (a.manualSizeM[0] === b.manualSizeM[0] &&
        a.manualSizeM[1] === b.manualSizeM[1] &&
        a.manualSizeM[2] === b.manualSizeM[2] &&
        a.hasManualCenter === b.hasManualCenter &&
        (!a.hasManualCenter ||
          (a.manualCenterM[0] === b.manualCenterM[0] &&
            a.manualCenterM[1] === b.manualCenterM[1] &&
            a.manualCenterM[2] === b.manualCenterM[2]))))
  );
}

export function AirboxRootInspectorSpecPanel({
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
  const effectiveLane: AirboxMeshPolicyLane =
    authoringLane === "fdm" || runtimeLane === "fdm" ? "fdm" : "fem";
  const runtimeResolved = runtimeLane === "fdm" || runtimeLane === "fem";

  const policyRes = useUniverseMeshPolicyResource();
  const scene = useSceneResource();
  const domainMeta = useDomainMetaResource({ enabled: effectiveLane === "fdm" });
  const fdmMembership = useSafeFdmRegionMembershipResource({
    enabled: effectiveLane === "fdm",
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(effectiveLane === "fem", runtimeStatus),
  });
  const buildCurrent = useSafeMeshBuildCurrent({
    enabled:
      effectiveLane === "fem" && shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const geometryDiagnostics = useSafeGeometryDiagnosticsResource({
    enabled: true,
  });

  const viz = useSafeAirboxTargetVisualization();
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const topologyMatches = matchesAirboxTopologyIdentity(
    runtimeStatus,
    manifest.data,
  );
  const currentManifest =
    topologyMatches || (runtimeStatus === null && manifest.data != null)
      ? (manifest.data ?? null)
      : null;
  const airboxParts = useMemo(
    () => findAirboxParts(currentManifest?.mesh_parts),
    [currentManifest?.mesh_parts],
  );
  const aggregate = useMemo(
    () => aggregateAirboxMeshParts(airboxParts),
    [airboxParts],
  );
  const carrier = useMemo(
    () => findCanonicalAirboxPart(currentManifest?.mesh_parts),
    [currentManifest?.mesh_parts],
  );

  const currentSceneRevision =
    asNumber(asRecord(scene.data)?.scene_revision) ??
    asNumber(asRecord(scene.data)?.revision);

  const domainPolicyPresentation = useMemo(
    () =>
      buildUniverseDomainPolicyPresentation({
        build: buildCurrent.data ?? null,
        buildStatus: buildCurrent.status,
        manifest: currentManifest,
        manifestStatus: manifest.status,
        policy: policyRes.data ?? null,
        runtimeResolved,
        sceneRevision: currentSceneRevision,
      }),
    [
      buildCurrent.data,
      buildCurrent.status,
      currentManifest,
      currentSceneRevision,
      manifest.status,
      policyRes.data,
      runtimeResolved,
    ],
  );

  const roleEvidence = useMemo(
    () =>
      effectiveLane === "fdm"
        ? resolveFdmRoleEvidence(
            domainMeta.data,
            fdmMembership.data,
            fdmMembership.error ? "error" : fdmMembership.status,
            scene.data?.objects,
          )
        : null,
    [
      domainMeta.data,
      effectiveLane,
      fdmMembership.data,
      fdmMembership.error,
      fdmMembership.status,
      scene.data?.objects,
    ],
  );

  const fdmExtentModel = useMemo(
    () =>
      resolveFdmUniverseExtentModel({
        explicitFdm: effectiveLane === "fdm",
        resource: domainMeta,
        roleEvidence,
      }),
    [domainMeta, effectiveLane, roleEvidence],
  );

  const baseline = useMemo<AirboxRootDraft>(() => {
    const cfg = asRecord(policyRes.data?.config);
    const eff = asRecord(policyRes.data?.effective_config);
    const rawMode = asString(cfg?.mode) ?? asString(eff?.mode) ?? "auto";
    const extentMode: "auto" | "manual" =
      rawMode === "manual" ? "manual" : "auto";

    const authoredPad = asTuple3(cfg?.padding);
    const effPad = asTuple3(eff?.padding) ?? [8e-8, 8e-8, 1.2e-7];
    const authoredSize = asTuple3(cfg?.size);
    const effSize = asTuple3(eff?.size) ?? [1.6e-6, 8e-7, 2.4e-7];
    const authoredCenter = asTuple3(cfg?.center);
    const effCenter = asTuple3(eff?.center) ?? [0, 0, 0];

    const studySlice = readStudyBoundarySlice(scene.data, effectiveLane);

    return {
      ...studySlice,
      airboxVisible: viz.settings.visible,
      boundsVisible: viz.settings.boundsVisible,
      extentMode,
      hasManualCenter: authoredCenter !== null,
      hasPadding: authoredPad !== null,
      manualCenterM: authoredCenter ?? effCenter,
      manualSizeM: authoredSize ?? effSize,
      paddingM: authoredPad ?? effPad,
      wireframeVisible: viz.settings.wireframeVisible,
    };
  }, [
    effectiveLane,
    policyRes.data?.config,
    policyRes.data?.effective_config,
    scene.data,
    viz.settings.boundsVisible,
    viz.settings.visible,
    viz.settings.wireframeVisible,
  ]);

  const baseConfigText = useMemo(
    () => formatUniverseMeshPolicyConfig(policyRes.data?.config),
    [policyRes.data?.config],
  );
  const baseRevision = policyRes.data?.revision;
  const authoredPresent =
    policyRes.data?.config !== null && policyRes.data?.config !== undefined;

  const outsideUniverseDiagnostics = useMemo(
    () =>
      (geometryDiagnostics.data?.diagnostics ?? []).filter(
        (d) => d.code === "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
      ),
    [geometryDiagnostics.data?.diagnostics],
  );

  const diagnosticsStale = Boolean(
    geometryDiagnostics.data &&
      currentSceneRevision !== null &&
      geometryDiagnostics.data.scene_revision !== currentSceneRevision,
  );

  const expandPaddingToFitObjects = useCallback(
    (
      draft: AirboxRootDraft,
      patchDraft: (partial: Partial<AirboxRootDraft>) => void,
    ) => {
      const envelope = computeSceneObjectsEnvelope(
        scene.data?.objects,
        domainMeta.data?.bounds ?? null,
      );
      if (!envelope) return;
      const marginFactor = 1.25;
      if (draft.extentMode === "manual") {
        patchDraft({
          hasManualCenter: true,
          manualCenterM: envelope.center,
          manualSizeM: [
            envelope.span[0] * marginFactor,
            envelope.span[1] * marginFactor,
            envelope.span[2] * marginFactor,
          ],
        });
      } else {
        patchDraft({
          hasPadding: true,
          paddingM: [
            Math.max(draft.paddingM[0], envelope.span[0] * 0.25),
            Math.max(draft.paddingM[1], envelope.span[1] * 0.25),
            Math.max(draft.paddingM[2], envelope.span[2] * 0.25),
          ],
        });
      }
    },
    [domainMeta.data?.bounds, scene.data?.objects],
  );

  const loadEffectiveDefaults = useCallback(
    (patchDraft: (partial: Partial<AirboxRootDraft>) => void) => {
      const resource = policyRes.data ?? {
        config: null,
        effective_config: null,
        revision: 0,
      };
      const effDraft = draftFromEffectiveUniverseMeshPolicyResource(resource);
      const parsed = (() => {
        try {
          return asRecord(JSON.parse(effDraft.configText));
        } catch {
          return asRecord(resource.effective_config);
        }
      })();
      const pad = asTuple3(parsed?.padding) ?? [0, 0, 0];
      const sz = asTuple3(parsed?.size);
      const ctr = asTuple3(parsed?.center);
      patchDraft({
        extentMode: asString(parsed?.mode) === "manual" ? "manual" : "auto",
        hasManualCenter: ctr !== null,
        hasPadding: true,
        ...(ctr ? { manualCenterM: ctr } : {}),
        ...(sz ? { manualSizeM: sz } : {}),
        paddingM: pad,
      });
    },
    [policyRes.data],
  );

  const handleLiveFieldChange = useCallback(
    <K extends keyof AirboxRootDraft & string>(
      key: K,
      value: AirboxRootDraft[K],
    ) => {
      if (key === "airboxVisible") {
        viz.patchAirboxVisualization({ visible: Boolean(value) });
      } else if (key === "boundsVisible") {
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

  const spec = useMemo<InspectorSpec<AirboxRootDraft>>(() => {
    const fdmShape = fdmExtentModel.gridShape ?? domainMeta.data?.grid?.shape;
    const fdmSpacing = fdmExtentModel.spacing ?? domainMeta.data?.grid?.spacing;
    const regionLegend = fdmMembership.data?.region_legend ?? [];

    const statePill = (): { label: string; tone: InspectorTone } => {
      if (outsideUniverseDiagnostics.length > 0) {
        return { label: "Outside bounds", tone: "warn" };
      }
      if (effectiveLane === "fdm") {
        return fdmExtentModel.status === "ready"
          ? { label: "Ready", tone: "ok" }
          : fdmExtentModel.status === "stale"
            ? { label: "Stale", tone: "warn" }
            : { label: "Configured", tone: "info" };
      }
      const st = domainPolicyPresentation.realization.state;
      if (st === "current") return { label: "Current", tone: "ok" };
      if (st === "building") return { label: "Building", tone: "live" };
      if (st === "stale") return { label: "Stale", tone: "warn" };
      if (st === "error") return { label: "Build error", tone: "err" };
      return { label: "Configured", tone: "ok" };
    };

    return {
      id: "airbox.root",
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
          { id: "airbox", label: "Airbox" },
        ],
        canFitView: true,
        extraMenuActions: [
          {
            icon: SquareDashed,
            id: "open-boundary-faces",
            label: "Open Boundary Faces",
            onSelect: (ctx) =>
              ctx.selectNode({
                kind: "boundary-faces.root",
                label: "Boundary Faces",
                nodeId: "model:boundary-faces",
                objectId: null,
                ref: null,
              }),
          },
          {
            icon: Sparkles,
            id: "load-effective-defaults",
            label: "Load Effective Defaults",
            onSelect: (ctx) => loadEffectiveDefaults(ctx.patchDraft),
          },
          {
            icon: AlertTriangle,
            id: "open-diagnostics",
            label: "Open Diagnostics",
            onSelect: () => {
              kernel.layout?.openBottomPanel?.("diagnostics");
            },
          },
        ],
        primaryHeaderAction: {
          icon: Grid3x3,
          label:
            effectiveLane === "fdm"
              ? "Build FDM Grid"
              : "Build Shared-Domain Mesh",
          onRun: async () => {
            const cmd =
              effectiveLane === "fdm"
                ? "grid.build-fdm"
                : "mesh.build-shared-domain";
            await kernel.commands.execute(
              cmd,
              createCommandContext("inspector", kernel, {
                input: { origin: "airbox" },
                resourceData: {
                  [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
                },
                sessionScopeKey: sessionScopeKey ?? null,
                sourceDetail: "airbox.root",
              }),
            );
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "airbox",
        icon: Layers,
        kindLabel:
          effectiveLane === "fdm"
            ? "FDM structured universe & Airbox"
            : "Universe bounding domain",
        statePill,
        title: () => "Airbox & Exterior Domain",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Extent mode",
          value: d.extentMode === "manual" ? "Manual box" : "Auto padding",
        },
        {
          id: "bc",
          label: "Outer formulation",
          value: formatDemagFormulationLabel(
            d.demagFormulation,
            d.periodicAxes,
          ),
        },
        {
          id: "carrier",
          label: effectiveLane === "fdm" ? "Grid" : "Air elements",
          value:
            effectiveLane === "fdm" && fdmShape
              ? fdmShape.join(" × ")
              : aggregate.elementCount !== null
                ? aggregate.elementCount.toLocaleString("en-US")
                : null,
        },
        {
          id: "rev",
          label: "Policy rev",
          value: baseRevision != null ? String(baseRevision) : null,
        },
      ],
      notices: (d) => {
        const list: InspectorNotice<AirboxRootDraft>[] = [];
        if (conflictNotice) {
          list.push({
            id: "airbox-policy-conflict",
            quickFix: {
              label: "Reload Latest Policy",
              onApply: () => {
                policyRes.refetch?.();
                scene.refetch?.();
                setConflictNotice(null);
              },
            },
            text: conflictNotice,
            title: "Concurrent revision conflict",
            tone: "err",
          });
        }
        for (const diag of outsideUniverseDiagnostics) {
          list.push({
            id: `outside-universe-${diag.id}`,
            quickFix:
              d.extentMode === "manual"
                ? {
                    label: "Switch Extent Mode to Auto Padding",
                    onApply: (ctx) => ctx.setField("extentMode", "auto"),
                  }
                : {
                    label: "Expand Padding to Fit Objects",
                    onApply: (ctx) =>
                      expandPaddingToFitObjects(ctx.draft, ctx.patchDraft),
                  },
            text: `${diag.message}${diag.object_id ? ` · Object: ${diag.object_id}` : ""}`,
            title: "Object extends outside Universe bounds",
            tone: diag.severity === "error" ? "err" : "warn",
          });
        }
        if (
          d.extentMode === "manual" &&
          diagnosticsStale &&
          outsideUniverseDiagnostics.length === 0
        ) {
          list.push({
            id: "stale-geometry-diagnostics",
            quickFix: {
              label: "Open diagnostics",
              onApply: () => {
                kernel.layout?.openBottomPanel?.("diagnostics");
              },
            },
            text: `Geometry diagnostics correspond to scene revision ${geometryDiagnostics.data?.scene_revision}; current scene revision is ${currentSceneRevision}.`,
            title: "Geometry bounds check pending refresh",
            tone: "info",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: Box,
          id: "extent",
          rows: [
            {
              key: "extentMode",
              label: "Extent mode",
              options: [
                { label: "Auto Padding", value: "auto" },
                { label: "Manual Box", value: "manual" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "hasPadding",
              label: "Author explicit exterior padding",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "paddingM",
              label: "Exterior padding (X, Y, Z)",
              showWhen: (d) => d.hasPadding,
              symbol: <>d</>,
              type: "vector3",
              units: LENGTH_UNITS,
              validate: (vec) =>
                vec.some((v) => !Number.isFinite(v) || v < 0)
                  ? "Padding components must be finite and >= 0."
                  : null,
            },
            {
              defaultDisplayUnit: "nm",
              key: "manualSizeM",
              label: "Manual box size (X, Y, Z)",
              showWhen: (d) => d.extentMode === "manual",
              symbol: <>L</>,
              type: "vector3",
              units: LENGTH_UNITS,
              validate: (vec, d) =>
                d.extentMode === "manual" &&
                vec.some((v) => !Number.isFinite(v) || v <= 0)
                  ? "Manual box size components must be greater than 0."
                  : null,
            },
            {
              key: "hasManualCenter",
              label: "Specify manual box center",
              showWhen: (d) => d.extentMode === "manual",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "manualCenterM",
              label: "Manual box center (X, Y, Z)",
              showWhen: (d) => d.extentMode === "manual" && d.hasManualCenter,
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "vector3",
              units: LENGTH_UNITS,
            },
          ],
          title: "Exterior extent & padding",
        },
        {
          defaultOpen: true,
          icon: AlertTriangle,
          id: "bounds-diagnostics-recovery",
          rows: [
            ...(outsideUniverseDiagnostics.length > 0
              ? outsideUniverseDiagnostics.map((diag) => ({
                  format: () =>
                    `${diag.code} (${diag.severity})${diag.blocks?.length ? ` · blocks ${diag.blocks.join(", ")}` : ""}`,
                  label: diag.object_id
                    ? `Outside object (${diag.object_id})`
                    : "Bounds diagnostic",
                  mono: true,
                  type: "readonly" as const,
                }))
              : [
                  {
                    format: () =>
                      "No GEOMETRY_OBJECT_OUTSIDE_UNIVERSE diagnostics reported on committed scene",
                    label: "Geometry containment",
                    type: "readonly" as const,
                  },
                ]),
            {
              render: (ctx) => (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      expandPaddingToFitObjects(ctx.draft, ctx.patchDraft)
                    }
                  >
                    Expand Padding to Fit Objects
                  </Button>
                  {ctx.draft.extentMode === "manual" ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => ctx.setField("extentMode", "auto")}
                    >
                      Switch Extent Mode to Auto Padding
                    </Button>
                  ) : null}
                  {ctx.draft.extentMode === "manual" ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => ctx.focusField("manualSizeM")}
                    >
                      Adjust manual bounds
                    </Button>
                  ) : null}
                  {outsideUniverseDiagnostics
                    .filter((diag) => Boolean(diag.object_id))
                    .map((diag) => (
                      <Button
                        key={diag.id}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          ctx.selectNode({
                            kind: "object.root",
                            label: diag.object_id!,
                            nodeId: `model:object:${diag.object_id!}`,
                            objectId: diag.object_id!,
                            ref: {
                              kind: "object.root",
                              nodeId: `model:object:${diag.object_id!}`,
                              objectId: diag.object_id!,
                              type: "scene-object",
                              visualizationTargetId:
                                visualizationTargetIdForSceneObject(
                                  diag.object_id!,
                                  null,
                                ),
                            },
                          })
                        }
                      >
                        Select object to adjust placement
                      </Button>
                    ))}
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      kernel.layout?.openBottomPanel?.("diagnostics")
                    }
                  >
                    Open diagnostics
                  </Button>
                </div>
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: (d) =>
            outsideUniverseDiagnostics.length > 0 || d.extentMode === "manual",
          title: "Geometry bounds diagnostics & recovery",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "boundary-conditions",
          rows: [
            {
              key: "demagFormulation",
              label:
                effectiveLane === "fdm"
                  ? "FDM demag realization"
                  : "Far-field / exterior demag formulation",
              options:
                effectiveLane === "fdm"
                  ? [
                      { label: "Auto (planner-selected)", value: "auto" },
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
                      { label: "Auto (planner-selected)", value: "auto" },
                      {
                        label: "Poisson Robin Airbox (1/r decay)",
                        value: "poisson_robin",
                      },
                      {
                        label: "Poisson Dirichlet Airbox (φ = 0)",
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
              label: "Periodic boundary axes (PBC)",
              options: [
                { label: "X (±X)", value: "x" },
                { label: "Y (±Y)", value: "y" },
                { label: "Z (±Z)", value: "z" },
              ],
              structural: true,
              type: "toggles",
            },
            {
              key: "pbcDemag",
              label: "Periodic demag kernel",
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
              label: "Periodic image repeats (X)",
              max: 64,
              min: 0,
              showWhen: (d) =>
                d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
              type: "number",
            },
            {
              integer: true,
              key: "periodicImagesY",
              label: "Periodic image repeats (Y)",
              max: 64,
              min: 0,
              showWhen: (d) =>
                d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
              type: "number",
            },
            {
              integer: true,
              key: "periodicImagesZ",
              label: "Periodic image repeats (Z)",
              max: 64,
              min: 0,
              showWhen: (d) =>
                d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
              type: "number",
            },
          ],
          title: "Outer boundary & far-field formulation",
        },
        {
          defaultOpen: false,
          footer: () =>
            viz.hasOverrides ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => viz.resetAirboxVisualization()}
              >
                Reset Airbox 3D Display
              </Button>
            ) : null,
          icon: Eye,
          id: "live-3d-display",
          live: true,
          rows: [
            {
              key: "airboxVisible",
              label: "Show Airbox in 3D viewport",
              type: "switch",
            },
            {
              key: "boundsVisible",
              label: "Show Airbox bounding box",
              type: "switch",
            },
            {
              key: "wireframeVisible",
              label: "Show Airbox mesh wireframe",
              type: "switch",
            },
          ],
          title: "3D Airbox display",
        },
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "fdm-grid-link",
          rows: [
            {
              format: () =>
                fdmExtentModel.universeRole
                  ? "Airbox outside magnetic support"
                  : "Structured universe carrier",
              label: "Airbox role",
              type: "readonly",
            },
            {
              format: () => (fdmShape ? fdmShape.join(" × ") : "—"),
              label: "Universe grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: () =>
                fdmExtentModel.totalCells !== null
                  ? fdmExtentModel.totalCells.toLocaleString("en-US")
                  : "—",
              label: "Total grid cells",
              type: "readonly",
            },
            {
              format: () =>
                fdmSpacing
                  ? `${formatLengthSmart(fdmSpacing[0])} × ${formatLengthSmart(fdmSpacing[1])} × ${formatLengthSmart(fdmSpacing[2])}`
                  : "—",
              label: "Voxel spacing",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: () =>
                fdmMembership.data
                  ? "Published with structured grid"
                  : "Not materialized",
              label: "Membership mask",
              type: "readonly",
            },
            ...(regionLegend.length > 0
              ? [
                  {
                    columns: [
                      {
                        header: "Owner",
                        id: "owner",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof regionLegend)[number]).object_id,
                      },
                      {
                        header: "Region",
                        id: "reg",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof regionLegend)[number]).region_id,
                      },
                      {
                        align: "right" as const,
                        header: "ID / Priority",
                        id: "num",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const item = r as (typeof regionLegend)[number];
                          return `#${item.numeric_id} (p=${item.priority})`;
                        },
                      },
                    ],
                    label: "Magnetic support owners & regions",
                    rowKey: (r: unknown) => {
                      const item = r as (typeof regionLegend)[number];
                      return `${item.numeric_id}:${item.object_id}:${item.region_id}`;
                    },
                    rows: () => regionLegend,
                    type: "table" as const,
                    wide: true,
                  },
                ]
              : []),
          ],
          showWhen: () => effectiveLane === "fdm",
          title: "FDM structured universe summary",
        },
        {
          defaultOpen: false,
          icon: Ruler,
          id: "domain-provenance-links",
          rows: [
            {
              format: () => {
                const b = domainMeta.data?.bounds;
                if (b) {
                  return `${formatTupleSmart(b.min)} .. ${formatTupleSmart(b.max)}`;
                }
                const mb = aggregateAirboxBounds(airboxParts);
                if (mb) {
                  return `${formatTupleSmart(mb.min)} .. ${formatTupleSmart(mb.max)}`;
                }
                return "Resolved after geometry realization";
              },
              label: "World AABB bounds",
              type: "readonly",
            },
            {
              format: () =>
                sanitizeStatusText(
                  domainPolicyPresentation.realization.detail,
                  "Pending realization",
                ),
              label: "Realization status",
              type: "readonly",
            },
            ...(effectiveLane === "fem"
              ? [
                  {
                    copyText: () => carrier?.id ?? null,
                    format: () => carrier?.id ?? "Not built",
                    label: "Mesh carrier",
                    mono: true,
                    type: "readonly" as const,
                  },
                ]
              : []),
            {
              items: () => [
                ...(effectiveLane === "fem"
                  ? [
                      {
                        id: "mesh-params",
                        jumpSelection: {
                          kind: "airbox.mesh.parameters",
                          label: "Mesh Parameters",
                          nodeId: "model:airbox:mesh:parameters",
                          objectId: null,
                          ref: null,
                        },
                        label: "Mesh Parameters",
                      },
                      {
                        id: "mesh-build",
                        jumpSelection: {
                          kind: "airbox.mesh.build",
                          label: "Mesh Build",
                          nodeId: "model:airbox:mesh:build",
                          objectId: null,
                          ref: null,
                        },
                        label: "Mesh Build",
                      },
                    ]
                  : []),
                {
                  id: "viz",
                  jumpSelection: {
                    kind: "airbox.visualization",
                    label: "Visualization",
                    nodeId: "model:airbox:visualization",
                    objectId: null,
                    ref: null,
                  },
                  label: "Visualization",
                },
                {
                  id: "bfaces",
                  jumpSelection: {
                    kind: "boundary-faces.root",
                    label: "Boundary Faces",
                    nodeId: "model:boundary-faces",
                    objectId: null,
                    ref: null,
                  },
                  label: "Boundary Faces",
                },
              ],
              label: "Related views",
              type: "chips",
            },
          ],
          title: "Resolved world bounds & navigation",
        },
      ],
      commitBar: {
        allowCleanApply: () =>
          !authoredPresent && Boolean(policyRes.data?.effective_config),
        cleanMessage: () => "Exterior domain & boundary policy is synchronized",
        mode: "staged",
        onApply: async (draft, base) => {
          setConflictNotice(null);
          const extentDirty =
            !universeExtentEquals(draft, base) || !authoredPresent;
          const studyDirty = !studyBoundaryEquals(draft, base);

          try {
            let latestPolicySnapshot = policyRes.data ?? null;

            if (studyDirty) {
              const studyPatch = buildStudyBoundaryMergePatch(draft);
              await commitStudyMergePatchWithHistory({
                fallbackBaseRevision: currentSceneRevision ?? 0,
                kernel,
                label: "Update exterior boundary formulation",
                runtimeStatus,
                sceneData: scene.data,
                sessionScopeKey,
                studyPatch,
              });
              if (
                extentDirty &&
                typeof kernel.api.meshing?.universePolicy === "function"
              ) {
                try {
                  latestPolicySnapshot =
                    await kernel.api.meshing.universePolicy(
                      sessionScopeKey ? { sessionScopeKey } : undefined,
                    );
                } catch {
                  // Fall back to current cached policy snapshot
                }
              }
            }

            if (extentDirty) {
              const nextConfig = buildUniverseConfigFromRootDraft(
                draft,
                asRecord(
                  latestPolicySnapshot?.config ?? policyRes.data?.config,
                ),
                effectiveLane,
              );
              await submitCanonicalUniversePolicy({
                baseConfigText,
                baseRevision,
                config: nextConfig,
                kernel,
                label: "Update Airbox exterior domain",
                lane: effectiveLane,
                latestPolicy: latestPolicySnapshot,
                runtimeLane:
                  runtimeLane === "fdm" || runtimeLane === "fem"
                    ? runtimeLane
                    : null,
                runtimeStatus,
                sceneData: scene.data,
                sessionScopeKey,
              });
            }
            return true;
          } catch (err) {
            if (isConflictApiError(err)) {
              policyRes.refetch?.();
              scene.refetch?.();
              kernel.resources?.invalidate?.(
                MESH_UNIVERSE_POLICY_RESOURCE_KEY,
                `conflict:${Date.now()}`,
              );
              kernel.resources?.invalidate?.(
                SCENE_RESOURCE_KEY,
                `conflict:${Date.now()}`,
              );
              setConflictNotice(
                "Universe or Study policy changed concurrently (HTTP 409). Latest state fetched — review and apply again.",
              );
            }
            throw err;
          }
        },
        onRevert: () => setConflictNotice(null),
      },
    };
  }, [
    aggregate.elementCount,
    airboxParts,
    authoredPresent,
    baseConfigText,
    baseRevision,
    carrier?.id,
    conflictNotice,
    currentSceneRevision,
    diagnosticsStale,
    domainMeta.data?.bounds,
    domainMeta.data?.grid?.shape,
    domainMeta.data?.grid?.spacing,
    domainPolicyPresentation.realization.detail,
    domainPolicyPresentation.realization.state,
    effectiveLane,
    expandPaddingToFitObjects,
    fdmExtentModel.gridShape,
    fdmExtentModel.spacing,
    fdmExtentModel.status,
    fdmExtentModel.totalCells,
    fdmExtentModel.universeRole,
    fdmMembership.data,
    geometryDiagnostics.data?.scene_revision,
    kernel,
    loadEffectiveDefaults,
    outsideUniverseDiagnostics,
    policyRes,
    runtimeLane,
    runtimeStatus,
    scene,
    sessionScopeKey,
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

// ============================================================================
// 2. airbox.multilayer.target — AirboxMultilayerTargetInspectorSpecPanel
// ============================================================================

export function AirboxMultilayerTargetInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);

  const multilayerRes = useFdmMultilayerLayoutResource();
  const bDemagFieldMeta = useSafeFieldMetaResource({
    enabled: lane === "fdm" || lane === null,
    quantityId: "b_demag",
    scope_id: "airbox",
    scope_kind: "airbox",
  });

  const certifiedTarget = useMemo(
    () => resolveFdmMultilayerAirboxTarget(multilayerRes.data),
    [multilayerRes.data],
  );

  const airbox = useMemo(
    () => asRecord(multilayerRes.data?.airbox),
    [multilayerRes.data],
  );
  const cells = useMemo<[number, number, number]>(() => {
    if (certifiedTarget) {
      return [
        certifiedTarget.cells[0],
        certifiedTarget.cells[1],
        certifiedTarget.cells[2],
      ];
    }
    return asTuple3(airbox?.cells) ?? [0, 0, 0];
  }, [airbox?.cells, certifiedTarget]);

  const cellSize = useMemo<[number, number, number]>(() => {
    if (certifiedTarget) {
      return [
        certifiedTarget.cellSize[0],
        certifiedTarget.cellSize[1],
        certifiedTarget.cellSize[2],
      ];
    }
    return (
      asTuple3(airbox?.cell_size_m) ?? asTuple3(airbox?.cell_size) ?? [0, 0, 0]
    );
  }, [airbox?.cell_size, airbox?.cell_size_m, certifiedTarget]);

  const origin = useMemo<[number, number, number]>(() => {
    if (certifiedTarget) {
      return [
        certifiedTarget.origin[0],
        certifiedTarget.origin[1],
        certifiedTarget.origin[2],
      ];
    }
    return asTuple3(airbox?.origin_m) ?? asTuple3(airbox?.origin) ?? [0, 0, 0];
  }, [airbox?.origin, airbox?.origin_m, certifiedTarget]);

  const sampleCount =
    certifiedTarget?.sampleCount ??
    asNumber(airbox?.sample_count) ??
    cells[0] * cells[1] * cells[2];
  const valueCount =
    certifiedTarget?.valueCount ??
    asNumber(airbox?.value_count) ??
    sampleCount * 3;

  const boundsMax = useMemo<[number, number, number]>(
    () => [
      origin[0] + cells[0] * cellSize[0],
      origin[1] + cells[1] * cellSize[1],
      origin[2] + cells[2] * cellSize[2],
    ],
    [cellSize, cells, origin],
  );

  const bDemagMaterialized =
    bDemagFieldMeta.status === "ready" && bDemagFieldMeta.data !== null;
  const hDemagAvailable = airbox?.h_demag_available === true;
  const hEffAvailable = airbox?.h_eff_available === true;
  const hEffReason = asString(airbox?.h_eff_unavailable_reason);
  const carrierUnavailableReason = asString(airbox?.unavailable_reason);

  const sourcePolicyText =
    asString(airbox?.source_policy) ?? "Not published";
  const carrierFingerprint =
    certifiedTarget?.carrierFingerprint ??
    asString(airbox?.carrier_fingerprint) ??
    "Not published";
  const carrierRevision = asNumber(airbox?.carrier_revision);
  const layoutRevision = asNumber(multilayerRes.data?.layout_revision);
  const observationRevision = asNumber(multilayerRes.data?.observation_revision);
  const sourceGridsText = useMemo(() => {
    const fps = airbox?.source_grid_fingerprints;
    if (Array.isArray(fps) && fps.length > 0) {
      return fps.filter((x): x is string => typeof x === "string").join(", ");
    }
    return "Not published";
  }, [airbox?.source_grid_fingerprints]);

  const runtimeIdentityText = useMemo(() => {
    const rt = airbox?.source_runtime_identity;
    if (!rt || typeof rt !== "object" || Array.isArray(rt)) {
      return "Not published";
    }
    try {
      return JSON.stringify(rt);
    } catch {
      return "Not published";
    }
  }, [airbox?.source_runtime_identity]);

  const layers = useMemo(
    () => multilayerRes.data?.layers ?? [],
    [multilayerRes.data?.layers],
  );

  const runBuildFdmGrid = useCallback(async () => {
    await kernel.commands.execute(
      "grid.build-fdm",
      createCommandContext("inspector", kernel, {
        input: { origin: "airbox" },
        resourceData: {
          [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
        },
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "airbox.multilayer.target",
      }),
    );
  }, [kernel, runtimeStatus, sessionScopeKey]);

  const baseline = useMemo(() => ({ unit: "nm" }), []);

  const spec = useMemo<InspectorSpec<{ unit: string }>>(() => {
    const carrierReady =
      certifiedTarget !== null ||
      (multilayerRes.data?.available === true && hDemagAvailable);

    const notices: InspectorNotice<{ unit: string }>[] = [];
    if (!carrierReady && carrierUnavailableReason) {
      notices.push({
        id: "ml-carrier-not-published",
        quickFix: {
          label: "Build FDM Grid",
          onApply: () => {
            void runBuildFdmGrid();
          },
        },
        text: sanitizeStatusText(
          carrierUnavailableReason,
          "Target-only Airbox carrier is not materialized yet.",
        ),
        title: "Target-only Airbox carrier not materialized",
        tone: "warn",
      });
    }
    notices.push({
      id: "ml-target-info",
      quickFix: {
        label: "Visualize H_demag in 3D",
        onApply: (ctx) =>
          ctx.selectNode({
            kind: "airbox.visualization",
            label: "Visualization",
            nodeId: "model:airbox:visualization",
            objectId: null,
            ref: null,
          }),
      },
      text: "Certified target-only stray-field observation grid outside magnetic Z-layers; distinct from the common FFT scratch layout.",
      title: "Stray-field observation carrier",
      tone: "info",
    });

    return {
      id: "airbox.multilayer.target",
      header: {
        breadcrumbs: [
          {
            id: "airbox",
            label: "Airbox",
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          },
          { id: "ml-target", label: "Multilayer Target" },
        ],
        canFitView: true,
        primaryHeaderAction: {
          icon: Grid3x3,
          label: "Build FDM Grid",
          onRun: runBuildFdmGrid,
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:multilayer-target",
        icon: Radar,
        kindLabel: "Target-only stray-field observation carrier",
        statePill: () =>
          carrierReady
            ? { label: "Ready", tone: "ok" }
            : { label: "Not materialized", tone: "neutral" },
        title: () => "Multilayer Demag Target",
      },
      facts: () => [
        {
          id: "grid",
          label: "Target grid",
          value: sampleCount > 0 ? cells.join(" × ") : null,
        },
        {
          id: "bdemag",
          label: "B_demag",
          tone: bDemagMaterialized ? "ok" : undefined,
          value: bDemagMaterialized ? "Ready" : "Not materialized",
        },
        {
          id: "hdemag",
          label: "H_demag",
          tone: hDemagAvailable ? "ok" : undefined,
          value: hDemagAvailable ? "Ready" : "Not materialized",
        },
        {
          id: "values",
          label: "Values",
          value: valueCount > 0 ? valueCount.toLocaleString("en-US") : null,
        },
      ],
      notices: () => notices,
      sections: [
        {
          defaultOpen: true,
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void runBuildFdmGrid()}
            >
              Build FDM Grid
            </Button>
          ),
          icon: Radar,
          id: "carrier-geometry",
          rows: [
            {
              format: () =>
                "Target-only stray-field observation outside magnetic Z-layers",
              label: "Airbox scope",
              type: "readonly",
            },
            {
              format: () =>
                "Post-step stray-field observation carrier (excluded from spin integration and common FFT scratch layout)",
              label: "Solver usage",
              type: "readonly",
            },
            {
              format: () =>
                certifiedTarget !== null
                  ? "Yes (certified target-only)"
                  : airbox?.target_only === true
                    ? "Yes"
                    : "Pending certification",
              label: "Target-only carrier",
              type: "readonly",
            },
            {
              format: () =>
                `${cells.join(" × ")} (${sampleCount.toLocaleString("en-US")} cells)`,
              label: "Target grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: () => valueCount.toLocaleString("en-US"),
              label: "Values",
              type: "readonly",
            },
            {
              format: () => formatTupleSmart(cellSize),
              label: "Target cell size",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: () => formatTupleSmart(origin),
              label: "Target origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                sampleCount > 0
                  ? `${formatTupleSmart(origin)} .. ${formatTupleSmart(boundsMax)}`
                  : "Not materialized",
              label: "Observation AABB bounds",
              type: "readonly",
            },
          ],
          title: "Target grid, scope & solver usage",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "field-capability",
          rows: [
            {
              format: () =>
                bDemagMaterialized
                  ? "Ready (materialized field data)"
                  : bDemagFieldMeta.status === "loading"
                    ? "Loading field metadata"
                    : "Not materialized",
              label: "B_demag field resource",
              symbol: (
                <>
                  B<sub>d</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                hDemagAvailable ? "Ready (3-component vector)" : "Not materialized",
              label: "Demagnetizing field (H_demag)",
              symbol: (
                <>
                  H<sub>d</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                hEffAvailable
                  ? "Ready (H_demag + uniform fields)"
                  : hEffReason
                    ? `Not materialized (${sanitizeStatusText(hEffReason, "pending")})`
                    : "Not materialized",
              label: "Effective field (H_eff)",
              symbol: (
                <>
                  H<sub>eff</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          title: "Field capability & materialization",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "coupled-layers",
          rows: [
            {
              items: () =>
                layers.map((layer) => ({
                  id: layer.layer_id,
                  jumpSelection: {
                    kind: "mesh.grid.layer",
                    label: layer.magnet_name,
                    nodeId: `model:mesh:grid:layer:${encodeURIComponent(layer.layer_id)}`,
                    objectId: layer.object_id,
                    ref: null,
                  },
                  label: layer.magnet_name,
                })),
              label: "Source Z-layers",
              showWhen: () => layers.length > 0,
              type: "chips",
            },
            {
              copyText: () => carrierFingerprint,
              format: () => carrierFingerprint,
              label: "Carrier fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                carrierRevision !== null
                  ? String(carrierRevision)
                  : "Not published",
              label: "Carrier revision",
              type: "readonly",
            },
            {
              format: () =>
                layoutRevision !== null
                  ? String(layoutRevision)
                  : "Not published",
              label: "Layout revision",
              type: "readonly",
            },
            {
              format: () =>
                observationRevision !== null
                  ? String(observationRevision)
                  : "Not published",
              label: "Observation revision",
              type: "readonly",
            },
            {
              copyText: () => sourcePolicyText,
              format: () => sourcePolicyText,
              label: "Source policy",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => sourceGridsText,
              format: () => sourceGridsText,
              label: "Source grids",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => runtimeIdentityText,
              format: () => runtimeIdentityText,
              label: "Runtime",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Carrier provenance & coupled Z-layers",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Certified target-only multilayer stray-field carrier",
      },
    };
  }, [
    airbox?.target_only,
    bDemagFieldMeta.status,
    bDemagMaterialized,
    boundsMax,
    carrierFingerprint,
    carrierRevision,
    carrierUnavailableReason,
    cellSize,
    cells,
    certifiedTarget,
    hDemagAvailable,
    hEffAvailable,
    hEffReason,
    layers,
    layoutRevision,
    multilayerRes.data?.available,
    observationRevision,
    origin,
    runBuildFdmGrid,
    runtimeIdentityText,
    sampleCount,
    sourceGridsText,
    sourcePolicyText,
    valueCount,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

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
