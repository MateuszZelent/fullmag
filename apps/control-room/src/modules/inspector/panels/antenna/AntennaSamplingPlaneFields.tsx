import { Button } from "@/shared/ui/Button";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { Vector3Field } from "../../primitives/Vector3Field";
import { antennaPlaneOrientation, antennaPlaneOrientations, antennaVectorDraftCells, type AntennaPlaneFrameDraft } from "./AntennaSamplingPlaneFieldsModel";

function VectorDraftField({ label, value, unit, onChange }: {
  label: string; value: string; unit?: string; onChange: (value: string) => void;
}) {
  const cells = antennaVectorDraftCells(value);
  if (!cells) return <InspectorGroup title={label} badge="invalid vector text">
    <FieldRow label="Stored vector text" value={<code title={value}>{value}</code>} />
    <p className="fm-inspector-hint">This text cannot be mapped to three coordinates without losing data. Replace it explicitly to enter X, Y and Z.</p>
    <Button type="button" onClick={() => onChange(",,")}>Replace {label} with XYZ fields</Button>
  </InspectorGroup>;
  const errors = value.trim() ? cells.map(cell => !cell.trim() ? "Required" : !Number.isFinite(Number(cell)) ? "Enter a finite value" : undefined) : undefined;
  return <Vector3Field label={label} values={cells} unit={unit} errors={errors} onChange={(index, text) => {
    const next = [...cells]; next[index] = text; onChange(JSON.stringify(next));
  }} />;
}

export function AntennaSamplingPlaneFields({ values, onChange }: {
  values: AntennaPlaneFrameDraft; onChange: (values: AntennaPlaneFrameDraft) => void;
}) {
  return <div data-testid="antenna-sampling-plane-fields"><InspectorGroup title="Sampling plane" badge="SI frame">
    <FormField label="Plane orientation" type="select" value={antennaPlaneOrientation(values)} onChange={event => {
      const preset = antennaPlaneOrientations.find(option => option.id === event.currentTarget.value);
      if (preset) onChange({ ...values, axisU: preset.axisU, axisV: preset.axisV });
    }}>
      <option value="custom" disabled>Custom axes · edit XYZ below</option>
      {antennaPlaneOrientations.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </FormField>
    <VectorDraftField label="Plane origin" unit="m" value={values.originM} onChange={originM => onChange({ ...values, originM })} />
    <VectorDraftField label="Axis u" unit="1" value={values.axisU} onChange={axisU => onChange({ ...values, axisU })} />
    <VectorDraftField label="Axis v" unit="1" value={values.axisV} onChange={axisV => onChange({ ...values, axisV })} />
    <p className="fm-inspector-hint">The origin is the plane centre in metres. The unit axes u and v define its orientation; the normal is u × v. Presets change only the axes. Custom values are validated without automatic normalization.</p>
  </InspectorGroup></div>;
}
