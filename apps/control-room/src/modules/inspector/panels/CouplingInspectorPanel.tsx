"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  authoringWriteOptions,
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  MODEL_COUPLINGS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  publishCommittedSceneResource,
  useModelCouplingsResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { resolveCouplingInspectorModel } from "./CouplingInspectorPanelModel";
import { syncAuthoringScriptBestEffort } from "./ObjectMagneticTexturePanelViewModel";

type CouplingOwner = { sessionScopeKey: string | null; couplingId: string | null };
type CouplingFeedback = { kind: "error" | "success" | "warning"; message: string };

function formatParameters(parameters: Record<string, unknown>): string {
  const entries = Object.entries(parameters);
  if (entries.length === 0) return "none";
  return entries
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

function formatOptionalNumber(value: number | null, unit = ""): string {
  if (value === null) return "not available";
  return `${value.toExponential(4)}${unit}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CouplingInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { api, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const couplings = useModelCouplingsResource();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const model = useMemo(
    () => resolveCouplingInspectorModel(selection, couplings.data ?? null),
    [couplings.data, selection],
  );
  const couplingId = model.couplingId;
  const owner = useMemo<CouplingOwner>(() => ({ sessionScopeKey, couplingId }), [sessionScopeKey, couplingId]);
  const activeOwner = useRef<CouplingOwner | null>(null);
  useLayoutEffect(() => {
    activeOwner.current = owner;
    return () => { activeOwner.current = null; };
  }, [owner]);
  const [feedbackState, setFeedbackState] = useState<(CouplingFeedback & { owner: CouplingOwner }) | null>(null);
  const feedback = feedbackState?.owner === owner ? feedbackState : null;
  const setFeedback = (value: CouplingFeedback | null) => setFeedbackState(value ? { ...value, owner } : null);
  const resourceCurrent = couplings.status === "ready" && !couplings.refreshError && Boolean(couplings.data);
  const revision = couplings.data?.scene_revision;
  const lockReason = !sessionScopeKey
    ? "Session identity is not ready."
    : !resourceCurrent
      ? "Wait for the current coupling resource before changing it."
      : !Number.isSafeInteger(revision) || (revision ?? -1) < 0
        ? "The canonical scene revision is unavailable. Refresh before changing a coupling."
        : model.mode === "missing"
      ? "The selected coupling is not present in the current model resource."
          : model.mode === "unselected"
            ? "Select an authored coupling to use its immediate actions."
            : undefined;

  useRegisterInspectorEditSession(
    "immediate",
    pending,
    false,
    !lockReason,
    lockReason,
    () => true,
    () => undefined,
    { historyMode: "mutation-owned" },
  );

  async function commitCouplingAction(
    action: "delete" | "toggle-enabled",
  ): Promise<void> {
    if (inFlight.current) return;
    if (lockReason || !model.couplingId || !sessionScopeKey || revision === undefined) {
      setFeedback({ kind: "error", message: lockReason ?? "Select an authored coupling." });
      return;
    }

    const operationSessionScopeKey = sessionScopeKey;
    const mutationContext = captureAuthoringMutationFence(createCommandContext("inspector", kernel, {
      sessionScopeKey: operationSessionScopeKey,
      sourceDetail: "coupling-inspector",
    }));
    if (mutationContext.isCurrentSessionScope?.() !== true) return;
    inFlight.current = true;
    setPending(true);
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory(
        mutationContext,
        action === "delete"
          ? `Delete coupling ${model.couplingId}`
          : `Toggle coupling ${model.couplingId}`,
        async ({ baseRevision }) => {
          if (baseRevision !== null && baseRevision !== revision) {
            throw new Error("The scene changed before the coupling action. Refresh before trying again.");
          }
          const options = authoringWriteOptions(
            revision,
            operationSessionScopeKey,
          );
          if (!options?.sessionScopeKey) throw new Error("Session identity is not ready.");
          if (action === "delete") {
            return api.model.deleteCoupling(model.couplingId!, options);
          }
          return api.model.patchCoupling(
            model.couplingId!,
            { enabled: !model.enabled },
            options,
          );
        },
      );
      if (mutationContext.isCurrentSessionScope?.() !== true) return;
      if (!Number.isSafeInteger(response.scene_revision) || response.scene_revision <= revision
        || response.committed_scene?.revision !== response.scene_revision) {
        throw new Error("The coupling ACK omitted a coherent committed scene. Refresh before trying again.");
      }
      publishCommittedSceneResource(
        resources,
        response.committed_scene,
        response.scene_revision,
        undefined,
        true,
        operationSessionScopeKey,
        api.resourceCacheScope,
      );
      resources.invalidate(
        MODEL_COUPLINGS_RESOURCE_KEY,
        response.scene_revision,
      );
      resources.invalidate(
        MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
        response.scene_revision,
      );
      const syncWarning = await syncAuthoringScriptBestEffort(api, operationSessionScopeKey);
      if (mutationContext.isCurrentSessionScope?.() !== true || activeOwner.current !== owner) return;
      const message = action === "delete" ? "Coupling deleted." : "Coupling updated.";
      setFeedback({ kind: syncWarning ? "warning" : "success", message: syncWarning ? `${message} Authoring script sync skipped: ${syncWarning}` : message });
    } catch (error) {
      if (mutationContext.isCurrentSessionScope?.() === true && activeOwner.current === owner) {
        setFeedback({ kind: "error", message: errorMessage(error) });
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Coupling" collapsible defaultOpen>
        {!resourceCurrent ? (
          couplings.error || couplings.refreshError ? (
            <FeedbackBanner kind="error" message={`Coupling resource unavailable: ${errorMessage(couplings.error ?? couplings.refreshError)}${couplings.data ? " Showing previous details." : ""}`} />
          ) : <p className="fm-help-text" role="status">{couplings.data ? "Refreshing couplings. Showing previous details." : "Loading coupling details…"}</p>
        ) : null}
        {resourceCurrent && model.mode === "missing" ? (
          <FeedbackBanner
            kind="warning"
            message="Selected coupling is not present in the current model resource."
          />
        ) : null}
        {model.mode === "unselected" ? (
          <FeedbackBanner kind="warning" message="No authored coupling selected." />
        ) : null}
        <FieldRow label="ID" value={model.couplingId ?? "none"} />
        <FieldRow label="Kind" value={model.mode === "found" ? model.kind : "not available"} />
        <FieldRow label="Enabled" value={model.mode === "found" ? model.enabled ? "yes" : "no" : "not available"} />
        <FieldRow label="Status" value={resourceCurrent ? model.realizationStatus : "not current"} />
        {lockReason && model.mode === "found" ? <p className="fm-help-text" role="status">{lockReason}</p> : null}
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || Boolean(lockReason)}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void commitCouplingAction("toggle-enabled")}
          >
            {model.enabled ? "Disable Coupling" : "Enable Coupling"}
          </Button>
          <Button
            disabled={pending || Boolean(lockReason)}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void commitCouplingAction("delete")}
          >
            Delete Coupling
          </Button>
        </div>
        {feedback ? (
          <FeedbackBanner kind={feedback.kind} message={feedback.message} />
        ) : null}
      </InspectorGroup>

      <InspectorGroup title="Endpoints" collapsible defaultOpen>
        <FieldRow label="Source" value={model.source?.label ?? "unresolved"} />
        <FieldRow label="Source kind" value={model.source?.kind ?? "unresolved"} />
        <FieldRow
          label="Source resolution"
          value={model.source?.resolutionStatus ?? "unresolved"}
        />
        <FieldRow
          label="Source faces"
          value={model.source?.resolvedFaceCount?.toString() ?? "not available"}
        />
        <FieldRow
          label="Source area"
          value={formatOptionalNumber(model.source?.area ?? null, " m²")}
        />
        <FieldRow label="Target" value={model.target?.label ?? "unresolved"} />
        <FieldRow label="Target kind" value={model.target?.kind ?? "unresolved"} />
        <FieldRow
          label="Target resolution"
          value={model.target?.resolutionStatus ?? "unresolved"}
        />
        <FieldRow
          label="Target faces"
          value={model.target?.resolvedFaceCount?.toString() ?? "not available"}
        />
        <FieldRow
          label="Target area"
          value={formatOptionalNumber(model.target?.area ?? null, " m²")}
        />
      </InspectorGroup>

      <InspectorGroup title="Parameters" collapsible defaultOpen>
        <FieldRow label="Values" value={formatParameters(model.parameters)} />
      </InspectorGroup>

      <InspectorGroup title="Diagnostics" collapsible defaultOpen>
        {model.blockerReason ? (
          <FeedbackBanner kind="error" message={model.blockerReason} />
        ) : null}
        <FieldRow
          label="Runtime policy"
          value={
            model.realizationStatus.includes("requires")
              ? "requires backend capability"
              : "authored intent"
          }
        />
        <FieldRow
          label="Source detail"
          value={model.source?.resolutionReason ?? "none"}
        />
        <FieldRow
          label="Target detail"
          value={model.target?.resolutionReason ?? "none"}
        />
        <FieldRow
          label="Source tolerance"
          value={formatOptionalNumber(model.source?.tolerance ?? null, " m")}
        />
        <FieldRow
          label="Target tolerance"
          value={formatOptionalNumber(model.target?.tolerance ?? null, " m")}
        />
      </InspectorGroup>
    </div>
  );
}
