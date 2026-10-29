import type { SavedPlaybackResource } from "./savedResultsPlayback";
import type { components } from "./generated/openapi-v2-types";
/** Domain model for the on-disk output catalog; transport remains in ControlRoomApi. */
export type ResultsSource = {kind:"current"} | {kind:"workspace";itemId:string};
export type ResultsCatalogStatus = "ready" | "empty" | "partial" | "unavailable";
export type ResultsEntryStatus = "ready" | "metadata_only" | "unsupported" | "unreadable";

export interface ResultsEntry {
  id:string;
  path:string;
  parent_id:string|null;
  name:string;
  kind:"directory"|"zarr_group"|"zarr_array"|"file";
  size_bytes:number|null;
  array_id:string|null;
  mime_type?:string|null;
  format?:string|null;
  status?:ResultsEntryStatus|string|null;
  reason?:string|null;
}
export interface ResultsCatalog {
  schema:string;
  revision:string;
  root_label:string;
  run_id:string|null;
  entries:ResultsEntry[];
  next_cursor:string|null;
  total_count:number;
  truncated:boolean;
  status?:ResultsCatalogStatus|string|null;
  reason?:string|null;
  can_read_values?:boolean;
  can_visualize_3d?:boolean;
}
export interface ResultsCoordinate {
  sample_index:number;
  kind:"physical_time"|"accepted_step";
  value:number|null;
  accepted_step?:string|null;
}
export interface ResultsFdmGeometry {
  kind:"fdm";
  cells_xyz:[number,number,number];
  cell_size_m:[number,number,number];
  origin_m:[number,number,number];
}
export interface ResultsFemGeometry {
  kind:"fem_p1";
  node_count:number;
  cell_count:number;
  playback_geometry_sha256?:string|null;
  fem_mesh?:SavedPlaybackResource["fem_mesh"];
}
export interface ResultsArray {
  id:string;
  path:string;
  revision:string;
  shape:number[];
  chunks:number[];
  dtype:string;
  quantity_id:string|null;
  unit:string|null;
  component_count:number|null;
  field_layout:string|null;
  sample_count:number;
  coordinates:ResultsCoordinate[];
  quantity_ids?:string[];
  dimension_order?:string[];
  can_read_values:boolean;
  can_visualize_3d:boolean;
  reason:string|null;
  geometry:ResultsFdmGeometry|ResultsFemGeometry|null;
}
export interface ResultsFilePreview {
  id:string;
  path:string;
  revision:string;
  content_type:string;
  text:string;
  truncated:boolean;
}

export function resultDatasetIdentity(source:ResultsSource,arrayId:string):string {
  return JSON.stringify([source.kind,source.kind==="workspace"?source.itemId:null,arrayId]);
}
export function parseResultDatasetIdentity(key:string):{source:ResultsSource;arrayId:string}|null {
  try {
    const value:unknown=JSON.parse(key);
    if(!Array.isArray(value)||value.length!==3||typeof value[2]!=="string"||!value[2])return null;
    if(value[0]==="current"&&value[1]===null)return {source:{kind:"current"},arrayId:value[2]};
    if(value[0]==="workspace"&&typeof value[1]==="string"&&/^\d+$/.test(value[1]))return {source:{kind:"workspace",itemId:value[1]},arrayId:value[2]};
    return null;
  } catch {return null;}
}

/** Decode source f64 without treating a missing/non-finite sample as live data. */
export function decodeResultValues(body:ArrayBuffer,expectedValues:number):Float64Array {
  if(!Number.isSafeInteger(expectedValues)||expectedValues<1||expectedValues>8*1024*1024||body.byteLength!==expectedValues*8)throw new Error("Saved sample size differs from its array metadata.");
  const data=new Float64Array(expectedValues),view=new DataView(body);
  for(let i=0;i<expectedValues;i++) {
    const value=view.getFloat64(i*8,true);
    if(!Number.isFinite(value))throw new Error("Saved sample contains a non-finite value.");
    data[i]=value;
  }
  return data;
}

export type ResultsCatalogWire=components["schemas"]["WorkspaceResultsCatalog"];
export type ResultsArrayWire=components["schemas"]["WorkspaceResultArray"];
export type ResultsEntryPreviewWire=components["schemas"]["WorkspaceResultEntryResponse"];

export function normalizeResultsCatalog(wire:ResultsCatalogWire):ResultsCatalog {
  return {...wire,run_id:wire.run_id ?? null,next_cursor:wire.next_cursor ?? null,
    entries:wire.entries.map(entry=>({...entry,parent_id:entry.parent_id ?? null,size_bytes:entry.size_bytes ?? null,array_id:entry.array_id ?? null}))};
}
export function normalizeResultsArray(wire:ResultsArrayWire):ResultsArray {
  const geometry=wire.geometry;
  return {...wire,quantity_id:wire.quantity_id ?? null,unit:wire.unit ?? null,
    component_count:wire.component_count ?? geometry?.component_count ?? null,
    field_layout:wire.field_layout ?? null,reason:wire.reason ?? null,
    coordinates:wire.coordinates.map(coordinate=>({...coordinate,value:coordinate.value ?? null,accepted_step:coordinate.accepted_step ?? null})),
    geometry:geometry?.kind==="fdm" && geometry.cells_xyz && geometry.cell_size_m && geometry.origin_m
      ? {kind:"fdm",cells_xyz:geometry.cells_xyz as [number,number,number],cell_size_m:geometry.cell_size_m as [number,number,number],origin_m:geometry.origin_m as [number,number,number]}
      :geometry?.kind==="fem_p1" && geometry.node_count && geometry.cell_count
        ? {kind:"fem_p1",node_count:geometry.node_count,cell_count:geometry.cell_count,playback_geometry_sha256:geometry.playback_geometry_sha256 ?? null,fem_mesh:geometry.fem_mesh ?? undefined}:null};
}
export function normalizeResultsPreview(wire:ResultsEntryPreviewWire):ResultsFilePreview {
  return {...wire,text:wire.text ?? ""};
}
