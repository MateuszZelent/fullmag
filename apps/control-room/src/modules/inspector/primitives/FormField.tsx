import { HelpCircle } from "lucide-react";
import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/Dialog";
import { Button } from "@/shared/ui/Button";

export interface FormFieldHelp {
  description: string;
  details?: readonly string[];
  title?: string;
}

interface BaseFieldProps {
  /** Displayed above (stacked) or beside (inline) the control. */
  label: string;
  /** Shown to the right of numeric inputs. */
  unit?: string;
  /** Muted hint text below the control. */
  hint?: string;
  /** Opens an inspector help dialog for domain-specific parameter semantics. */
  help?: FormFieldHelp | string;
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

function FormFieldLabel({
  fieldId,
  help,
  label,
}: {
  fieldId: string;
  help?: FormFieldHelp | string;
  label: string;
}) {
  return (
    <div className="fm-inspector-form-field__label-row">
      <label htmlFor={fieldId} className="fm-inspector-form-field__label">{label}</label>
      <FormFieldHelpButton help={help} label={label} />
    </div>
  );
}

function FormFieldHelpButton({
  help,
  label,
}: {
  help?: FormFieldHelp | string;
  label: string;
}) {
  if (!help) return null;
  const normalized: FormFieldHelp =
    typeof help === "string" ? { description: help } : help;
  const title = normalized.title ?? label;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          aria-label={`Explain ${label}`}
          className="fm-inspector-form-field__help"
          type="button"
        >
          <HelpCircle aria-hidden="true" size={14} />
        </button>
      </DialogTrigger>
      <DialogContent aria-describedby="fm-inspector-field-help-description">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription id="fm-inspector-field-help-description">
            {normalized.description}
          </DialogDescription>
        </DialogHeader>
        {normalized.details && normalized.details.length > 0 ? (
          <div className="fm-dialog__body">
            <ul className="fm-inspector-field-help__list">
              {normalized.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" type="button" variant="primary">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Unified form field primitive for the inspector panels.
 * Renders label + control + optional unit/hint with consistent Catppuccin styling.
 * All input/textarea/select/checkbox controls use fm-inspector-* CSS classes.
 */
export function FormField(props: FormFieldProps) {
  const { label, unit, hint, help, inline = true, disabled } = props;
  const fieldId = useId();
  const wrapClass = inline
    ? "fm-inspector-form-field fm-inspector-form-field--inline"
    : "fm-inspector-form-field";

  if (props.type === "checkbox") {
    const { checked, onChange } = props;
    return (
      <div className={wrapClass}>
        <FormFieldLabel fieldId={fieldId} help={help} label={label} />
        <div className="fm-inspector-form-field__control">
          <label className="fm-inspector-checkbox-wrap">
            <input
              id={fieldId}
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
        <FormFieldLabel fieldId={fieldId} help={help} label={label} />
        <div className="fm-inspector-form-field__control">
          <select
            {...(rest as object)}
            id={fieldId}
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
        <FormFieldLabel fieldId={fieldId} help={help} label={label} />
        <div className="fm-inspector-form-field__control">
          <textarea
            {...(rest as object)}
            id={fieldId}
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
      <FormFieldLabel fieldId={fieldId} help={help} label={label} />
      <div className="fm-inspector-form-field__control">
        <input
          {...(rest as object)}
          id={fieldId}
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
