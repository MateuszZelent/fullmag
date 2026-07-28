"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { FormField } from "../../primitives/FormField";
import type {
  StageAutosaveDraft,
  StageAutosaveOwnerKind,
} from "../StageAutosaveDraft";

export function StageAutosaveSection({
  draft,
  onChange,
  owner,
}: {
  draft: StageAutosaveDraft;
  onChange: (draft: StageAutosaveDraft) => void;
  owner: StageAutosaveOwnerKind;
}) {
  const cadenceUnit = owner === "relax" ? "accepted steps" : "s";
  return (
    <section className="fm-stage-autosave" aria-label="Stage autosave">
      <div className="fm-stage-autosave__heading">
        <div>
          <strong>Autosave</strong>
          <p>Persist data owned by this {owner === "relax" ? "Relax" : "Run"} stage.</p>
        </div>
        <FormField
          checked={draft.enabled}
          inline
          label="Enabled"
          type="checkbox"
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
      </div>
      {draft.enabled ? (
        <div className="fm-stage-autosave__body">
          <FormField
            label="Target"
            value={draft.target}
            hint="Stages sharing a continuous target append references to one logical series."
            onChange={(event) => onChange({ ...draft, target: event.target.value })}
          />
          <FormField
            label="Layout"
            type="select"
            value={draft.layout}
            onChange={(event) => onChange({ ...draft, layout: event.target.value as StageAutosaveDraft["layout"] })}
          >
            <option value="continuous">Continuous</option>
            <option value="separate">Separate per stage</option>
          </FormField>
          <FormField
            label="Format"
            type="select"
            value={draft.format}
            onChange={(event) => onChange({ ...draft, format: event.target.value as StageAutosaveDraft["format"] })}
          >
            <option value="zarr">Zarr (default)</option>
            <option value="hdf5">HDF5</option>
            <option value="txt">TXT table only</option>
          </FormField>
          <FormField
            checked={draft.tableEnabled}
            label="Scalar table"
            type="checkbox"
            onChange={(event) => onChange({ ...draft, tableEnabled: event.target.checked })}
          />
          {draft.tableEnabled ? (
            <div className="fm-stage-autosave__subsection">
              <FormField
                label="Table quantities"
                value={draft.tableQuantities}
                hint="Comma-separated canonical quantity names."
                onChange={(event) => onChange({ ...draft, tableQuantities: event.target.value })}
              />
              <FormField
                label="Table cadence"
                unit={cadenceUnit}
                value={draft.tableCadence}
                onChange={(event) => onChange({ ...draft, tableCadence: event.target.value })}
              />
            </div>
          ) : null}
          <div className="fm-stage-autosave__fields">
            <div className="fm-stage-autosave__fields-heading">
              <strong>Field snapshots</strong>
              <Button
                disabled={draft.format === "txt"}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => onChange({
                  ...draft,
                  fields: [...draft.fields, { cadence: owner === "relax" ? "10" : "1e-12", quantity: "m" }],
                })}
              >
                <Plus aria-hidden="true" size={14} />
                Add field
              </Button>
            </div>
            {draft.format === "txt" ? (
              <p className="fm-stage-autosave__notice">TXT stores scalar tables only. Choose Zarr or HDF5 for fields.</p>
            ) : null}
            {draft.fields.map((field, index) => (
              <div className="fm-stage-autosave__field" key={`${index}:${field.quantity}`}>
                <FormField
                  label="Quantity"
                  value={field.quantity}
                  onChange={(event) => onChange({
                    ...draft,
                    fields: draft.fields.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: event.target.value } : item),
                  })}
                />
                <FormField
                  label="Cadence"
                  unit={cadenceUnit}
                  value={field.cadence}
                  onChange={(event) => onChange({
                    ...draft,
                    fields: draft.fields.map((item, itemIndex) => itemIndex === index ? { ...item, cadence: event.target.value } : item),
                  })}
                />
                <Button
                  aria-label={`Remove field ${field.quantity || index + 1}`}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() => onChange({ ...draft, fields: draft.fields.filter((_, itemIndex) => itemIndex !== index) })}
                >
                  <Trash2 aria-hidden="true" size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
