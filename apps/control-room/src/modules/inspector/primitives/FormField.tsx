import type { ComponentPropsWithoutRef, ReactNode } from "react";

interface BaseFieldProps {
  /** Displayed above (stacked) or beside (inline) the control. */
  label: string;
  /** Shown to the right of numeric inputs. */
  unit?: string;
  /** Muted hint text below the control. */
  hint?: string;
  /** When true, renders label left + control right (default: stacked). */
  inline?: boolean;
  disabled?: boolean;
}

type TextFieldProps = BaseFieldProps & {
  type?: "text" | "number";
  mono?: boolean;
} & Omit<ComponentPropsWithoutRef<"input">, "type" | "disabled">;

type TextareaFieldProps = BaseFieldProps & {
  type: "textarea";
} & Omit<ComponentPropsWithoutRef<"textarea">, "disabled">;

type SelectFieldProps = BaseFieldProps & {
  type: "select";
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"select">, "disabled">;

type CheckboxFieldProps = BaseFieldProps & {
  type: "checkbox";
  checked?: boolean;
  onChange?: ComponentPropsWithoutRef<"input">["onChange"];
};

export type FormFieldProps =
  | TextFieldProps
  | TextareaFieldProps
  | SelectFieldProps
  | CheckboxFieldProps;

/**
 * Unified form field primitive for the inspector panels.
 * Renders label + control + optional unit/hint with consistent Catppuccin styling.
 * All input/textarea/select/checkbox controls use fm-inspector-* CSS classes.
 */
export function FormField(props: FormFieldProps) {
  const { label, unit, hint, inline = true, disabled } = props;
  const wrapClass = inline
    ? "fm-inspector-form-field fm-inspector-form-field--inline"
    : "fm-inspector-form-field";

  if (props.type === "checkbox") {
    const { checked, onChange } = props;
    return (
      <div className={wrapClass}>
        <span className="fm-inspector-form-field__label">{label}</span>
        <div className="fm-inspector-form-field__control">
          <label className="fm-inspector-checkbox-wrap">
            <input
              aria-label={label}
              checked={checked}
              className="fm-inspector-checkbox"
              disabled={disabled}
              type="checkbox"
              onChange={onChange}
            />
          </label>
        </div>
      </div>
    );
  }

  if (props.type === "select") {
    const { children, onChange, value, ...rest } = props as SelectFieldProps & {
      onChange?: ComponentPropsWithoutRef<"select">["onChange"];
      value?: ComponentPropsWithoutRef<"select">["value"];
    };
    return (
      <div className={wrapClass}>
        <span className="fm-inspector-form-field__label">{label}</span>
        <div className="fm-inspector-form-field__control">
          <select
            {...(rest as object)}
            aria-label={label}
            className="fm-inspector-select"
            disabled={disabled}
            value={value}
            onChange={onChange}
          >
            {children}
          </select>
        </div>
        {hint && <span className="fm-inspector-form-field__hint">{hint}</span>}
      </div>
    );
  }

  if (props.type === "textarea") {
    const { onChange, value, rows, readOnly, ...rest } = props as TextareaFieldProps & {
      onChange?: ComponentPropsWithoutRef<"textarea">["onChange"];
      value?: ComponentPropsWithoutRef<"textarea">["value"];
      rows?: number;
      readOnly?: boolean;
    };
    return (
      <div className="fm-inspector-form-field">
        <span className="fm-inspector-form-field__label">{label}</span>
        <div className="fm-inspector-form-field__control">
          <textarea
            {...(rest as object)}
            aria-label={label}
            className="fm-inspector-textarea"
            disabled={disabled}
            readOnly={readOnly}
            rows={rows ?? 5}
            value={value}
            onChange={onChange}
          />
        </div>
        {hint && <span className="fm-inspector-form-field__hint">{hint}</span>}
      </div>
    );
  }

  // text / number
  const { type, mono, onChange, value, inputMode, ...rest } = props as TextFieldProps & {
    onChange?: ComponentPropsWithoutRef<"input">["onChange"];
    value?: ComponentPropsWithoutRef<"input">["value"];
    inputMode?: ComponentPropsWithoutRef<"input">["inputMode"];
  };
  const inputClass = [
    "fm-inspector-input",
    mono === false ? "fm-inspector-input--text" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={wrapClass}>
      <span className="fm-inspector-form-field__label">{label}</span>
      <div className="fm-inspector-form-field__control">
        <input
          {...(rest as object)}
          aria-label={label}
          className={inputClass}
          disabled={disabled}
          inputMode={inputMode ?? (type === "number" ? "decimal" : undefined)}
          type={type ?? "text"}
          value={value}
          onChange={onChange}
        />
        {unit && <span className="fm-inspector-form-field__unit">{unit}</span>}
      </div>
      {hint && <span className="fm-inspector-form-field__hint">{hint}</span>}
    </div>
  );
}
