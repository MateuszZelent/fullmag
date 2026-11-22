"use client";

import {
  AlertTriangle,
  Grid3x3,
  Layers,
  Sparkles,
  SquareDashed,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  useDomainMetaResource,
  useMeshSharedDomainManifestResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { shouldLoadRuntimeMeshBuild } from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { buildUniverseDomainPolicyPresentation } from "@/shared/domain/mesh/domainPresentation";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import {
  aggregateAirboxMeshParts,
  findAirboxParts,
  findCanonicalAirboxPart,
} from "../../panels/airbox/airboxMeshInspectorModel";
import {
  draftFromEffectiveUniverseMeshPolicyResource,
  formatUniverseMeshPolicyConfig,
  type AirboxMeshPolicyLane,
} from "../../panels/airbox/airboxMeshPolicyDraft";
import {
  asNumber,
  asRecord,
  asString,
  asTuple3,
  commitStudyMergePatchWithHistory,
  computeSceneObjectsEnvelope,
  isConflictApiError,
  resolveFdmRoleEvidence,
  submitCanonicalUniversePolicy,
  useSafeAirboxTargetVisualization,
  useSafeFdmRegionMembershipResource,
  useSafeGeometryDiagnosticsResource,
  useSafeMeshBuildCurrent,
} from "../../panels/airbox/airboxSpecShared";
import { resolveFdmUniverseExtentModel } from "../../panels/airbox/fdmUniverseExtentModel";
import { buildAirboxRootSpecSections } from "./airboxRootSections";
import {
  type AirboxRootDraft,
  readStudyBoundarySlice,
  formatDemagFormulationLabel,
  universeExtentEquals,
  studyBoundaryEquals,
  buildStudyBoundaryMergePatch,
  buildUniverseConfigFromRootDraft,
} from "./universeShared";

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
      sections: buildAirboxRootSpecSections({
        airboxParts,
        carrier,
        domainMeta,
        domainPolicyPresentation,
        effectiveLane,
        expandPaddingToFitObjects,
        fdmExtentModel,
        fdmMembership,
        fdmShape,
        fdmSpacing,
        kernel,
        outsideUniverseDiagnostics,
        regionLegend,
        viz,
      }),
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
    carrier,
    conflictNotice,
    currentSceneRevision,
    diagnosticsStale,
    domainMeta,
    domainPolicyPresentation,
    effectiveLane,
    expandPaddingToFitObjects,
    fdmExtentModel,
    fdmMembership,
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
