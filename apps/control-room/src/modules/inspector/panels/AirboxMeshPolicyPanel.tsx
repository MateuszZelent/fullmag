"use client";

import { useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  useMeshSummaryResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  asRecord,
  formatCount,
  formatLength,
  JsonResourceSection,
  MeshResourceFields,
  recordField,
} from "./MeshResourceView";
import { MeshQualityStatisticsView } from "./MeshQualityStatisticsView";
import {
  AIRBOX_GRADING_MODES,
  buildAirboxMeshPolicyReplaceRequest,
  defaultUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  draftKeyForUniverseMeshPolicyResource,
  type AirboxMeshPolicyDraft,
} from "./AirboxMeshPolicyPanelModel";

interface DraftState {
  draft: AirboxMeshPolicyDraft;
  key: string;
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AirboxMeshPolicyPanel({ selection }: InspectorPanelProps) {
  void selection;
  const { api, resources } = useKernel();
  const sessionStatus = useSessionStatus();
  const policy = useUniverseMeshPolicyResource();
  const report = useMeshUniverseReportResource({
    enabled: shouldLoadRuntimeMeshSummary(true, sessionStatus.data),
  });
  const quality = useMeshUniverseQualityResource({
    enabled: shouldLoadRuntimeMeshSummary(true, sessionStatus.data),
  });
  const summary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(true, sessionStatus.data),
  });
  const resource = policy.data ?? defaultUniverseMeshPolicyResource();
  const baseDraft = useMemo(
    () => draftFromUniverseMeshPolicyResource(resource),
    [resource],
  );
  const draftKey = draftKeyForUniverseMeshPolicyResource(resource);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const effectiveAirbox = asRecord(summary.data?.effective_airbox_target);
  const qualityRecord = asRecord(quality.data?.quality);
  const qualityStatistics = normalizeMeshQualityStatistics(quality.data?.quality);

  function updateDraft(patch: Partial<AirboxMeshPolicyDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyPolicy(): Promise<void> {
    const result = buildAirboxMeshPolicyReplaceRequest(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setPending(true);
    try {
      const next = await api.meshing.replaceUniversePolicy(result.request);
      resources.invalidate(MESH_UNIVERSE_POLICY_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, next.revision);
      setFeedback({ kind: "success", message: "Universe/airbox mesh policy updated." });
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
      defaultValue={["summary", "controls", "target", "quality-statistics", "transactions"]}
    >
      <InspectorSection value="summary" title="Universe / Airbox Mesh Policy" badge={policy.status} collapsible defaultCollapsed={false}>
        <FieldRow label="Revision" value={String(resource.revision)} />
        <FieldRow label="Policy state" value={resource.config ? "configured" : "unconfigured"} />
        <FieldRow label="Report state" value={report.status} />
        <FieldRow label="Quality state" value={quality.status} />
      </InspectorSection>

      <InspectorSection value="controls" title="Airbox Size Controls" badge="FEM domain">
        <FormField
          label="Airbox hmax"
          type="number"
          unit="m"
          value={draft.airboxHmax}
          onChange={(event) => updateDraft({ airboxHmax: event.target.value })}
        />
        <FormField
          label="Airbox hmin"
          type="number"
          unit="m"
          value={draft.airboxHmin}
          onChange={(event) => updateDraft({ airboxHmin: event.target.value })}
        />
        <FormField
          label="Airbox growth rate"
          type="number"
          value={draft.airboxGrowthRate}
          onChange={(event) =>
            updateDraft({ airboxGrowthRate: event.target.value })
          }
        />
        <FormField
          label="Airbox grading"
          type="select"
          value={draft.airboxGrading}
          onChange={(event) =>
            updateDraft({
              airboxGrading: event.target.value as AirboxMeshPolicyDraft["airboxGrading"],
            })
          }
        >
          {AIRBOX_GRADING_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </FormField>
      </InspectorSection>

      <InspectorSection value="target" title="Resolved Airbox Target">
        <MeshResourceFields
          fields={[
            {
              label: "Effective hmax",
              value: formatLength(recordField(effectiveAirbox, "maximum_element_size")),
            },
            {
              label: "Effective hmin",
              value: formatLength(recordField(effectiveAirbox, "minimum_element_size")),
            },
            {
              label: "Growth rate",
              value: String(recordField(effectiveAirbox, "growth_rate") ?? "unset"),
            },
            {
              label: "Quality status",
              value: String(recordField(qualityRecord, "status") ?? quality.status),
            },
          ]}
        />
      </InspectorSection>

      <InspectorSection
        value="quality-statistics"
        title="Airbox Quality Distributions"
        badge={qualityStatistics ? formatCount(qualityStatistics.elementCount) : "missing"}
        collapsible
        defaultCollapsed={false}
      >
        <MeshQualityStatisticsView statistics={qualityStatistics} />
      </InspectorSection>

      <InspectorSection value="advanced" title="Advanced JSON" collapsible defaultCollapsed={true}>
        <FormField
          label="Universe policy JSON"
          rows={8}
          type="textarea"
          value={draft.configText}
          onChange={(event) => updateDraft({ configText: event.target.value })}
        />
      </InspectorSection>

      <InspectorSection value="transactions" title="Transactions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyPolicy()}
          >
            Apply Airbox Policy
          </Button>
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setDraftState({ draft: baseDraft, key: draftKey });
              setFeedback(null);
            }}
          >
            Revert
          </Button>
        </div>
        {feedback ? (
          <FeedbackBanner kind={feedback.kind} message={feedback.message} />
        ) : null}
      </InspectorSection>

      <JsonResourceSection sectionValue="json-report" title="Universe Report JSON" value={report.data} />
      <JsonResourceSection sectionValue="json-quality" title="Universe Quality JSON" value={quality.data} />
    </Accordion>
  );
}
