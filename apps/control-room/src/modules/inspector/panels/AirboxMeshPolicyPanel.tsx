"use client";

import { useCallback, useMemo, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type {
  JsonObject,
  LiveStatusResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
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
import {
  normalizeMeshQualityStatistics,
  type MeshQualityStatistics,
} from "@/shared/domain/mesh/qualityStatistics";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField, type FormFieldHelp } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  asRecord,
  formatCount,
  formatLength,
  JsonResourceSection,
  type JsonRecord,
  MeshResourceFields,
  recordField,
} from "./MeshResourceView";
import type { MeshSizeDistributionHoverBin } from "./MeshQualityChart";
import { MeshQualityStatisticsView } from "./MeshQualityStatisticsView";
import { emitMeshSizeHistogramHover } from "./meshSizeHistogramHover";
import {
  AIRBOX_GRADING_MODES,
  airboxMeshPolicyDraftDirty,
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

type AirboxMeshPolicyPatch = Partial<AirboxMeshPolicyDraft>;
type AirboxMeshPolicyPatchHandler = (patch: AirboxMeshPolicyPatch) => void;
type AirboxMeshPart = NonNullable<
  MeshSharedDomainManifestResource["mesh_parts"]
>[number];

const AIRBOX_MESH_HELP: Record<string, FormFieldHelp> = {
  center: {
    description: "Manual airbox center coordinate in meters.",
    details: ["Used when the airbox geometry is manually constrained by the universe policy."],
  },
  curvatureFactor: {
    description: "Curvature-driven sizing factor for the airbox/domain mesh where curvature sizing is active.",
  },
  grading: {
    description: "Element-size grading profile from refined regions to the coarse far-field airbox.",
    details: ["geometric is the COMSOL-like default for smooth growth."],
  },
  growthRate: {
    description: "Maximum requested growth rate for the airbox size transition.",
  },
  hmax: {
    description: "Coarsest target element size in the far-field airbox.",
  },
  hmin: {
    description: "Smallest allowed airbox element size. Fine edge/interface requests can be clamped by this value.",
  },
  mode: {
    description: "Airbox sizing mode. Auto derives the domain from scene geometry and universe settings.",
  },
  narrowRegionResolution: {
    description: "Resolution target for narrow air/domain regions when automatic narrow-region sizing is active.",
  },
  padding: {
    description: "Additional airbox padding around scene geometry in meters.",
  },
  size: {
    description: "Manual airbox extent in meters along the selected axis.",
  },
};

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

function isAirboxPart(part: AirboxMeshPart): boolean {
  return (
    part.id === "part:__air__" ||
    part.role === "air" ||
    part.label.toLowerCase() === "airbox"
  );
}

export function AirboxMeshPolicyPanel({ selection }: InspectorPanelProps) {
  void selection;
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
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
  const effectiveAirbox = asRecord(summary.data?.effective_airbox_target) as JsonObject | null;
  const baseDraft = useMemo(
    () =>
      draftFromUniverseMeshPolicyResource(resource, {
        effectiveTarget: effectiveAirbox,
      }),
    [effectiveAirbox, resource],
  );
  const draftKey = draftKeyForUniverseMeshPolicyResource(resource, {
    effectiveTarget: effectiveAirbox,
  });
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const isDirty = airboxMeshPolicyDraftDirty(draft, baseDraft);
  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sourceDetail: "airbox-mesh-policy",
      }),
    [kernel],
  );
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

  function updateDraft(patch: AirboxMeshPolicyPatch): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyPolicy({
    silentSuccess = false,
  }: {
    silentSuccess?: boolean;
  } = {}): Promise<{ ok: boolean }> {
    const result = buildAirboxMeshPolicyReplaceRequest(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return { ok: false };
    }

    setPending(true);
    try {
      const next = await api.meshing.replaceUniversePolicy(result.request);
      resources.invalidate(MESH_UNIVERSE_POLICY_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, next.revision);
      if (!silentSuccess) {
        setFeedback({
          kind: "success",
          message: "Policy saved. Current solver mesh is stale until a shared-domain mesh build completes.",
        });
      }
      return { ok: true };
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
      return { ok: false };
    } finally {
      setPending(false);
    }
  }

  async function buildSharedDomainMesh(): Promise<void> {
    if (isDirty) {
      const applied = await applyPolicy({ silentSuccess: true });
      if (!applied.ok) return;
    }

    try {
      await commands.execute("mesh.build-shared-domain", commandContext);
      setFeedback({
        kind: "success",
        message: isDirty
          ? "Policy saved. Shared-domain mesh build submitted."
          : "Shared-domain mesh build submitted. The Mesh Build monitor will track the command.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    }
  }

  function revertPolicyDraft(): void {
    setDraftState({ draft: baseDraft, key: draftKey });
    setFeedback(null);
  }

  const hoverSizeDistributionBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: { kind: "airbox" },
      });
    },
    [kernel],
  );
  const sections = airboxMeshInspectorSections(selection.kind);
  const showSection = (section: string) => sections.includes(section);

  return (
    <Accordion
      key={selection.kind ?? "default"}
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      {showSection("summary") ? (
        <AirboxMeshPolicySummarySection
          policyStatus={policy.status}
          qualityStatus={quality.status}
          reportStatus={report.status}
          resourceConfigured={Boolean(resource.config)}
          resourceRevision={resource.revision}
        />
      ) : null}
      {showSection("controls") ? (
        <AirboxMeshPolicyControlsSection draft={draft} onChange={updateDraft} />
      ) : null}
      {showSection("geometry") ? (
        <AirboxMeshPolicyGeometrySection draft={draft} onChange={updateDraft} />
      ) : null}
      {showSection("target") ? (
        <AirboxMeshPolicyTargetSection
          effectiveAirbox={effectiveAirbox}
          qualityRecord={qualityRecord}
          qualityStatus={quality.status}
        />
      ) : null}
      {showSection("mesh-part") ? (
        <AirboxMeshPolicyMeshPartSection
          airboxBoundaryFaceIndices={airboxBoundaryFaceIndices}
          airboxNodeIndices={airboxNodeIndices}
          airboxNodeSource={airboxNodeSource}
          airboxPart={airboxPart}
          airboxSurfaceFaces={airboxSurfaceFaces}
          manifestStatus={manifest.status}
        />
      ) : null}
      {showSection("quality-statistics") ? (
        <AirboxMeshPolicyQualitySection
          onHoverSizeDistributionBin={hoverSizeDistributionBin}
          qualityStatistics={qualityStatistics}
        />
      ) : null}
      {showSection("advanced") ? (
        <AirboxMeshPolicyAdvancedSection draft={draft} onChange={updateDraft} />
      ) : null}
      {showSection("transactions") ? (
        <AirboxMeshPolicyTransactionsSection
          buildLabel={
            isDirty ? "Apply & Build Shared-Domain Mesh" : "Build Shared-Domain Mesh"
          }
          feedback={feedback}
          isDirty={isDirty}
          onApply={() => void applyPolicy()}
          onBuild={() => void buildSharedDomainMesh()}
          onRevert={revertPolicyDraft}
          pending={pending}
        />
      ) : null}
      {showSection("json-report") ? (
        <JsonResourceSection
          sectionValue="json-report"
          title="Universe Report JSON"
          value={report.data}
        />
      ) : null}
      {showSection("json-quality") ? (
        <JsonResourceSection
          sectionValue="json-quality"
          title="Universe Quality JSON"
          value={quality.data}
        />
      ) : null}
    </Accordion>
  );
}

function airboxMeshInspectorSections(selectionKind: string | null): string[] {
  switch (selectionKind) {
    case "airbox.mesh-quality":
      return ["summary", "mesh-part", "quality-statistics", "json-quality"];
    case "airbox.mesh":
      return ["summary", "controls", "geometry", "target", "advanced", "transactions", "json-report"];
    default:
      return [
        "summary",
        "controls",
        "geometry",
        "target",
        "mesh-part",
        "quality-statistics",
        "advanced",
        "transactions",
        "json-report",
        "json-quality",
      ];
  }
}

function AirboxMeshPolicySummarySection({
  policyStatus,
  qualityStatus,
  reportStatus,
  resourceConfigured,
  resourceRevision,
}: {
  policyStatus: string;
  qualityStatus: string;
  reportStatus: string;
  resourceConfigured: boolean;
  resourceRevision: unknown;
}) {
  return (
    <InspectorSection
      value="summary"
      title="Universe / Airbox Mesh Policy"
      badge={policyStatus}
      collapsible
      defaultCollapsed={false}
    >
      <FieldRow label="Revision" value={String(resourceRevision)} />
      <FieldRow
        label="Policy state"
        value={resourceConfigured ? "configured" : "unconfigured"}
      />
      <FieldRow label="Report state" value={reportStatus} />
      <FieldRow label="Quality state" value={qualityStatus} />
    </InspectorSection>
  );
}

function AirboxMeshPolicyControlsSection({
  draft,
  onChange,
}: {
  draft: AirboxMeshPolicyDraft;
  onChange: AirboxMeshPolicyPatchHandler;
}) {
  return (
    <InspectorSection
      value="controls"
      title="Element Size Parameters"
      badge="FEM domain"
    >
      <FormField
        help={AIRBOX_MESH_HELP.hmax}
        label="Maximum element size"
        type="number"
        unit="m"
        value={draft.airboxHmax}
        onChange={(event) => onChange({ airboxHmax: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.hmin}
        label="Minimum element size"
        type="number"
        unit="m"
        value={draft.airboxHmin}
        onChange={(event) => onChange({ airboxHmin: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.growthRate}
        label="Maximum element growth rate"
        type="number"
        value={draft.airboxGrowthRate}
        onChange={(event) => onChange({ airboxGrowthRate: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.curvatureFactor}
        label="Curvature factor"
        type="number"
        value={draft.curvatureFactor}
        onChange={(event) => onChange({ curvatureFactor: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.narrowRegionResolution}
        label="Resolution of narrow regions"
        type="number"
        value={draft.narrowRegionResolution}
        onChange={(event) =>
          onChange({ narrowRegionResolution: event.target.value })
        }
      />
      <FormField
        help={AIRBOX_MESH_HELP.grading}
        label="Element grading"
        type="select"
        value={draft.airboxGrading}
        onChange={(event) =>
          onChange({
            airboxGrading: event.target
              .value as AirboxMeshPolicyDraft["airboxGrading"],
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
  );
}

function AirboxMeshPolicyGeometrySection({
  draft,
  onChange,
}: {
  draft: AirboxMeshPolicyDraft;
  onChange: AirboxMeshPolicyPatchHandler;
}) {
  return (
    <InspectorSection
      value="geometry"
      title="Airbox Geometry"
      collapsible
      defaultCollapsed={true}
    >
      <FormField
        help={AIRBOX_MESH_HELP.mode}
        label="Domain mode"
        type="select"
        value={draft.airboxMode}
        onChange={(event) => onChange({ airboxMode: event.target.value })}
      >
        <option value="">Inherited</option>
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      </FormField>
      <FormField
        help={AIRBOX_MESH_HELP.padding}
        label="Padding X"
        type="number"
        unit="m"
        value={draft.paddingX}
        onChange={(event) => onChange({ paddingX: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.padding}
        label="Padding Y"
        type="number"
        unit="m"
        value={draft.paddingY}
        onChange={(event) => onChange({ paddingY: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.padding}
        label="Padding Z"
        type="number"
        unit="m"
        value={draft.paddingZ}
        onChange={(event) => onChange({ paddingZ: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.size}
        label="Size X"
        type="number"
        unit="m"
        value={draft.airboxSizeX}
        onChange={(event) => onChange({ airboxSizeX: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.size}
        label="Size Y"
        type="number"
        unit="m"
        value={draft.airboxSizeY}
        onChange={(event) => onChange({ airboxSizeY: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.size}
        label="Size Z"
        type="number"
        unit="m"
        value={draft.airboxSizeZ}
        onChange={(event) => onChange({ airboxSizeZ: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.center}
        label="Center X"
        type="number"
        unit="m"
        value={draft.airboxCenterX}
        onChange={(event) => onChange({ airboxCenterX: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.center}
        label="Center Y"
        type="number"
        unit="m"
        value={draft.airboxCenterY}
        onChange={(event) => onChange({ airboxCenterY: event.target.value })}
      />
      <FormField
        help={AIRBOX_MESH_HELP.center}
        label="Center Z"
        type="number"
        unit="m"
        value={draft.airboxCenterZ}
        onChange={(event) => onChange({ airboxCenterZ: event.target.value })}
      />
    </InspectorSection>
  );
}

function AirboxMeshPolicyTargetSection({
  effectiveAirbox,
  qualityRecord,
  qualityStatus,
}: {
  effectiveAirbox: JsonRecord | null;
  qualityRecord: JsonRecord | null;
  qualityStatus: string;
}) {
  return (
    <InspectorSection value="target" title="Resolved Airbox Target">
      <MeshResourceFields
        fields={[
          {
            label: "Effective max. element size",
            value: formatLength(
              recordField(effectiveAirbox, "maximum_element_size"),
            ),
          },
          {
            label: "Effective min. element size",
            value: formatLength(
              recordField(effectiveAirbox, "minimum_element_size"),
            ),
          },
          {
            label: "Growth rate",
            value: String(recordField(effectiveAirbox, "growth_rate") ?? "unset"),
          },
          {
            label: "Quality status",
            value: String(recordField(qualityRecord, "status") ?? qualityStatus),
          },
        ]}
      />
    </InspectorSection>
  );
}

function AirboxMeshPolicyMeshPartSection({
  airboxBoundaryFaceIndices,
  airboxNodeIndices,
  airboxNodeSource,
  airboxPart,
  airboxSurfaceFaces,
  manifestStatus,
}: {
  airboxBoundaryFaceIndices: readonly unknown[];
  airboxNodeIndices: readonly unknown[];
  airboxNodeSource: string;
  airboxPart: AirboxMeshPart | null;
  airboxSurfaceFaces: readonly unknown[];
  manifestStatus: string;
}) {
  return (
    <InspectorSection
      value="mesh-part"
      title="Airbox Mesh Part"
      badge={airboxPart ? formatCount(airboxPart.node_count) : manifestStatus}
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
  );
}

function AirboxMeshPolicyQualitySection({
  onHoverSizeDistributionBin,
  qualityStatistics,
}: {
  onHoverSizeDistributionBin: (bin: MeshSizeDistributionHoverBin | null) => void;
  qualityStatistics: MeshQualityStatistics | null;
}) {
  return (
    <InspectorSection
      value="quality-statistics"
      title="Airbox Quality Distributions"
      badge={
        qualityStatistics ? formatCount(qualityStatistics.elementCount) : "missing"
      }
      collapsible
      defaultCollapsed={false}
    >
      <MeshQualityStatisticsView
        statistics={qualityStatistics}
        onHoverSizeDistributionBin={onHoverSizeDistributionBin}
      />
    </InspectorSection>
  );
}

function AirboxMeshPolicyAdvancedSection({
  draft,
  onChange,
}: {
  draft: AirboxMeshPolicyDraft;
  onChange: AirboxMeshPolicyPatchHandler;
}) {
  return (
    <InspectorSection
      value="advanced"
      title="Advanced JSON"
      collapsible
      defaultCollapsed={true}
    >
      <FormField
        label="Universe policy JSON"
        rows={8}
        type="textarea"
        value={draft.configText}
        onChange={(event) => onChange({ configText: event.target.value })}
      />
    </InspectorSection>
  );
}

export function AirboxMeshPolicyTransactionsSection({
  buildLabel,
  feedback,
  isDirty,
  onApply,
  onBuild,
  onRevert,
  pending,
}: {
  buildLabel: string;
  feedback: Feedback;
  isDirty: boolean;
  onApply: () => void;
  onBuild: () => void;
  onRevert: () => void;
  pending: boolean;
}) {
  return (
    <InspectorSection value="transactions" title="Transactions">
      {isDirty ? (
        <FeedbackBanner
          kind="warning"
          message="Unapplied changes. Apply Airbox Policy or Apply & Build before trusting the current airbox mesh."
        />
      ) : null}
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="primary"
          onClick={onApply}
        >
          Apply Airbox Policy
        </Button>
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="secondary"
          onClick={onBuild}
        >
          {buildLabel}
        </Button>
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={onRevert}
        >
          Revert
        </Button>
      </div>
      {feedback ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
    </InspectorSection>
  );
}
