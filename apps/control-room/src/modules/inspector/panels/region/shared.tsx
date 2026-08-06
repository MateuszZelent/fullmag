import { Button } from "@/shared/ui/Button";
import { FieldRow } from "../../primitives/FieldRow";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { MaterialParameterFieldListResource } from "@/kernel/api/apiTypes";
import type {
  ObjectRegionDraft,
  ObjectRegionPanelModel,
  RegionCouplingDependency,
  RegionMaterialOverrideDraft,
  RegionMeshPolicyDraft,
  RegionShapeDraft,
} from "../ObjectRegionsPanelModel";
import { resolveRegionInlineDiagnostics } from "./regionDiagnosticPresentation";
import type { RegionMeshLifecycle } from "@/shared/domain/mesh/regionMeshLifecycle";
import type { MeshInspectorLane } from "../fdmMeshInspectorModel";

export interface RegionSubPanelProps {
  model: ObjectRegionPanelModel;
  draft: ObjectRegionDraft;
  pending: boolean;
  draftDirty: boolean;
  buildRegion: () => Promise<void>;
  regionMeshLifecycle: RegionMeshLifecycle | null;
  canWriteRegion: boolean;
  canWriteMeshRegion?: boolean;
  meshLane?: MeshInspectorLane;
  updateDraft: (patch: Partial<ObjectRegionDraft>) => void;
  updateShape: (patch: Partial<RegionShapeDraft>) => void;
  updateShapeVector: (key: "axis" | "center" | "size", index: 0 | 1 | 2, value: number) => void;
  updateMeshPolicy: (patch: Partial<RegionMeshPolicyDraft>) => void;
  updateMaterialOverride: (
    index: number,
    patch: Partial<RegionMaterialOverrideDraft>,
  ) => void;
  addMaterialOverride: () => void;
  removeMaterialOverride: (index: number) => void;
  materialFields: MaterialParameterFieldListResource | null;
  couplingDependencies: RegionCouplingDependency[];
  applyRegion: () => Promise<boolean>;
  duplicateRegion: () => Promise<void>;
  deleteRegion: () => Promise<void>;
  revert: () => void;
  feedback: { kind: "error" | "success"; message: string } | null;
}

export function ObjectRegionInlineDiagnostics({
  capabilityGates,
  model,
}: {
  capabilityGates: readonly string[];
  model: ObjectRegionPanelModel;
}) {
  const diagnostics = resolveRegionInlineDiagnostics(
    model.diagnostics,
    capabilityGates,
  );
  if (diagnostics.length === 0) return null;

  return (
    <div className="fm-region-inline-diagnostics">
      {diagnostics.map((diagnostic) => (
        <FeedbackBanner
          key={diagnostic.diagnosticId}
          kind={diagnostic.kind}
          message={diagnostic.message}
        />
      ))}
    </div>
  );
}

export function ObjectRegionMetadataSection({
  model,
  meshLane = "unknown",
}: {
  model: ObjectRegionPanelModel;
  meshLane?: MeshInspectorLane;
}) {
  return (
    <InspectorGroup title="Authored Subregion" collapsible defaultOpen>
      <FieldRow label="Owner object ID" value={model.objectId} />
      <FieldRow label="Subregion ID" value={model.regionId} />
      <FieldRow label="Source" value={model.source} />
      <FieldRow label="Material ref" value={model.materialRef} />
      <FieldRow label="Magnetization ref" value={model.magnetizationRef} />
      <FieldRow label="Material overrides" value={String(model.materialOverrideCount)} />
      <FieldRow label="Parameter fields" value={String(model.materialFieldCount)} />
      <FieldRow
        label="Priority"
        value={model.priority === null ? "default" : String(model.priority)}
      />
      <FieldRow
        label="Realization"
        value={
          meshLane === "fem"
            ? model.realizationStatus ?? model.realizationPolicy ?? "inherits object"
            : meshLane === "fdm"
              ? "structured-grid membership"
              : "Withheld until the session discretization is explicit"
        }
      />
    </InspectorGroup>
  );
}

export function ObjectRegionActionsSection({
  pending,
  draftDirty,
  buildRegion,
  regionMeshLifecycle,
  meshLane = "unknown",
  canWriteRegion,
  canWriteMeshRegion,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
  couplingDependencies,
}: {
  pending: boolean;
  draftDirty: boolean;
  buildRegion: () => Promise<void>;
  regionMeshLifecycle: RegionMeshLifecycle | null;
  meshLane?: MeshInspectorLane;
  canWriteRegion: boolean;
  canWriteMeshRegion?: boolean;
  applyRegion: () => Promise<boolean>;
  revert: () => void;
  duplicateRegion: () => Promise<void>;
  deleteRegion: () => Promise<void>;
  feedback: { kind: "error" | "success"; message: string } | null;
  couplingDependencies: RegionCouplingDependency[];
}) {
  const femMeshLifecycle = meshLane === "fem" ? regionMeshLifecycle : null;
  const meshWritesAllowed = meshLane === "fem" && (canWriteMeshRegion ?? canWriteRegion);
  const hasActiveCouplings = couplingDependencies.length > 0;
  const couplingSummary =
    couplingDependencies.length === 0
      ? "none"
      : couplingDependencies
          .map(
            (dependency) =>
              `${dependency.couplingId} (${dependency.endpointRole}, ${dependency.status})`,
          )
          .join("; ");
  return (
    <InspectorGroup title="Actions">
      {femMeshLifecycle ? (
        <>
          <FieldRow label="Mesh realization" value={femMeshLifecycle.status} />
          <FieldRow label="Mesh status" value={femMeshLifecycle.reason} />
          <FieldRow
            label="Mesh generation"
            value={femMeshLifecycle.generationId ?? "not realized"}
          />
          <FieldRow
            label="Topology fingerprint"
            value={femMeshLifecycle.topologyFingerprint ?? "not certified"}
          />
        </>
      ) : (
        <>
          <FieldRow
            label="Mesh realization"
            value={
              meshLane === "fdm"
                ? "structured-grid cell participation"
                : "unresolved; FEM realization withheld"
            }
          />
          <FieldRow
            label="Unstructured topology"
            value={
              meshLane === "fdm"
                ? "Not applicable for FDM structured-grid regions"
                : "Not available until the session discretization is explicit"
            }
          />
          <FieldRow
            label="Mesh write actions"
            value={
              meshLane === "fdm"
                ? "FDM structured-grid membership is read-only; runtime-derived"
                : "withheld until FEM is resolved"
            }
          />
        </>
      )}
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending || !canWriteRegion}
          size="sm"
          type="button"
          variant="primary"
          title={canWriteRegion ? undefined : "Select an authored object region"}
          onClick={() => void applyRegion()}
        >
          Apply Region
        </Button>
        {meshLane === "fem" ? (
          <Button
            disabled={pending || !meshWritesAllowed || femMeshLifecycle?.status === "unsupported"}
            size="sm"
            type="button"
            variant="primary"
            title={meshWritesAllowed ? femMeshLifecycle?.reason : "FEM mesh realization is unavailable"}
            onClick={() => void buildRegion()}
          >
            {draftDirty ? "Apply & Build Mesh" : "Build Mesh"}
          </Button>
        ) : null}
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={revert}
        >
          Revert
        </Button>
        <Button
          disabled={pending || !canWriteRegion}
          size="sm"
          type="button"
          variant="ghost"
          title={canWriteRegion ? undefined : "Select an authored object region"}
          onClick={() => void duplicateRegion()}
        >
          Duplicate Region
        </Button>
        <span className="fm-inspector-toolbar__spacer" />
        <Button
          disabled={pending || !canWriteRegion || hasActiveCouplings}
          size="sm"
          type="button"
          variant="danger"
          title={
            hasActiveCouplings
              ? "Delete Coupling first"
              : canWriteRegion
                ? undefined
                : "Select an authored object region"
          }
          onClick={() => void deleteRegion()}
        >
          Delete Region
        </Button>
      </div>
      <FieldRow label="Active couplings" value={couplingSummary} />
      <FieldRow
        label="Write actions"
        value={
          hasActiveCouplings
            ? "Delete Coupling first"
            : canWriteRegion
              ? "available"
              : "authored regions only"
        }
      />
      {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
    </InspectorGroup>
  );
}
