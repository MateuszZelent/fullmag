"use client";

import { useId, useReducer, useState } from "react";

import type {
  FrozenSpinsSelectionExpression,
  SelectionGeometryPredicate,
  SelectionScalarExpression,
} from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

interface SelectionExpressionBuilderProps {
  expression: FrozenSpinsSelectionExpression;
  objectId: string;
  regionId?: string | null;
  onChange: (expression: FrozenSpinsSelectionExpression) => void;
}

type SimpleSelectionKind =
  | "all_magnetic"
  | "in_object"
  | "in_region"
  | "ref"
  | "and"
  | "or"
  | "xor"
  | "inside_geometry"
  | "compare"
  | "approx"
  | "between"
  | "not";

const SIMPLE_KINDS: readonly SimpleSelectionKind[] = [
  "all_magnetic",
  "in_object",
  "in_region",
  "ref",
  "and",
  "or",
  "xor",
  "inside_geometry",
  "compare",
  "approx",
  "between",
  "not",
];

const OPERATOR_OPTIONS: readonly (readonly [string, string])[] = [
  ["all_magnetic", "All magnetic DOFs"],
  ["in_object", "In object"],
  ["in_region", "In region"],
  ["ref", "Named selection"],
  ["and", "All expressions (AND)"],
  ["or", "Any expression (OR)"],
  ["xor", "Exactly one expression (XOR)"],
  ["not", "Negation (NOT)"],
  ["inside_geometry", "Inside geometry"],
  ["compare", "Scalar comparison"],
  ["approx", "Approximate scalar equality"],
  ["between", "Scalar interval"],
];

type BooleanSelectionExpression = Extract<
  FrozenSpinsSelectionExpression,
  { kind: "and" | "or" | "xor" }
>;
type SelectionClauseExpression = BooleanSelectionExpression["expressions"][number];

interface SelectionClauseKeyEntry {
  key: string;
  expression: SelectionClauseExpression;
}

interface SelectionClauseKeyState {
  idPrefix: string;
  nextId: number;
  entries: SelectionClauseKeyEntry[];
}

type SelectionClauseKeyAction =
  | {
      type: "append";
      expressions: readonly SelectionClauseExpression[];
      expression: SelectionClauseExpression;
    }
  | {
      type: "remove";
      expressions: readonly SelectionClauseExpression[];
      index: number;
    }
  | {
      type: "replace";
      expressions: readonly SelectionClauseExpression[];
      index: number;
      expression: SelectionClauseExpression;
    };

function initializeSelectionClauseKeys({
  idPrefix,
  expressions,
}: {
  idPrefix: string;
  expressions: readonly SelectionClauseExpression[];
}): SelectionClauseKeyState {
  return {
    idPrefix,
    nextId: expressions.length,
    entries: expressions.map((expression, index) => ({
      key: `${idPrefix}:clause:${index}`,
      expression,
    })),
  };
}

function resolveSelectionClauseKeys(
  state: SelectionClauseKeyState,
  expressions: readonly SelectionClauseExpression[],
): SelectionClauseKeyState {
  const used = new Set<number>();
  const entries: (SelectionClauseKeyEntry | null)[] = expressions.map((expression) => {
    const match = state.entries.findIndex(
      (entry, index) => !used.has(index) && entry.expression === expression,
    );
    if (match < 0) return null;
    used.add(match);
    return state.entries[match] ?? null;
  });
  let nextId = state.nextId;

  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index] !== null) continue;
    if (index < state.entries.length && !used.has(index)) {
      used.add(index);
      entries[index] = state.entries[index] ?? null;
    }
    if (entries[index] === null) {
      const expression = expressions[index];
      if (expression) {
        entries[index] = {
          key: `${state.idPrefix}:clause:${nextId++}`,
          expression,
        };
      }
    } else {
      entries[index] = {
        ...(entries[index] as SelectionClauseKeyEntry),
        expression: expressions[index] as SelectionClauseExpression,
      };
    }
  }

  return {
    idPrefix: state.idPrefix,
    nextId,
    entries: entries.filter((entry): entry is SelectionClauseKeyEntry => entry !== null),
  };
}

function reduceSelectionClauseKeys(
  state: SelectionClauseKeyState,
  action: SelectionClauseKeyAction,
): SelectionClauseKeyState {
  const resolved = resolveSelectionClauseKeys(state, action.expressions);
  if (action.type === "append") {
    return {
      ...resolved,
      nextId: resolved.nextId + 1,
      entries: [
        ...resolved.entries,
        {
          key: `${resolved.idPrefix}:clause:${resolved.nextId}`,
          expression: action.expression,
        },
      ],
    };
  }
  if (action.type === "remove") {
    return {
      ...resolved,
      entries: resolved.entries.filter((_, index) => index !== action.index),
    };
  }
  return {
    ...resolved,
    entries: resolved.entries.map((entry, index) =>
      index === action.index
        ? { ...entry, expression: action.expression }
        : entry,
    ),
  };
}

export function SelectionExpressionBuilder({
  expression,
  objectId,
  regionId,
  onChange,
}: SelectionExpressionBuilderProps) {
  const editable = SIMPLE_KINDS.includes(expression.kind as SimpleSelectionKind);
  const editorId = useId();
  const expressionChildren =
    expression.kind === "and" || expression.kind === "or" || expression.kind === "xor"
      ? expression.expressions
      : [];
  const [childKeyState, dispatchChildKey] = useReducer(
    reduceSelectionClauseKeys,
    { idPrefix: editorId, expressions: expressionChildren },
    initializeSelectionClauseKeys,
  );
  const childKeyEntries = resolveSelectionClauseKeys(childKeyState, expressionChildren).entries;

  return (
    <fieldset className="fm-inspector-field" data-selection-expression-kind={expression.kind}>
      <legend>Selection expression</legend>
      <SelectField
        label="Operator"
        options={OPERATOR_OPTIONS}
        value={editable ? expression.kind : "advanced"}
        onChange={(nextKind) => onChange(defaultExpression(nextKind, objectId, regionId))}
      />
      {expression.kind === "in_object" ? (
        <TextField
          error={expression.object_id.trim() === "" ? "Object ID cannot be empty." : undefined}
          label="Object ID"
          value={expression.object_id}
          onChange={(value) => onChange({ ...expression, object_id: value })}
        />
      ) : null}
      {expression.kind === "in_region" ? (
        <>
          <TextField
            error={expression.object_id.trim() === "" ? "Object ID cannot be empty." : undefined}
            label="Object ID"
            value={expression.object_id}
            onChange={(value) => onChange({ ...expression, object_id: value })}
          />
          <TextField
            error={expression.region_id.trim() === "" ? "Region ID cannot be empty." : undefined}
            label="Region ID"
            value={expression.region_id}
            onChange={(value) => onChange({ ...expression, region_id: value })}
          />
        </>
      ) : null}
      {expression.kind === "ref" ? (
        <TextField
          error={expression.selection_id.trim() === "" ? "Selection ID cannot be empty." : undefined}
          label="Selection ID"
          value={expression.selection_id}
          onChange={(value) => onChange({ ...expression, selection_id: value })}
        />
      ) : null}
      {expression.kind === "and" || expression.kind === "or" || expression.kind === "xor" ? (
        <div className="fm-inspector-panel">
          {expression.expressions.length === 0 ? (
            <p className="fm-inspector-feedback" data-kind="error">
              At least one sub-expression clause is required.
            </p>
          ) : null}
          {childKeyEntries.map(({ expression: child, key }, index) => (
            <div className="fm-inspector-panel" key={key}>
              <SelectionExpressionBuilder
                expression={child}
                objectId={objectId}
                regionId={regionId}
                onChange={(next) => {
                  dispatchChildKey({
                    type: "replace",
                    expressions: expression.expressions,
                    index,
                    expression: next,
                  });
                  onChange({
                    ...expression,
                    expressions: expression.expressions.map((entry, childIndex) =>
                      childIndex === index ? next : entry,
                    ),
                  });
                }}
              />
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  dispatchChildKey({
                    type: "remove",
                    expressions: expression.expressions,
                    index,
                  });
                  onChange({
                    ...expression,
                    expressions: expression.expressions.filter(
                      (_, childIndex) => childIndex !== index,
                    ),
                  });
                }}
              >
                Remove clause
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              const child = defaultTargetExpression(objectId, regionId);
              dispatchChildKey({
                type: "append",
                expressions: expression.expressions,
                expression: child,
              });
              onChange({
                ...expression,
                expressions: [...expression.expressions, child],
              });
            }}
          >
            Add clause
          </Button>
        </div>
      ) : null}
      {expression.kind === "not" ? (
        <SelectionExpressionBuilder
          expression={expression.expression}
          objectId={objectId}
          regionId={regionId}
          onChange={(next) => onChange({ ...expression, expression: next })}
        />
      ) : null}
      {expression.kind === "compare" ? (
        <div className="fm-inspector-panel">
          <ScalarExpressionBuilder
            expression={expression.lhs}
            label="Left value"
            objectId={objectId}
            onChange={(lhs) => onChange({ ...expression, lhs })}
          />
          <SelectField
            label="Comparison"
            options={[
              ["lt", "<"],
              ["le", "\u2264"],
              ["gt", ">"],
              ["ge", "\u2265"],
            ]}
            value={expression.op}
            onChange={(op) => onChange({ ...expression, op: op as typeof expression.op })}
          />
          <ScalarExpressionBuilder
            expression={expression.rhs}
            label="Right value"
            objectId={objectId}
            onChange={(rhs) => onChange({ ...expression, rhs })}
          />
          <ToleranceFields
            tolerance={expression.tolerance ?? { atol: 0, rtol: 0 }}
            onChange={(tolerance) => onChange({ ...expression, tolerance })}
          />
        </div>
      ) : null}
      {expression.kind === "approx" ? (
        <div className="fm-inspector-panel">
          <ScalarExpressionBuilder
            expression={expression.value}
            label="Value"
            objectId={objectId}
            onChange={(value) => onChange({ ...expression, value })}
          />
          <ScalarExpressionBuilder
            expression={expression.target}
            label="Target"
            objectId={objectId}
            onChange={(target) => onChange({ ...expression, target })}
          />
          <NumberField
            label="Absolute tolerance"
            min={0}
            value={expression.atol}
            onChange={(atol) => onChange({ ...expression, atol })}
          />
          <NumberField
            label="Relative tolerance"
            min={0}
            value={expression.rtol}
            onChange={(rtol) => onChange({ ...expression, rtol })}
          />
        </div>
      ) : null}
      {expression.kind === "between" ? (
        <div className="fm-inspector-panel">
          <ScalarExpressionBuilder
            expression={expression.value}
            label="Value"
            objectId={objectId}
            onChange={(value) => onChange({ ...expression, value })}
          />
          <NumberField
            label="Lower bound"
            value={expression.lower}
            onChange={(lower) => onChange({ ...expression, lower })}
          />
          <NumberField
            label="Upper bound"
            value={expression.upper}
            onChange={(upper) => onChange({ ...expression, upper })}
          />
          {expression.lower > expression.upper ? (
            <p className="fm-inspector-feedback" data-kind="error">
              Lower bound cannot exceed upper bound.
            </p>
          ) : null}
          <SelectField
            label="Closed interval"
            options={[
              ["none", "Open"],
              ["left", "Closed left"],
              ["right", "Closed right"],
              ["both", "Closed both"],
            ]}
            value={expression.closed}
            onChange={(closed) =>
              onChange({ ...expression, closed: closed as typeof expression.closed })
            }
          />
        </div>
      ) : null}
      {expression.kind === "inside_geometry" ? (
        <div className="fm-inspector-panel">
          <SelectField
            label="Frame"
            options={[
              ["world", "World"],
              ["object", "Object"],
            ]}
            value={expression.frame.kind}
            onChange={(kind) =>
              onChange({
                ...expression,
                frame:
                  kind === "object" ? { kind, object_id: objectId } : { kind: "world" },
              })
            }
          />
          {expression.frame.kind === "object" ? (
            <TextField
              error={
                expression.frame.object_id.trim() === ""
                  ? "Frame object ID cannot be empty."
                  : undefined
              }
              label="Frame object ID"
              value={expression.frame.object_id}
              onChange={(object_id) =>
                onChange({ ...expression, frame: { kind: "object", object_id } })
              }
            />
          ) : null}
          <GeometryPredicateBuilder
            geometry={expression.geometry}
            onChange={(geometry) => onChange({ ...expression, geometry })}
          />
          <SelectField
            label="Boundary"
            options={[
              ["inclusive", "Inclusive"],
              ["exclusive", "Exclusive"],
            ]}
            value={expression.boundary.kind}
            onChange={(kind) =>
              onChange({
                ...expression,
                boundary: {
                  ...expression.boundary,
                  kind: kind as typeof expression.boundary.kind,
                },
              })
            }
          />
          <NumberField
            label="Boundary absolute tolerance (m)"
            min={0}
            value={expression.boundary.absolute_tolerance_m}
            onChange={(absolute_tolerance_m) =>
              onChange({
                ...expression,
                boundary: { ...expression.boundary, absolute_tolerance_m },
              })
            }
          />
          <NumberField
            label="Boundary relative tolerance"
            min={0}
            value={expression.boundary.relative_tolerance}
            onChange={(relative_tolerance) =>
              onChange({
                ...expression,
                boundary: { ...expression.boundary, relative_tolerance },
              })
            }
          />
        </div>
      ) : null}
    </fieldset>
  );
}

function TextField({
  error,
  label,
  onChange,
  value,
}: {
  error?: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const errorId = useId();
  return (
    <div className="fm-inspector-field-wrapper">
      <label className="fm-inspector-field">
        <span>{label}</span>
        <Input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          className={error ? "fm-inspector-input--invalid" : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {error ? (
        <p className="fm-inspector-feedback" data-kind="error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NumberField({
  error: externalError,
  label,
  max,
  min,
  onChange,
  value,
}: {
  error?: string;
  label: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  value: number;
}) {
  const [draft, setDraft] = useState(() => ({
    internalError: null as string | null,
    sourceValue: value,
    text: String(value),
  }));
  if (draft.sourceValue !== value) {
    setDraft({ internalError: null, sourceValue: value, text: String(value) });
  }

  function handleChange(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      setDraft({
        internalError: "Value cannot be empty.",
        sourceValue: value,
        text: raw,
      });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft({
        internalError: "Must be a valid finite number.",
        sourceValue: value,
        text: raw,
      });
      return;
    }
    if (min !== undefined && parsed < min) {
      setDraft({
        internalError: `Must be at least ${min}.`,
        sourceValue: value,
        text: raw,
      });
      return;
    }
    if (max !== undefined && parsed > max) {
      setDraft({
        internalError: `Must be at most ${max}.`,
        sourceValue: value,
        text: raw,
      });
      return;
    }
    setDraft({ internalError: null, sourceValue: value, text: raw });
    onChange(parsed);
  }

  const effectiveError = externalError ?? draft.internalError;
  const errorId = useId();

  return (
    <div className="fm-inspector-field-wrapper">
      <label className="fm-inspector-field">
        <span>{label}</span>
        <Input
          aria-describedby={effectiveError ? errorId : undefined}
          aria-invalid={effectiveError ? true : undefined}
          className={effectiveError ? "fm-inspector-input--invalid" : undefined}
          type="number"
          value={draft.text}
          onChange={(event) => handleChange(event.target.value)}
        />
      </label>
      {effectiveError ? (
        <p className="fm-inspector-feedback" data-kind="error" id={errorId}>
          {effectiveError}
        </p>
      ) : null}
    </div>
  );
}

function SelectField({
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
  const activeTitle = options.find(([opt]) => opt === value)?.[1] ?? value;
  return (
    <div className="fm-inspector-field">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} density="compact">
          <SelectValue placeholder={activeTitle}>{activeTitle}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(([option, title]) => (
            <SelectItem key={option} value={option}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function VectorField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: number[]) => void;
  value: number[];
}) {
  return (
    <TextField
      label={label}
      value={value.join(", ")}
      onChange={(raw) => {
        const parsed = raw
          .split(",")
          .map((entry) => Number(entry.trim()))
          .filter(Number.isFinite);
        if (parsed.length > 0) {
          onChange(parsed);
        }
      }}
    />
  );
}

function ToleranceFields({
  onChange,
  tolerance,
}: {
  onChange: (value: { atol: number; rtol: number }) => void;
  tolerance: { atol: number; rtol: number };
}) {
  return (
    <>
      <NumberField
        label="Absolute tolerance"
        min={0}
        value={tolerance.atol}
        onChange={(atol) => onChange({ ...tolerance, atol })}
      />
      <NumberField
        label="Relative tolerance"
        min={0}
        value={tolerance.rtol}
        onChange={(rtol) => onChange({ ...tolerance, rtol })}
      />
    </>
  );
}

function ScalarExpressionBuilder({
  expression,
  label,
  objectId,
  onChange,
}: {
  expression: SelectionScalarExpression;
  label: string;
  objectId: string;
  onChange: (expression: SelectionScalarExpression) => void;
}) {
  return (
    <fieldset className="fm-inspector-field" data-selection-scalar-kind={expression.kind}>
      <legend>{label}</legend>
      <SelectField
        label="Scalar kind"
        options={[
          ["constant", "Constant"],
          ["coordinate", "Coordinate"],
          ["magnetization_component", "Magnetization component"],
          ["magnetization_norm", "Magnetization norm"],
          ["magnetization_dot", "Magnetization dot axis"],
          ["abs", "Absolute value"],
        ]}
        value={expression.kind}
        onChange={(kind) => onChange(defaultScalarExpression(kind, objectId))}
      />
      {expression.kind === "constant" ? (
        <NumberField
          label="Value"
          value={expression.value}
          onChange={(value) => onChange({ ...expression, value })}
        />
      ) : null}
      {expression.kind === "coordinate" ? (
        <>
          <SelectField
            label="Component"
            options={[
              ["x", "x"],
              ["y", "y"],
              ["z", "z"],
            ]}
            value={expression.component}
            onChange={(component) =>
              onChange({ ...expression, component: component as typeof expression.component })
            }
          />
          <SelectField
            label="Frame"
            options={[
              ["world", "World"],
              ["object", "Object"],
            ]}
            value={expression.frame.kind}
            onChange={(kind) =>
              onChange({
                ...expression,
                frame: kind === "object" ? { kind, object_id: objectId } : { kind: "world" },
              })
            }
          />
          {expression.frame.kind === "object" ? (
            <TextField
              label="Frame object ID"
              value={expression.frame.object_id}
              onChange={(object_id) =>
                onChange({ ...expression, frame: { kind: "object", object_id } })
              }
            />
          ) : null}
        </>
      ) : null}
      {expression.kind === "magnetization_component" ? (
        <SelectField
          label="Component"
          options={[
            ["x", "x"],
            ["y", "y"],
            ["z", "z"],
          ]}
          value={expression.component}
          onChange={(component) =>
            onChange({ ...expression, component: component as typeof expression.component })
          }
        />
      ) : null}
      {expression.kind === "magnetization_dot" ? (
        <VectorField
          label="Axis"
          value={expression.axis}
          onChange={(axis) => onChange({ ...expression, axis })}
        />
      ) : null}
      {expression.kind === "abs" ? (
        <ScalarExpressionBuilder
          expression={expression.value}
          label="Absolute value input"
          objectId={objectId}
          onChange={(value) => onChange({ ...expression, value })}
        />
      ) : null}
    </fieldset>
  );
}

function GeometryPredicateBuilder({
  geometry,
  onChange,
}: {
  geometry: SelectionGeometryPredicate;
  onChange: (geometry: SelectionGeometryPredicate) => void;
}) {
  const binary =
    geometry.kind === "union" || geometry.kind === "intersection" || geometry.kind === "xor";
  return (
    <fieldset className="fm-inspector-field" data-selection-geometry-kind={geometry.kind}>
      <legend>Geometry predicate</legend>
      <SelectField
        label="Geometry kind"
        options={[
          ["box", "Box"],
          ["sphere", "Sphere"],
          ["cylinder", "Cylinder"],
          ["ellipsoid", "Ellipsoid"],
          ["imported_solid", "Imported solid"],
          ["union", "Union"],
          ["intersection", "Intersection"],
          ["difference", "Difference"],
          ["xor", "XOR"],
          ["complement", "Complement"],
          ["affine", "Affine transform"],
        ]}
        value={geometry.kind}
        onChange={(kind) => onChange(defaultGeometryPredicate(kind))}
      />
      {geometry.kind === "box" ? (
        <>
          <VectorField
            label="Center (m)"
            value={geometry.center_m}
            onChange={(center_m) => onChange({ ...geometry, center_m })}
          />
          <VectorField
            label="Size (m)"
            value={geometry.size_m}
            onChange={(size_m) => onChange({ ...geometry, size_m })}
          />
        </>
      ) : null}
      {geometry.kind === "sphere" ? (
        <>
          <VectorField
            label="Center (m)"
            value={geometry.center_m}
            onChange={(center_m) => onChange({ ...geometry, center_m })}
          />
          <NumberField
            label="Radius (m)"
            value={geometry.radius_m}
            onChange={(radius_m) => onChange({ ...geometry, radius_m })}
          />
        </>
      ) : null}
      {geometry.kind === "cylinder" ? (
        <>
          <VectorField
            label="Center (m)"
            value={geometry.center_m}
            onChange={(center_m) => onChange({ ...geometry, center_m })}
          />
          <VectorField
            label="Axis"
            value={geometry.axis}
            onChange={(axis) => onChange({ ...geometry, axis })}
          />
          <NumberField
            label="Radius (m)"
            value={geometry.radius_m}
            onChange={(radius_m) => onChange({ ...geometry, radius_m })}
          />
          <NumberField
            label="Height (m)"
            value={geometry.height_m}
            onChange={(height_m) => onChange({ ...geometry, height_m })}
          />
        </>
      ) : null}
      {geometry.kind === "ellipsoid" ? (
        <>
          <VectorField
            label="Center (m)"
            value={geometry.center_m}
            onChange={(center_m) => onChange({ ...geometry, center_m })}
          />
          <VectorField
            label="Radii (m)"
            value={geometry.radii_m}
            onChange={(radii_m) => onChange({ ...geometry, radii_m })}
          />
        </>
      ) : null}
      {geometry.kind === "imported_solid" ? (
        <TextField
          label="Asset ID"
          value={geometry.asset_id}
          onChange={(asset_id) => onChange({ ...geometry, asset_id })}
        />
      ) : null}
      {binary ? (
        <>
          <GeometryPredicateBuilder
            geometry={geometry.a}
            onChange={(a) => onChange({ ...geometry, a })}
          />
          <GeometryPredicateBuilder
            geometry={geometry.b}
            onChange={(b) => onChange({ ...geometry, b })}
          />
        </>
      ) : null}
      {geometry.kind === "difference" ? (
        <>
          <GeometryPredicateBuilder
            geometry={geometry.base}
            onChange={(base) => onChange({ ...geometry, base })}
          />
          <GeometryPredicateBuilder
            geometry={geometry.tool}
            onChange={(tool) => onChange({ ...geometry, tool })}
          />
        </>
      ) : null}
      {geometry.kind === "complement" ? (
        <>
          <GeometryPredicateBuilder
            geometry={geometry.geometry}
            onChange={(next) => onChange({ ...geometry, geometry: next })}
          />
          <GeometryPredicateBuilder
            geometry={geometry.domain}
            onChange={(domain) => onChange({ ...geometry, domain })}
          />
        </>
      ) : null}
      {geometry.kind === "affine" ? (
        <>
          <GeometryPredicateBuilder
            geometry={geometry.geometry}
            onChange={(next) => onChange({ ...geometry, geometry: next })}
          />
          <VectorField
            label="Translation (m)"
            value={geometry.translation_m}
            onChange={(translation_m) => onChange({ ...geometry, translation_m })}
          />
          <VectorField
            label="Rotation xyzw"
            value={geometry.rotation_xyzw}
            onChange={(rotation_xyzw) => onChange({ ...geometry, rotation_xyzw })}
          />
          <VectorField
            label="Scale"
            value={geometry.scale}
            onChange={(scale) => onChange({ ...geometry, scale })}
          />
          <VectorField
            label="Pivot (m)"
            value={geometry.pivot_m}
            onChange={(pivot_m) => onChange({ ...geometry, pivot_m })}
          />
        </>
      ) : null}
    </fieldset>
  );
}

function defaultScalarExpression(kind: string, objectId: string): SelectionScalarExpression {
  if (kind === "coordinate") {
    return { kind, component: "x", frame: { kind: "object", object_id: objectId } };
  }
  if (kind === "magnetization_component") return { kind, component: "x" };
  if (kind === "magnetization_norm") return { kind };
  if (kind === "magnetization_dot") return { kind, axis: [1, 0, 0] };
  if (kind === "abs") return { kind, value: { kind: "constant", value: 0 } };
  return { kind: "constant", value: 0 };
}

function defaultGeometryPredicate(kind: string): SelectionGeometryPredicate {
  const box: SelectionGeometryPredicate = { kind: "box", center_m: [0, 0, 0], size_m: [1, 1, 1] };
  if (kind === "sphere") return { kind, center_m: [0, 0, 0], radius_m: 1 };
  if (kind === "cylinder") {
    return { kind, axis: [0, 0, 1], center_m: [0, 0, 0], height_m: 1, radius_m: 1 };
  }
  if (kind === "ellipsoid") return { kind, center_m: [0, 0, 0], radii_m: [1, 1, 1] };
  if (kind === "imported_solid") return { kind, asset_id: "asset" };
  if (kind === "union" || kind === "intersection" || kind === "xor") {
    return { kind, a: box, b: box };
  }
  if (kind === "difference") return { kind, base: box, tool: box };
  if (kind === "complement") return { kind, geometry: box, domain: box };
  if (kind === "affine") {
    return {
      kind,
      geometry: box,
      pivot_m: [0, 0, 0],
      rotation_xyzw: [0, 0, 0, 1],
      scale: [1, 1, 1],
      translation_m: [0, 0, 0],
    };
  }
  return box;
}

function defaultTargetExpression(
  objectId: string,
  regionId?: string | null,
): FrozenSpinsSelectionExpression {
  return regionId
    ? { kind: "in_region", object_id: objectId, region_id: regionId }
    : { kind: "in_object", object_id: objectId };
}

function defaultExpression(
  kind: string,
  objectId: string,
  regionId?: string | null,
): FrozenSpinsSelectionExpression {
  if (kind === "all_magnetic") return { kind };
  if (kind === "in_object") return { kind, object_id: objectId };
  if (kind === "in_region") {
    return { kind, object_id: objectId, region_id: regionId ?? "region" };
  }
  if (kind === "ref") return { kind, selection_id: "selection" };
  if (kind === "and" || kind === "or" || kind === "xor") {
    return { kind, expressions: [defaultTargetExpression(objectId, regionId)] };
  }
  if (kind === "not") {
    return { kind, expression: defaultTargetExpression(objectId, regionId) };
  }
  if (kind === "inside_geometry") {
    return {
      boundary: { absolute_tolerance_m: 0, kind: "inclusive", relative_tolerance: 0 },
      frame: { kind: "world" },
      geometry: defaultGeometryPredicate("box"),
      kind,
      sampling: { kind: "dof_point" },
    };
  }
  if (kind === "compare") {
    return {
      kind,
      lhs: defaultScalarExpression("coordinate", objectId),
      op: "ge",
      rhs: defaultScalarExpression("constant", objectId),
      tolerance: { atol: 0, rtol: 0 },
    };
  }
  if (kind === "approx") {
    return {
      atol: 0,
      kind,
      rtol: 0,
      target: defaultScalarExpression("constant", objectId),
      value: defaultScalarExpression("magnetization_component", objectId),
    };
  }
  if (kind === "between") {
    return {
      closed: "both",
      kind,
      lower: 0,
      upper: 1,
      value: defaultScalarExpression("coordinate", objectId),
    };
  }
  return defaultTargetExpression(objectId, regionId);
}
