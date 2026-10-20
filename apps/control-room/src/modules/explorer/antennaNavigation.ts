import type { SceneResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { buildObjectExplorerNode } from "./builders/objectExplorerNodes";
import { modelTreeSnapshotFromScene } from "./builders/sceneModelTreeAdapter";
import { selectionRefFromNode } from "./explorerSelection";
import type { ExplorerNode } from "./explorerTypes";

import { antennaResourceOwner, type AntennaOwnedResourceKind as ResourceKind } from "@/shared/domain/physics/antennaResourceOwner";
export interface AntennaNavigationLink {
  key: string;
  label: string;
  selection: Selection | null;
  reason: string | null;
}

function unique<T>(items: readonly T[], matches: (item: T) => boolean): T | null {
  const found = items.filter(matches);
  return found.length === 1 ? found[0] : null;
}

/** Derive routes from the same builders as Explorer; never persist another tree. */
export function antennaNavigationLinks(scene: SceneResource, origin: Selection): AntennaNavigationLink[] {
  const ref = origin.ref;
  if (ref?.type !== "scene-object" || (ref.kind !== "object.antenna" && !ref.kind.startsWith("object.antenna."))) return [];
  const objectId = ref.objectId;
  const object = unique(scene.objects ?? [], item => item.id === objectId);
  if (!object) return [{ key: "missing-owner", label: "Related resources", selection: null, reason: "The source object is missing or ambiguous." }];
  const stages = scene.antenna_field_solve_stages ?? [];
  const projections = scene.antenna_target_projections ?? [], drives = scene.solved_antenna_drives ?? [];
  const spectra = scene.antenna_spectrum_requests ?? [];
  const stage = (id: string) => unique(stages, item => item.id === id);
  const projection = (id: string) => unique(projections, item => item.id === id);
  const resourceOwner = (kind: ResourceKind, id: string) => antennaResourceOwner(scene, kind, id);
  const kind = ref.antennaResourceKind;
  const id = ref.antennaResourceId;
  if (kind && kind !== "terminals" && kind !== "conductor" && (!id || resourceOwner(kind, id) !== objectId)) {
    return [{ key: "invalid-origin", label: "Related resources", selection: null, reason: "The selected antenna resource or its source binding is missing or ambiguous." }];
  }
  const objects = modelTreeSnapshotFromScene(scene).objects ?? [];
  const links: AntennaNavigationLink[] = [];
  function add(key: string, label: string, targetObjectId: string, targetKind: ExplorerNode["kind"], resourceId?: string, regionId?: string) {
    if (links.some(link => link.key === key)) return;
    let valid = Boolean(unique(scene.objects ?? [], item => item.id === targetObjectId));
    if (resourceId) valid &&= resourceOwner(targetKind.slice("object.antenna.".length) as ResourceKind, resourceId) === targetObjectId;
    if (regionId) {
      const targetObject = unique(scene.objects ?? [], item => item.id === targetObjectId);
      valid &&= Boolean(unique(targetObject?.regions ?? [], item => item.region_id === regionId && (!item.owner_object || item.owner_object === targetObjectId)));
    }
    const snapshot = unique(objects, item => item.id === targetObjectId);
    const nodes: ExplorerNode[] = [];
    function visit(node: ExplorerNode) { nodes.push(node); node.children?.forEach(visit); }
    if (valid && snapshot) visit(buildObjectExplorerNode(snapshot, { scene }));
    const node = unique(nodes, item => item.kind === targetKind && (resourceId === undefined || item.antennaResourceId === resourceId) && (regionId === undefined || item.regionId === regionId));
    const targetRef = node && node.selectable !== false ? selectionRefFromNode(node) : null;
    links.push({ key, label, reason: targetRef ? null : "The related resource is missing, ambiguous or has no Explorer route.",
      selection: node && targetRef ? { kind: node.kind, label: node.label, objectId: node.objectId ?? null, nodeId: node.id, ref: targetRef, moduleSource: "inspector" } : null });
  }
  function addResource(resourceKind: ResourceKind, resourceId: string, label: string) {
    add(`${resourceKind}:${resourceId}`, label, objectId, `object.antenna.${resourceKind}`, resourceId);
  }
  function addTarget(target: NonNullable<SceneResource["antenna_target_projections"]>[number]["target"]) {
    if (target.kind === "global") {
      links.push({ key: "global-target", label: "Global receiver", selection: null, reason: "Global scope has no single receiver object to open." });
    } else add(`target:${target.object_id}:${target.kind === "region" ? target.region_id : "object"}`, "Receiver", target.object_id, target.kind === "region" ? "object.region" : "object.root", undefined, target.kind === "region" ? target.region_id : undefined);
  }
  if (ref.kind === "object.antenna") {
    add("conductor", "Conductor", objectId, "object.antenna.conductor");
    add("geometry", "Geometry", objectId, "object.antenna.geometry");
    add("terminals", "Terminals and source", objectId, "object.antenna.terminals");
    for (const item of scene.antenna_port_modes ?? []) if (item.source_object_id === objectId) addResource("port", item.id, "Port");
    for (const item of stages) if (item.source_object_id === objectId) addResource("solution", item.id, "Field solve");
    for (const item of projections) if (resourceOwner("projection", item.id) === objectId) addResource("projection", item.id, "Projection");
    for (const item of drives) if (resourceOwner("drive", item.id) === objectId) addResource("drive", item.id, "Current drive");
    for (const item of spectra) if (resourceOwner("spectrum", item.id) === objectId) addResource("spectrum", item.id, "Source spectrum");
    add("regional", "Regional field drive", objectId, "object.antenna.regional");
  }
  if (kind === "conductor") {
    add("geometry", "Geometry", objectId, "object.antenna.geometry");
    add("mesh", "Mesh policy", objectId, "object.mesh");
  }
  if (kind === "port" && id) {
    add("conductor", "Conductor", objectId, "object.antenna.conductor");
    stages.filter(item => item.source_object_id === objectId && item.port_mode_ids.includes(id)).forEach(item => addResource("solution", item.id, "Field solve"));
  }
  if (kind === "solution" && id) {
    stage(id)?.port_mode_ids.forEach(portId => addResource("port", portId, "Port"));
    projections.filter(item => item.solution.stage_id === id).forEach(item => addResource("projection", item.id, "Projection"));
    spectra.filter(item => item.solution_ref.stage_id === id).forEach(item => addResource("spectrum", item.id, "Source spectrum"));
  }
  if (kind === "projection" && id) {
    const item = projection(id);
    if (item) { addResource("solution", item.solution.stage_id, "Field solve"); addTarget(item.target); }
    drives.filter(item => item.projection_ref === id).forEach(item => addResource("drive", item.id, "Current drive"));
  }
  if (kind === "drive" && id) {
    const item = unique(drives, item => item.id === id), bound = item ? projection(item.projection_ref) : null;
    if (item) { addResource("projection", item.projection_ref, "Projection"); addResource("port", item.port_mode_id, "Port"); }
    if (bound) { addResource("solution", bound.solution.stage_id, "Field solve"); addTarget(bound.target); }
  }
  if (kind === "spectrum" && id) {
    const item = unique(spectra, item => item.id === id);
    if (item) { addResource("solution", item.solution_ref.stage_id, "Field solve"); addTarget(item.target); }
  }
  return links;
}
