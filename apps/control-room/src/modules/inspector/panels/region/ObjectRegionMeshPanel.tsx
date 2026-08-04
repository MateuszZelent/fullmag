"use client";

import type { ChangeEvent } from "react";
import { useCallback, useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useDomainMetaResource,
  useFdmRegionMembershipBinaryResource,
  useFdmRegionMembershipResource,
  useMeshRegionQualityResource,
  useMeshRegionMembershipResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { FormField } from "../../primitives/FormField";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { MeshQualityStatisticsView } from "../MeshQualityStatisticsView";
import { emitMeshSizeHistogramHover } from "../meshSizeHistogramHover";
import { PhysicalScalarField } from "../ObjectRegionsPanel";
import {
  ObjectRegionMetadataSection,
  ObjectRegionActionsSection,
  ObjectRegionInlineDiagnostics,
  type RegionSubPanelProps,
} from "./shared";
import {
  fdmMeshNotApplicableReason,
  resolveFdmObjectMeshInspectorModel,
  type FdmObjectMeshInspectorResources,
} from "../fdmMeshInspectorModel";

export function ObjectRegionMeshPanel({
  model,
  draft,
  pending,
  draftDirty,
  buildRegion,
  regionMeshLifecycle,
  canWriteRegion,
  canWriteMeshRegion,
  meshLane = "unknown",
  couplingDependencies,
  updateMeshPolicy,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
}: RegionSubPanelProps) {
  const kernel = useKernel();
  const fdmLane = meshLane === "fdm";
  const femLane = meshLane === "fem";
  const fdmDomain = useDomainMetaResource({ enabled: fdmLane });
  const fdmMembership = useFdmRegionMembershipResource({ enabled: fdmLane });
  const fdmMembershipBinary = useFdmRegionMembershipBinaryResource(
    model.regionId === "none" ? null : model.regionId,
    {
      enabled: fdmLane && model.mode === "committed" && model.regionId !== "none",
    },
  );
  const fdmMeshResources = useMemo<FdmObjectMeshInspectorResources>(
    () => ({
      binary: fdmMembershipBinary,
      domain: fdmDomain,
      membership: fdmMembership,
    }),
    [fdmDomain, fdmMembership, fdmMembershipBinary],
  );
  const fdmModel = useMemo(
    () =>
      resolveFdmObjectMeshInspectorModel({
        lane: meshLane,
        objectId: model.objectId,
        regionId: model.regionId === "none" ? null : model.regionId,
        resources: fdmMeshResources,
      }),
    [fdmMeshResources, meshLane, model.objectId, model.regionId],
  );
  const membership = useMeshRegionMembershipResource(model.regionId, {
    enabled:
      femLane &&
      model.mode === "committed" &&
      model.regionId !== "none",
  });
  const quality = useMeshRegionQualityResource(model.regionId, {
    enabled:
      femLane &&
      model.mode === "committed" &&
      model.regionId !== "none",
  });
  const qualityStatistics = useMemo(
    () => normalizeMeshQualityStatistics(quality.data?.quality),
    [quality.data?.quality],
  );
  const hoverSizeDistributionBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: {
          kind: "region",
          meshPartIds: membership.data?.mesh_part_ids ?? [],
          objectId: model.objectId,
          regionId: model.regionId,
        },
      });
    },
    [kernel, membership.data?.mesh_part_ids, model.objectId, model.regionId],
  );
  if (meshLane === "fdm") {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
        <ObjectRegionMetadataSection model={model} meshLane={meshLane} />
        <InspectorGroup title="FDM Region Participation" badge={fdmModel.status}>
          {fdmModel.notice ? (
            <FeedbackBanner
              kind={fdmModel.status === "error" ? "error" : "warning"}
              message={fdmModel.notice}
            />
          ) : null}
          <FieldRow label="Mesh semantics" value="structured grid cells" />
          <FieldRow label="Grid origin" value={fdmModel.origin?.join(", ") ?? "not materialized"} unit="m" />
          <FieldRow label="Grid spacing" value={fdmModel.spacing?.join(", ") ?? "not materialized"} unit="m" />
          <FieldRow label="Grid shape" value={fdmModel.shape?.join(" × ") ?? "not materialized"} />
          <FieldRow label="Total cells" value={fdmModel.totalCells?.toLocaleString("en-US") ?? "not materialized"} />
          <FieldRow
            label="Cell participation"
            value={
              fdmModel.participation === "canonical-mask"
                ? `${fdmModel.activeCellCount ?? 0} active · ${fdmModel.inactiveCellCount ?? 0} outside support`
                : fdmModel.participation === "legacy-ambiguous"
                  ? "legacy mask is ambiguous; classification withheld"
                  : fdmModel.participation === "descriptor-only"
                    ? "canonical mask descriptor available; binary mask not loaded"
                    : "not materialized"
            }
          />
          <FieldRow
            label="Region metadata"
            value={
              fdmModel.metadata.length > 0
                ? fdmModel.metadata.map((entry) => `${entry.regionId} (${entry.numericId})`).join(", ")
                : "none for selected object"
            }
          />
          <FieldRow label="Grid fingerprint" value={fdmModel.gridFingerprint ?? "not materialized"} mono />
        </InspectorGroup>
        <InspectorGroup title="FEM Mesh Controls" badge="not applicable" collapsible defaultOpen={false}>
          <FeedbackBanner kind="warning" message={fdmMeshNotApplicableReason()} />
          <FieldRow label="Element order" value="Not applicable for FDM" />
          <FieldRow label="Tetra / prism / hex topology" value="Not applicable for FDM" />
          <FieldRow label="Gmsh and size fields" value="Not applicable for FDM" />
          <FieldRow label="Mesh quality" value="Not applicable for structured cells" />
          <FieldRow label="Shared-domain build" value="Not available in the FDM region inspector" />
          <FieldRow label="Write actions" value="Read-only: no FEM policy patch or mesh-build command" />
        </InspectorGroup>
      </div>
    );
  }
  if (meshLane !== "fem") {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
        <ObjectRegionMetadataSection model={model} meshLane={meshLane} />
        <InspectorGroup title="Mesh Semantics" badge="unresolved">
          <FeedbackBanner
            kind="warning"
            message="Mesh lane is unresolved; FEM mesh resources and controls are withheld until the session discretization is explicit."
          />
          <FieldRow label="Discretization" value={meshLane} />
          <FieldRow label="Mesh controls" value="Unavailable until FEM or FDM is resolved" />
        </InspectorGroup>
        <ObjectRegionActionsSection
          pending={pending}
          draftDirty={draftDirty}
          buildRegion={buildRegion}
          regionMeshLifecycle={regionMeshLifecycle}
          canWriteRegion={canWriteRegion}
          canWriteMeshRegion={canWriteMeshRegion}
          meshLane={meshLane}
          couplingDependencies={couplingDependencies}
          applyRegion={applyRegion}
          revert={revert}
          duplicateRegion={duplicateRegion}
          deleteRegion={deleteRegion}
          feedback={feedback}
        />
      </div>
    );
  }
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={model} meshLane={meshLane} />

      <InspectorGroup title="Mesh Policy">
        <ObjectRegionInlineDiagnostics
          capabilityGates={["regions.mesh_policy"]}
          model={model}
        />
        <FormField
          label="Enable mesh policy"
          type="checkbox"
          checked={draft.meshPolicy.enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => updateMeshPolicy({ enabled: event.target.checked })}
        />
        <PhysicalScalarField
          label="Max element size"
          unit="m"
          value={draft.meshPolicy.maximumElementSize}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ maximumElementSize: next })}
        />
        <PhysicalScalarField
          label="Min element size"
          unit="m"
          value={draft.meshPolicy.minimumElementSize}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ minimumElementSize: next })}
        />
        <PhysicalScalarField
          label="Transition distance"
          unit="m"
          value={draft.meshPolicy.transitionDistance}
          disabled={!draft.meshPolicy.enabled}
          onValueChange={(next) => updateMeshPolicy({ transitionDistance: next })}
        />
        <FormField
          label="Order"
          type="number"
          step={1}
          value={String(draft.meshPolicy.order)}
          disabled={!draft.meshPolicy.enabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => updateMeshPolicy({ order: Number(event.target.value) })}
        />
      </InspectorGroup>

      <InspectorGroup
        title="Region Quality Distributions"
        badge={
          qualityStatistics?.elementCount === null ||
          qualityStatistics?.elementCount === undefined
            ? quality.status
            : qualityStatistics.elementCount.toLocaleString("en-US")
        }
        collapsible
        defaultOpen
      >
        <MeshQualityStatisticsView
          statistics={qualityStatistics}
          onHoverSizeDistributionBin={hoverSizeDistributionBin}
        />
      </InspectorGroup>

      <ObjectRegionActionsSection
        pending={pending}
        draftDirty={draftDirty}
        buildRegion={buildRegion}
        regionMeshLifecycle={regionMeshLifecycle}
        canWriteRegion={canWriteRegion}
        canWriteMeshRegion={canWriteMeshRegion}
        meshLane={meshLane}
        couplingDependencies={couplingDependencies}
        applyRegion={applyRegion}
        revert={revert}
        duplicateRegion={duplicateRegion}
        deleteRegion={deleteRegion}
        feedback={feedback}
      />
    </div>
  );
}
