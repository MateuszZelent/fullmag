"use client";

import { useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  MODEL_COUPLINGS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  publishCommittedSceneResource,
  useModelCouplingsResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import { resolveCouplingInspectorModel } from "./CouplingInspectorPanelModel";

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
  const { api, resources } = useKernel();
  const couplings = useModelCouplingsResource();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const model = useMemo(
    () => resolveCouplingInspectorModel(selection, couplings.data ?? null),
    [couplings.data, selection],
  );

  async function commitCouplingAction(
    action: "delete" | "toggle-enabled",
  ): Promise<void> {
    if (!model.couplingId || model.mode !== "found") {
      setFeedback({ kind: "error", message: "Select an authored coupling." });
      return;
    }

    setPending(true);
    try {
      const response =
        action === "delete"
          ? await api.model.deleteCoupling(model.couplingId, {
              baseRevision: couplings.data?.scene_revision,
            })
          : await api.model.patchCoupling(
              model.couplingId,
              { enabled: !model.enabled },
              { baseRevision: couplings.data?.scene_revision },
            );
      publishCommittedSceneResource(
        resources,
        response.committed_scene,
        response.scene_revision,
      );
      resources.invalidate(
        MODEL_COUPLINGS_RESOURCE_KEY,
        response.scene_revision,
      );
      resources.invalidate(
        MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
        response.scene_revision,
      );
      setFeedback({
        kind: "success",
        message:
          action === "delete" ? "Coupling deleted." : "Coupling updated.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={["identity", "endpoints", "parameters", "diagnostics"]}
    >
      <InspectorSection value="identity" title="Coupling" collapsible defaultCollapsed={false}>
        {model.mode === "missing" ? (
          <FeedbackBanner
            kind="warning"
            message="Selected coupling is not present in the current model resource."
          />
        ) : null}
        {model.mode === "unselected" ? (
          <FeedbackBanner kind="warning" message="No authored coupling selected." />
        ) : null}
        <FieldRow label="ID" value={model.couplingId ?? "none"} />
        <FieldRow label="Kind" value={model.kind} />
        <FieldRow label="Enabled" value={model.enabled ? "yes" : "no"} />
        <FieldRow label="Status" value={model.realizationStatus} />
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || model.mode !== "found"}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void commitCouplingAction("toggle-enabled")}
          >
            {model.enabled ? "Disable Coupling" : "Enable Coupling"}
          </Button>
          <Button
            disabled={pending || model.mode !== "found"}
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
      </InspectorSection>

      <InspectorSection value="endpoints" title="Endpoints">
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
      </InspectorSection>

      <InspectorSection value="parameters" title="Parameters">
        <FieldRow label="Values" value={formatParameters(model.parameters)} />
      </InspectorSection>

      <InspectorSection value="diagnostics" title="Diagnostics">
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
      </InspectorSection>
    </Accordion>
  );
}
