"use client";

import { useCallback } from "react";

import { DATA_FIELDS_PATH } from "../api/apiPaths";
import { fieldVectorResourceKey } from "../api/fieldQueryIdentity";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import type {
  FieldCatalogResource,
  LiveStatusResource,
  PlanarFieldMetaResource,
  PlanarFieldProbeResource,
  PlanarFieldQuery,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { sessionScopedResourceKey } from "./sessionResourceIdentity";
import { useResource } from "./useResource";
import { useFieldCatalogResource } from "./studyRuntimeResources";
import { useSessionResourceIdentity, useSessionStatusSelector } from "./useSessionStatus";

export interface FdmCellPhysicsTarget {
  ordinal: number;
  generationId: string;
  gridFingerprint: string;
  membershipRevision: string;
  meshRevision: number;
  centerM: readonly [number, number, number];
  cellSizeM: readonly [number, number, number];
}

export interface FdmCellQuantitySample {
  id: string;
  label: string;
  unit: string;
  group: "material" | "magnetization" | "energy";
  status: "ready" | "unavailable";
  scalar: number | null;
  vector: readonly number[] | null;
  sourceStep: number | null;
  sourceTimeSeconds: number | null;
  reason: string | null;
}

export interface FdmCellPhysicsSnapshot {
  runId: string;
  volumeM3: number;
  rows: FdmCellQuantitySample[];
}

const SOURCE = { kind: "default" } as const;
const RESOLUTION = { resolution_x: 16, resolution_y: 16, vector_budget: 0, include_mesh: false };
const MAX_QUANTITIES = 32;
type Descriptor = FieldCatalogResource["quantities"][number];
type CellApi = Pick<ControlRoomApi, "sessions" | "data">;

export function fdmCellPhysicsEpoch(status: LiveStatusResource | null): string | null {
  if (!status) return null;
  const r = status.resources;
  return JSON.stringify([
    status.session.session_epoch, status.session.request_scope_epoch, status.run?.run_id ?? null,
    status.domain.generation_id, r.mesh_revision, r.region_membership_revision,
    r.region_coefficients_revision, r.scene_revision, r.field_catalog_revision,
    r.field_revision, r.stages_revision, r.visualization_state_revision,
  ]);
}

export function fdmCellCenter(
  origin: readonly number[], spacing: readonly number[], ijk: readonly number[],
): [number, number, number] {
  return [0, 1, 2].map((axis) => origin[axis] + (ijk[axis] + 0.5) * spacing[axis]) as [number, number, number];
}

function assertTarget(target: FdmCellPhysicsTarget, status: LiveStatusResource) {
  if (
    status.domain.discretization !== "fdm" ||
    status.domain.generation_id !== target.generationId ||
    status.resources.mesh_revision !== target.meshRevision ||
    `${status.resources.mesh_revision}:${status.resources.region_membership_revision}` !== target.membershipRevision ||
    !Number.isSafeInteger(target.ordinal) || target.ordinal < 0 ||
    target.ordinal >= status.domain.cell_count ||
    target.centerM.some((v) => !Number.isFinite(v)) ||
    target.cellSizeM.some((v) => !Number.isFinite(v) || v <= 0)
  ) throw new Error("The selected cell no longer belongs to the current FDM grid. Select it again.");
}

function componentFor(field: Descriptor): string {
  return field.components === 1 ? "scalar" : "magnitude";
}

function assertMeta(meta: PlanarFieldMetaResource | null, target: FdmCellPhysicsTarget): asserts meta is PlanarFieldMetaResource {
  if (!meta || meta.generation_id !== target.generationId || meta.mesh_revision !== String(target.meshRevision)) {
    throw new Error("Field geometry no longer matches the selected cell.");
  }
}

function dotDelta(center: readonly number[], origin: readonly number[], axis: readonly number[]): number {
  return center.reduce((sum, value, i) => sum + (value - origin[i]) * axis[i], 0);
}

export function validateFdmCellProbe(
  probe: PlanarFieldProbeResource, meta: PlanarFieldMetaResource, target: FdmCellPhysicsTarget,
): void {
  // Never use a raster pixel or a same-sized field from another mesh as a cell sample.
  if (
    probe.cell_id !== target.ordinal || probe.occupancy !== "occupied" ||
    probe.sampling_method !== "point_probe" || probe.quantity_id !== meta.quantity_id ||
    probe.source.kind !== "default" ||
    (probe.source.kind === "default" && probe.source.domain_generation_id !== target.generationId) ||
    JSON.stringify(probe.source) !== JSON.stringify(meta.source) ||
    probe.world_m.length !== 3 ||
    probe.world_m.some((v, i) => !Number.isFinite(v) || Math.abs(v - target.centerM[i]) > target.cellSizeM[i] * 1e-7)
  ) throw new Error("The field probe does not identify the selected cell and its exact centre.");
}

function rowFor(field: Descriptor): FdmCellQuantitySample {
  return {
    id: field.quantity_id, label: field.label, unit: field.unit,
    group: field.quantity_id === "m" ? "magnetization" : field.quantity_id.startsWith("mat_") ? "material" : "energy",
    status: "unavailable", scalar: null, vector: null,
    sourceStep: Number.isFinite(field.source_step) ? field.source_step : null,
    sourceTimeSeconds: field.source_time_seconds ?? null, reason: null,
  };
}

/** A bounded, read-only point inspection over existing typed resources. */
export async function loadFdmCellPhysics(
  api: CellApi, target: FdmCellPhysicsTarget,
  options: { signal: AbortSignal; sessionScopeKey?: string },
): Promise<FdmCellPhysicsSnapshot> {
  const before = await api.sessions.current.status(options);
  assertTarget(target, before);
  // Status in a mounted Inspector may lag high-frequency field publications.
  // Pin this read transaction to the fresh authoritative status, not that cached pointer.
  const expectedEpoch = fdmCellPhysicsEpoch(before);
  const catalog = await api.data.fields.catalog(options);
  if (catalog.domain_generation_id !== target.generationId) throw new Error("Field catalog belongs to another grid.");
  const fields = catalog.quantities.filter((field) =>
    field.quantity_id === "m" || field.quantity_id.startsWith("mat_") || field.quantity_id.startsWith("eden_"));
  if (fields.length > MAX_QUANTITIES) throw new Error("Cell inspection exceeds the supported quantity budget.");
  const seedField = fields.find((field) => field.available && field.stale_by_steps === 0 && field.state === "complete");
  if (!seedField) return { runId: before.run?.run_id ?? "not started", volumeM3: target.cellSizeM.reduce((a, b) => a * b, 1), rows: fields.map((field) => ({ ...rowFor(field), reason: "No current published field is available." })) };
  const seed = await api.data.fields.planar.meta(seedField.quantity_id, SOURCE, {
    ...RESOLUTION, component: componentFor(seedField),
  }, options);
  assertMeta(seed, target);
  const axis = seed.section?.normal_axis;
  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : axis === "z" ? 2 : null;
  if (axisIndex === null || seed.section?.stops_kind !== "fdm_cell_layers") {
    throw new Error("Cell inspection requires a regular FDM grid carrier.");
  }
  const rows: FdmCellQuantitySample[] = [];
  // Sequential reads bound backend work; each meta+probe pair is revision pinned.
  for (const field of fields) {
    options.signal.throwIfAborted();
    const row = rowFor(field);
    if (!field.available || field.stale_by_steps > 0 || field.state !== "complete") {
      row.reason = field.materialization_reason_code ?? "Field is not currently published for this state.";
      rows.push(row);
      continue;
    }
    try {
      const query: PlanarFieldQuery = {
        ...RESOLUTION, component: componentFor(field), position_m: target.centerM[axisIndex],
        expected_scene_revision: seed.scene_revision, expected_mesh_revision: seed.mesh_revision,
      };
      const meta = await api.data.fields.planar.meta(field.quantity_id, SOURCE, query, options);
      assertMeta(meta, target);
      if (meta.field_revision !== String(field.field_revision) || meta.section?.normal_axis !== axis) {
        throw new Error("Field revision or inspection plane changed during sampling.");
      }
      const probe = await api.data.fields.planar.probe(field.quantity_id, SOURCE, {
        ...query, sample_token: meta.sample_token,
        expected_carrier_revision: meta.carrier_revision, expected_field_revision: meta.field_revision,
        u_m: dotDelta(target.centerM, meta.frame.origin_m, meta.frame.u_axis),
        v_m: dotDelta(target.centerM, meta.frame.origin_m, meta.frame.v_axis),
      }, options);
      validateFdmCellProbe(probe, meta, target);
      const scalar = probe.scalar;
      const vector = probe.vector;
      if (field.quantity_id === "m" ? vector?.length !== 3 || vector.some((v) => !Number.isFinite(v)) : scalar == null || !Number.isFinite(scalar)) {
        throw new Error("The selected cell has no finite field sample.");
      }
      Object.assign(row, { status: "ready", scalar: scalar ?? null, vector: vector ?? null });
    } catch (error) {
      options.signal.throwIfAborted();
      row.reason = error instanceof Error ? error.message : "Cell sample is unavailable.";
    }
    rows.push(row);
  }
  const after = await api.sessions.current.status(options);
  if (fdmCellPhysicsEpoch(after) !== expectedEpoch) throw new Error("Fields changed during cell inspection. Refresh the cell values.");
  return { runId: before.run?.run_id ?? "not started", volumeM3: target.cellSizeM.reduce((a, b) => a * b, 1), rows };
}

export function fdmCellPhysicsResourceKey(
  target: FdmCellPhysicsTarget | null, epoch: string | null, catalog: FieldCatalogResource | null,
): string {
  const fieldKeys = (catalog?.quantities ?? [])
    .filter((field) => field.quantity_id === "m" || field.quantity_id.startsWith("mat_") || field.quantity_id.startsWith("eden_"))
    .slice(0, MAX_QUANTITIES)
    .map((field) => fieldVectorResourceKey(field.quantity_id)).sort();
  return `${DATA_FIELDS_PATH}#fdm-cell-physics:${JSON.stringify([target, epoch, catalog?.revision])}|${fieldKeys.join("|")}`;
}

export function useFdmCellPhysicsResource(target: FdmCellPhysicsTarget | null) {
  const { api } = useKernel();
  const identity = useSessionResourceIdentity();
  const epoch = useSessionStatusSelector((resource) => fdmCellPhysicsEpoch(resource.data));
  const catalog = useFieldCatalogResource({ enabled: target !== null });
  // The existing realtime bridge recognizes canonical field query segments in
  // aggregate resource keys. Exact and broad field updates refresh this read too.
  const key = fdmCellPhysicsResourceKey(target, epoch, catalog.data);
  const load = useCallback(({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) => {
    if (!target || !epoch) throw new Error("Select a current FDM cell.");
    return loadFdmCellPhysics(api, target, { signal, sessionScopeKey });
  }, [api, epoch, target]);
  return useResource<FdmCellPhysicsSnapshot>({
    enabled: target !== null && identity !== null && epoch !== null,
    resourceKey: identity ? sessionScopedResourceKey(identity, key) : key,
    load, minRefetchIntervalMs: 1000, abortStaleInflight: false, retryPolicy: null, notifyOnError: false,
  });
}
