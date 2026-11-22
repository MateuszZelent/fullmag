"use client";

import { useId, useState } from "react";

import type {
  MaskFunctionResource,
  MaskTermResource,
  ReadyAntennaResource,
} from "@/kernel/api/apiTypes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Input } from "@/shared/ui/Input";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";

import type { MaskFunctionRole } from "../../../panels/MaskAntennaPanelModel";

import {
  isValidScriptIdentifier,
  MASK_OUTPUT_LABELS,
  parseFiniteNumber,
  rawError,
  rawValue,
  type RawInputs,
} from "./fieldDriveMaskShared";

/* ── Sub-Controls Using Strictly @/shared/ui Components ── */

export function MaskRawScalarField({
  disabled,
  fieldKey,
  hint,
  label,
  onChange,
  raw,
  unit,
  value,
}: {
  disabled: boolean;
  fieldKey: string;
  hint?: string;
  label: string;
  onChange: (key: string, text: string) => void;
  raw: RawInputs;
  unit?: string;
  value: number | undefined;
}) {
  const id = useId();
  const error = rawError(raw, fieldKey);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-[var(--fm-text)]" htmlFor={id}>
          {label}
        </label>
        {unit ? (
          <span className="font-mono text-xs text-[var(--fm-text-muted)]">{unit}</span>
        ) : null}
      </div>
      <Input
        aria-invalid={error ? "true" : "false"}
        aria-label={label}
        autoComplete="off"
        className="font-mono text-xs"
        disabled={disabled}
        id={id}
        inputMode="text"
        type="text"
        value={rawValue(raw, fieldKey, value)}
        onChange={(event) => onChange(fieldKey, event.target.value)}
      />
      {hint && !error ? (
        <span className="text-xs text-[var(--fm-text-muted)]">{hint}</span>
      ) : null}
      {error ? (
        <span className="text-xs text-[var(--fm-danger)]" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function MaskRawVectorField({
  disabled,
  keyPrefix,
  label,
  onChange,
  raw,
  unit,
  values,
}: {
  disabled: boolean;
  keyPrefix: string;
  label: string;
  onChange: (key: string, text: string) => void;
  raw: RawInputs;
  unit?: string;
  values: readonly number[];
}) {
  const axes = ["X", "Y", "Z"] as const;
  const keys = ([0, 1, 2] as const).map((index) => `${keyPrefix}|${index}`);
  const errors = keys.map((key) => rawError(raw, key)).filter(Boolean);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--fm-text)]">{label}</span>
        {unit ? (
          <span className="font-mono text-xs text-[var(--fm-text-muted)]">{unit}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {axes.map((axis, index) => {
          const key = keys[index]!;
          const err = rawError(raw, key);
          return (
            <div key={key} className="flex items-center gap-1">
              <span className="font-mono text-xs text-[var(--fm-text-muted)]">{axis}</span>
              <Input
                aria-invalid={err ? "true" : "false"}
                aria-label={`${label} ${axis}`}
                autoComplete="off"
                className="font-mono text-xs"
                disabled={disabled}
                inputMode="text"
                type="text"
                value={rawValue(raw, key, values[index])}
                onChange={(event) => onChange(key, event.target.value)}
              />
            </div>
          );
        })}
      </div>
      {errors[0] ? (
        <span className="text-xs text-[var(--fm-danger)]" role="alert">
          {errors[0]}
        </span>
      ) : null}
    </div>
  );
}

export function ArrayMaskRows({
  mask,
}: {
  mask: Extract<MaskTermResource["mask"], { kind: "sampled" }>;
}) {
  const rows: readonly { label: string; value: string }[] = [
    { label: "Mask", value: "array (written by a loop), read-only" },
    { label: "Lattice", value: mask.size.join(" x ") },
    { label: "Cell", value: `${mask.cell_m.join(", ")} m` },
    { label: "Origin", value: `${mask.origin_m.join(", ")} m` },
    { label: "SHA-256", value: mask.sha256.slice(0, 16) },
  ];
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2"
      data-slot="mask-sampled-array-rows"
    >
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-[var(--fm-text-muted)]">{row.label}</span>
          <span className="font-mono text-[var(--fm-text)]">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function MaskFunctionFields({
  disabled,
  onLocalAdd,
  onLocalChange,
  onLocalRemove,
  onOutputChange,
  onParameterAdd,
  onParameterRemove,
  onRawChange,
  raw,
  role,
  target,
  termKey,
}: {
  disabled: boolean;
  onLocalAdd: (name: string, expression: string) => void;
  onLocalChange: (localIndex: number, expression: string) => void;
  onLocalRemove: (name: string) => void;
  onOutputChange: (outputIndex: number, expression: string) => void;
  onParameterAdd: (name: string) => void;
  onParameterRemove: (name: string) => void;
  onRawChange: (key: string, text: string) => void;
  raw: RawInputs;
  role: MaskFunctionRole;
  target: MaskFunctionResource;
  termKey: string;
}) {
  const [newParameter, setNewParameter] = useState("");
  const [newLocalName, setNewLocalName] = useState("");
  const [newLocalExpr, setNewLocalExpr] = useState("");

  const parameters = target.parameters ?? [];
  const locals = target.locals ?? [];
  const usedNames = new Set([
    ...parameters.map((p) => p.name),
    ...locals.map((l) => l.name),
  ]);
  const canAddParam =
    isValidScriptIdentifier(newParameter) && !usedNames.has(newParameter);
  const canAddLocal =
    isValidScriptIdentifier(newLocalName) &&
    !usedNames.has(newLocalName) &&
    newLocalExpr.trim().length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-[var(--fm-text)]">
          {role === "mask" ? "Mask function" : "Time function"}
        </span>
        <Badge data-tone="neutral">{target.name ?? "custom"}</Badge>
      </div>

      {/* Named scalar parameters */}
      {parameters.map((parameter) => (
        <div key={parameter.name} className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1">
            <MaskRawScalarField
              disabled={disabled}
              fieldKey={`term|${termKey}|${role}|${parameter.name}`}
              label={parameter.name}
              raw={raw}
              value={parameter.value}
              onChange={onRawChange}
            />
          </div>
          <Button
            aria-label={`Remove ${parameter.name}`}
            disabled={disabled}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => onParameterRemove(parameter.name)}
          >
            Remove {parameter.name}
          </Button>
        </div>
      ))}

      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <Input
            aria-label={role === "mask" ? "New parameter" : "New time parameter"}
            autoComplete="off"
            className="font-mono text-xs"
            disabled={disabled}
            placeholder="Parameter name (e.g. B0)"
            type="text"
            value={newParameter}
            onChange={(event) => setNewParameter(event.target.value)}
          />
        </div>
        <Button
          disabled={disabled || !canAddParam}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            onParameterAdd(newParameter);
            setNewParameter("");
          }}
        >
          Add parameter
        </Button>
      </div>

      {/* Named local sub-expressions */}
      {locals.map((local, index) => (
        <div key={local.name} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-medium text-[var(--fm-text)]">
              {local.name} =
            </span>
            <Button
              aria-label={`Remove local ${local.name}`}
              disabled={disabled}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => onLocalRemove(local.name)}
            >
              Remove {local.name}
            </Button>
          </div>
          <Input
            aria-label={`${local.name} =`}
            autoComplete="off"
            className="font-mono text-xs"
            disabled={disabled}
            spellCheck={false}
            type="text"
            value={local.expression}
            onChange={(event) => onLocalChange(index, event.target.value)}
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          aria-label={role === "mask" ? "New local name" : "New time local name"}
          autoComplete="off"
          className="w-24 font-mono text-xs"
          disabled={disabled}
          placeholder="Local (k)"
          type="text"
          value={newLocalName}
          onChange={(event) => setNewLocalName(event.target.value)}
        />
        <Input
          aria-label={role === "mask" ? "New local expression" : "New time local expression"}
          autoComplete="off"
          className="min-w-0 flex-1 font-mono text-xs"
          disabled={disabled}
          placeholder="Expression (2 * pi / wavelength)"
          spellCheck={false}
          type="text"
          value={newLocalExpr}
          onChange={(event) => setNewLocalExpr(event.target.value)}
        />
        <Button
          disabled={disabled || !canAddLocal}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            onLocalAdd(newLocalName, newLocalExpr);
            setNewLocalName("");
            setNewLocalExpr("");
          }}
        >
          Add local
        </Button>
      </div>

      {/* Output vector / time equations */}
      {keyedOccurrences(
        target.outputs.map((output, index) => ({
          output,
          index,
          identity: role === "mask" ? (MASK_OUTPUT_LABELS[index] ?? `B${index}`) : "f(t)",
        })),
        (entry) => entry.identity,
      ).map(({ item, key }) => {
        const eqLabel = role === "mask" ? `${item.identity} =` : "f(t) =";
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-medium text-[var(--fm-text)]">
                {eqLabel}
              </span>
              {role === "mask" ? (
                <span className="font-mono text-xs text-[var(--fm-text-muted)]">T</span>
              ) : null}
            </div>
            <Input
              aria-label={eqLabel}
              autoComplete="off"
              className="font-mono text-xs"
              disabled={disabled}
              spellCheck={false}
              type="text"
              value={item.output}
              onChange={(event) => onOutputChange(item.index, event.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ReadyAntennaCallFields({
  antenna,
  buildDisabled,
  busy,
  disabled,
  onBuild,
  values,
}: {
  antenna: ReadyAntennaResource;
  buildDisabled: boolean;
  busy: boolean;
  disabled: boolean;
  onBuild: (values: Record<string, number>) => void;
  values: Record<string, number>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const parsed: Record<string, number> = {};
  let missing: string | null = null;
  let invalid = false;

  for (const argument of antenna.arguments) {
    const text =
      drafts[argument.name] ??
      (values[argument.name] === undefined ? "" : String(values[argument.name]));
    if (text.trim().length === 0) {
      if (typeof argument.default !== "number" && argument.name !== "sigma_x") {
        missing ??= argument.name;
      }
      continue;
    }
    const value = parseFiniteNumber(text);
    if (value === null) invalid = true;
    else parsed[argument.name] = value;
  }

  return (
    <div className="flex flex-col gap-2" data-slot="ready-antenna-call-fields">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-[var(--fm-text-muted)]">Function</span>
        <span className="font-mono text-[var(--fm-text)]">{antenna.function}</span>
      </div>
      {antenna.arguments.map((argument) => {
        const text =
          drafts[argument.name] ??
          (values[argument.name] === undefined ? "" : String(values[argument.name]));
        const error =
          text.trim().length > 0 && parseFiniteNumber(text) === null
            ? "Enter a finite number in SI units."
            : undefined;
        return (
          <div key={argument.name} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-medium text-[var(--fm-text)]">
                {argument.name}
              </span>
              {argument.unit ? (
                <span className="font-mono text-xs text-[var(--fm-text-muted)]">
                  {argument.unit}
                </span>
              ) : null}
            </div>
            <Input
              aria-invalid={error ? "true" : "false"}
              aria-label={argument.name}
              autoComplete="off"
              className="font-mono text-xs"
              disabled={disabled || busy}
              inputMode="text"
              type="text"
              value={text}
              onChange={(event) => {
                const next = event.target.value;
                setDrafts((current) => ({ ...current, [argument.name]: next }));
              }}
            />
            {argument.doc && !error ? (
              <span className="text-xs text-[var(--fm-text-muted)]">{argument.doc}</span>
            ) : null}
            {error ? (
              <span className="text-xs text-[var(--fm-danger)]" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-end pt-1">
        <Button
          disabled={disabled || buildDisabled || busy || invalid || missing !== null}
          disabledReason={missing ? `Give ${missing}.` : null}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onBuild(parsed)}
        >
          {busy ? "Building terms…" : "Build terms"}
        </Button>
      </div>
    </div>
  );
}

export function MaskCodePreviewDialog({
  codePreview,
  onClose,
}: {
  codePreview: {
    title: string;
    language: "python" | "json";
    code: string;
  } | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={codePreview !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{codePreview?.title ?? "Code preview"}</DialogTitle>
          <DialogDescription>
            {codePreview?.language === "json" ? "JSON payload" : "Python authoring snippet"}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-80 overflow-auto rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-3 font-mono text-xs text-[var(--fm-text)]">
          <code>{codePreview?.code ?? ""}</code>
        </pre>
        <DialogFooter>
          <Button size="sm" type="button" variant="primary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
