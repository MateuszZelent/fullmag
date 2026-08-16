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
import { controlVariants } from "@/shared/ui/controlVariants";
import { cn } from "@/shared/utils/className";

import { InspectorPropertyRow } from "./InspectorPropertyRow";

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
  /** Error text below the control. Takes precedence over hint. */
  error?: string;
  /** Opens an inspector help dialog for domain-specific parameter semantics. */
  help?: FormFieldHelp | string;
  /** When true, renders label left + control right (default: stacked). */
  inline?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}

type TextFieldProps = BaseFieldProps & {
  type?: "text" | "number" | "range";
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

const FORM_FIELD_WRAPPER_PROP_KEYS = [
  "disabled",
  "error",
  "help",
  "hint",
  "inline",
  "invalid",
  "label",
  "unit",
] as const;

function controlRestProps(
  props: object,
  extraKeys: readonly string[] = [],
): object {
  const rest = { ...(props as Record<string, unknown>) };
  for (const key of FORM_FIELD_WRAPPER_PROP_KEYS) {
    delete rest[key];
  }
  for (const key of extraKeys) {
    delete rest[key];
  }
  return rest;
}

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
      <label className="fm-inspector-form-field__label" htmlFor={fieldId}>
        {label}
      </label>
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
 * Compatibility form API for Inspector panels.
 * New label/control geometry is owned by InspectorPropertyRow. The fm-inspector-*
 * classes remain temporarily for unmigrated domain selectors during the gated rollout.
 */
export function FormField(props: FormFieldProps) {
  const { label, unit, hint, error, help, inline = true, disabled, invalid } =
    props;
  const fieldId = useId();
  const hintText = error ?? hint;
  const feedbackId = hintText
    ? `${fieldId}-${error ? "error" : "hint"}`
    : undefined;
  const invalidValue = invalid || Boolean(error);
  const wrapClass = inline
    ? "fm-inspector-form-field fm-inspector-form-field--inline"
    : "fm-inspector-form-field";
  const hintClass = error
    ? "fm-inspector-form-field__hint fm-inspector-form-field__hint--error"
    : "fm-inspector-form-field__hint";
  const feedback = hintText ? (
    <span
      aria-live={error ? "assertive" : undefined}
      className={hintClass}
      id={feedbackId}
      role={error ? "alert" : undefined}
    >
      {hintText}
    </span>
  ) : null;
  const labelNode = (
    <FormFieldLabel fieldId={fieldId} help={help} label={label} />
  );
  const layout = inline ? "inline" : "stacked";

  if (props.type === "checkbox") {
    const { checked, onChange } = props;
    return (
      <InspectorPropertyRow
        className={wrapClass}
        label={labelNode}
        layout={layout}
      >
        <div className="fm-inspector-form-field__control w-full">
          <input
            id={fieldId}
            aria-label={label}
            aria-describedby={feedbackId}
            aria-errormessage={error ? feedbackId : undefined}
            aria-invalid={invalidValue || undefined}
            checked={checked}
            className="fm-inspector-checkbox size-4 shrink-0 accent-fm-accent disabled:cursor-not-allowed disabled:opacity-100"
            disabled={disabled}
            type="checkbox"
            onChange={onChange}
          />
          {feedback}
        </div>
      </InspectorPropertyRow>
    );
  }

  if (props.type === "select") {
    const { children, onChange, value } = props as SelectFieldProps & {
      onChange?: ComponentPropsWithoutRef<"select">["onChange"];
      value?: ComponentPropsWithoutRef<"select">["value"];
    };
    const rest = controlRestProps(props, [
      "children",
      "onChange",
      "type",
      "value",
    ]);
    return (
      <InspectorPropertyRow
        className={wrapClass}
        label={labelNode}
        layout={layout}
      >
        <div className="fm-inspector-form-field__control flex w-full flex-col items-stretch gap-1">
          <select
            {...(rest as object)}
            id={fieldId}
            aria-label={label}
            aria-describedby={feedbackId}
            aria-errormessage={error ? feedbackId : undefined}
            aria-invalid={invalidValue || undefined}
            className={cn(
              "fm-inspector-select w-full appearance-none",
              controlVariants({ invalid: Boolean(invalid) }),
            )}
            disabled={disabled}
            value={value}
            onChange={onChange}
          >
            {children}
          </select>
          {feedback}
        </div>
      </InspectorPropertyRow>
    );
  }

  if (props.type === "textarea") {
    const { onChange, readOnly, rows, value } = props as TextareaFieldProps & {
      onChange?: ComponentPropsWithoutRef<"textarea">["onChange"];
      value?: ComponentPropsWithoutRef<"textarea">["value"];
      rows?: number;
      readOnly?: boolean;
    };
    const rest = controlRestProps(props, [
      "onChange",
      "readOnly",
      "rows",
      "type",
      "value",
    ]);
    return (
      <InspectorPropertyRow
        className="fm-inspector-form-field"
        label={labelNode}
        layout="stacked"
      >
        <div className="fm-inspector-form-field__control flex w-full flex-col items-stretch gap-1">
          <textarea
            {...(rest as object)}
            id={fieldId}
            aria-label={label}
            aria-describedby={feedbackId}
            aria-errormessage={error ? feedbackId : undefined}
            aria-invalid={invalidValue || undefined}
            className={cn(
              "fm-inspector-textarea h-auto min-h-24 w-full resize-y py-2",
              controlVariants({ invalid: Boolean(invalid) }),
            )}
            disabled={disabled}
            readOnly={readOnly}
            rows={rows ?? 5}
            value={value}
            onChange={onChange}
          />
          {feedback}
        </div>
      </InspectorPropertyRow>
    );
  }

  // text / number
  const { inputMode, mono, onChange, type, value } = props as TextFieldProps & {
    onChange?: ComponentPropsWithoutRef<"input">["onChange"];
    value?: ComponentPropsWithoutRef<"input">["value"];
    inputMode?: ComponentPropsWithoutRef<"input">["inputMode"];
  };
  const rest = controlRestProps(props, [
    "inputMode",
    "mono",
    "onChange",
    "type",
    "value",
  ]);
  const inputClass = cn(
    "fm-inspector-input w-full",
    mono === true ? "fm-inspector-input--mono font-fm-mono" : "font-fm-ui",
    controlVariants({ invalid: Boolean(invalid) }),
  );
  const inputType = type === "number" && unit ? "text" : type ?? "text";
  const resolvedInputMode =
    inputMode ?? (type === "number" || unit ? "decimal" : undefined);
  return (
    <InspectorPropertyRow
      className={wrapClass}
      label={labelNode}
      layout={layout}
      unit={
        unit ? (
          <span className="fm-inspector-form-field__unit">{unit}</span>
        ) : undefined
      }
    >
      <div className="fm-inspector-form-field__control flex w-full flex-col items-stretch gap-1">
        <input
          {...(rest as object)}
          id={fieldId}
          aria-label={label}
          aria-describedby={feedbackId}
          aria-errormessage={error ? feedbackId : undefined}
          aria-invalid={invalidValue || undefined}
          className={inputClass}
          disabled={disabled}
          inputMode={resolvedInputMode}
          type={inputType}
          value={value}
          onInput={onChange as ComponentPropsWithoutRef<"input">["onInput"]}
        />
        {feedback}
      </div>
    </InspectorPropertyRow>
  );
}
