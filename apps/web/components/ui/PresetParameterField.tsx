import type React from "react";
import { TextField } from "./TextField";
import SelectField from "./SelectField";
import { Vector3Field } from "./Vector3Field";
export interface BasePresetParameterDescriptor {
  key: string;
  label: string;
  type: string;
  unit?: string;
  min?: number;
  options?: Array<{ value: string | number; label: string }>;
}

interface PresetParameterFieldProps {
  parameter: BasePresetParameterDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
}

export function PresetParameterField({ parameter, value, onChange }: PresetParameterFieldProps) {
  if (parameter.type === "vector3") {
    const vector: [number, number, number] = Array.isArray(value) ? (value as [number, number, number]) : [0, 0, 0];
    const isDirection = parameter.key.includes("axis") || parameter.key.includes("direction");
    return (
      <Vector3Field
        label={parameter.label}
        value={vector}
        onChange={onChange}
        unit={parameter.unit}
        onNormalize={isDirection}
      />
    );
  }

  if (parameter.type === "enum") {
    return (
      <SelectField
        label={parameter.label}
        value={String(value)}
        onchange={onChange}
        options={(parameter.options ?? []).map((option) => ({
          label: option.label,
          value: String(option.value),
        }))}
      />
    );
  }

  if (parameter.type === "boolean") {
    return (
      <SelectField
        label={parameter.label}
        value={value ? "true" : "false"}
        onchange={(val) => onChange(val === "true")}
        options={[
          { label: "True", value: "true" },
          { label: "False", value: "false" },
        ]}
      />
    );
  }

  const isInteger = parameter.type === "integer";
  return (
    <TextField
      label={parameter.label}
      defaultValue={String(value ?? "")}
      onBlur={(event) => {
        const parsed = isInteger
          ? Number.parseInt(event.target.value, 10)
          : Number.parseFloat(event.target.value);
        if (!Number.isFinite(parsed)) return;
        if (
          typeof parameter.min === "number" &&
          (parsed < parameter.min || (parameter.min === 0 && parsed === 0))
        ) {
          return;
        }
        onChange(parsed);
      }}
      unit={parameter.unit}
      mono
    />
  );
}
