"use client";

import { useMemo, useState } from "react";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
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

type AirboxMeshPolicyRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision"
  >;
};

function selectAirboxMeshPolicyRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): AirboxMeshPolicyRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      explicit_topology: status.data.capabilities?.explicit_topology ?? false,
    },
    domain: {
      discretization: status.data.domain?.discretization ?? "",
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
    },
  };
}

function airboxMeshPolicyRuntimeStatusEquals(
  previous: AirboxMeshPolicyRuntimeStatus | null,
  next: AirboxMeshPolicyRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAirboxPart(part: {
  id: string;
  label: string;
  role: string;
}): boolean {
  return (
    part.id === "part:__air__" ||
    part.role === "air" ||
    part.label.toLowerCase() === "airbox"
  );
}

export function AirboxMeshPolicyPanel({ selection }: InspectorPanelProps) {
  void selection;
  const { api, resources } = useKernel();
  const runtimeStatus = useSessionStatusSelector(
    selectAirboxMeshPolicyRuntimeStatus,
    { isEqual: airboxMeshPolicyRuntimeStatusEquals },
  );
  const policy = useUniverseMeshPolicyResource();
  const report = useMeshUniverseReportResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const quality = useMeshUniverseQualityResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const summary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
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
  const airboxPart = useMemo(
    () => manifest.data?.mesh_parts?.find(isAirboxPart) ?? null,
    [manifest.data?.mesh_parts],
  );
  const airboxNodeIndices = airboxPart?.node_indices ?? [];
  const airboxBoundaryFaceIndices = airboxPart?.boundary_face_indices ?? [];
  const airboxSurfaceFaces = airboxPart?.surface_faces ?? [];
  const airboxNodeSource =
    airboxNodeIndices.length > 0
      ? "explicit node_indices"
      : airboxPart
        ? "node_start/node_count range"
        : "not available";

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
      defaultValue={["summary", "controls", "geometry", "target", "mesh-part", "quality-statistics", "transactions"]}
    >
      <InspectorSection value="summary" title="Universe / Airbox Mesh Policy" badge={policy.status} collapsible defaultCollapsed={false}>
        <FieldRow label="Revision" value={String(resource.revision)} />
        <FieldRow label="Policy state" value={resource.config ? "configured" : "unconfigured"} />
        <FieldRow label="Report state" value={report.status} />
        <FieldRow label="Quality state" value={quality.status} />
      </InspectorSection>

      <InspectorSection value="controls" title="Element Size Parameters" badge="FEM domain">
        <FormField
          label="Maximum element size"
          type="number"
          unit="m"
          value={draft.airboxHmax}
          onChange={(event) => updateDraft({ airboxHmax: event.target.value })}
        />
        <FormField
          label="Minimum element size"
          type="number"
          unit="m"
          value={draft.airboxHmin}
          onChange={(event) => updateDraft({ airboxHmin: event.target.value })}
        />
        <FormField
          label="Maximum element growth rate"
          type="number"
          value={draft.airboxGrowthRate}
          onChange={(event) =>
            updateDraft({ airboxGrowthRate: event.target.value })
          }
        />
        <FormField
          label="Curvature factor"
          type="number"
          value={draft.curvatureFactor}
          onChange={(event) =>
            updateDraft({ curvatureFactor: event.target.value })
          }
        />
        <FormField
          label="Resolution of narrow regions"
          type="number"
          value={draft.narrowRegionResolution}
          onChange={(event) =>
            updateDraft({ narrowRegionResolution: event.target.value })
          }
        />
        <FormField
          label="Element grading"
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

      <InspectorSection value="geometry" title="Airbox Geometry" collapsible defaultCollapsed={true}>
        <FormField
          label="Domain mode"
          type="select"
          value={draft.airboxMode}
          onChange={(event) => updateDraft({ airboxMode: event.target.value })}
        >
          <option value="">Inherited</option>
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </FormField>
        <FormField
          label="Padding X"
          type="number"
          unit="m"
          value={draft.paddingX}
          onChange={(event) => updateDraft({ paddingX: event.target.value })}
        />
        <FormField
          label="Padding Y"
          type="number"
          unit="m"
          value={draft.paddingY}
          onChange={(event) => updateDraft({ paddingY: event.target.value })}
        />
        <FormField
          label="Padding Z"
          type="number"
          unit="m"
          value={draft.paddingZ}
          onChange={(event) => updateDraft({ paddingZ: event.target.value })}
        />
        <FormField
          label="Size X"
          type="number"
          unit="m"
          value={draft.airboxSizeX}
          onChange={(event) => updateDraft({ airboxSizeX: event.target.value })}
        />
        <FormField
          label="Size Y"
          type="number"
          unit="m"
          value={draft.airboxSizeY}
          onChange={(event) => updateDraft({ airboxSizeY: event.target.value })}
        />
        <FormField
          label="Size Z"
          type="number"
          unit="m"
          value={draft.airboxSizeZ}
          onChange={(event) => updateDraft({ airboxSizeZ: event.target.value })}
        />
        <FormField
          label="Center X"
          type="number"
          unit="m"
          value={draft.airboxCenterX}
          onChange={(event) => updateDraft({ airboxCenterX: event.target.value })}
        />
        <FormField
          label="Center Y"
          type="number"
          unit="m"
          value={draft.airboxCenterY}
          onChange={(event) => updateDraft({ airboxCenterY: event.target.value })}
        />
        <FormField
          label="Center Z"
          type="number"
          unit="m"
          value={draft.airboxCenterZ}
          onChange={(event) => updateDraft({ airboxCenterZ: event.target.value })}
        />
      </InspectorSection>

      <InspectorSection value="target" title="Resolved Airbox Target">
        <MeshResourceFields
          fields={[
            {
              label: "Effective max. element size",
              value: formatLength(recordField(effectiveAirbox, "maximum_element_size")),
            },
            {
              label: "Effective min. element size",
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
        value="mesh-part"
        title="Airbox Mesh Part"
        badge={airboxPart ? formatCount(airboxPart.node_count) : manifest.status}
        collapsible
        defaultCollapsed={false}
      >
        <MeshResourceFields
          fields={[
            {
              label: "Points / nodes",
              value: formatCount(airboxPart?.node_count),
            },
            {
              label: "Tetrahedra",
              value: formatCount(airboxPart?.element_count),
            },
            {
              label: "Boundary faces",
              value: formatCount(airboxPart?.boundary_face_count),
            },
            {
              label: "Surface faces",
              value: formatCount(airboxSurfaceFaces.length),
            },
            {
              label: "Part id",
              value: airboxPart?.id ?? "not available",
            },
            {
              label: "Role",
              value: airboxPart?.role ?? "not available",
            },
            {
              label: "Node source",
              value: airboxNodeSource,
            },
            {
              label: "Node range start",
              value:
                airboxPart && airboxNodeIndices.length === 0
                  ? formatCount(airboxPart.node_start)
                  : "not used",
            },
            {
              label: "Explicit node indices",
              value: formatCount(airboxNodeIndices.length),
            },
            {
              label: "Explicit boundary indices",
              value: formatCount(airboxBoundaryFaceIndices.length),
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
