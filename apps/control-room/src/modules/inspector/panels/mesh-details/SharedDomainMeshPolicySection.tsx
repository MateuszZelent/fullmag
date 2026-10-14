"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MESH_SEMANTICS_RESOURCE_KEY,
  MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
  useMeshSemanticsResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { publishCommittedMeshPolicyResource } from "@/kernel/resources/meshPolicyResourceCache";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "../inspectorDraftState";

interface SharedDomainPolicyDraft {
  authoredPresent: boolean;
  configText: string;
  curvatureFactor: string;
  growthRate: string;
  hMax: string;
  hMin: string;
  narrowRegionResolution: string;
  optimize: boolean;
}

interface SharedDomainResourceLike {
  config?: Record<string, unknown> | null;
  effective_config?: Record<string, unknown> | null;
  revision?: number;
}

type Feedback = { kind: "error" | "success" | "warning"; message: string } | null;

function readPositiveNumberString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "";
}

function formatPolicyJson(
  config: Record<string, unknown> | null | undefined,
): string {
  if (!config || Object.keys(config).length === 0) return "{}";
  return JSON.stringify(config, null, 2);
}

function draftFromSharedDomainResource(
  resource: SharedDomainResourceLike | null,
): SharedDomainPolicyDraft {
  const config = resource?.config ?? {};
  return {
    authoredPresent: Boolean(
      resource?.config && Object.keys(resource.config).length > 0,
    ),
    configText: formatPolicyJson(resource?.config),
    curvatureFactor: readPositiveNumberString(config.curvature_factor),
    growthRate: readPositiveNumberString(
      config.growth_rate ?? config.airbox_growth_rate,
    ),
    hMax: readPositiveNumberString(
      config.h_max ?? config.h_target ?? config.airbox_hmax,
    ),
    hMin: readPositiveNumberString(config.h_min ?? config.airbox_hmin),
    narrowRegionResolution: readPositiveNumberString(
      config.narrow_region_resolution,
    ),
    optimize: config.optimize !== false,
  };
}

function draftFromEffectiveSharedDomainResource(
  resource: SharedDomainResourceLike | null,
): SharedDomainPolicyDraft {
  const source = resource?.config ?? resource?.effective_config ?? {};
  return {
    ...draftFromSharedDomainResource({
      config: source,
      effective_config: resource?.effective_config ?? null,
      revision: resource?.revision ?? 0,
    }),
    authoredPresent: true,
  };
}

function isSharedDomainDraftDirty(
  left: SharedDomainPolicyDraft,
  right: SharedDomainPolicyDraft,
): boolean {
  return (
    left.hMax !== right.hMax ||
    left.hMin !== right.hMin ||
    left.growthRate !== right.growthRate ||
    left.curvatureFactor !== right.curvatureFactor ||
    left.narrowRegionResolution !== right.narrowRegionResolution ||
    left.optimize !== right.optimize ||
    left.configText !== right.configText
  );
}

function buildSharedDomainPolicyConfig(
  draft: SharedDomainPolicyDraft,
): { config: JsonObject; ok: true } | { error: string; ok: false } {
  let base: JsonObject = {};
  try {
    const parsed = JSON.parse(draft.configText || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: "Shared-domain mesh policy JSON must be an object.",
        ok: false,
      };
    }
    base = { ...(parsed as JsonObject) };
  } catch {
    return {
      error: "Shared-domain mesh policy JSON must be valid JSON.",
      ok: false,
    };
  }

  const numericEntries: readonly [string, string, string][] = [
    ["h_max", draft.hMax, "Global maximum element size (h_max)"],
    ["h_min", draft.hMin, "Global minimum element size (h_min)"],
    ["growth_rate", draft.growthRate, "Element growth rate"],
    ["curvature_factor", draft.curvatureFactor, "Curvature factor"],
    [
      "narrow_region_resolution",
      draft.narrowRegionResolution,
      "Narrow region resolution",
    ],
  ];

  for (const [key, raw, label] of numericEntries) {
    const trimmed = raw.trim();
    if (!trimmed) {
      delete base[key];
      continue;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: `${label} must be greater than 0.`, ok: false };
    }
    base[key] = parsed;
  }

  base.optimize = draft.optimize;
  return { config: base, ok: true };
}

export function SharedDomainMeshPolicySection() {
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const semanticsResource = useMeshSemanticsResource();
  const resource = useMemo<SharedDomainResourceLike>(() => {
    const data = semanticsResource.data as Record<string, unknown> | null;
    const sharedConfig =
      data?.shared_domain_config &&
      typeof data.shared_domain_config === "object" &&
      !Array.isArray(data.shared_domain_config)
        ? (data.shared_domain_config as Record<string, unknown>)
        : null;
    return {
      config: sharedConfig,
      effective_config: sharedConfig,
      revision: typeof data?.revision === "number" ? data.revision : 0,
    };
  }, [semanticsResource.data]);

  const baseDraft = useMemo(
    () => draftFromSharedDomainResource(resource),
    [resource],
  );
  const baseKey = `${sessionScopeKey ?? "no-session"}:${resource.revision ?? 0}:${formatPolicyJson(resource.config)}`;
  const identityKey = "shared-domain-policy";

  const [draftState, setDraftState] = useState<
    InspectorDraftState<SharedDomainPolicyDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey,
      identityKey,
    }),
  );
  const { dirty, draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey,
    identityKey,
    isDirty: isSharedDomainDraftDirty,
    state: draftState,
  });

  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const [buildPending, setBuildPending] = useState(false);
  const operationGuard = useRef(0);

  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sessionScopeKey,
        sourceDetail: "shared-domain-mesh-policy",
        input: { origin: "shared-domain" },
      }),
    [kernel, sessionScopeKey],
  );

  const updateField = useCallback(
    (patch: Partial<SharedDomainPolicyDraft>) => {
      const merged: SharedDomainPolicyDraft = {
        ...draft,
        ...patch,
        authoredPresent: true,
      };
      if (patch.configText === undefined) {
        const built = buildSharedDomainPolicyConfig(merged);
        if (built.ok) {
          merged.configText = formatPolicyJson(built.config);
        }
      }
      setDraftState(
        updateInspectorDraftState({
          baseDraft,
          baseKey,
          currentDraft: draft,
          identityKey,
          isDirty: isSharedDomainDraftDirty,
          patch: merged,
        }),
      );
    },
    [baseDraft, baseKey, draft],
  );

  const loadEffectiveDefaults = () => {
    const seeded = draftFromEffectiveSharedDomainResource(resource);
    setDraftState({
      baseKey,
      dirty: true,
      draft: seeded,
      identityKey,
    });
    setFeedback({
      kind: "success",
      message:
        "Backend-effective shared-domain defaults loaded into draft. Click Apply Shared-Domain Policy to save.",
    });
  };

  const revert = () => {
    setDraftState(
      initialInspectorDraftState({ baseDraft, baseKey, identityKey }),
    );
    setFeedback(null);
  };

  const validation = buildSharedDomainPolicyConfig(draft);
  const validationError = validation.ok ? null : validation.error;

  const applyPolicy = async ({ silent = false } = {}) => {
    if (!sessionScopeKey) {
      if (!silent) {
        setFeedback({
          kind: "error",
          message: "An active session is required to save the shared-domain policy.",
        });
      }
      return false;
    }
    const checked = buildSharedDomainPolicyConfig(draft);
    if (!checked.ok) {
      setFeedback({ kind: "error", message: checked.error });
      return false;
    }
    const opId = ++operationGuard.current;
    setPending(true);
    try {
      const next = await api.meshing.sharedDomain.replacePolicy(
        { config: checked.config },
        { sessionScopeKey },
      );
      if (operationGuard.current !== opId) return false;
      publishCommittedMeshPolicyResource?.(
        resources,
        MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
        sessionScopeKey,
        next,
      );
      resources.invalidate(
        MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
        next.revision,
      );
      resources.invalidate(MESH_SEMANTICS_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, next.revision);
      resources.invalidate(
        MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
        next.revision,
      );
      if (!silent) {
        setFeedback({
          kind: "success",
          message:
            "Shared-domain mesh policy saved. Build Shared-Domain Mesh to realize updated sizing.",
        });
      }
      return true;
    } catch (error) {
      if (operationGuard.current !== opId) return false;
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to save shared-domain policy.",
      });
      return false;
    } finally {
      if (operationGuard.current === opId) setPending(false);
    }
  };

  const buildSharedDomain = async () => {
    if (!sessionScopeKey || pending || buildPending) return;
    setBuildPending(true);
    try {
      if (dirty) {
        const saved = await applyPolicy({ silent: true });
        if (!saved) return;
      }
      const result = await commands.execute(
        "mesh.build-shared-domain",
        commandContext,
      );
      setFeedback({
        kind:
          result.status === "completed"
            ? "success"
            : result.status === "failed"
              ? "error"
              : "warning",
        message:
          result.message ??
          (result.status === "completed"
            ? "Shared-domain mesh build completed."
            : "Shared-domain mesh build submitted."),
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to build shared-domain mesh.",
      });
    } finally {
      setBuildPending(false);
    }
  };

  const effectiveHMax = readPositiveNumberString(
    resource.effective_config?.h_max ?? resource.effective_config?.h_target,
  );
  const effectiveHMin = readPositiveNumberString(
    resource.effective_config?.h_min,
  );
  const effectiveGrowthRate = readPositiveNumberString(
    resource.effective_config?.growth_rate,
  );

  return (
    <InspectorGroup
      badge={draft.authoredPresent ? "authored" : "inherited defaults"}
      title="Shared-Domain Mesh Policy"
    >
      {!draft.authoredPresent && resource.effective_config ? (
        <FeedbackBanner
          kind="warning"
          message="Shared-domain mesh policy is currently using backend defaults. Load Effective Defaults or enter explicit values below to author a canonical shared-domain policy."
        />
      ) : null}
      {dirty ? (
        <FeedbackBanner
          kind="warning"
          message="Unapplied shared-domain policy changes. Click Apply Shared-Domain Policy or Apply & Build Shared-Domain Mesh."
        />
      ) : null}
      <div className="fm-inspector-toolbar">
        <Button
          disabled={!sessionScopeKey || pending || validationError !== null}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => void applyPolicy()}
        >
          Apply Shared-Domain Policy
        </Button>
        <Button
          disabled={
            !sessionScopeKey || pending || buildPending || validationError !== null
          }
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => void buildSharedDomain()}
        >
          {buildPending
            ? "Building Shared-Domain Mesh…"
            : dirty
              ? "Apply & Build Shared-Domain Mesh"
              : "Build Shared-Domain Mesh"}
        </Button>
        {!draft.authoredPresent && resource.effective_config ? (
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="secondary"
            onClick={loadEffectiveDefaults}
          >
            Load Effective Defaults
          </Button>
        ) : null}
        <Button
          disabled={pending || !dirty}
          size="sm"
          type="button"
          variant="ghost"
          onClick={revert}
        >
          Revert
        </Button>
      </div>
      {validationError ? (
        <FeedbackBanner kind="error" message={validationError} />
      ) : null}
      {feedback ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
      <FormField
        inputMode="decimal"
        label="Global max element size (h_max)"
        placeholder={effectiveHMax ? `Effective: ${effectiveHMax}` : "e.g. 5e-9"}
        type="text"
        unit="m"
        value={draft.hMax}
        onChange={(event) => updateField({ hMax: event.target.value })}
      />
      <FormField
        inputMode="decimal"
        label="Global min element size (h_min)"
        placeholder={effectiveHMin ? `Effective: ${effectiveHMin}` : "e.g. 1e-9"}
        type="text"
        unit="m"
        value={draft.hMin}
        onChange={(event) => updateField({ hMin: event.target.value })}
      />
      <FormField
        inputMode="decimal"
        label="Element growth rate"
        placeholder={
          effectiveGrowthRate ? `Effective: ${effectiveGrowthRate}` : "e.g. 1.3"
        }
        type="text"
        value={draft.growthRate}
        onChange={(event) => updateField({ growthRate: event.target.value })}
      />
      <FormField
        inputMode="decimal"
        label="Curvature factor"
        placeholder="e.g. 0.2"
        type="text"
        value={draft.curvatureFactor}
        onChange={(event) =>
          updateField({ curvatureFactor: event.target.value })
        }
      />
      <FormField
        inputMode="decimal"
        label="Narrow region resolution"
        placeholder="e.g. 2"
        type="text"
        value={draft.narrowRegionResolution}
        onChange={(event) =>
          updateField({ narrowRegionResolution: event.target.value })
        }
      />
      <FormField
        checked={draft.optimize}
        label="Optimize tetrahedral quality"
        type="checkbox"
        onChange={(event) => updateField({ optimize: event.target.checked })}
      />
    </InspectorGroup>
  );
}
