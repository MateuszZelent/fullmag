"use client";

import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  CornerUpLeft,
  Plus,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { colorValueLabel } from "@/shared/color/colorValueLabel";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/ContextMenu";
import { DisabledReason } from "@/shared/ui/DisabledReason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/shared/ui/HoverCard";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "@/shared/ui/InputGroup";
import { OverflowText } from "@/shared/ui/OverflowText";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/Popover";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/ToggleGroup";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/Tooltip";
import { cn } from "@/shared/utils/className";

import { announceFieldError } from "./fieldErrorAnnouncer";
import type {
  InspectorActionContext,
  InspectorRowSpec,
  SymbolInfo,
  UnitOption,
} from "./types";
import {
  computeDragScrubValueSI,
  formatNumericScalar,
  formatQuantityDisplay,
  inspectorValuesEqual,
  parseQuantityInputToSI,
} from "./unitConversion";

const MAX_INLINE_TABLE_COLUMNS = 4;
const NONE_REFERENCE_SENTINEL = "__fm_none_reference__";

const THEME_COLOR_SWATCHES = [
  { value: "var(--fm-chart-blue)", label: "Blue" },
  { value: "var(--fm-chart-mauve)", label: "Mauve" },
  { value: "var(--fm-chart-peach)", label: "Peach" },
  { value: "var(--fm-chart-green)", label: "Green" },
  { value: "var(--fm-chart-teal)", label: "Teal" },
  { value: "var(--fm-chart-sky)", label: "Sky" },
  { value: "var(--fm-chart-red)", label: "Red" },
  { value: "var(--fm-chart-yellow)", label: "Yellow" },
  { value: "var(--fm-chart-pink)", label: "Pink" },
  { value: "var(--fm-chart-lavender)", label: "Lavender" },
] as const;

const AXIS_PRESETS: readonly { label: string; vec: readonly [number, number, number] }[] = [
  { label: "+X", vec: [1, 0, 0] },
  { label: "\u2212X", vec: [-1, 0, 0] },
  { label: "+Y", vec: [0, 1, 0] },
  { label: "\u2212Y", vec: [0, -1, 0] },
  { label: "+Z", vec: [0, 0, 1] },
  { label: "\u2212Z", vec: [0, 0, -1] },
];

const NATIVELY_LABELED_ROW_TYPES = new Set<InspectorRowSpec<unknown>["type"]>([
  "quantity",
  "number",
  "text",
  "textarea",
  "expression",
  "select",
  "switch",
  "color",
  "reference",
]);

function renderOptionIcon(icon: LucideIcon | ReactNode | undefined): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const IconComponent = icon as LucideIcon;
  return <IconComponent aria-hidden="true" data-icon="inline-start" size={16} />;
}

function readDraftValue<TDraft>(draft: TDraft, key: string | undefined): unknown {
  if (!key) return undefined;
  return (draft as Record<string, unknown>)[key];
}

function formatPythonLiteral(value: unknown): string {
  if (Array.isArray(value)) {
    return `(${value.map((item) => formatPythonLiteral(item)).join(", ")})`;
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "float('nan')";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function formatRowValueText<TDraft>(
  row: InspectorRowSpec<TDraft>,
  value: unknown,
  activeUnit?: UnitOption,
): string {
  if (row.type === "quantity" && typeof value === "number" && activeUnit) {
    return `${formatQuantityDisplay(value, activeUnit.toSiFactor)} ${activeUnit.unit}`;
  }
  if (row.type === "number" && typeof value === "number") {
    const formatted = formatNumericScalar(value);
    return row.unitSuffix ? `${formatted} ${row.unitSuffix}` : formatted;
  }
  if (row.type === "vector3" && Array.isArray(value)) {
    const factor = activeUnit?.toSiFactor ?? 1;
    const tuple = `(${value
      .slice(0, 3)
      .map((entry) =>
        typeof entry === "number" ? formatQuantityDisplay(entry, factor) : String(entry ?? ""),
      )
      .join(", ")})`;
    const suffix = activeUnit?.unit ?? row.unitSuffix;
    return suffix ? `${tuple} ${suffix}` : tuple;
  }
  if (typeof value === "number") return formatNumericScalar(value);
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.join(", ");
  return value == null ? "" : String(value);
}

/** Evaluates built-in numeric/range constraints plus row `validate` and `serverError`. */
export function evaluateInspectorRowError<TDraft>(
  row: InspectorRowSpec<TDraft>,
  draft: TDraft,
  externalError?: string | null,
): string | null {
  if (row.showWhen && !row.showWhen(draft)) return null;
  if (externalError) return externalError;

  const key = row.key;
  if (!key) return null;
  const value = readDraftValue(draft, key);

  if (row.type === "quantity" || row.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "Enter a finite number, for example 2.6e10.";
    }
    if (row.type === "number" && row.integer && !Number.isInteger(value)) {
      return "Enter a whole integer value.";
    }
    if (row.min !== undefined) {
      const belowMin =
        row.type === "quantity" && row.minExclusive ? value <= row.min : value < row.min;
      if (belowMin) {
        return row.type === "quantity" && row.minExclusive
          ? `Value must be strictly greater than ${formatNumericScalar(row.min)}.`
          : `Value must be at least ${formatNumericScalar(row.min)}.`;
      }
    }
    if (row.max !== undefined && value > row.max) {
      return `Value must be at most ${formatNumericScalar(row.max)}.`;
    }
  }

  if (row.type === "vector3") {
    if (
      !Array.isArray(value) ||
      value.length < 3 ||
      value.slice(0, 3).some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      return "Each vector component must be a finite number.";
    }
  }

  const validator = row.validate as ((val: unknown, d: TDraft) => string | null) | undefined;
  const validationMessage = validator?.(value, draft) ?? null;
  if (validationMessage) return validationMessage;

  return row.serverError?.(draft) ?? null;
}

/* ── Quantity / Number input preserving partial scientific typing ── */
interface QuantityNumberFieldProps {
  id: string;
  label: string;
  value: number;
  units?: readonly [UnitOption, ...UnitOption[]];
  activeUnit: UnitOption;
  unitSuffix?: string;
  integer?: boolean;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  resetToken?: number;
  onDisplayUnitChange?: (unit: string) => void;
  onCommitSI: (nextSI: number) => void;
  onBlurField: () => void;
  onParseErrorChange: (error: string | null) => void;
}

function QuantityNumberField({
  id,
  label,
  value,
  units,
  activeUnit,
  unitSuffix,
  integer,
  disabled,
  invalid,
  describedBy,
  resetToken = 0,
  onDisplayUnitChange,
  onCommitSI,
  onBlurField,
  onParseErrorChange,
}: QuantityNumberFieldProps) {
  const formattedDisplay = formatQuantityDisplay(value, activeUnit.toSiFactor);
  const [rawText, setRawText] = useState(formattedDisplay);
  const [localParseError, setLocalParseError] = useState<string | null>(null);
  const focusedRef = useRef(false);
  const onParseErrorChangeRef = useRef(onParseErrorChange);
  useEffect(() => {
    onParseErrorChangeRef.current = onParseErrorChange;
  }, [onParseErrorChange]);
  const prevSyncedRef = useRef({
    formattedDisplay,
    unit: activeUnit.unit,
    resetToken,
  });

  // Sync display text when external value, display unit, or explicit reset changes while unfocused.
  useEffect(() => {
    const prev = prevSyncedRef.current;
    const changed =
      prev.formattedDisplay !== formattedDisplay ||
      prev.unit !== activeUnit.unit ||
      prev.resetToken !== resetToken;
    if (!focusedRef.current && changed) {
      prevSyncedRef.current = { formattedDisplay, unit: activeUnit.unit, resetToken };
      setRawText(formattedDisplay);
      setLocalParseError(null);
      onParseErrorChangeRef.current(null);
    }
  }, [formattedDisplay, activeUnit.unit, resetToken]);

  const handleUnitSelect = (nextUnitName: string) => {
    const nextOption = units?.find((entry) => entry.unit === nextUnitName);
    if (!nextOption) return;
    // Unit switching updates presentation only without mutating draft[key] or marking dirty.
    const nextDisplay = formatQuantityDisplay(value, nextOption.toSiFactor);
    focusedRef.current = false;
    prevSyncedRef.current = { formattedDisplay: nextDisplay, unit: nextUnitName, resetToken };
    setLocalParseError(null);
    onParseErrorChangeRef.current(null);
    setRawText(nextDisplay);
    onDisplayUnitChange?.(nextUnitName);
  };

  return (
    <InputGroup className="fm-inspector-field">
      <InputGroupInput
        aria-describedby={describedBy}
        aria-invalid={invalid || Boolean(localParseError) ? "true" : "false"}
        autoComplete="off"
        className="fm-inspector-field__input"
        disabled={disabled}
        id={id}
        inputMode={integer ? "numeric" : "decimal"}
        spellCheck={false}
        type="text"
        value={rawText}
        onBlur={() => {
          focusedRef.current = false;
          const parsedSI = parseQuantityInputToSI(rawText, activeUnit.toSiFactor);
          if (parsedSI === null) {
            const msg = "Enter a valid number, for example 1.5e-3.";
            setLocalParseError(msg);
            onParseErrorChangeRef.current(msg);
          } else {
            const finalSI = integer ? Math.round(parsedSI) : parsedSI;
            const canonical = formatQuantityDisplay(finalSI, activeUnit.toSiFactor);
            prevSyncedRef.current = {
              formattedDisplay: canonical,
              unit: activeUnit.unit,
              resetToken,
            };
            setLocalParseError(null);
            onParseErrorChangeRef.current(null);
            if (!Object.is(finalSI, value)) {
              onCommitSI(finalSI);
            }
            setRawText(canonical);
          }
          onBlurField();
        }}
        onChange={(event) => {
          const nextText = event.target.value;
          setRawText(nextText);
          const parsedSI = parseQuantityInputToSI(nextText, activeUnit.toSiFactor);
          if (parsedSI !== null) {
            const finalSI = integer ? Math.round(parsedSI) : parsedSI;
            setLocalParseError(null);
            onParseErrorChangeRef.current(null);
            if (!Object.is(finalSI, value)) {
              onCommitSI(finalSI);
            }
          }
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
      />
      {units && units.length > 0 ? (
        <InputGroupAddon align="inline-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <InputGroupButton
                aria-label={`${label} unit`}
                className="fm-inspector-unit-trigger"
                disabled={disabled}
                size="sm"
                variant="ghost"
              >
                <span>{activeUnit.unit}</span>
                <ChevronDown aria-hidden="true" data-icon="inline-end" size={12} />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={activeUnit.unit} onValueChange={handleUnitSelect}>
                {units.map((option) => (
                  <DropdownMenuRadioItem key={option.unit} value={option.unit}>
                    {option.unit}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </InputGroupAddon>
      ) : unitSuffix ? (
        <InputGroupAddon align="inline-end">
          <InputGroupText>{unitSuffix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

/* ── Single axis numeric field for Vector3 ── */
interface AxisScalarInputProps {
  id: string;
  axis: "x" | "y" | "z" | "r" | "\u03b8" | "\u03c6";
  axisTone: "x" | "y" | "z";
  ariaLabel: string;
  value: number;
  toSiFactor: number;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  onCommitSI: (nextSI: number) => void;
  onBlurField: () => void;
}

function AxisScalarInput({
  id,
  axis,
  axisTone,
  ariaLabel,
  value,
  toSiFactor,
  disabled,
  invalid,
  describedBy,
  onCommitSI,
  onBlurField,
}: AxisScalarInputProps) {
  const formatted = formatQuantityDisplay(value, toSiFactor);
  const [rawText, setRawText] = useState(formatted);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setRawText(formatted);
    }
  }, [formatted]);

  return (
    <InputGroup className="fm-inspector-vector3__cell">
      <InputGroupAddon align="inline-start">
        <InputGroupText
          className={cn(
            "fm-inspector-vector3__axis",
            axisTone === "x" && "text-fm-axis-x",
            axisTone === "y" && "text-fm-axis-y",
            axisTone === "z" && "text-fm-axis-z",
          )}
        >
          {axis}
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        aria-describedby={describedBy}
        aria-invalid={invalid ? "true" : "false"}
        aria-label={ariaLabel}
        autoComplete="off"
        className="fm-inspector-vector3__input"
        disabled={disabled}
        id={id}
        inputMode="decimal"
        spellCheck={false}
        type="text"
        value={rawText}
        onBlur={() => {
          focusedRef.current = false;
          const parsedSI = parseQuantityInputToSI(rawText, toSiFactor);
          if (parsedSI !== null) {
            if (!Object.is(parsedSI, value)) {
              onCommitSI(parsedSI);
            }
            setRawText(formatQuantityDisplay(parsedSI, toSiFactor));
          }
          onBlurField();
        }}
        onChange={(event) => {
          const next = event.target.value;
          setRawText(next);
          const parsedSI = parseQuantityInputToSI(next, toSiFactor);
          if (parsedSI !== null && !Object.is(parsedSI, value)) {
            onCommitSI(parsedSI);
          }
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
      />
    </InputGroup>
  );
}

/* ── Vector3 compound field ── */
interface Vector3FieldControlProps {
  id: string;
  label: string;
  value: readonly [number, number, number];
  units?: readonly UnitOption[];
  activeUnit?: UnitOption;
  unitSuffix?: string;
  coordinateModes?: readonly ("cartesian" | "spherical")[];
  axisPresets?: boolean;
  normalizeAction?: boolean;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  onDisplayUnitChange?: (unit: string) => void;
  onChange: (next: readonly [number, number, number]) => void;
  onBlurField: () => void;
}

function Vector3FieldControl({
  id,
  label,
  value,
  units,
  activeUnit,
  unitSuffix,
  coordinateModes,
  axisPresets,
  normalizeAction,
  disabled,
  invalid,
  describedBy,
  onDisplayUnitChange,
  onChange,
  onBlurField,
}: Vector3FieldControlProps) {
  const [coordMode, setCoordMode] = useState<"cartesian" | "spherical">(
    coordinateModes?.[0] ?? "cartesian",
  );
  const toSiFactor = activeUnit?.toSiFactor ?? 1;
  const [vx, vy, vz] = value;
  const norm = Math.hypot(vx, vy, vz);

  const sphericalR = norm;
  const sphericalThetaDeg =
    norm > 0 ? (Math.acos(Math.max(-1, Math.min(1, vz / norm))) * 180) / Math.PI : 0;
  const sphericalPhiDeg = (Math.atan2(vy, vx) * 180) / Math.PI;

  const updateSpherical = (nextR: number, nextThetaDeg: number, nextPhiDeg: number) => {
    const thetaRad = (nextThetaDeg * Math.PI) / 180;
    const phiRad = (nextPhiDeg * Math.PI) / 180;
    const sinTheta = Math.sin(thetaRad);
    onChange([
      Number((nextR * sinTheta * Math.cos(phiRad)).toPrecision(12)),
      Number((nextR * sinTheta * Math.sin(phiRad)).toPrecision(12)),
      Number((nextR * Math.cos(thetaRad)).toPrecision(12)),
    ]);
  };

  return (
    <div className="fm-inspector-vector3">
      {coordinateModes && coordinateModes.length > 1 ? (
        <div className="fm-inspector-vector3__toolbar">
          <SegmentedControl
            aria-label={`${label} coordinates`}
            disabled={disabled}
            options={coordinateModes.map((mode) => ({
              value: mode,
              label: mode === "cartesian" ? "Cartesian" : "Spherical",
            }))}
            value={coordMode}
            onValueChange={setCoordMode}
          />
        </div>
      ) : null}

      <div className="fm-inspector-vector3__row">
        <div className="fm-inspector-vector3__grid">
          {coordMode === "cartesian" ? (
            <>
              <AxisScalarInput
                ariaLabel={`${label} x`}
                axis="x"
                axisTone="x"
                describedBy={describedBy}
                disabled={disabled}
                id={id}
                invalid={invalid}
                toSiFactor={toSiFactor}
                value={vx}
                onBlurField={onBlurField}
                onCommitSI={(nextX) => onChange([nextX, vy, vz])}
              />
              <AxisScalarInput
                ariaLabel={`${label} y`}
                axis="y"
                axisTone="y"
                describedBy={describedBy}
                disabled={disabled}
                id={`${id}-y`}
                invalid={invalid}
                toSiFactor={toSiFactor}
                value={vy}
                onBlurField={onBlurField}
                onCommitSI={(nextY) => onChange([vx, nextY, vz])}
              />
              <AxisScalarInput
                ariaLabel={`${label} z`}
                axis="z"
                axisTone="z"
                describedBy={describedBy}
                disabled={disabled}
                id={`${id}-z`}
                invalid={invalid}
                toSiFactor={toSiFactor}
                value={vz}
                onBlurField={onBlurField}
                onCommitSI={(nextZ) => onChange([vx, vy, nextZ])}
              />
            </>
          ) : (
            <>
              <AxisScalarInput
                ariaLabel={`${label} radius`}
                axis="r"
                axisTone="x"
                describedBy={describedBy}
                disabled={disabled}
                id={id}
                invalid={invalid}
                toSiFactor={toSiFactor}
                value={sphericalR}
                onBlurField={onBlurField}
                onCommitSI={(nextR) =>
                  updateSpherical(Math.max(0, nextR), sphericalThetaDeg, sphericalPhiDeg)
                }
              />
              <AxisScalarInput
                ariaLabel={`${label} polar angle theta in degrees`}
                axis="θ"
                axisTone="y"
                describedBy={describedBy}
                disabled={disabled}
                id={`${id}-theta`}
                invalid={invalid}
                toSiFactor={1}
                value={sphericalThetaDeg}
                onBlurField={onBlurField}
                onCommitSI={(nextTheta) =>
                  updateSpherical(sphericalR, nextTheta, sphericalPhiDeg)
                }
              />
              <AxisScalarInput
                ariaLabel={`${label} azimuthal angle phi in degrees`}
                axis="φ"
                axisTone="z"
                describedBy={describedBy}
                disabled={disabled}
                id={`${id}-phi`}
                invalid={invalid}
                toSiFactor={1}
                value={sphericalPhiDeg}
                onBlurField={onBlurField}
                onCommitSI={(nextPhi) =>
                  updateSpherical(sphericalR, sphericalThetaDeg, nextPhi)
                }
              />
            </>
          )}
        </div>

        {units && units.length > 0 && activeUnit ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`${label} unit`}
                className="fm-inspector-unit-trigger"
                disabled={disabled}
                size="sm"
                variant="ghost"
              >
                <span>{activeUnit.unit}</span>
                <ChevronDown aria-hidden="true" data-icon="inline-end" size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={activeUnit.unit}
                onValueChange={(nextUnit) => onDisplayUnitChange?.(nextUnit)}
              >
                {units.map((option) => (
                  <DropdownMenuRadioItem key={option.unit} value={option.unit}>
                    {option.unit}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : unitSuffix ? (
          <span className="fm-inspector-vector3__unit">{unitSuffix}</span>
        ) : null}
      </div>

      {axisPresets || normalizeAction ? (
        <div className="fm-inspector-vector3__presets">
          {axisPresets
            ? AXIS_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  className="fm-inspector-vector3__preset"
                  disabled={disabled}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    const scale = norm > 0 ? norm : 1;
                    onChange([
                      preset.vec[0] * scale,
                      preset.vec[1] * scale,
                      preset.vec[2] * scale,
                    ]);
                  }}
                >
                  {preset.label}
                </Button>
              ))
            : null}
          {normalizeAction ? (
            <Button
              className="fm-inspector-vector3__preset"
              disabled={disabled || norm === 0}
              disabledReason={norm === 0 ? "Cannot normalize the zero vector." : undefined}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                if (norm <= 0) return;
                onChange([vx / norm, vy / norm, vz / norm]);
              }}
            >
              Normalize
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Copy button with transient Check feedback ── */
function InlineCopyButton({
  text,
  label = "Copy value",
  onCopied,
}: {
  text: string;
  label?: string;
  onCopied?: (copiedText: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="fm-inspector-icon-btn"
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => {
            navigator.clipboard?.writeText(text).catch(() => undefined);
            setCopied(true);
            onCopied?.(text);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? (
            <Check aria-hidden="true" size={14} />
          ) : (
            <Copy aria-hidden="true" size={14} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

/* ── Theme-aware Color selector using design tokens only ── */
function ColorControl({
  id,
  value,
  disabled,
  invalid,
  describedBy,
  onChange,
  onBlurField,
}: {
  id: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  onChange: (next: string) => void;
  onBlurField: () => void;
}) {
  const labelText = colorValueLabel(value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-describedby={describedBy}
          aria-invalid={invalid ? "true" : "false"}
          className="fm-inspector-color-trigger"
          disabled={disabled}
          id={id}
          size="sm"
          type="button"
          variant="secondary"
        >
          <span
            aria-hidden="true"
            className="fm-inspector-color-trigger__swatch"
            style={{ background: value || "var(--fm-accent)" }}
          />
          <span className="fm-inspector-color-trigger__label">{labelText}</span>
          <ChevronDown aria-hidden="true" data-icon="inline-end" size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="fm-inspector-color-popover">
        <div className="fm-inspector-color-popover__body">
          <span className="fm-inspector-color-popover__title">Theme swatches</span>
          <div aria-label="Theme color swatches" className="fm-inspector-color-swatches" role="radiogroup">
            {THEME_COLOR_SWATCHES.map((swatch) => {
              const selected = swatch.value === value;
              return (
                <Tooltip key={swatch.value}>
                  <TooltipTrigger asChild>
                    <button
                      aria-checked={selected}
                      aria-label={swatch.label}
                      className="fm-inspector-color-swatch"
                      data-selected={selected ? "true" : "false"}
                      role="radio"
                      style={{ background: swatch.value }}
                      type="button"
                      onClick={() => {
                        onChange(swatch.value);
                        onBlurField();
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent>{swatch.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          <InputGroup className="fm-inspector-field">
            <InputGroupInput
              aria-label="Custom color value"
              autoComplete="off"
              className="font-mono"
              placeholder="CSS token or hex"
              spellCheck={false}
              type="text"
              value={value}
              onBlur={onBlurField}
              onChange={(event) => onChange(event.target.value)}
            />
          </InputGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ── Physics symbol with HoverCard definition and pointer-capture drag-scrubbing ── */
interface PhysicsSymbolProps {
  symbol: ReactNode;
  symbolInfo?: SymbolInfo;
  scrubConfig?: {
    startValueSI: number;
    stepDisplay: number;
    toSiFactor: number;
    mode: "lin" | "log";
    min?: number;
    max?: number;
    onScrubSI: (nextSI: number) => void;
    onScrubEnd: () => void;
  };
}

function PhysicsSymbol({ symbol, symbolInfo, scrubConfig }: PhysicsSymbolProps) {
  const dragStartRef = useRef<{ x: number; startValueSI: number } | null>(null);
  const scrubbable = Boolean(scrubConfig);

  const handlePointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!scrubConfig || !Number.isFinite(scrubConfig.startValueSI)) return;
    event.preventDefault();
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic test events may not have an active pointer id.
      }
    }
    dragStartRef.current = { x: event.clientX, startValueSI: scrubConfig.startValueSI };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!dragStartRef.current || !scrubConfig) return;
    const deltaPx = event.clientX - dragStartRef.current.x;
    const nextSI = computeDragScrubValueSI({
      startValueSI: dragStartRef.current.startValueSI,
      deltaPx,
      stepDisplay: scrubConfig.stepDisplay,
      toSiFactor: scrubConfig.toSiFactor,
      mode: scrubConfig.mode,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      min: scrubConfig.min,
      max: scrubConfig.max,
    });
    scrubConfig.onScrubSI(nextSI);
  };

  const finishScrub = () => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    scrubConfig?.onScrubEnd();
  };

  const symbolNode = (
    <span
      className="fm-sym fm-inspector-row__symbol"
      data-scrubbable={scrubbable ? "true" : undefined}
      tabIndex={symbolInfo ? 0 : undefined}
      onPointerCancel={finishScrub}
      onPointerDown={scrubbable ? handlePointerDown : undefined}
      onPointerMove={scrubbable ? handlePointerMove : undefined}
      onPointerUp={finishScrub}
    >
      {symbol}
    </span>
  );

  if (!symbolInfo) return symbolNode;

  return (
    <HoverCard closeDelay={80} openDelay={350}>
      <HoverCardTrigger asChild>{symbolNode}</HoverCardTrigger>
      <HoverCardContent align="start" className="fm-inspector-symbol-card" side="left">
        <div className="fm-inspector-symbol-card__header">
          <span className="fm-inspector-symbol-card__name">{symbolInfo.name}</span>
          <span className="fm-sym fm-inspector-symbol-card__glyph">{symbol}</span>
        </div>
        <p className="fm-inspector-symbol-card__def">{symbolInfo.definition}</p>
        {symbolInfo.formula ? (
          <div className="fm-inspector-symbol-card__formula">{symbolInfo.formula}</div>
        ) : null}
        <div className="fm-inspector-symbol-card__meta">
          <Badge variant="secondary">SI unit: {symbolInfo.siUnit}</Badge>
          {symbolInfo.typicalRange ? <Badge variant="default">{symbolInfo.typicalRange}</Badge> : null}
        </div>
        {scrubbable ? (
          <p className="fm-inspector-symbol-card__scrub-tip">
            Drag sideways to adjust (Shift ×10, Alt ×0.1).
          </p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}

/* ── Canonical PropertyRow (Slot 7) ── */
export interface PropertyRowProps<TDraft> {
  ctx: InspectorActionContext<TDraft>;
  row: InspectorRowSpec<TDraft>;
  liveRow: boolean;
  displayUnit?: string;
  onDisplayUnitChange?: (unit: string) => void;
  touched?: boolean;
  onTouchField?: (fieldKey: string) => void;
  forceShowErrors?: boolean;
  externalError?: string | null;
  flash?: "applied" | "live" | "focus";
  onParseErrorChange?: (fieldKey: string, error: string | null) => void;
}

export function PropertyRow<TDraft>({
  ctx,
  row,
  liveRow,
  displayUnit,
  onDisplayUnitChange,
  touched,
  onTouchField,
  forceShowErrors = false,
  externalError = null,
  flash,
  onParseErrorChange,
}: PropertyRowProps<TDraft>): ReactNode {
  const generatedId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const [localTouched, setLocalTouched] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const key = row.key;
  const controlId = `${ctx.specId}-${key ?? generatedId}`;
  const labelId = `${controlId}-label`;
  const errorId = `${controlId}-error`;
  const hintId = `${controlId}-hint`;

  const value = readDraftValue(ctx.draft, key);
  const baselineValue = readDraftValue(ctx.baseline, key);
  const hasBaselineKey =
    Boolean(key) &&
    typeof ctx.baseline === "object" &&
    ctx.baseline !== null &&
    key! in (ctx.baseline as Record<string, unknown>);
  const dirty = Boolean(key) && hasBaselineKey && !inspectorValuesEqual(value, baselineValue);

  const disabledReasonText = row.disabledReason?.(ctx.draft)?.trim() || null;
  const isDisabled = Boolean(disabledReasonText);

  const isTouched = Boolean(touched || localTouched);
  const serverErr = externalError ?? row.serverError?.(ctx.draft) ?? null;
  const validationErr = parseError ?? evaluateInspectorRowError(row, ctx.draft, externalError);
  const showErr = Boolean(
    validationErr && (isTouched || forceShowErrors || Boolean(serverErr)),
  );

  const activeUnit = useMemo<UnitOption | undefined>(() => {
    if (row.type === "quantity") {
      return (
        row.units.find((entry) => entry.unit === displayUnit) ??
        row.units.find((entry) => entry.unit === row.defaultDisplayUnit) ??
        row.units[0]
      );
    }
    if (row.type === "vector3" && row.units && row.units.length > 0) {
      return (
        row.units.find((entry) => entry.unit === displayUnit) ??
        row.units.find((entry) => entry.unit === row.defaultDisplayUnit) ??
        row.units[0]
      );
    }
    return undefined;
  }, [displayUnit, row]);

  // Announce validation errors to the single polite live region only when visible.
  const prevAnnouncedErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const nextMessage = showErr ? validationErr : null;
    if (nextMessage === prevAnnouncedErrorRef.current) return;
    prevAnnouncedErrorRef.current = nextMessage;
    if (nextMessage !== null) {
      announceFieldError(controlId, nextMessage);
    } else if (isTouched || forceShowErrors) {
      announceFieldError(controlId, null);
    }
  }, [controlId, forceShowErrors, isTouched, showErr, validationErr]);

  useEffect(() => {
    if (flash !== "focus" || !rowRef.current) return;
    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof rowRef.current.scrollIntoView === "function") {
      rowRef.current.scrollIntoView({
        block: "center",
        behavior: prefersReduced ? "auto" : "smooth",
      });
    }
    const controlScope =
      rowRef.current.querySelector<HTMLElement>(".fm-inspector-row__control") ?? rowRef.current;
    const focusTarget = controlScope.querySelector<HTMLElement>(
      'input, textarea, [role="combobox"], [role="switch"], [role="slider"], button[role="radio"], button',
    );
    focusTarget?.focus?.({ preventScroll: true });
  }, [flash]);

  if (row.showWhen && !row.showWhen(ctx.draft)) {
    return null;
  }

  const handleFieldTouch = () => {
    if (!key) return;
    setLocalTouched(true);
    onTouchField?.(key);
  };

  const handleParseError = (error: string | null) => {
    setParseError(error);
    if (key) onParseErrorChange?.(key, error);
  };

  const setTypedField = (nextValue: unknown) => {
    if (!key) return;
    ctx.setField(key, nextValue as TDraft[typeof key]);
  };

  const describedBy =
    [row.hint ? hintId : null, showErr ? errorId : null].filter(Boolean).join(" ") || undefined;

  let controlNode: ReactNode = null;

  switch (row.type) {
    case "quantity": {
      const unitOption = activeUnit ?? row.units[0];
      const numericValue = typeof value === "number" ? value : 0;
      controlNode = (
        <QuantityNumberField
          activeUnit={unitOption}
          describedBy={describedBy}
          disabled={isDisabled}
          id={controlId}
          invalid={showErr}
          label={row.label ?? key ?? "Quantity"}
          resetToken={resetToken}
          units={row.units}
          value={numericValue}
          onBlurField={handleFieldTouch}
          onCommitSI={setTypedField}
          onDisplayUnitChange={onDisplayUnitChange}
          onParseErrorChange={handleParseError}
        />
      );
      break;
    }

    case "number": {
      const numericValue = typeof value === "number" ? value : 0;
      controlNode = (
        <QuantityNumberField
          activeUnit={{ unit: row.unitSuffix ?? "", toSiFactor: 1 }}
          describedBy={describedBy}
          disabled={isDisabled}
          id={controlId}
          integer={row.integer}
          invalid={showErr}
          label={row.label ?? key ?? "Number"}
          resetToken={resetToken}
          unitSuffix={row.unitSuffix}
          value={numericValue}
          onBlurField={handleFieldTouch}
          onCommitSI={setTypedField}
          onParseErrorChange={handleParseError}
        />
      );
      break;
    }

    case "vector3": {
      const rawVec = Array.isArray(value) ? value : [0, 0, 0];
      const tuple: readonly [number, number, number] = [
        typeof rawVec[0] === "number" ? rawVec[0] : 0,
        typeof rawVec[1] === "number" ? rawVec[1] : 0,
        typeof rawVec[2] === "number" ? rawVec[2] : 0,
      ];
      controlNode = (
        <Vector3FieldControl
          activeUnit={activeUnit}
          axisPresets={row.axisPresets}
          coordinateModes={row.coordinateModes}
          describedBy={describedBy}
          disabled={isDisabled}
          id={controlId}
          invalid={showErr}
          label={row.label ?? key ?? "Vector"}
          normalizeAction={row.normalizeAction}
          unitSuffix={row.unitSuffix}
          units={row.units}
          value={tuple}
          onBlurField={handleFieldTouch}
          onChange={setTypedField}
          onDisplayUnitChange={onDisplayUnitChange}
        />
      );
      break;
    }

    case "select": {
      const grouped = new Map<string, typeof row.options[number][]>();
      for (const option of row.options) {
        const groupKey = option.group ?? "";
        const bucket = grouped.get(groupKey) ?? [];
        bucket.push(option);
        grouped.set(groupKey, bucket);
      }
      controlNode = (
        <Select
          disabled={isDisabled}
          value={String(value ?? "")}
          onValueChange={(nextValue) => {
            setTypedField(nextValue);
            handleFieldTouch();
          }}
        >
          <SelectTrigger
            aria-describedby={describedBy}
            aria-invalid={showErr ? "true" : "false"}
            id={controlId}
            invalid={showErr}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" position="popper">
            {Array.from(grouped.entries()).map(([groupName, groupOptions]) => (
              <SelectGroup key={groupName || "__default"}>
                {groupName ? <SelectLabel>{groupName}</SelectLabel> : null}
                {groupOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    disabled={Boolean(option.disabledReason)}
                    value={option.value}
                  >
                    <span className="fm-inspector-select-item__body">
                      {option.swatchCss ? (
                        <span
                          aria-hidden="true"
                          className="fm-inspector-select-item__swatch"
                          style={{ background: option.swatchCss }}
                        />
                      ) : null}
                      <span>{option.label}</span>
                      {option.disabledReason ? (
                        <span className="fm-inspector-select-item__reason">
                          ({option.disabledReason})
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    }

    case "segmented": {
      if (row.presentation === "tiles") {
        controlNode = (
          <ToggleGroup
            aria-describedby={describedBy}
            aria-labelledby={row.label ? labelId : undefined}
            className="fm-inspector-tiles"
            disabled={isDisabled}
            type="single"
            value={String(value ?? "")}
            onValueChange={(nextValue) => {
              if (!nextValue) return;
              setTypedField(nextValue);
              handleFieldTouch();
            }}
          >
            {row.options.map((option) => {
              const item = (
                <ToggleGroupItem
                  key={option.value}
                  className="fm-inspector-tile"
                  disabled={isDisabled || Boolean(option.disabledReason)}
                  value={option.value}
                >
                  {renderOptionIcon(option.icon)}
                  <span className="fm-inspector-tile__label">{option.label}</span>
                </ToggleGroupItem>
              );
              return option.disabledReason ? (
                <DisabledReason key={option.value} reason={option.disabledReason}>
                  {item}
                </DisabledReason>
              ) : (
                item
              );
            })}
          </ToggleGroup>
        );
      } else {
        controlNode = (
          <SegmentedControl
            aria-label={row.label ?? key ?? "Selection"}
            disabled={isDisabled}
            options={row.options.map((option) => ({
              value: option.value,
              label: option.label,
              disabled: Boolean(option.disabledReason),
              accessibleLabel: option.disabledReason
                ? `${option.label} (${option.disabledReason})`
                : undefined,
            }))}
            value={String(value ?? "")}
            onValueChange={(nextValue) => {
              setTypedField(nextValue);
              handleFieldTouch();
            }}
          />
        );
      }
      break;
    }

    case "switch": {
      controlNode = (
        <Switch
          aria-describedby={describedBy}
          aria-invalid={showErr ? "true" : "false"}
          checked={Boolean(value)}
          disabled={isDisabled}
          id={controlId}
          onCheckedChange={(checked) => {
            setTypedField(checked);
            handleFieldTouch();
          }}
        />
      );
      break;
    }

    case "color": {
      controlNode = (
        <ColorControl
          describedBy={describedBy}
          disabled={isDisabled}
          id={controlId}
          invalid={showErr}
          value={String(value ?? "")}
          onBlurField={handleFieldTouch}
          onChange={setTypedField}
        />
      );
      break;
    }

    case "expression": {
      controlNode = (
        <div className="fm-inspector-expression">
          <InputGroup className="fm-inspector-field">
            {row.multiline ? (
              <InputGroupTextarea
                aria-describedby={describedBy}
                aria-invalid={showErr ? "true" : "false"}
                autoComplete="off"
                className="font-mono"
                disabled={isDisabled}
                id={controlId}
                placeholder={row.placeholder}
                rows={3}
                spellCheck={false}
                value={String(value ?? "")}
                onBlur={handleFieldTouch}
                onChange={(event) => setTypedField(event.target.value)}
              />
            ) : (
              <InputGroupInput
                aria-describedby={describedBy}
                aria-invalid={showErr ? "true" : "false"}
                autoComplete="off"
                className="font-mono"
                disabled={isDisabled}
                id={controlId}
                placeholder={row.placeholder}
                spellCheck={false}
                type="text"
                value={String(value ?? "")}
                onBlur={handleFieldTouch}
                onChange={(event) => setTypedField(event.target.value)}
              />
            )}
          </InputGroup>
          {row.allowedVariables && row.allowedVariables.length > 0 ? (
            <div className="fm-inspector-expression__vars">
              {row.allowedVariables.map((variable) => (
                <Badge key={variable} className="font-mono" variant="default">
                  {variable}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      );
      break;
    }

    case "reference": {
      const options = row.options(ctx.draft);
      const currentId = typeof value === "string" ? value : "";
      const selectedOption = options.find((opt) => opt.id === currentId);
      const warning = row.sharedUsageWarning?.(ctx.draft) ?? null;

      controlNode = (
        <div className="fm-inspector-reference">
          <div className="fm-inspector-reference__row">
            <Select
              disabled={isDisabled}
              value={currentId || (row.allowNone ? NONE_REFERENCE_SENTINEL : "")}
              onValueChange={(nextValue) => {
                setTypedField(nextValue === NONE_REFERENCE_SENTINEL ? null : nextValue);
                handleFieldTouch();
              }}
            >
              <SelectTrigger
                aria-describedby={describedBy}
                aria-invalid={showErr ? "true" : "false"}
                id={controlId}
                invalid={showErr}
              >
                <SelectValue placeholder={`Select ${row.targetKindLabel}`} />
              </SelectTrigger>
              <SelectContent align="end" position="popper">
                <SelectGroup>
                  {row.allowNone ? (
                    <SelectItem value={NONE_REFERENCE_SENTINEL}>
                      {row.allowNone.label}
                    </SelectItem>
                  ) : null}
                  {options.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      <span className="fm-inspector-reference__option">
                        <span>{opt.label}</span>
                        {opt.subtitle ? (
                          <span className="fm-inspector-reference__subtitle">
                            {opt.subtitle}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selectedOption?.jumpSelection ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`Jump to ${selectedOption.label}`}
                    className="fm-inspector-icon-btn"
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => ctx.selectNode(selectedOption.jumpSelection!)}
                  >
                    <ArrowUpRight aria-hidden="true" size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Jump to {selectedOption.label}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          {warning ? (
            <p className="fm-inspector-reference__warning" role="status">
              <TriangleAlert aria-hidden="true" size={14} />
              <span>{warning}</span>
            </p>
          ) : null}
          {row.onCreateNew || row.onDuplicateUnlink ? (
            <div className="fm-inspector-reference__actions">
              {row.onDuplicateUnlink ? (
                <Button
                  disabled={isDisabled}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => void row.onDuplicateUnlink?.(ctx)}
                >
                  Duplicate to unlink
                </Button>
              ) : null}
              {row.onCreateNew ? (
                <Button
                  disabled={isDisabled}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => void row.onCreateNew?.(ctx)}
                >
                  <Plus aria-hidden="true" data-icon="inline-start" size={14} />
                  New {row.targetKindLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
      break;
    }

    case "table": {
      const visibleColumns = row.columns.slice(0, MAX_INLINE_TABLE_COLUMNS);
      const allRows = row.rows(ctx.draft);
      const maxInline = row.maxInlineRows ?? allRows.length;
      const visibleRows = allRows.slice(0, maxInline);
      const remainingCount = Math.max(0, allRows.length - visibleRows.length);

      controlNode = (
        <div className="fm-inspector-table">
          <div className="fm-inspector-table__wrap">
            <table aria-labelledby={row.label ? labelId : undefined} className="fm-inspector-table__el">
              <thead>
                <tr>
                  {visibleColumns.map((column) => (
                    <th
                      key={column.id}
                      data-align={column.align ?? "left"}
                      scope="col"
                    >
                      {column.header}
                    </th>
                  ))}
                  {row.onRemoveRow ? <th className="fm-inspector-table__action-col" scope="col" /> : null}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((entry, rowIndex) => {
                  const stableKey = row.rowKey(entry);
                  return (
                    <tr
                      key={stableKey}
                      data-clickable={row.onSelectRow ? "true" : undefined}
                      data-row-key={stableKey}
                      onClick={row.onSelectRow ? () => row.onSelectRow?.(entry, ctx) : undefined}
                    >
                      {visibleColumns.map((column) => (
                        <td
                          key={column.id}
                          className={cn(column.mono && "font-mono")}
                          data-align={column.align ?? "left"}
                        >
                          {column.renderCell(entry, rowIndex)}
                        </td>
                      ))}
                      {row.onRemoveRow ? (
                        <td className="fm-inspector-table__action-cell">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                aria-label={`Remove row ${stableKey}`}
                                className="fm-inspector-icon-btn"
                                disabled={isDisabled}
                                size="icon"
                                type="button"
                                variant="ghost"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  row.onRemoveRow?.(stableKey, ctx);
                                }}
                              >
                                <Trash2 aria-hidden="true" size={14} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Remove row</TooltipContent>
                          </Tooltip>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {row.onAddRow || row.expandedViewAction || remainingCount > 0 ? (
            <div className="fm-inspector-table__footer">
              {row.onAddRow ? (
                <Button
                  disabled={isDisabled}
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => row.onAddRow?.(ctx)}
                >
                  <Plus aria-hidden="true" data-icon="inline-start" size={14} />
                  Add row
                </Button>
              ) : null}
              {remainingCount > 0 ? (
                <span className="fm-inspector-table__more">
                  +{remainingCount} more
                </span>
              ) : null}
              {row.expandedViewAction ? (
                <Button
                  className="fm-ml-auto"
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => row.expandedViewAction?.onOpen(ctx)}
                >
                  {row.expandedViewAction.label}
                  <ArrowUpRight aria-hidden="true" data-icon="inline-end" size={14} />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
      break;
    }

    case "text": {
      controlNode = (
        <InputGroup className="fm-inspector-field">
          <InputGroupInput
            aria-describedby={describedBy}
            aria-invalid={showErr ? "true" : "false"}
            autoComplete="off"
            className={cn(row.mono && "font-mono")}
            disabled={isDisabled}
            id={controlId}
            placeholder={row.placeholder}
            spellCheck={false}
            type="text"
            value={String(value ?? "")}
            onBlur={handleFieldTouch}
            onChange={(event) => setTypedField(event.target.value)}
          />
        </InputGroup>
      );
      break;
    }

    case "textarea": {
      controlNode = (
        <InputGroup className="fm-inspector-field">
          <InputGroupTextarea
            aria-describedby={describedBy}
            aria-invalid={showErr ? "true" : "false"}
            disabled={isDisabled}
            id={controlId}
            placeholder={row.placeholder}
            rows={row.rows ?? 3}
            value={String(value ?? "")}
            onBlur={handleFieldTouch}
            onChange={(event) => setTypedField(event.target.value)}
          />
        </InputGroup>
      );
      break;
    }

    case "range": {
      const numericValue = typeof value === "number" && Number.isFinite(value) ? value : row.min;
      controlNode = (
        <div className="fm-inspector-range">
          <Slider
            aria-label={row.label ?? key ?? "Range"}
            disabled={isDisabled}
            id={controlId}
            max={row.max}
            min={row.min}
            step={row.step}
            value={[numericValue]}
            valueText={(v) => `${formatNumericScalar(v)}${row.unitSuffix ?? ""}`}
            onValueChange={([nextValue]) => {
              if (nextValue === undefined) return;
              setTypedField(nextValue);
              handleFieldTouch();
            }}
          />
          <output className="fm-inspector-range__output" htmlFor={controlId}>
            {formatNumericScalar(numericValue)}
            {row.unitSuffix ?? ""}
          </output>
        </div>
      );
      break;
    }

    case "toggles": {
      const activeValues = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
      controlNode = (
        <ToggleGroup
          aria-describedby={describedBy}
          aria-labelledby={row.label ? labelId : undefined}
          className="fm-inspector-toggles"
          disabled={isDisabled}
          type="multiple"
          value={activeValues}
          onValueChange={(nextValues) => {
            setTypedField(nextValues);
            handleFieldTouch();
          }}
        >
          {row.options.map((option) => (
            <ToggleGroupItem key={option.value} size="sm" value={option.value}>
              {option.icon ? (
                <option.icon aria-hidden="true" data-icon="inline-start" size={14} />
              ) : null}
              <span>{option.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      );
      break;
    }

    case "readonly": {
      const renderedValue = row.format(ctx.draft);
      const copyPayload = row.copyText?.(ctx.draft) ?? null;
      controlNode = (
        <div className="fm-inspector-readonly">
          <div className={cn("fm-inspector-readonly__value", row.mono && "font-mono")}>
            {typeof renderedValue === "string" && row.mono ? (
              <OverflowText>{renderedValue}</OverflowText>
            ) : (
              renderedValue
            )}
          </div>
          {copyPayload ? (
            <InlineCopyButton
              label={`Copy ${row.label ?? "value"}`}
              text={copyPayload}
              onCopied={(copied) => ctx.notify("Copied to clipboard", copied)}
            />
          ) : null}
        </div>
      );
      break;
    }

    case "chips": {
      const items = row.items(ctx.draft);
      controlNode = (
        <div className="fm-inspector-chips">
          {items.map((item) =>
            item.jumpSelection ? (
              <Button
                key={item.id}
                className="fm-inspector-chip-btn"
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => ctx.selectNode(item.jumpSelection!)}
              >
                <span>{item.label}</span>
                <ArrowUpRight aria-hidden="true" data-icon="inline-end" size={12} />
              </Button>
            ) : (
              <Badge key={item.id} variant="secondary">
                {item.label}
              </Badge>
            ),
          )}
        </div>
      );
      break;
    }

    case "custom": {
      controlNode = row.render(ctx);
      break;
    }
  }

  const wrappedControl = disabledReasonText ? (
    <DisabledReason className="fm-inspector-row__disabled-wrap" reason={disabledReasonText}>
      {controlNode}
    </DisabledReason>
  ) : (
    controlNode
  );

  const scrubConfig =
    !isDisabled &&
    key &&
    (row.type === "quantity" || row.type === "number") &&
    typeof value === "number"
      ? {
          startValueSI: value,
          stepDisplay: row.step ?? (row.type === "number" && row.integer ? 1 : 0.01),
          toSiFactor: row.type === "quantity" ? (activeUnit?.toSiFactor ?? row.units[0].toSiFactor) : 1,
          mode: row.scrub ?? "lin",
          min: row.min,
          max: row.max,
          onScrubSI: (nextSI: number) => {
            const finalVal = row.type === "number" && row.integer ? Math.round(nextSI) : nextSI;
            setTypedField(finalVal);
          },
          onScrubEnd: handleFieldTouch,
        }
      : undefined;

  const vectorNote =
    row.type === "vector3" && row.vectorNote && Array.isArray(value) && value.length >= 3
      ? row.vectorNote(
          [
            typeof value[0] === "number" ? value[0] : 0,
            typeof value[1] === "number" ? value[1] : 0,
            typeof value[2] === "number" ? value[2] : 0,
          ],
          ctx.draft,
        )
      : null;

  const isWide = Boolean(row.wide || !row.label || row.type === "table" || row.type === "custom");
  const isVector = row.type === "vector3";
  const usesNativeLabel = NATIVELY_LABELED_ROW_TYPES.has(row.type);

  const baselineDisplayText = formatRowValueText(row, baselineValue, activeUnit);
  const currentDisplayText = formatRowValueText(row, value, activeUnit);

  const labelBlock = row.label ? (
    <div className="fm-inspector-row__label-wrap">
      {usesNativeLabel ? (
        <label className="fm-inspector-row__label" htmlFor={controlId} id={labelId}>
          {row.label}
        </label>
      ) : (
        <span className="fm-inspector-row__label" id={labelId}>
          {row.label}
        </span>
      )}
      {row.symbol ? (
        <PhysicsSymbol
          scrubConfig={scrubConfig}
          symbol={row.symbol}
          symbolInfo={row.symbolInfo}
        />
      ) : null}
      {dirty && !liveRow && !isDisabled && key ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Revert ${row.label}`}
              className="fm-inspector-row__revert"
              size="icon"
              type="button"
              variant="ghost"
              onClick={() => {
                setParseError(null);
                setResetToken((token) => token + 1);
                onParseErrorChange?.(key, null);
                ctx.revertField(key);
              }}
            >
              <CornerUpLeft aria-hidden="true" size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Revert to {baselineDisplayText || "baseline"}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  ) : null;

  const rowElement = (
    <div
      ref={rowRef}
      className={cn(
        "fm-inspector-row",
        isWide && "fm-inspector-row--wide",
        isVector && !isWide && "fm-inspector-row--vector3",
        flash === "applied" && "fm-row-flash-applied",
        flash === "live" && "fm-row-flash-live",
        flash === "focus" && "fm-row-flash-focus",
      )}
      data-context-menu-ready={key && row.type !== "custom" ? "true" : undefined}
      data-dirty={dirty && !liveRow ? "true" : "false"}
      data-invalid={showErr ? "true" : "false"}
      data-row={key ?? undefined}
      data-slot="inspector-row"
    >
      <span
        aria-hidden="true"
        className="fm-inspector-row__bar"
        data-state={showErr ? "error" : dirty && !liveRow ? "dirty" : "clean"}
      />
      {labelBlock}
      <div className="fm-inspector-row__control">{wrappedControl}</div>
      {row.hint ? (
        <p className="fm-inspector-row__hint" id={hintId}>
          {row.hint}
        </p>
      ) : null}
      {vectorNote ? (
        <p className="fm-inspector-row__note" data-tone={vectorNote.tone}>
          {vectorNote.tone === "ok" ? (
            <Check aria-hidden="true" size={14} />
          ) : (
            <TriangleAlert aria-hidden="true" size={14} />
          )}
          <span>{vectorNote.text}</span>
        </p>
      ) : null}
      {showErr && validationErr ? (
        <p className="fm-inspector-row__error" data-slot="field-error" id={errorId}>
          {validationErr}
        </p>
      ) : null}
    </div>
  );

  const pythonSnippetGenerator = row.toPythonSnippet as
    | ((val: unknown, d: TDraft) => string)
    | undefined;
  const pythonSnippet = key
    ? (pythonSnippetGenerator?.(value, ctx.draft) ??
      `${ctx.specId}.${key} = ${formatPythonLiteral(value)}`)
    : "";

  const content =
    !key || row.type === "custom" ? (
      rowElement
    ) : (
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowElement}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem
              onSelect={() => {
                navigator.clipboard?.writeText(currentDisplayText).catch(() => undefined);
                ctx.notify("Copied value", currentDisplayText);
              }}
            >
              <Copy aria-hidden="true" size={14} />
              <span>Copy value</span>
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                navigator.clipboard?.writeText(pythonSnippet).catch(() => undefined);
                ctx.notify("Copied as Python", pythonSnippet);
              }}
            >
              <Copy aria-hidden="true" size={14} />
              <span>Copy as Python</span>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              disabled={!dirty || liveRow || isDisabled}
              onSelect={() => {
                setParseError(null);
                setResetToken((token) => token + 1);
                onParseErrorChange?.(key, null);
                ctx.revertField(key);
              }}
            >
              <CornerUpLeft aria-hidden="true" size={14} />
              <span>Revert field</span>
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    );

  return <TooltipProvider delayDuration={250}>{content}</TooltipProvider>;
}
