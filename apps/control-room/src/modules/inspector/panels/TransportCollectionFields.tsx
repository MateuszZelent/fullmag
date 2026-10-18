import type { SceneResource } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { chargeBoundaryKinds, chargeMaterialFields, changeTransportBoundaryKind, spinBoundaryKinds, spinMaterialFields, transportRows, transportScopeOptions, updateTransportRow, type CollectionRow } from "./TransportCollectionFieldsModel";

interface Props { family: "current_transport" | "spin_transport"; collection: "domain" | "materials" | "boundaries"; value: string; scene: SceneResource | null; onChange: (value: string) => void }
const record = (value: unknown): CollectionRow => value && typeof value === "object" && !Array.isArray(value) ? value as CollectionRow : {};
const text = (value: unknown): string => value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value);
export function TransportCollectionFields({ family, collection, value, scene, onChange }: Props) {
  let rows: CollectionRow[];
  try { rows = transportRows(value); } catch (error) { return <FeedbackBanner kind="error" message={error instanceof Error ? error.message : String(error)} />; }
  const scopes = transportScopeOptions(scene);
  const update = (index: number, path: string[], input: string, kind?: "text" | "number" | "vector" | "reaction") => onChange(updateTransportRow(value, index, path, input, kind));
  const scopeField = (index: number, ref: CollectionRow, path: string[], label: string) => <FormField label={label} type="select" value={JSON.stringify([ref.object_id ?? "", ref.region_id ?? ""])} onChange={(event) => {
    const [objectId, regionId] = JSON.parse(event.currentTarget.value) as [string, string];
    const first = updateTransportRow(value, index, [...path, "object_id"], objectId);
    onChange(updateTransportRow(first, index, [...path, "region_id"], regionId));
  }}><option value={'["",""]'}>Select authored object or region</option>
    {ref.object_id && !scopes.some((scope) => scope.objectId === ref.object_id && scope.regionId === (ref.region_id ?? "")) ? <option value={JSON.stringify([ref.object_id, ref.region_id ?? ""])}>Unavailable: {text(ref.object_id)} / {text(ref.region_id)}</option> : null}
    {scopes.map((scope) => <option key={`${scope.objectId}:${scope.regionId}`} value={JSON.stringify([scope.objectId, scope.regionId])}>{scope.label}</option>)}
  </FormField>;
  const surface = (index: number, ref: CollectionRow, path: string[], label: string) => <InspectorGroup title={label}>
    <FormField label={`${label} object`} type="select" value={text(ref.object_id)} onChange={(event) => update(index, [...path, "object_id"], event.currentTarget.value)}><option value="">Select object</option>{scene?.objects?.map((object) => <option key={object.id} value={object.id}>{object.name || object.id}</option>)}</FormField>
    <FormField label={`${label} surface ID`} value={text(ref.surface_id)} onChange={(event) => update(index, [...path, "surface_id"], event.currentTarget.value)} />
    <FormField label={`${label} outward orientation`} value={text(ref.orientation)} onChange={(event) => update(index, [...path, "orientation"], event.currentTarget.value, "vector")} />
  </InspectorGroup>;
  return <InspectorGroup title={`${family === "spin_transport" ? "Spin" : "Charge"} ${collection}`} collapsible defaultOpen>
    {rows.map((row, index) => <InspectorGroup key={index} title={`${collection} ${index + 1}`}>
      {collection === "domain" ? scopeField(index, row, [], "Domain scope") : null}
      {collection === "materials" ? <>
        {scopeField(index, record(row.region), ["region"], "Material scope")}
        {(family === "spin_transport" ? spinMaterialFields : chargeMaterialFields).map(([key, label, unit]) => <FormField key={key} label={label} unit={unit} value={text(record(row.material)[key])} onChange={(event) => update(index, ["material", key], event.currentTarget.value, key === "capacitance_formula_version" ? "text" : key === "lambda_j_m" || key === "lambda_phi_m" ? "reaction" : "number")} />)}
      </> : null}
      {collection === "boundaries" ? <>
        <FormField label="Boundary ID" value={text(row.id)} onChange={(event) => update(index, ["id"], event.currentTarget.value)} />
        <FormField label="Boundary kind" type="select" value={text(row.kind)} onChange={(event) => onChange(changeTransportBoundaryKind(value, index, event.currentTarget.value))}><option value="">Select explicit boundary kind</option>{(family === "spin_transport" ? spinBoundaryKinds : chargeBoundaryKinds).map((kind) => <option key={kind} value={kind}>{kind}</option>)}</FormField>
        {row.kind === "voltage_electrode" ? <FormField label="Potential" unit="V" value={text(row.potential_V)} onChange={(event) => update(index, ["potential_V"], event.currentTarget.value, "number")} /> : null}
        {row.kind === "normal_current_electrode" ? <FormField label="Outward current density" unit="A/m²" value={text(row.outward_current_density_Apm2)} onChange={(event) => update(index, ["outward_current_density_Apm2"], event.currentTarget.value, "number")} /> : null}
        {row.kind === "specified_spin_potential" ? <FormField label="Spin potential vector" unit="V" value={text(row.spin_potential_V)} onChange={(event) => update(index, ["spin_potential_V"], event.currentTarget.value, "vector")} /> : null}
        {row.kind === "specified_spin_flux" ? <FormField label="Normal spin flux vector" unit="A/m²" value={text(row.normal_spin_flux_Apm2)} onChange={(event) => update(index, ["normal_spin_flux_Apm2"], event.currentTarget.value, "vector")} /> : null}
        {row.kind === "periodic_spin" ? <>
          {surface(index, record(row.minus_surface), ["minus_surface"], "Minus surface")}
          {surface(index, record(row.plus_surface), ["plus_surface"], "Plus surface")}
          <FormField label="Periodic translation" unit="m" value={text(row.translation_m)} onChange={(event) => update(index, ["translation_m"], event.currentTarget.value, "vector")} />
        </> : <>
          {(Array.isArray(row.surfaces) ? row.surfaces : []).map((entry, surfaceIndex) => <div key={surfaceIndex}>
            {/* Array surface editing uses the same typed surface carrier, preserving other entries. */}
            <SurfaceRow value={record(entry)} scene={scene} label={`Surface ${surfaceIndex + 1}`} onChange={(next) => onChange(JSON.stringify(rows.map((item, i) => i === index ? { ...row, surfaces: (row.surfaces as unknown[]).map((itemSurface, j) => j === surfaceIndex ? next : itemSurface) } : item)))} />
            <Button type="button" onClick={() => onChange(JSON.stringify(rows.map((item, i) => i === index ? { ...row, surfaces: (row.surfaces as unknown[]).filter((_, j) => j !== surfaceIndex) } : item)))}>Remove surface from draft</Button>
          </div>)}
          <Button type="button" onClick={() => onChange(JSON.stringify(rows.map((item, i) => i === index ? { ...row, surfaces: [...(Array.isArray(row.surfaces) ? row.surfaces : []), {}] } : item)))}>Add explicit surface</Button>
        </>}
      </> : null}
      <Button type="button" onClick={() => onChange(JSON.stringify(rows.filter((_, i) => i !== index)))}>Remove row from draft</Button>
    </InspectorGroup>)}
    <Button type="button" onClick={() => onChange(JSON.stringify([...rows, collection === "domain" ? {} : collection === "materials" ? { region: {}, material: {} } : { id: "", surfaces: [] }]))}>Add explicit {collection === "domain" ? "domain scope" : collection === "materials" ? "material assignment" : "boundary"}</Button>
    <p className="fm-inspector-hint">Values are explicit SI parameters. Unedited parameters are preserved; clone-only validation owns geometry and execution qualification.</p>
  </InspectorGroup>;
}
function SurfaceRow({ value, scene, label, onChange }: { value: CollectionRow; scene: SceneResource | null; label: string; onChange: (value: CollectionRow) => void }) {
  const edit = (key: string, input: string, kind: "text" | "vector" = "text") => onChange(transportRows(updateTransportRow(JSON.stringify([value]), 0, [key], input, kind))[0]);
  return <InspectorGroup title={label}>
    <FormField label={`${label} object`} type="select" value={text(value.object_id)} onChange={(event) => edit("object_id", event.currentTarget.value)}><option value="">Select object</option>{scene?.objects?.map((object) => <option key={object.id} value={object.id}>{object.name || object.id}</option>)}</FormField>
    <FormField label={`${label} surface ID`} value={text(value.surface_id)} onChange={(event) => edit("surface_id", event.currentTarget.value)} />
    <FormField label={`${label} outward orientation`} value={text(value.orientation)} onChange={(event) => edit("orientation", event.currentTarget.value, "vector")} />
  </InspectorGroup>;
}
