"use client";

import type { ChangeEvent } from "react";
import { useCallback, useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useMeshRegionQualityResource,
  useMeshRegionMembershipResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { FormField } from "../../primitives/FormField";
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

export function ObjectRegionMeshPanel({
  model,
  draft,
  pending,
  draftDirty,
  buildRegion,
  regionMeshLifecycle,
  canWriteRegion,
  couplingDependencies,
  updateMeshPolicy,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
}: RegionSubPanelProps) {
  const kernel = useKernel();
  const membership = useMeshRegionMembershipResource(model.regionId, {
    enabled: model.mode === "committed" && model.regionId !== "none",
  });
  const quality = useMeshRegionQualityResource(model.regionId, {
    enabled: model.mode === "committed" && model.regionId !== "none",
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
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-[var(--fm-inspector-group-gap)]">
      <ObjectRegionMetadataSection model={model} />

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
