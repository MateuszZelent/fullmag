"use client";

import { useMemo, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  resolveObjectMeshPolicyResourceKey,
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshReportResourceKey,
  useObjectMeshPolicyResource,
  useObjectMeshQualityResource,
  useObjectMeshReportResource,
  useObjectMeshSizeFieldResource,
  useObjectTopologyResource,
} from "@/kernel/resources/geometryLifecycleResources";
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
  JsonResourceSection,
  MeshResourceFields,
  recordField,
} from "./MeshResourceView";
import { MeshQualityStatisticsView } from "./MeshQualityStatisticsView";
import {
  buildObjectMeshPolicyReplaceRequest,
  defaultObjectMeshPolicyResource,
  draftFromObjectMeshPolicyResource,
  draftKeyForObjectMeshPolicyResource,
  type ObjectMeshPolicyDraft,
} from "./ObjectMeshPolicyPanelModel";

interface DraftState {
  draft: ObjectMeshPolicyDraft;
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

type UpdateObjectMeshPolicyDraft = (
  patch: Partial<ObjectMeshPolicyDraft>,
) => void;

function ObjectMeshPolicySummarySection({
  hasConfig,
  objectId,
  policyRevision,
  policyStatus,
  qualityStatus,
  reportStatus,
}: {
  hasConfig: boolean;
  objectId: string | null | undefined;
  policyRevision: number;
  policyStatus: string;
  qualityStatus: string;
  reportStatus: string;
}) {
  return (
    <InspectorSection value="summary" title="Object Mesh Policy" badge={policyStatus} collapsible defaultCollapsed={false}>
      <FieldRow label="Object ID" value={objectId ?? "no object selection"} />
      <FieldRow label="Revision" value={String(policyRevision)} />
      <FieldRow label="Policy" value={hasConfig ? "object override" : "inherited"} />
      <FieldRow label="Report state" value={reportStatus} />
      <FieldRow label="Quality state" value={qualityStatus} />
    </InspectorSection>
  );
}

function ObjectMeshOverrideSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection value="override" title="Override">
      <FormField
        checked={draft.present}
        label="Use object policy"
        type="checkbox"
        onChange={(event) => updateDraft({ present: event.target.checked })}
      />
    </InspectorSection>
  );
}

const MESH_SIZE_CALIBRATIONS = [
  "",
  "general_physics",
  "micromagnetics_static",
  "micromagnetics_relaxation",
  "micromagnetics_frequency_domain",
  "magnetostatics_dominated",
  "imported_surface_cleanup",
] as const;

const MESH_SIZE_PRESETS = [
  "",
  "extremely_fine",
  "extra_fine",
  "finer",
  "fine",
  "normal",
  "coarse",
  "coarser",
  "extra_coarse",
  "extremely_coarse",
] as const;

function ObjectMeshPresetSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection value="preset" title="Mesh Size Presets" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} label="Calibrate for" type="select" value={draft.calibrateFor} onChange={(event) => updateDraft({ calibrateFor: event.target.value })}>
        {MESH_SIZE_CALIBRATIONS.map((cal) => (
          <option key={cal} value={cal}>
            {cal || "Inherited"}
          </option>
        ))}
      </FormField>
      <FormField disabled={!draft.present} label="Size preset" type="select" value={draft.sizePreset} onChange={(event) => updateDraft({ sizePreset: event.target.value })}>
        {MESH_SIZE_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {preset ? preset.replace(/_/g, " ") : "Inherited"}
          </option>
        ))}
      </FormField>
      <FormField disabled={!draft.present} label="Size factor" type="number" value={draft.sizeFactor} onChange={(event) => updateDraft({ sizeFactor: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshSizeSemanticsSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection value="semantics" title="Element Size Parameters" badge="solver policy">
      <FormField disabled={!draft.present} label="Maximum element size" type="number" unit="m" value={draft.maximumElementSize} onChange={(event) => updateDraft({ maximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} label="Minimum element size" type="number" unit="m" value={draft.minimumElementSize} onChange={(event) => updateDraft({ minimumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} label="Maximum growth rate" type="number" value={draft.maximumElementGrowthRate} onChange={(event) => updateDraft({ maximumElementGrowthRate: event.target.value })} />
      <FormField disabled={!draft.present} label="Curvature factor" type="number" value={draft.curvatureFactor} onChange={(event) => updateDraft({ curvatureFactor: event.target.value })} />
      <FormField disabled={!draft.present} label="Narrow region resolution" type="number" value={draft.narrowRegionResolution} onChange={(event) => updateDraft({ narrowRegionResolution: event.target.value })} />
      <FormField disabled={!draft.present} label="FEM order" type="number" value={draft.order} onChange={(event) => updateDraft({ order: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshSweepStrategySection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection value="strategy" title="Thin-Film Sweep Strategy" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} label="Mesh strategy" type="select" value={draft.meshStrategy} onChange={(event) => updateDraft({ meshStrategy: event.target.value })}>
        <option value="">Inherited</option>
        <option value="auto">Auto</option>
        <option value="free_tetrahedral">Free tetrahedral</option>
        <option value="swept_prism">Swept prism</option>
        <option value="swept_hex">Swept hex</option>
      </FormField>
      <FormField disabled={!draft.present} label="Through-thickness elements" type="number" value={draft.throughThicknessElements} onChange={(event) => updateDraft({ throughThicknessElements: event.target.value })} />
      <FormField disabled={!draft.present} label="Thickness distribution" type="select" value={draft.throughThicknessDistribution} onChange={(event) => updateDraft({ throughThicknessDistribution: event.target.value })}>
        <option value="">Inherited</option>
        <option value="fixed">Fixed</option>
        <option value="linear">Linear</option>
        <option value="exponential">Exponential</option>
      </FormField>
      <FormField disabled={!draft.present} label="Thickness element ratio" type="number" value={draft.throughThicknessElementRatio} onChange={(event) => updateDraft({ throughThicknessElementRatio: event.target.value })} />
      <FormField disabled={!draft.present} label="Symmetric thickness" type="select" value={draft.throughThicknessSymmetric} onChange={(event) => updateDraft({ throughThicknessSymmetric: event.target.value })}>
        <option value="">Inherited</option>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </FormField>
      <FormField disabled={!draft.present} label="Sweep face meshing" type="select" value={draft.sweepFaceMeshing} onChange={(event) => updateDraft({ sweepFaceMeshing: event.target.value })}>
        <option value="">Inherited</option>
        <option value="triangular">Triangular</option>
        <option value="quadrilateral">Quadrilateral</option>
      </FormField>
    </InspectorSection>
  );
}

function ObjectMeshInterfaceTransitionSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection value="interface" title="Interface And Transition Refinement" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} label="Interface max. element size" type="number" unit="m" value={draft.interfaceMaximumElementSize} onChange={(event) => updateDraft({ interfaceMaximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} label="Interface thickness" type="number" unit="m" value={draft.interfaceThickness} onChange={(event) => updateDraft({ interfaceThickness: event.target.value })} />
      <FormField disabled={!draft.present} label="Transition distance" type="number" unit="m" value={draft.transitionDistance} onChange={(event) => updateDraft({ transitionDistance: event.target.value })} />
      <FormField disabled={!draft.present} label="Transition growth" type="number" value={draft.transitionGrowth} onChange={(event) => updateDraft({ transitionGrowth: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshBackendParametersSection({
  draft,
  updateDraft,
  sizeFieldKinds,
  sizeFieldsLength,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
  sizeFieldKinds: string[];
  sizeFieldsLength: number;
}) {
  return (
    <InspectorSection value="backend" title="Backend Mesh Parameters" badge="structured">
      <FormField disabled={!draft.present} label="Gmsh 2D algorithm" type="number" value={draft.algorithm2d} onChange={(event) => updateDraft({ algorithm2d: event.target.value })} />
      <FormField disabled={!draft.present} label="Gmsh 3D algorithm" type="number" value={draft.algorithm3d} onChange={(event) => updateDraft({ algorithm3d: event.target.value })} />
      <FormField disabled={!draft.present} label="Smoothing steps" type="number" value={draft.smoothingSteps} onChange={(event) => updateDraft({ smoothingSteps: event.target.value })} />
      <FormField disabled={!draft.present} label="Optimizer" type="select" value={draft.optimize} onChange={(event) => updateDraft({ optimize: event.target.value })}>
        <option value="">Inherited</option>
        <option value="Netgen">Netgen</option>
        <option value="HighOrder">High order</option>
        <option value="Relocate3D">Relocate 3D</option>
      </FormField>
      <FormField disabled={!draft.present} label="Optimizer iterations" type="number" value={draft.optimizeIterations} onChange={(event) => updateDraft({ optimizeIterations: event.target.value })} />
      <FormField disabled={!draft.present} label="Compute quality" type="select" value={draft.computeQuality} onChange={(event) => updateDraft({ computeQuality: event.target.value })}>
        <option value="">Inherited</option>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </FormField>
      <FormField disabled={!draft.present} label="Per-element quality" type="select" value={draft.perElementQuality} onChange={(event) => updateDraft({ perElementQuality: event.target.value })}>
        <option value="">Inherited</option>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </FormField>
      <FormField disabled={!draft.present} label="Boundary-layer count" type="number" value={draft.boundaryLayerCount} onChange={(event) => updateDraft({ boundaryLayerCount: event.target.value })} />
      <FormField disabled={!draft.present} label="Boundary-layer thickness" type="number" unit="m" value={draft.boundaryLayerThickness} onChange={(event) => updateDraft({ boundaryLayerThickness: event.target.value })} />
      <FormField disabled={!draft.present} label="Boundary-layer stretching" type="number" value={draft.boundaryLayerStretching} onChange={(event) => updateDraft({ boundaryLayerStretching: event.target.value })} />
      <FormField disabled={!draft.present} label="Boundary-layer surface tags" type="text" value={draft.boundaryLayerTargetSurfaceTags} onChange={(event) => updateDraft({ boundaryLayerTargetSurfaceTags: event.target.value })} />
      <FormField disabled={!draft.present} label="Boundary-layer curve tags" type="text" value={draft.boundaryLayerTargetCurveTags} onChange={(event) => updateDraft({ boundaryLayerTargetCurveTags: event.target.value })} />
      <MeshResourceFields
        fields={[
          { label: "Size-field count", value: String(sizeFieldsLength) },
          { label: "Size-field kinds", value: sizeFieldKinds.length ? sizeFieldKinds.join(", ") : "none" },
        ]}
      />
    </InspectorSection>
  );
}

function ObjectMeshManualSizeFieldSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  const disabled = !draft.present || !draft.manualBoxSizeFieldEnabled;
  return (
    <InspectorSection value="manual-size-field" title="Manual Size Field" badge="Box">
      <FormField
        checked={draft.manualBoxSizeFieldEnabled}
        disabled={!draft.present}
        label="Use Box size field"
        type="checkbox"
        onChange={(event) =>
          updateDraft({ manualBoxSizeFieldEnabled: event.target.checked })
        }
      />
      <FormField disabled={disabled} label="Box VIn" type="number" unit="m" value={draft.manualBoxSizeFieldVIn} onChange={(event) => updateDraft({ manualBoxSizeFieldVIn: event.target.value })} />
      <FormField disabled={disabled} label="Box VOut" type="number" unit="m" value={draft.manualBoxSizeFieldVOut} onChange={(event) => updateDraft({ manualBoxSizeFieldVOut: event.target.value })} />
      <FormField disabled={disabled} label="Box X min" type="number" unit="m" value={draft.manualBoxSizeFieldXMin} onChange={(event) => updateDraft({ manualBoxSizeFieldXMin: event.target.value })} />
      <FormField disabled={disabled} label="Box X max" type="number" unit="m" value={draft.manualBoxSizeFieldXMax} onChange={(event) => updateDraft({ manualBoxSizeFieldXMax: event.target.value })} />
      <FormField disabled={disabled} label="Box Y min" type="number" unit="m" value={draft.manualBoxSizeFieldYMin} onChange={(event) => updateDraft({ manualBoxSizeFieldYMin: event.target.value })} />
      <FormField disabled={disabled} label="Box Y max" type="number" unit="m" value={draft.manualBoxSizeFieldYMax} onChange={(event) => updateDraft({ manualBoxSizeFieldYMax: event.target.value })} />
      <FormField disabled={disabled} label="Box Z min" type="number" unit="m" value={draft.manualBoxSizeFieldZMin} onChange={(event) => updateDraft({ manualBoxSizeFieldZMin: event.target.value })} />
      <FormField disabled={disabled} label="Box Z max" type="number" unit="m" value={draft.manualBoxSizeFieldZMax} onChange={(event) => updateDraft({ manualBoxSizeFieldZMax: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshEdgeCornerSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection value="edge" title="Edge And Corner Refinement" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} label="Edge max. element size" type="number" unit="m" value={draft.edgeMaximumElementSize} onChange={(event) => updateDraft({ edgeMaximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} label="Edge thickness" type="number" unit="m" value={draft.edgeThickness} onChange={(event) => updateDraft({ edgeThickness: event.target.value })} />
      <FormField disabled={!draft.present} label="Corner max. element size" type="number" unit="m" value={draft.cornerMaximumElementSize} onChange={(event) => updateDraft({ cornerMaximumElementSize: event.target.value })} />
      <FormField disabled={!draft.present} label="Corner extent" type="number" unit="m" value={draft.cornerExtent} onChange={(event) => updateDraft({ cornerExtent: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshEffectiveTargetSection({
  effectiveTarget,
  reportStatus,
}: {
  effectiveTarget: Record<string, unknown> | null;
  reportStatus: string;
}) {
  return (
    <InspectorSection value="target" title="Effective Target" badge={reportStatus}>
      <MeshResourceFields
        fields={[
          { label: "Maximum element", value: String(recordField(effectiveTarget, "maximum_element_size") ?? "unset") },
          { label: "Minimum element", value: String(recordField(effectiveTarget, "minimum_element_size") ?? "unset") },
          { label: "Source", value: String(recordField(effectiveTarget, "source") ?? "not resolved") },
          { label: "Transition realization", value: String(recordField(effectiveTarget, "transition_realization") ?? "none") },
        ]}
      />
    </InspectorSection>
  );
}

function ObjectMeshTopologyQualitySection({
  qualityRecord,
  qualityRevision,
  qualityStatus,
  topology,
}: {
  qualityRecord: Record<string, unknown> | null;
  qualityRevision: number | undefined;
  qualityStatus: string;
  topology: ReturnType<typeof useObjectTopologyResource>;
}) {
  return (
    <InspectorSection value="topology" title="Topology And Quality" badge={topology.status}>
      <MeshResourceFields
        fields={[
          { label: "Topology fetch", value: topology.status },
          { label: "Nodes", value: formatCount(topology.data?.nodeCount) },
          { label: "Elements", value: formatCount(topology.data?.elementCount) },
          { label: "Boundary faces", value: formatCount(topology.data?.boundaryFaceCount) },
          { label: "Quality revision", value: String(qualityRevision ?? "unknown") },
          { label: "Quality status", value: String(recordField(qualityRecord, "status") ?? qualityStatus) },
        ]}
      />
    </InspectorSection>
  );
}

function ObjectMeshQualityStatisticsSection({
  statistics,
}: {
  statistics: ReturnType<typeof normalizeMeshQualityStatistics>;
}) {
  return (
    <InspectorSection
      value="object-quality-statistics"
      title="Object Quality Distributions"
      badge={statistics ? formatCount(statistics.elementCount) : "missing"}
      collapsible
      defaultCollapsed={false}
    >
      <MeshQualityStatisticsView statistics={statistics} />
    </InspectorSection>
  );
}

function ObjectMeshAdvancedJsonSection({
  draft,
  updateDraft,
}: {
  draft: ObjectMeshPolicyDraft;
  updateDraft: UpdateObjectMeshPolicyDraft;
}) {
  return (
    <InspectorSection value="advanced" title="Advanced JSON" collapsible defaultCollapsed={true}>
      <FormField disabled={!draft.present} label="Policy JSON" rows={8} type="textarea" value={draft.configText} onChange={(event) => updateDraft({ configText: event.target.value })} />
    </InspectorSection>
  );
}

function ObjectMeshTransactionsSection({
  feedback,
  objectId,
  onApply,
  onBuild,
  onRevert,
  pending,
}: {
  feedback: Feedback;
  objectId: string | null | undefined;
  onApply: () => void;
  onBuild: () => void;
  onRevert: () => void;
  pending: boolean;
}) {
  return (
    <InspectorSection value="transactions" title="Transactions">
      <div className="fm-inspector-toolbar">
        <Button disabled={pending || !objectId} size="sm" type="button" variant="primary" onClick={onApply}>
          Apply Policy
        </Button>
        <Button disabled={pending || !objectId} size="sm" type="button" variant="secondary" onClick={onBuild}>
          Build Mesh
        </Button>
        <Button disabled={pending} size="sm" type="button" variant="ghost" onClick={onRevert}>
          Revert
        </Button>
      </div>
      {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    </InspectorSection>
  );
}

export function ObjectMeshPolicyPanel({ selection }: InspectorPanelProps) {
  const objectId = selection.objectId;
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const policy = useObjectMeshPolicyResource(objectId);
  const report = useObjectMeshReportResource(objectId);
  const quality = useObjectMeshQualityResource(objectId);
  const sizeField = useObjectMeshSizeFieldResource(objectId);
  const topology = useObjectTopologyResource(objectId);
  const resource = policy.data ?? defaultObjectMeshPolicyResource(objectId ?? "");
  const baseDraft = useMemo(
    () => draftFromObjectMeshPolicyResource(resource),
    [resource],
  );
  const draftKey = draftKeyForObjectMeshPolicyResource(objectId, resource);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const reportRecord = asRecord(report.data?.report);
  const effectiveTarget = asRecord(recordField(reportRecord, "effective_target"));
  const sizeFieldRecord = asRecord(sizeField.data?.size_field);
  const sizeFields = Array.isArray(recordField(sizeFieldRecord, "size_fields"))
    ? (recordField(sizeFieldRecord, "size_fields") as unknown[])
    : [];
  const sizeFieldKinds: string[] = [];
  for (const field of sizeFields) {
    const kind = asRecord(field)?.kind;
    if (typeof kind === "string" && kind.length > 0) {
      sizeFieldKinds.push(kind);
    }
  }
  const qualityRecord = asRecord(quality.data?.quality);
  const qualityStatistics = normalizeMeshQualityStatistics(quality.data?.quality);
  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sourceDetail: "object-mesh-policy",
      }),
    [kernel],
  );

  function updateDraft(patch: Partial<ObjectMeshPolicyDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyPolicy(): Promise<void> {
    if (!objectId) {
      setFeedback({ kind: "error", message: "No selected scene object." });
      return;
    }

    const result = buildObjectMeshPolicyReplaceRequest(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setPending(true);
    try {
      const next = await api.meshing.replaceObjectPolicy(
        objectId,
        result.request,
      );
      const revision = next.revision;
      resources.invalidate(resolveObjectMeshPolicyResourceKey(objectId), revision);
      resources.invalidate(resolveObjectMeshReportResourceKey(objectId), revision);
      resources.invalidate(resolveObjectMeshQualityResourceKey(objectId), revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
      setFeedback({ kind: "success", message: "Object mesh policy updated." });
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
      defaultValue={["summary", "override", "preset", "semantics", "backend", "manual-size-field", "target", "topology", "object-quality-statistics", "transactions"]}
    >
      <ObjectMeshPolicySummarySection
        hasConfig={Boolean(resource.config)}
        objectId={objectId}
        policyRevision={resource.revision}
        policyStatus={policy.status}
        qualityStatus={quality.status}
        reportStatus={report.status}
      />
      <ObjectMeshOverrideSection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshPresetSection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshSizeSemanticsSection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshSweepStrategySection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshInterfaceTransitionSection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshBackendParametersSection
        draft={draft}
        updateDraft={updateDraft}
        sizeFieldKinds={sizeFieldKinds}
        sizeFieldsLength={sizeFields.length}
      />
      <ObjectMeshManualSizeFieldSection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshEdgeCornerSection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshEffectiveTargetSection
        effectiveTarget={effectiveTarget}
        reportStatus={report.status}
      />
      <ObjectMeshTopologyQualitySection
        qualityRecord={qualityRecord}
        qualityRevision={quality.data?.revision}
        qualityStatus={quality.status}
        topology={topology}
      />
      <ObjectMeshQualityStatisticsSection statistics={qualityStatistics} />
      <ObjectMeshAdvancedJsonSection draft={draft} updateDraft={updateDraft} />
      <ObjectMeshTransactionsSection
        feedback={feedback}
        objectId={objectId}
        onApply={() => void applyPolicy()}
        onBuild={() => void commands.execute("mesh.build-selected", commandContext)}
        onRevert={() => {
          setDraftState({ draft: baseDraft, key: draftKey });
          setFeedback(null);
        }}
        pending={pending}
      />

      <JsonResourceSection sectionValue="json-report" title="Object Mesh Report JSON" value={report.data} />
      <JsonResourceSection sectionValue="json-quality" title="Object Mesh Quality JSON" value={quality.data} />
      <JsonResourceSection sectionValue="json-size-field" title="Object Size Field JSON" value={sizeField.data} />
    </Accordion>
  );
}
