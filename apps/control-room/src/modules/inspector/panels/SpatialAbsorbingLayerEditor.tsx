import { Button } from "@/shared/ui/Button";
import { FormField } from "../primitives/FormField";
import { Vector3Field } from "../primitives/Vector3Field";
import {
  ABSORBING_BOUNDARY_FACES,
  ABSORBING_BOUNDARY_FRAMES,
  ABSORBING_BOUNDARY_PROFILES,
  type GeometryKind,
  type LayerDraft,
  type VectorDraft,
} from "./ObjectAbsorbingBoundaryPanelModel";

const geometries: Record<GeometryKind, string> = {
  faces: "Object faces", plane: "Plane", cylinder: "Cylinder", sphere: "Sphere",
  region_boundary: "Region boundary", expression: "Distance expression",
};

export interface BoundaryRegionOption {
  id: string;
  label: string;
}

export function SpatialAbsorbingLayerEditor({
  draft, update, fieldError, regions,
}: {
  draft: LayerDraft;
  update: (patch: Partial<LayerDraft>) => void;
  fieldError: (field: keyof LayerDraft) => string | undefined;
  regions: BoundaryRegionOption[];
}) {
  const { kind } = draft;
  const radial = kind === "cylinder" || kind === "sphere";
  const orientationLabel = kind === "plane" ? "Normal" : "Axis";
  const total = Number(draft.totalWidth);
  const ramp = Number(draft.rampWidth);
  const plateau = total - ramp;
  const validWidths = Number.isFinite(total) && Number.isFinite(ramp) && ramp > 0 && ramp <= total;
  function vectorField(key: "point" | "orientation", label: string) {
    const error = fieldError(key);
    return <Vector3Field
      label={label} values={draft[key]} unit={key === "point" ? "m" : undefined}
      errors={error ? [error] : undefined}
      onChange={(index, value) => {
        const next: VectorDraft = [...draft[key]];
        next[index] = value;
        update({ [key]: next });
      }}
    />;
  }
  function regionOptions(current: string) {
    return <>
      {current && !regions.some(option => option.id === current) && <option value={current}>Missing region ({current})</option>}
      {regions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </>;
  }
  return (
    <>
      <FormField label="Layer name" value={draft.name} error={fieldError("name")}
        onChange={event => update({ name: event.target.value })} />
      <FormField label="Layer enabled" type="checkbox" checked={draft.enabled}
        onChange={event => update({ enabled: event.target.checked })} />
      <FormField label="Target material" type="select" value={draft.region} error={fieldError("region")}
        hint="Limits this layer to the selected magnetic material."
        onChange={event => update({ region: event.target.value })}>
        <option value="">Whole magnetic object</option>
        {regionOptions(draft.region)}
      </FormField>
      <FormField label="Geometry" type="select" value={kind}
        onChange={event => update({ kind: event.target.value as GeometryKind })}>
        {Object.entries(geometries).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </FormField>
      {kind === "faces" && <fieldset className="fm-inspector-form-field">
        <legend>Faces</legend>
        {ABSORBING_BOUNDARY_FACES.map((face, index) => (
          <FormField key={face} label={face} type="checkbox" checked={draft.faces.includes(face)}
            error={index === 0 ? fieldError("faces") : undefined}
            onChange={event => update({ faces: event.target.checked
              ? [...draft.faces, face] : draft.faces.filter(value => value !== face) })} />
        ))}
      </fieldset>}
      {(kind === "plane" || radial) && vectorField("point", kind === "plane" ? "Origin" : "Center")}
      {(kind === "plane" || kind === "cylinder") && vectorField("orientation", orientationLabel)}
      {kind === "plane" && <>
        <p className="fm-inspector-form-field__hint">Damping increases along the normal toward the plane.</p>
        <Button type="button" variant="ghost" onClick={() => {
          const reversed: VectorDraft = [...draft.orientation];
          draft.orientation.forEach((v, index) => { if (v.trim() && Number.isFinite(Number(v))) reversed[index] = String(-Number(v)); });
          update({ orientation: reversed });
        }}>Reverse normal</Button>
      </>}
      {radial && <>
        <FormField label="Boundary radius" type="number" unit="m" value={draft.radius} error={fieldError("radius")}
          onChange={event => update({ radius: event.target.value })} />
        <FormField label="Damping increases" type="select" value={draft.direction}
          onChange={event => update({ direction: event.target.value as LayerDraft["direction"] })}>
          <option value="outward">Outward toward the radius</option>
          <option value="inward">Inward toward the radius</option>
        </FormField>
      </>}
      {kind === "region_boundary" && <FormField label="Boundary of region" type="select"
        value={draft.boundaryRegion} error={fieldError("boundaryRegion")}
        help="Follows the full region surface, including cylinder end caps. For only the rim of a thin film, choose Cylinder with its axis along the film normal. For a custom contour, choose Distance expression."
        hint={regions.length ? "Measures inward distance in the selected region’s own coordinate frame." : "Create a region under this object’s Regions node to use its boundary."}
        onChange={event => update({ boundaryRegion: event.target.value })}>
        <option value="">Select a region</option>
        {regionOptions(draft.boundaryRegion)}
      </FormField>}
      {kind === "expression" && <FormField label="Distance d(x,y,z)" type="text" mono unit="m"
        value={draft.distanceExpression} error={fieldError("distanceExpression")} maxLength={256}
        placeholder="5e-7 - sqrt(x**2 + y**2)"
        help="Use x, y, z in the selected frame, arithmetic, powers (**), abs, sqrt, exp, log, log1p, tanh, sin, cos, min(a,b), and max(a,b). For a lateral boundary in a thin film, use an in-plane distance."
        hint="Coordinates and distance are in metres. The layer occupies 0 ≤ d ≤ total width, with maximum damping at d = 0."
        onChange={event => update({ distanceExpression: event.target.value })} />}
      <FormField
        label="Total width"
        error={fieldError("totalWidth")}
        type="number"
        unit="m"
        value={draft.totalWidth}
        onChange={(event) => update({ totalWidth: event.target.value })}
      />
      <FormField
        label="Ramp width"
        error={fieldError("rampWidth")}
        hint={validWidths
          ? "Plateau width " + Number(plateau.toPrecision(6)) + " m (" + Number((plateau * 1e9).toPrecision(6)) + " nm)" : undefined}
        type="number"
        unit="m"
        value={draft.rampWidth}
        onChange={(event) => update({ rampWidth: event.target.value })}
      />
      <FormField
        label="Maximum damping"
        hint="Added to the local material damping. The largest layer contribution wins where layers overlap."
        error={fieldError("maxDamping")}
        type="number"
        value={draft.maxDamping}
        onChange={(event) => update({ maxDamping: event.target.value })}
      />
      <FormField
        label="Profile"
        error={fieldError("profile")}
        type="select"
        value={draft.profile}
        onChange={(event) => update({ profile: event.target.value })}
      >
        {ABSORBING_BOUNDARY_PROFILES.map((profile) => (
          <option key={profile} value={profile}>{profile}</option>
        ))}
      </FormField>
      {draft.profile === "custom" ? (
        <FormField
          label="Expression"
          error={fieldError("expression")}
          type="text"
          mono
          value={draft.expression}
          maxLength={256}
          placeholder="u**3"
          hint="u runs from 0 at the start of the ramp to 1 at the plateau."
          help="Use u, decimal numbers, +, -, *, /, **, parentheses, and abs, sqrt, exp, log, log1p, tanh, sin, or cos. The result must stay in [0, 1] and equal 0 and 1 at the respective endpoints."
          onChange={(event) => update({ expression: event.target.value })}
        />
      ) : null}
      {kind !== "region_boundary" && <FormField
        label="Frame"
        error={fieldError("frame")}
        type="select"
        value={draft.frame}
        onChange={(event) => update({ frame: event.target.value })}
      >
        {ABSORBING_BOUNDARY_FRAMES.map((frame) => (
          <option key={frame} value={frame}>{frame === "object" ? "Object coordinates" : "World coordinates"}</option>
        ))}
      </FormField>}
    </>
  );
}
