"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MESH_SEMANTICS_RESOURCE_KEY,
  MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  useMeshSemanticsResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { publishCommittedMeshPolicyResource } from "@/kernel/resources/meshPolicyResourceCache";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionResourceIdentity,
} from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "../inspectorDraftState";
import {
  buildSharedDomainPolicyConfig,
  draftFromEffectiveSharedDomainResource,
  draftFromSharedDomainResource,
  formatPolicyJson,
  isSharedDomainDraftDirty,
  readAuthoredText,
  type SharedDomainPolicyDraft,
  type SharedDomainResourceLike,
} from "./sharedDomainMeshPolicyDraft";

type Feedback = { kind: "error" | "success" | "warning"; message: string } | null;

export function SharedDomainMeshPolicySection() {
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const semanticsResource = useMeshSemanticsResource();
  const observedPolicy = useMemo<SharedDomainResourceLike>(() => {
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

  const identityKey = sessionScopeKey ?? "no-session";
  const [acknowledged, setAcknowledged] = useState<{
    identityKey: string;
    policy: SharedDomainResourceLike & { revision: number };
  } | null>(null);
  const resource = acknowledged?.identityKey === identityKey &&
    acknowledged.policy.revision > (observedPolicy.revision ?? 0)
    ? acknowledged.policy
    : observedPolicy;
  const baseDraft = useMemo(
    () => draftFromSharedDomainResource(resource),
    [resource],
  );
  const baseKey = `${identityKey}:${resource.revision ?? 0}:${formatPolicyJson(resource.config)}`;
  const draftEditVersion = useRef(0);

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

  // The mesh build command resolves its FEM lane from the session status in
  // the command context; without it the build is refused as "unknown lane".
  const runtimeResourceData = useRuntimeCommandControlResourceData({
    includeSharedDomainReadiness: false,
    includeStageExecution: false,
  });
  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        resourceData: runtimeResourceData,
        sessionScopeKey,
        sourceDetail: "shared-domain-mesh-policy",
        input: { origin: "shared-domain" },
      }),
    [kernel, runtimeResourceData, sessionScopeKey],
  );

  const updateField = useCallback(
    (patch: Partial<SharedDomainPolicyDraft>) => {
      draftEditVersion.current += 1;
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
    [baseDraft, baseKey, draft, identityKey],
  );

  const loadEffectiveDefaults = () => {
    draftEditVersion.current += 1;
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
    draftEditVersion.current += 1;
    setDraftState(
      initialInspectorDraftState({ baseDraft, baseKey, identityKey }),
    );
    setFeedback(null);
  };

  const validation = buildSharedDomainPolicyConfig(draft);
  const validationError = validation.ok ? null : validation.error;

  const acknowledgePolicyDraft = useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    sessionScopeKey !== null && validationError === null,
    undefined,
    applyPolicy,
    revert,
  );

  async function applyPolicy({ silent = false } = {}) {
    if (!sessionScopeKey || commandContext.isCurrentSessionScope?.() === false) {
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
    const submittedEditVersion = draftEditVersion.current;
    const isCurrentOperation = () => operationGuard.current === opId &&
      commandContext.isCurrentSessionScope?.() !== false;
    setPending(true);
    try {
      const next = await api.meshing.sharedDomain.replacePolicy(
        { config: checked.config },
        { sessionScopeKey },
      );
      if (!isCurrentOperation()) return false;
      const policy = { ...next, effective_config: next.config };
      setAcknowledged({ identityKey, policy });
      const draftWasEdited = draftEditVersion.current !== submittedEditVersion;
      if (draftWasEdited) {
        // An edit can match the old baseline while the new one is in flight.
        setDraftState((current) => ({ ...current, dirty: true }));
      } else {
        setDraftState(initialInspectorDraftState({
          baseDraft: draftFromSharedDomainResource(policy),
          baseKey: `${identityKey}:${policy.revision}:${formatPolicyJson(policy.config)}`,
          identityKey,
        }));
        acknowledgePolicyDraft();
      }
      publishCommittedMeshPolicyResource(
        resources,
        MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
        sessionScopeKey,
        next,
        api.resourceCacheScope,
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
      // The policy is stored in the scene document and bumps the scene and
      // mesh revisions without a realtime event. Refetch both, so open object
      // drafts and the build dialog's mesh_revision precondition stay current.
      resources.invalidate(SCENE_RESOURCE_KEY, `mesh-policy:shared-domain:${next.revision}`);
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, `mesh-policy:shared-domain:${next.revision}`);
      if (draftWasEdited) {
        setFeedback({ kind: "warning", message: "Shared-domain policy saved. Newer draft edits still need Apply or Revert." });
      } else if (!silent) {
        setFeedback({
          kind: "success",
          message:
            "Shared-domain mesh policy saved. Build Shared-Domain Mesh to realize updated sizing.",
        });
      }
      return true;
    } catch (error) {
      if (!isCurrentOperation()) return false;
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to save shared-domain policy.",
      });
      return false;
    } finally {
      if (operationGuard.current === opId) setPending(false);
    }
  }

  const buildSharedDomain = async () => {
    if (!sessionScopeKey || pending || buildPending) return;
    setBuildPending(true);
    try {
      if (dirty) {
        const submittedEditVersion = draftEditVersion.current;
        const saved = await applyPolicy({ silent: true });
        if (!saved || draftEditVersion.current !== submittedEditVersion) return;
      }
      if (commandContext.isCurrentSessionScope?.() === false) return;
      const result = await commands.execute(
        "mesh.build-shared-domain",
        commandContext,
      );
      if (commandContext.isCurrentSessionScope?.() === false) return;
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
      if (commandContext.isCurrentSessionScope?.() === false) return;
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to build shared-domain mesh.",
      });
    } finally {
      setBuildPending(false);
    }
  };

  const effectiveConfig = resource.effective_config ?? {};
  const effectiveHMax = readAuthoredText(effectiveConfig, "hmax", "maximum_element_size");
  const effectiveHMin = readAuthoredText(effectiveConfig, "hmin", "minimum_element_size");
  const effectiveGrowthRate = readAuthoredText(
    effectiveConfig,
    "growth_rate",
    "maximum_element_growth_rate",
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
          disabled={!sessionScopeKey || pending || !dirty || validationError !== null}
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
