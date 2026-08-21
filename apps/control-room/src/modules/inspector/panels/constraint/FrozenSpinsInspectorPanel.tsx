"use client";

import { useEffect, useRef, useState } from "react";

import type {
  FrozenSpinsActivation,
  FrozenSpinsDefinition,
  FrozenSpinsMembershipPolicy,
  FrozenSpinsPreviewResponse,
  FrozenSpinsReferencePolicy,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY,
  frozenSpinsCollectionResourceKey,
  frozenSpinsDefinitionResourceKey,
  useFrozenSpinsDefinitionResource,
} from "@/kernel/resources/frozenSpinsResources";
import { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { SelectionExpressionBuilder } from "../selection/SelectionExpressionBuilder";

type PendingField = "apply" | "delete" | "preview" | null;

interface Feedback {
  kind: "error" | "success" | "warning";
  message: string;
}

export function FrozenSpinsInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frozen-spins" ? selection.ref : null;
  const constraintId = ref?.constraintId ?? "";
  const resource = useFrozenSpinsDefinitionResource(constraintId, {
    enabled: ref !== null,
  });
  const lastGoodRef = useRef<{
    constraintId: string;
    resource: NonNullable<typeof resource.data>;
  } | null>(null);
  if (resource.data) {
    lastGoodRef.current = { constraintId, resource: resource.data };
  }
  const retainedResource =
    resource.data ??
    (lastGoodRef.current?.constraintId === constraintId
      ? lastGoodRef.current.resource
      : null);

  if (!ref) {
    return (
      <FeedbackBanner
        kind="warning"
        message="Select a Frozen Spins constraint in Explorer."
      />
    );
  }
  if (resource.error && !retainedResource) {
    return <FeedbackBanner kind="error" message={errorMessage(resource.error)} />;
  }
  if (!retainedResource) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
        <p className="fm-help-text">Loading Frozen Spins definition…</p>
      </div>
    );
  }

  return (
    <FrozenSpinsEditor
      key={constraintId}
      definition={retainedResource.definition}
      objectId={ref.objectId}
      regionId={ref.regionId ?? null}
      revision={retainedResource.revision}
    />
  );
}

export function FrozenSpinsEditor({
  definition: initialDefinition,
  objectId,
  regionId,
  revision: initialRevision,
}: {
  definition: FrozenSpinsDefinition;
  objectId: string;
  regionId: string | null;
  revision: number;
}) {
  const kernel = useKernel();
  const [draft, setDraft] = useState(() => normalizeDefinition(initialDefinition));
  const draftRef = useRef(draft);
  const [revision, setRevision] = useState(initialRevision);
  const [pendingField, setPendingField] = useState<PendingField>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [preview, setPreview] = useState<FrozenSpinsPreviewResponse | null>(null);
  const fieldMeta = useFieldMetaResource({
    owner_object_id: objectId,
    quantityId: "m",
  });
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  async function applyDraft(): Promise<void> {
    const submittedDraft = draft;
    setPendingField("apply");
    setFeedback(null);
    try {
      const response = await kernel.api.model.frozenSpins.patch(draft.id, {
        definition: draft,
        expected_revision: revision,
      });
      if (draftRef.current === submittedDraft) {
        const acknowledged = normalizeDefinition(response.definition);
        draftRef.current = acknowledged;
        setDraft(acknowledged);
      }
      setRevision(response.revision);
      invalidateDefinitionResources(kernel, draft.id, response.revision);
      setFeedback({ kind: "success", message: "Frozen Spins definition updated." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPendingField(null);
    }
  }

  async function createPreview(): Promise<void> {
    const sourceStateRevision = fieldMeta.data?.source_revision;
    const topologyFingerprint = fieldMeta.data?.publication_bundle?.topology_hash;
    if (sourceStateRevision === undefined || !topologyFingerprint) {
      setFeedback({
        kind: "warning",
        message: "Current magnetization and topology identity are required for preview.",
      });
      return;
    }
    setPendingField("preview");
    setFeedback(null);
    try {
      const response = await kernel.api.model.frozenSpins.createPreview({
        expected_revision: revision,
        expected_source_state_revision: sourceStateRevision,
        expected_topology_fingerprint: topologyFingerprint,
        selector: draft.selector,
        stage_id:
          draft.activation?.kind === "stage_ids"
            ? draft.activation.stage_ids[0] ?? null
            : null,
        target_object_id: objectId,
      });
      setPreview(response);
      kernel.resources.invalidate(
        FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY,
        response.preview_id,
      );
      setFeedback({
        kind: response.current ? "success" : "warning",
        message: response.current
          ? "Frozen Spins preview is current and visible in the 3D viewport."
          : "Preview was created but is stale against the current model state.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPendingField(null);
    }
  }

  async function deleteDefinition(): Promise<void> {
    setPendingField("delete");
    setFeedback(null);
    try {
      const response = await kernel.api.model.frozenSpins.delete(draft.id, {
        expected_revision: revision,
      });
      kernel.resources.invalidate(
        frozenSpinsCollectionResourceKey(),
        response.revision,
      );
      kernel.resources.invalidate(
        frozenSpinsDefinitionResourceKey(draft.id),
        response.revision,
      );
      kernel.selection.clear("inspector");
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
      setPendingField(null);
    }
  }

  const activation = draft.activation ?? { kind: "all_stages" };
  const reference = draft.reference ?? { kind: "capture_current_at_activation" };
  const membership = draft.membership ?? { kind: "static" };

  return (
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-frozen-spins-inspector-id={draft.id}
    >
      {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
      <InspectorGroup title="Frozen Spins" collapsible defaultOpen>
        <FieldRow label="Constraint ID" value={draft.id} />
        <FieldRow label="Schema" value={draft.schema_version} />
        <TextInput
          label="Name"
          value={draft.name}
          onChange={(name) => setDraft((current) => ({ ...current, name }))}
        />
        <label className="fm-inspector-field">
          <input
            checked={draft.enabled ?? true}
            type="checkbox"
            onChange={(event) =>
              setDraft((current) => ({ ...current, enabled: event.target.checked }))
            }
          />
          <span>Enabled</span>
        </label>
      </InspectorGroup>

      <InspectorGroup title="Selection" collapsible defaultOpen>
        <SelectionExpressionBuilder
          expression={draft.selector}
          objectId={objectId}
          regionId={regionId}
          onChange={(selector) => setDraft((current) => ({ ...current, selector }))}
        />
        <SelectInput
          label="Membership"
          value={membership.kind}
          options={[
            ["static", "Static"],
            ["snapshot_at_activation", "Snapshot at activation"],
          ]}
          onChange={(kind) =>
            setDraft((current) => ({
              ...current,
              membership: { kind } as FrozenSpinsMembershipPolicy,
            }))
          }
        />
        <SelectInput
          label="Empty selection"
          value={draft.empty_selection ?? "error"}
          options={[
            ["error", "Error"],
            ["allow_noop", "Allow no-op"],
          ]}
          onChange={(empty_selection) =>
            setDraft((current) => ({
              ...current,
              empty_selection: empty_selection as FrozenSpinsDefinition["empty_selection"],
            }))
          }
        />
        <SelectInput
          label="Inactive selection"
          value={draft.inactive_selection ?? "warn_and_intersect"}
          options={[
            ["warn_and_intersect", "Warn and intersect"],
            ["error", "Error"],
          ]}
          onChange={(inactive_selection) =>
            setDraft((current) => ({
              ...current,
              inactive_selection:
                inactive_selection as FrozenSpinsDefinition["inactive_selection"],
            }))
          }
        />
      </InspectorGroup>

      <InspectorGroup title="Activation and reference" collapsible defaultOpen>
        <SelectInput
          label="Activation"
          value={activation.kind}
          options={[
            ["all_stages", "All stages"],
            ["stage_ids", "Selected stage IDs"],
          ]}
          onChange={(kind) =>
            setDraft((current) => ({
              ...current,
              activation:
                kind === "stage_ids"
                  ? { kind, stage_ids: [] }
                  : ({ kind } as FrozenSpinsActivation),
            }))
          }
        />
        {activation.kind === "stage_ids" ? (
          <TextInput
            label="Stage IDs"
            value={activation.stage_ids.join(", ")}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                activation: {
                  kind: "stage_ids",
                  stage_ids: splitIds(value),
                },
              }))
            }
          />
        ) : null}
        <SelectInput
          label="Reference"
          value={reference.kind}
          options={[
            ["capture_current_at_activation", "Capture current at activation"],
            ["initial_state", "Initial state"],
            ["explicit_field_asset", "Explicit field asset"],
          ]}
          onChange={(kind) =>
            setDraft((current) => ({
              ...current,
              reference:
                kind === "explicit_field_asset"
                  ? { kind, asset_id: "" }
                  : ({ kind } as FrozenSpinsReferencePolicy),
            }))
          }
        />
        {reference.kind === "explicit_field_asset" ? (
          <TextInput
            label="Field asset ID"
            value={reference.asset_id}
            onChange={(asset_id) =>
              setDraft((current) => ({
                ...current,
                reference: { kind: "explicit_field_asset", asset_id },
              }))
            }
          />
        ) : null}
      </InspectorGroup>

      <InspectorGroup title="Preview" collapsible defaultOpen>
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pendingField === "preview"}
            size="sm"
            type="button"
            onClick={() => void createPreview()}
          >
            {pendingField === "preview" ? "Computing preview…" : "Preview mask"}
          </Button>
          <Button
            disabled={pendingField === "apply"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyDraft()}
          >
            {pendingField === "apply" ? "Applying…" : "Apply"}
          </Button>
          <Button
            disabled={pendingField === "delete"}
            size="sm"
            type="button"
            variant="danger"
            onClick={() => void deleteDefinition()}
          >
            {pendingField === "delete" ? "Deleting…" : "Delete"}
          </Button>
        </div>
        {preview ? <FrozenSpinsPreviewDetails preview={preview} /> : null}
      </InspectorGroup>
    </div>
  );
}

export function FrozenSpinsPreviewDetails({
  preview,
}: {
  preview: FrozenSpinsPreviewResponse;
}) {
  return (
    <div className="fm-inspector-panel" data-preview-current={preview.current}>
      <FieldRow label="Preview ID" value={preview.preview_id} />
      <FieldRow label="Frozen DOFs" value={String(preview.frozen_dof_count)} />
      <FieldRow label="Free DOFs" value={String(preview.free_dof_count)} />
      <FieldRow label="Frozen fraction" value={`${(preview.fraction * 100).toFixed(2)}%`} />
      <FieldRow label="Bounds (m)" value={formatBounds(preview.bounds_m)} />
      <FieldRow label="Mask hash" value={preview.mask_sha256} />
      <FieldRow label="Freshness" value={preview.current ? "current" : "stale"} />
      <FieldRow label="Qualification" value={preview.resolved.qualification} />
      {preview.warnings.map((warning) => (
        <FeedbackBanner
          key={`${warning.code}:${warning.message}`}
          kind="warning"
          message={`${warning.code}: ${warning.message}`}
        />
      ))}
    </div>
  );
}

function normalizeDefinition(definition: FrozenSpinsDefinition): FrozenSpinsDefinition {
  return {
    ...definition,
    activation: definition.activation ?? { kind: "all_stages" },
    empty_selection: definition.empty_selection ?? "error",
    enabled: definition.enabled ?? true,
    inactive_selection: definition.inactive_selection ?? "warn_and_intersect",
    membership: definition.membership ?? { kind: "static" },
    reference: definition.reference ?? { kind: "capture_current_at_activation" },
  };
}

function invalidateDefinitionResources(
  kernel: ReturnType<typeof useKernel>,
  constraintId: string,
  revision: number,
): void {
  kernel.resources.invalidate(frozenSpinsCollectionResourceKey(), revision);
  kernel.resources.invalidate(frozenSpinsDefinitionResourceKey(constraintId), revision);
}

function splitIds(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function formatBounds(bounds: number[][] | null | undefined): string {
  if (!bounds?.length) return "not available";
  return bounds.map((axis) => `[${axis.map((value) => value.toExponential(3)).join(", ")}]`).join(" × ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TextInput({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <input
        aria-label={label}
        className="fm-inspector-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectInput({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  value: string;
}) {
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <select
        aria-label={label}
        className="fm-inspector-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, title]) => (
          <option key={option} value={option}>{title}</option>
        ))}
      </select>
    </label>
  );
}
