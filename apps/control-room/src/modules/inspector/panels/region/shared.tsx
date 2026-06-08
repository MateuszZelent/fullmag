import { Button } from "@/shared/ui/Button";
import { FieldRow } from "../../primitives/FieldRow";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorSection } from "../../primitives/InspectorSection";
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

export interface RegionSubPanelProps {
  model: ObjectRegionPanelModel;
  draft: ObjectRegionDraft;
  pending: boolean;
  canWriteRegion: boolean;
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
  applyRegion: () => Promise<void>;
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

export function ObjectRegionMetadataSection({ model }: { model: ObjectRegionPanelModel }) {
  return (
    <InspectorSection value="regions" title="Object Regions" collapsible defaultCollapsed={false}>
      <FieldRow label="Object ID" value={model.objectId} />
      <FieldRow label="Region ID" value={model.regionId} />
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
        value={model.realizationStatus ?? model.realizationPolicy ?? "inherits object"}
      />
    </InspectorSection>
  );
}

export function ObjectRegionActionsSection({
  pending,
  canWriteRegion,
  applyRegion,
  revert,
  duplicateRegion,
  deleteRegion,
  feedback,
  couplingDependencies,
}: {
  pending: boolean;
  canWriteRegion: boolean;
  applyRegion: () => Promise<void>;
  revert: () => void;
  duplicateRegion: () => Promise<void>;
  deleteRegion: () => Promise<void>;
  feedback: { kind: "error" | "success"; message: string } | null;
  couplingDependencies: RegionCouplingDependency[];
}) {
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
    <InspectorSection value="actions" title="Actions">
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
    </InspectorSection>
  );
}
