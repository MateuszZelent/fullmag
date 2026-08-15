"use client";

import type { PhysicsGraphModuleResource } from "@/kernel/api/apiTypes";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { FeedbackBanner } from "../primitives/FeedbackBanner";
import type { InspectorPanelProps } from "../inspectorTypes";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";

function scopeFromResource(
  module: PhysicsGraphModuleResource,
): Parameters<typeof buildPhysicsInspectorOverviewModel>[0]["scope"] {
  const scope = module.applies_to[0];
  if (!scope) return { kind: "global", stableRef: "global" };
  switch (scope.kind) {
    case "global":
      return { kind: "global", stableRef: "global" };
    case "object":
      return {
        kind: "object",
        objectId: scope.object_id,
        label: `Object · ${scope.object_id}`,
        stableRef: `object:${scope.object_id}`,
      };
    case "region":
      return {
        kind: "region",
        objectId: scope.object_id,
        regionId: scope.region_id,
        label: `Region · ${scope.object_id}:${scope.region_id}`,
        stableRef: `region:${scope.object_id}:${scope.region_id}`,
      };
    case "interface":
      return {
        kind: "interface",
        sideA: regionLabel(scope.side_a),
        sideB: regionLabel(scope.side_b),
        stableRef: `interface:${regionLabel(scope.side_a)}:${regionLabel(scope.side_b)}`,
      };
    case "cross_object":
      return {
        kind: "cross_object",
        label: "Cross-object",
        stableRef: `cross-object:${scope.object_ids.join(",")}`,
      };
    case "unresolved":
      return {
        kind: "unresolved",
        label: "Unresolved",
        stableRef: `unresolved:${scope.source_path}`,
      };
  }
}

function regionLabel(region: { object_id: string; region_id?: string | null }): string {
  return `${region.object_id}:${region.region_id ?? "default"}`;
}

function selectedModule(
  selection: Selection,
  modules: readonly PhysicsGraphModuleResource[],
): PhysicsGraphModuleResource | null {
  const ref = selection.ref;
  if (ref?.type !== "physics-module") return null;
  return modules.find((module) => module.id === ref.physicsModuleId) ?? null;
}

export function PhysicsGraphModuleInspectorPanel({ selection }: InspectorPanelProps) {
  const resource = usePhysicsGraphResource({ enabled: true });
  const selectedPhysicsModule = selectedModule(selection, resource.data?.modules ?? []);
  if (!selectedPhysicsModule) {
    return (
      <div className="fm-inspector-panel">
        <FeedbackBanner kind="warning" message="The selected physics module is no longer present in the current graph revision." />
      </div>
    );
  }

  const status = selectedPhysicsModule.activation;
  const model = buildPhysicsInspectorOverviewModel({
    dependency: {
      requiredSourceIds: selectedPhysicsModule.depends_on,
      status,
    },
    execution: {
      capability: selectedPhysicsModule.capability,
      graphRevision: resource.data?.scene_revision ?? null,
      sceneRevision: resource.data?.scene_revision ?? null,
    },
    family: selectedPhysicsModule.presentation.family,
    scope: scopeFromResource(selectedPhysicsModule),
    source: {
      id: selectedPhysicsModule.id,
      kind: selectedPhysicsModule.kind,
      path: selectedPhysicsModule.source_path,
      status,
    },
    status,
    statusReason: selectedPhysicsModule.activation === "active" ? null : `Activation: ${selectedPhysicsModule.activation}`,
  });

  return <PhysicsInspectorOverview model={model} />;
}
