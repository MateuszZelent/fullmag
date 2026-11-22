"use client";

import {
  AlertTriangle,
  Grid3x3,
  History,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  useDomainMetaResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import {
  draftFromEffectiveUniverseMeshPolicyResource,
  formatUniverseMeshPolicyConfig,
  type AirboxMeshPolicyLane,
} from "../../panels/airbox/airboxMeshPolicyDraft";
import {
  asNumber,
  asRecord,
  computeSceneObjectsEnvelope,
  formatLengthSmart,
  isConflictApiError,
  submitCanonicalUniversePolicy,
  useSafeGeometryDiagnosticsResource,
} from "../../panels/airbox/airboxSpecShared";
import {
  type AirboxMeshParamsDraft,
  paramsDraftFromConfig,
  buildCanonicalPolicyConfigFromParamsDraft,
} from "./airboxMeshParamsDraft";
import { buildAirboxMeshSizingSections } from "./airboxMeshSizingSections";
import {
  FDM_EFFECTIVE_POLICY_KEYS,
  EFFECTIVE_POLICY_KEYS,
  formatEffectiveValue,
} from "./universeShared";

export function AirboxMeshParametersInspectorSpecPanel({
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

  const policyRes = useUniverseMeshPolicyResource();
  const scene = useSceneResource();
  const domainMeta = useDomainMetaResource({ enabled: effectiveLane === "fdm" });
  const geometryDiagnostics = useSafeGeometryDiagnosticsResource({
    enabled: true,
  });

  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [restoredBanner, setRestoredBanner] = useState<string | null>(null);
  const [seedOverrides, setSeedOverrides] = useState<
    Partial<AirboxMeshParamsDraft> | undefined
  >(undefined);
  const [seedGeneration, setSeedGeneration] = useState(0);

  const baseline = useMemo<AirboxMeshParamsDraft>(
    () =>
      paramsDraftFromConfig(
        asRecord(policyRes.data?.config),
        asRecord(policyRes.data?.effective_config),
      ),
    [policyRes.data?.config, policyRes.data?.effective_config],
  );

  const baseConfigText = useMemo(
    () => formatUniverseMeshPolicyConfig(policyRes.data?.config),
    [policyRes.data?.config],
  );
  const baseRevision = policyRes.data?.revision;
  const authoredPresent =
    policyRes.data?.config !== null && policyRes.data?.config !== undefined;

  // Listen for build-history draft restoration requests on kernel bus
  useEffect(() => {
    if (!kernel?.bus?.on) return undefined;
    return kernel.bus.on("mesh:build-history-restore-requested", (event) => {
      const target = String(event.meshTarget ?? "");
      if (
        !/^(study_domain|shared_domain|universe|airbox)$/.test(target) ||
        !event.snapshot ||
        !Object.prototype.hasOwnProperty.call(event.snapshot, "universe")
      ) {
        return;
      }
      const restoredCfg = asRecord(event.snapshot.universe);
      const nextDraft = paramsDraftFromConfig(
        restoredCfg,
        asRecord(policyRes.data?.effective_config),
      );
      setSeedOverrides(nextDraft);
      setSeedGeneration((g) => g + 1);
      setRestoredBanner(
        `Build ${event.buildId ?? event.entryId} restored into Airbox mesh draft. Click Apply to commit before rebuilding.`,
      );
    });
  }, [kernel.bus, policyRes.data?.effective_config]);

  useEffect(() => {
    if (policyRes.status === "ready") {
      kernel?.bus?.emit?.("mesh:build-history-editor-ready", {
        target: "universe",
      });
    }
  }, [kernel?.bus, policyRes.status]);

  const loadEffectiveDefaultsIntoDraft = useCallback(
    (patchDraft: (partial: Partial<AirboxMeshParamsDraft>) => void) => {
      const resource = policyRes.data ?? {
        config: null,
        effective_config: null,
        revision: 0,
      };
      const effectiveDraft =
        draftFromEffectiveUniverseMeshPolicyResource(resource);
      const parsedEffective = (() => {
        try {
          return asRecord(JSON.parse(effectiveDraft.configText));
        } catch {
          return asRecord(resource.effective_config);
        }
      })();
      const seeded = paramsDraftFromConfig(
        parsedEffective,
        asRecord(resource.effective_config),
      );
      patchDraft({
        ...seeded,
        gradingChoice:
          seeded.gradingChoice === "default" ? "geometric" : seeded.gradingChoice,
        hasAirboxHmax:
          seeded.hasAirboxHmax ||
          asNumber(parsedEffective?.airbox_hmax) !== null,
        hasGrowthRate: true,
        hasPadding: true,
      });
      setRestoredBanner(
        "Backend-effective defaults loaded into draft. Click Apply to save.",
      );
    },
    [policyRes.data],
  );

  const outsideUniverseDiagnostics = useMemo(
    () =>
      (geometryDiagnostics.data?.diagnostics ?? []).filter(
        (d) => d.code === "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
      ),
    [geometryDiagnostics.data?.diagnostics],
  );

  const expandDraftToFitObjects = useCallback(
    (
      draft: AirboxMeshParamsDraft,
      patchDraft: (partial: Partial<AirboxMeshParamsDraft>) => void,
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

  const applyDraftPolicy = useCallback(
    async (draft: AirboxMeshParamsDraft): Promise<boolean> => {
      setConflictNotice(null);
      const nextConfig = buildCanonicalPolicyConfigFromParamsDraft(
        draft,
        asRecord(policyRes.data?.config),
        effectiveLane,
      );
      try {
        await submitCanonicalUniversePolicy({
          baseConfigText,
          baseRevision,
          config: nextConfig,
          kernel,
          label:
            effectiveLane === "fdm"
              ? "Update FDM Airbox universe policy"
              : "Update Airbox mesh parameters",
          lane: effectiveLane,
          latestPolicy: policyRes.data ?? null,
          runtimeLane:
            runtimeLane === "fdm" || runtimeLane === "fem" ? runtimeLane : null,
          runtimeStatus,
          sceneData: scene.data,
          sessionScopeKey,
        });
        setRestoredBanner(null);
        setSeedOverrides(undefined);
        return true;
      } catch (err) {
        if (isConflictApiError(err)) {
          policyRes.refetch?.();
          kernel.resources?.invalidate?.(
            MESH_UNIVERSE_POLICY_RESOURCE_KEY,
            `conflict:${Date.now()}`,
          );
          setConflictNotice(
            "Universe policy changed in another view (HTTP 409). Latest revision fetched — review and click Apply again.",
          );
        }
        throw err;
      }
    },
    [
      baseConfigText,
      baseRevision,
      effectiveLane,
      kernel,
      policyRes,
      runtimeLane,
      runtimeStatus,
      scene.data,
      sessionScopeKey,
    ],
  );

  const effectiveEntries = useMemo(() => {
    const eff = asRecord(policyRes.data?.effective_config) ?? {};
    const keys =
      effectiveLane === "fdm" ? FDM_EFFECTIVE_POLICY_KEYS : EFFECTIVE_POLICY_KEYS;
    return keys.map((key) => ({
      id: key,
      key,
      value: formatEffectiveValue(key, eff[key]),
    }));
  }, [effectiveLane, policyRes.data?.effective_config]);

  const spec = useMemo<InspectorSpec<AirboxMeshParamsDraft>>(
    () => ({
      id: `airbox.mesh.parameters${seedGeneration > 0 ? `:seed-${seedGeneration}` : ""}`,
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
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "params", label: "Parameters" },
        ],
        extraMenuActions: [
          {
            icon: Sparkles,
            id: "load-effective-defaults",
            label: "Load Effective Defaults",
            onSelect: (ctx) => loadEffectiveDefaultsIntoDraft(ctx.patchDraft),
          },
          {
            icon: History,
            id: "inspect-policy-json",
            label: "Inspect Policy JSON",
            onSelect: (ctx) => {
              const cfg = buildCanonicalPolicyConfigFromParamsDraft(
                ctx.draft,
                asRecord(policyRes.data?.config),
                effectiveLane,
              );
              ctx.openCodePreview(
                "Universe & Airbox mesh policy",
                "json",
                formatUniverseMeshPolicyConfig(cfg),
              );
            },
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
          onRun: async (ctx) => {
            const draftChanged =
              JSON.stringify(ctx.draft) !== JSON.stringify(ctx.baseline);
            if (draftChanged) {
              await applyDraftPolicy(ctx.draft);
            }
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
                sourceDetail: "airbox.mesh.parameters",
              }),
            );
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:parameters",
        icon: SlidersHorizontal,
        kindLabel:
          effectiveLane === "fdm"
            ? "FDM structured-grid universe policy"
            : "FEM exterior element sizing & grading",
        statePill: () =>
          authoredPresent
            ? { label: "Authored", tone: "ok" }
            : { label: "Inherited defaults", tone: "info" },
        title: () => "Airbox Mesh Parameters",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Extent",
          value: d.extentMode === "manual" ? "Manual box" : "Auto padding",
        },
        ...(effectiveLane === "fem"
          ? [
              {
                id: "hmax",
                label: "h_max,air",
                value: d.hasAirboxHmax
                  ? formatLengthSmart(d.airboxHmaxM)
                  : "Default",
              },
              {
                id: "hmin",
                label: "h_min,air",
                value: d.hasAirboxHmin
                  ? formatLengthSmart(d.airboxHminM)
                  : "Default",
              },
              {
                id: "growth",
                label: "Growth g_air",
                value: d.hasGrowthRate ? String(d.growthRate) : "Default (1.3)",
              },
            ]
          : [
              {
                id: "rev",
                label: "Policy rev",
                value: baseRevision != null ? String(baseRevision) : null,
              },
            ]),
      ],
      notices: (d) => {
        const list: InspectorNotice<AirboxMeshParamsDraft>[] = [];
        if (conflictNotice) {
          list.push({
            id: "policy-conflict",
            quickFix: {
              label: "Reload Latest Policy",
              onApply: () => {
                policyRes.refetch?.();
                setConflictNotice(null);
              },
            },
            text: conflictNotice,
            title: "Policy revision conflict",
            tone: "err",
          });
        }
        if (restoredBanner) {
          list.push({
            id: "restored-draft",
            text: restoredBanner,
            title: "Staged policy draft updated",
            tone: "info",
          });
        }
        if (!authoredPresent && policyRes.data?.effective_config) {
          list.push({
            id: "inherited-defaults-notice",
            quickFix: {
              label: "Load Effective Defaults",
              onApply: (ctx) => loadEffectiveDefaultsIntoDraft(ctx.patchDraft),
            },
            text: "Universe & Airbox policy currently inherits backend defaults. Load effective defaults or enable explicit controls below.",
            title: "Using backend-effective defaults",
            tone: "info",
          });
        }
        for (const diag of outsideUniverseDiagnostics) {
          list.push({
            id: `diag-${diag.id}`,
            quickFix:
              d.extentMode === "manual"
                ? {
                    label: "Switch Extent Mode to Auto Padding",
                    onApply: (ctx) => ctx.setField("extentMode", "auto"),
                  }
                : {
                    label: "Expand Padding to Fit Objects",
                    onApply: (ctx) =>
                      expandDraftToFitObjects(ctx.draft, ctx.patchDraft),
                  },
            text: `${diag.message}${diag.object_id ? ` (object: ${diag.object_id})` : ""}`,
            title: "Geometry extends outside Universe bounds",
            tone: diag.severity === "error" ? "err" : "warn",
          });
        }
        return list;
      },
      sections: buildAirboxMeshSizingSections({
        effectiveEntries,
        effectiveLane,
        expandDraftToFitObjects,
        kernel,
        loadEffectiveDefaultsIntoDraft,
        onResetDraftToSaved: () => setRestoredBanner(null),
        outsideUniverseDiagnostics,
      }),
      commitBar: {
        allowCleanApply: () =>
          restoredBanner !== null ||
          (!authoredPresent && Boolean(policyRes.data?.effective_config)),
        applyLabel: (_, dirty) =>
          dirty
            ? effectiveLane === "fdm"
              ? "Apply & Refresh Grid"
              : "Apply Policy"
            : "Commit Policy",
        cleanMessage: () =>
          effectiveLane === "fdm"
            ? "FDM universe policy matches committed scene"
            : "Exterior FEM sizing matches universe policy",
        mode: "staged",
        onApply: applyDraftPolicy,
        onRevert: () => {
          setRestoredBanner(null);
          setConflictNotice(null);
        },
      },
    }),
    [
      applyDraftPolicy,
      authoredPresent,
      baseRevision,
      conflictNotice,
      effectiveEntries,
      effectiveLane,
      expandDraftToFitObjects,
      kernel,
      loadEffectiveDefaultsIntoDraft,
      outsideUniverseDiagnostics,
      policyRes,
      restoredBanner,
      runtimeStatus,
      seedGeneration,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      seedStagedOverrides={seedOverrides}
      selection={selection}
      spec={spec}
    />
  );
}
