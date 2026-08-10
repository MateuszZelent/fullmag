"use client";

import type { ChangeEvent } from "react";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { RegionEditShapeKind } from "../ObjectRegionsPanelModel";
import { PhysicalScalarField } from "../ObjectRegionsPanel";
import {
  ObjectRegionMetadataSection,
  ObjectRegionActionsSection,
  type RegionSubPanelProps,
} from "./shared";

export function ObjectRegionGeometryPanel({
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
  updateShape,
  updateShapeVector,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
}: RegionSubPanelProps) {
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <ObjectRegionMetadataSection model={model} meshLane={meshLane} />

      <InspectorGroup title="Shape">
        <FormField
          label="Kind"
          type="select"
          value={draft.shape.kind}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            updateShape({ kind: event.target.value as RegionEditShapeKind })
          }
        >
          <option value="box">Box</option>
          <option value="cylinder">Cylinder</option>
          <option value="sphere">Sphere</option>
        </FormField>
        <PhysicalScalarField
          label="Center X"
          unit="m"
          value={draft.shape.center[0]}
          onValueChange={(next) => updateShapeVector("center", 0, next)}
        />
        <PhysicalScalarField
          label="Center Y"
          unit="m"
          value={draft.shape.center[1]}
          onValueChange={(next) => updateShapeVector("center", 1, next)}
        />
        <PhysicalScalarField
          label="Center Z"
          unit="m"
          value={draft.shape.center[2]}
          onValueChange={(next) => updateShapeVector("center", 2, next)}
        />
        {draft.shape.kind === "box" ? (
          <>
            <PhysicalScalarField
              label="Size X"
              unit="m"
              value={draft.shape.size[0]}
              onValueChange={(next) => updateShapeVector("size", 0, next)}
            />
            <PhysicalScalarField
              label="Size Y"
              unit="m"
              value={draft.shape.size[1]}
              onValueChange={(next) => updateShapeVector("size", 1, next)}
            />
            <PhysicalScalarField
              label="Size Z"
              unit="m"
              value={draft.shape.size[2]}
              onValueChange={(next) => updateShapeVector("size", 2, next)}
            />
          </>
        ) : null}
        {(
          draft.shape.kind === "cylinder" || draft.shape.kind === "sphere"
        ) ? (
          <PhysicalScalarField
            label="Radius"
            unit="m"
            value={draft.shape.radius}
            onValueChange={(next) => updateShape({ radius: next })}
          />
        ) : null}
        {draft.shape.kind === "cylinder" ? (
          <>
            <PhysicalScalarField
              label="Height"
              unit="m"
              value={draft.shape.height}
              onValueChange={(next) => updateShape({ height: next })}
            />
            <PhysicalScalarField
              label="Axis X"
              value={draft.shape.axis[0]}
              onValueChange={(next) => updateShapeVector("axis", 0, next)}
            />
            <PhysicalScalarField
              label="Axis Y"
              value={draft.shape.axis[1]}
              onValueChange={(next) => updateShapeVector("axis", 1, next)}
            />
            <PhysicalScalarField
              label="Axis Z"
              value={draft.shape.axis[2]}
              onValueChange={(next) => updateShapeVector("axis", 2, next)}
            />
          </>
        ) : null}
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
