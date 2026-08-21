"use client";

import type {
  FrozenSpinsSelectionExpression,
  SelectionGeometryPredicate,
  SelectionScalarExpression,
} from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";

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

export function SelectionExpressionBuilder({
  expression,
  objectId,
  regionId,
  onChange,
}: SelectionExpressionBuilderProps) {
  const editable = SIMPLE_KINDS.includes(expression.kind as SimpleSelectionKind);
  return (
    <fieldset className="fm-inspector-field" data-selection-expression-kind={expression.kind}>
      <legend>Selection expression</legend>
      <label className="fm-inspector-field">
        <span>Operator</span>
        <select
          className="fm-inspector-input"
          value={editable ? expression.kind : "advanced"}
          onChange={(event) =>
            onChange(defaultExpression(event.target.value, objectId, regionId))
          }
        >
          <option value="all_magnetic">All magnetic DOFs</option>
          <option value="in_object">In object</option>
          <option value="in_region">In region</option>
          <option value="ref">Named selection</option>
          <option value="and">All expressions (AND)</option>
          <option value="or">Any expression (OR)</option>
          <option value="xor">Exactly one expression (XOR)</option>
          <option value="not">Negation (NOT)</option>
          <option value="inside_geometry">Inside geometry</option>
          <option value="compare">Scalar comparison</option>
          <option value="approx">Approximate scalar equality</option>
          <option value="between">Scalar interval</option>
        </select>
      </label>
      {expression.kind === "in_object" ? (
        <TextField
          label="Object ID"
          value={expression.object_id}
          onChange={(value) => onChange({ ...expression, object_id: value })}
        />
      ) : null}
      {expression.kind === "in_region" ? (
        <>
          <TextField
            label="Object ID"
            value={expression.object_id}
            onChange={(value) => onChange({ ...expression, object_id: value })}
          />
          <TextField
            label="Region ID"
            value={expression.region_id}
            onChange={(value) => onChange({ ...expression, region_id: value })}
          />
        </>
      ) : null}
      {expression.kind === "ref" ? (
        <TextField
          label="Selection ID"
          value={expression.selection_id}
          onChange={(value) => onChange({ ...expression, selection_id: value })}
        />
      ) : null}
      {expression.kind === "and" || expression.kind === "or" || expression.kind === "xor" ? (
        <div className="fm-inspector-panel">
          {expression.expressions.map((child, index) => (
            <div className="fm-inspector-panel" key={index}>
              <SelectionExpressionBuilder
                expression={child}
                objectId={objectId}
                regionId={regionId}
                onChange={(next) =>
                  onChange({
                    ...expression,
                    expressions: expression.expressions.map((entry, childIndex) =>
                      childIndex === index ? next : entry,
                    ),
                  })
                }
              />
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...expression,
                    expressions: expression.expressions.filter(
                      (_, childIndex) => childIndex !== index,
                    ),
                  })
                }
              >
                Remove clause
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() =>
              onChange({
                ...expression,
                expressions: [
                  ...expression.expressions,
                  defaultTargetExpression(objectId, regionId),
                ],
              })
            }
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
        <div className="fm-inspector-panel grid gap-2">
          <ScalarExpressionBuilder
            label="Left value"
            expression={expression.lhs}
            objectId={objectId}
            onChange={(lhs) => onChange({ ...expression, lhs })}
          />
          <SelectField
            label="Comparison"
            value={expression.op}
            options={[["lt", "<"], ["le", "≤"], ["gt", ">"], ["ge", "≥"]]}
            onChange={(op) => onChange({ ...expression, op: op as typeof expression.op })}
          />
          <ScalarExpressionBuilder
            label="Right value"
            expression={expression.rhs}
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
        <div className="fm-inspector-panel grid gap-2">
          <ScalarExpressionBuilder label="Value" expression={expression.value} objectId={objectId} onChange={(value) => onChange({ ...expression, value })} />
          <ScalarExpressionBuilder label="Target" expression={expression.target} objectId={objectId} onChange={(target) => onChange({ ...expression, target })} />
          <NumberField label="Absolute tolerance" value={expression.atol} onChange={(atol) => onChange({ ...expression, atol })} />
          <NumberField label="Relative tolerance" value={expression.rtol} onChange={(rtol) => onChange({ ...expression, rtol })} />
        </div>
      ) : null}
      {expression.kind === "between" ? (
        <div className="fm-inspector-panel grid gap-2">
          <ScalarExpressionBuilder label="Value" expression={expression.value} objectId={objectId} onChange={(value) => onChange({ ...expression, value })} />
          <NumberField label="Lower bound" value={expression.lower} onChange={(lower) => onChange({ ...expression, lower })} />
          <NumberField label="Upper bound" value={expression.upper} onChange={(upper) => onChange({ ...expression, upper })} />
          <SelectField label="Closed interval" value={expression.closed} options={[["none", "Open"], ["left", "Closed left"], ["right", "Closed right"], ["both", "Closed both"]]} onChange={(closed) => onChange({ ...expression, closed: closed as typeof expression.closed })} />
        </div>
      ) : null}
      {expression.kind === "inside_geometry" ? (
        <div className="fm-inspector-panel grid gap-2">
          <SelectField
            label="Frame"
            value={expression.frame.kind}
            options={[["world", "World"], ["object", "Object"]]}
            onChange={(kind) => onChange({ ...expression, frame: kind === "object" ? { kind, object_id: objectId } : { kind: "world" } })}
          />
          {expression.frame.kind === "object" ? (
            <TextField label="Frame object ID" value={expression.frame.object_id} onChange={(object_id) => onChange({ ...expression, frame: { kind: "object", object_id } })} />
          ) : null}
          <GeometryPredicateBuilder geometry={expression.geometry} onChange={(geometry) => onChange({ ...expression, geometry })} />
          <SelectField label="Boundary" value={expression.boundary.kind} options={[["inclusive", "Inclusive"], ["exclusive", "Exclusive"]]} onChange={(kind) => onChange({ ...expression, boundary: { ...expression.boundary, kind: kind as typeof expression.boundary.kind } })} />
          <NumberField label="Boundary absolute tolerance (m)" value={expression.boundary.absolute_tolerance_m} onChange={(absolute_tolerance_m) => onChange({ ...expression, boundary: { ...expression.boundary, absolute_tolerance_m } })} />
          <NumberField label="Boundary relative tolerance" value={expression.boundary.relative_tolerance} onChange={(relative_tolerance) => onChange({ ...expression, boundary: { ...expression.boundary, relative_tolerance } })} />
        </div>
      ) : null}
    </fieldset>
  );
}

function TextField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <input
        className="fm-inspector-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <input
        className="fm-inspector-input"
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
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
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <select className="fm-inspector-input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([option, title]) => <option key={option} value={option}>{title}</option>)}
      </select>
    </label>
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
      onChange={(raw) =>
        onChange(raw.split(",").map((entry) => Number(entry.trim())).filter(Number.isFinite))
      }
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
      <NumberField label="Absolute tolerance" value={tolerance.atol} onChange={(atol) => onChange({ ...tolerance, atol })} />
      <NumberField label="Relative tolerance" value={tolerance.rtol} onChange={(rtol) => onChange({ ...tolerance, rtol })} />
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
        value={expression.kind}
        options={[["constant", "Constant"], ["coordinate", "Coordinate"], ["magnetization_component", "Magnetization component"], ["magnetization_norm", "Magnetization norm"], ["magnetization_dot", "Magnetization dot axis"], ["abs", "Absolute value"]]}
        onChange={(kind) => onChange(defaultScalarExpression(kind, objectId))}
      />
      {expression.kind === "constant" ? <NumberField label="Value" value={expression.value} onChange={(value) => onChange({ ...expression, value })} /> : null}
      {expression.kind === "coordinate" ? (
        <>
          <SelectField label="Component" value={expression.component} options={[["x", "x"], ["y", "y"], ["z", "z"]]} onChange={(component) => onChange({ ...expression, component: component as typeof expression.component })} />
          <SelectField label="Frame" value={expression.frame.kind} options={[["world", "World"], ["object", "Object"]]} onChange={(kind) => onChange({ ...expression, frame: kind === "object" ? { kind, object_id: objectId } : { kind: "world" } })} />
          {expression.frame.kind === "object" ? <TextField label="Frame object ID" value={expression.frame.object_id} onChange={(object_id) => onChange({ ...expression, frame: { kind: "object", object_id } })} /> : null}
        </>
      ) : null}
      {expression.kind === "magnetization_component" ? <SelectField label="Component" value={expression.component} options={[["x", "x"], ["y", "y"], ["z", "z"]]} onChange={(component) => onChange({ ...expression, component: component as typeof expression.component })} /> : null}
      {expression.kind === "magnetization_dot" ? <VectorField label="Axis" value={expression.axis} onChange={(axis) => onChange({ ...expression, axis })} /> : null}
      {expression.kind === "abs" ? <ScalarExpressionBuilder label="Absolute value input" expression={expression.value} objectId={objectId} onChange={(value) => onChange({ ...expression, value })} /> : null}
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
  const binary = geometry.kind === "union" || geometry.kind === "intersection" || geometry.kind === "xor";
  return (
    <fieldset className="fm-inspector-field" data-selection-geometry-kind={geometry.kind}>
      <legend>Geometry predicate</legend>
      <SelectField
        label="Geometry kind"
        value={geometry.kind}
        options={[["box", "Box"], ["sphere", "Sphere"], ["cylinder", "Cylinder"], ["ellipsoid", "Ellipsoid"], ["imported_solid", "Imported solid"], ["union", "Union"], ["intersection", "Intersection"], ["difference", "Difference"], ["xor", "XOR"], ["complement", "Complement"], ["affine", "Affine transform"]]}
        onChange={(kind) => onChange(defaultGeometryPredicate(kind))}
      />
      {geometry.kind === "box" ? <><VectorField label="Center (m)" value={geometry.center_m} onChange={(center_m) => onChange({ ...geometry, center_m })} /><VectorField label="Size (m)" value={geometry.size_m} onChange={(size_m) => onChange({ ...geometry, size_m })} /></> : null}
      {geometry.kind === "sphere" ? <><VectorField label="Center (m)" value={geometry.center_m} onChange={(center_m) => onChange({ ...geometry, center_m })} /><NumberField label="Radius (m)" value={geometry.radius_m} onChange={(radius_m) => onChange({ ...geometry, radius_m })} /></> : null}
      {geometry.kind === "cylinder" ? <><VectorField label="Center (m)" value={geometry.center_m} onChange={(center_m) => onChange({ ...geometry, center_m })} /><VectorField label="Axis" value={geometry.axis} onChange={(axis) => onChange({ ...geometry, axis })} /><NumberField label="Radius (m)" value={geometry.radius_m} onChange={(radius_m) => onChange({ ...geometry, radius_m })} /><NumberField label="Height (m)" value={geometry.height_m} onChange={(height_m) => onChange({ ...geometry, height_m })} /></> : null}
      {geometry.kind === "ellipsoid" ? <><VectorField label="Center (m)" value={geometry.center_m} onChange={(center_m) => onChange({ ...geometry, center_m })} /><VectorField label="Radii (m)" value={geometry.radii_m} onChange={(radii_m) => onChange({ ...geometry, radii_m })} /></> : null}
      {geometry.kind === "imported_solid" ? <TextField label="Asset ID" value={geometry.asset_id} onChange={(asset_id) => onChange({ ...geometry, asset_id })} /> : null}
      {binary ? <><GeometryPredicateBuilder geometry={geometry.a} onChange={(a) => onChange({ ...geometry, a })} /><GeometryPredicateBuilder geometry={geometry.b} onChange={(b) => onChange({ ...geometry, b })} /></> : null}
      {geometry.kind === "difference" ? <><GeometryPredicateBuilder geometry={geometry.base} onChange={(base) => onChange({ ...geometry, base })} /><GeometryPredicateBuilder geometry={geometry.tool} onChange={(tool) => onChange({ ...geometry, tool })} /></> : null}
      {geometry.kind === "complement" ? <><GeometryPredicateBuilder geometry={geometry.geometry} onChange={(next) => onChange({ ...geometry, geometry: next })} /><GeometryPredicateBuilder geometry={geometry.domain} onChange={(domain) => onChange({ ...geometry, domain })} /></> : null}
      {geometry.kind === "affine" ? <><GeometryPredicateBuilder geometry={geometry.geometry} onChange={(next) => onChange({ ...geometry, geometry: next })} /><VectorField label="Translation (m)" value={geometry.translation_m} onChange={(translation_m) => onChange({ ...geometry, translation_m })} /><VectorField label="Rotation xyzw" value={geometry.rotation_xyzw} onChange={(rotation_xyzw) => onChange({ ...geometry, rotation_xyzw })} /><VectorField label="Scale" value={geometry.scale} onChange={(scale) => onChange({ ...geometry, scale })} /><VectorField label="Pivot (m)" value={geometry.pivot_m} onChange={(pivot_m) => onChange({ ...geometry, pivot_m })} /></> : null}
    </fieldset>
  );
}

function defaultScalarExpression(kind: string, objectId: string): SelectionScalarExpression {
  if (kind === "coordinate") return { kind, component: "x", frame: { kind: "object", object_id: objectId } };
  if (kind === "magnetization_component") return { kind, component: "x" };
  if (kind === "magnetization_norm") return { kind };
  if (kind === "magnetization_dot") return { kind, axis: [1, 0, 0] };
  if (kind === "abs") return { kind, value: { kind: "constant", value: 0 } };
  return { kind: "constant", value: 0 };
}

function defaultGeometryPredicate(kind: string): SelectionGeometryPredicate {
  const box: SelectionGeometryPredicate = { kind: "box", center_m: [0, 0, 0], size_m: [1, 1, 1] };
  if (kind === "sphere") return { kind, center_m: [0, 0, 0], radius_m: 1 };
  if (kind === "cylinder") return { kind, axis: [0, 0, 1], center_m: [0, 0, 0], height_m: 1, radius_m: 1 };
  if (kind === "ellipsoid") return { kind, center_m: [0, 0, 0], radii_m: [1, 1, 1] };
  if (kind === "imported_solid") return { kind, asset_id: "asset" };
  if (kind === "union" || kind === "intersection" || kind === "xor") return { kind, a: box, b: box };
  if (kind === "difference") return { kind, base: box, tool: box };
  if (kind === "complement") return { kind, geometry: box, domain: box };
  if (kind === "affine") return { kind, geometry: box, pivot_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1], scale: [1, 1, 1], translation_m: [0, 0, 0] };
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
