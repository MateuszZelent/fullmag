import { useId, type ReactNode } from "react";

interface Vector3FieldProps {
  errors?: readonly (string | undefined)[];
  label: string;
  values: readonly [string, string, string];
  onChange: (index: 0 | 1 | 2, value: string) => void;
  unit?: string;
  unitControls?: readonly [ReactNode, ReactNode, ReactNode];
  disabled?: boolean;
}

/**
 * A highly compact, responsive horizontal Vector3 input field.
 * Renders color-coded X, Y, Z badges (Red, Green, Blue) mimicking professional 3D tools.
 */
export function Vector3Field({
  errors,
  label,
  values,
  onChange,
  unit,
  unitControls,
  disabled,
}: Vector3FieldProps) {
  const fieldId = useId();

  return (
    <div className="fm-inspector-form-field fm-inspector-form-field--inline">
      <label htmlFor={`${fieldId}-x`} className="fm-inspector-form-field__label">
        {label}
      </label>
      <div className="fm-inspector-form-field__control">
        <div className="fm-inspector-vector3">
          {(["x", "y", "z"] as const).map((axis, index) => {
            const elementId = `${fieldId}-${axis}`;
            const errorId = errors?.[index] ? `${elementId}-error` : undefined;
            return (
              <div
                key={axis}
                className="fm-inspector-vector3-item"
                data-disabled={disabled ? "true" : "false"}
              >
                <label
                  htmlFor={elementId}
                  className="fm-inspector-vector3-item__badge"
                  data-axis={axis}
                >
                  {axis.toUpperCase()}
                </label>
                <input
                  id={elementId}
                  aria-label={`${label} ${axis.toUpperCase()}`}
                  aria-describedby={errorId}
                  aria-errormessage={errorId}
                  aria-invalid={Boolean(errors?.[index]) || undefined}
                  className="fm-inspector-input"
                  disabled={disabled}
                  type="text"
                  value={values[index] ?? ""}
                  onChange={(event) => onChange(index as 0 | 1 | 2, event.target.value)}
                  onInput={(event) => onChange(index as 0 | 1 | 2, event.currentTarget.value)}
                />
                {unitControls?.[index]}
                {errors?.[index] ? (
                  <span
                    className="fm-inspector-form-field__hint fm-inspector-form-field__hint--error"
                    id={errorId}
                    role="alert"
                  >
                    {errors[index]}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {unit && !unitControls && <span className="fm-inspector-form-field__unit">{unit}</span>}
      </div>
    </div>
  );
}
