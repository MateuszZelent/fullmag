import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { RealtimeInvalidationBridge } from "../realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "./ResourceInvalidationController";
import { fieldVectorResourceKey } from "../api/fieldQueryIdentity";
import type { FieldCatalogResource } from "../api/apiTypes";
import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { LiveStatusResource, PlanarFieldMetaResource, PlanarFieldProbeResource } from "../api/apiTypes";
import { fdmCellCenter, fdmCellPhysicsEpoch, fdmCellPhysicsResourceKey, loadFdmCellPhysics, validateFdmCellProbe, type FdmCellPhysicsTarget } from "./fdmCellPhysicsResources";

const target: FdmCellPhysicsTarget = { ordinal: 5, generationId: "g1", gridFingerprint: "grid1", membershipRevision: "2:1", meshRevision: 2, centerM: [3e-9, 8e-9, 15e-9], cellSizeM: [2e-9, 4e-9, 6e-9] };
const status = { session: { session_epoch: "s:1", request_scope_epoch: "a:1" }, run: { run_id: "run1" }, domain: { discretization: "fdm", generation_id: "g1", cell_count: 24 }, resources: { mesh_revision: 2, region_membership_revision: 1, field_revision: 9, scene_revision: 4 } } as unknown as LiveStatusResource;
const frame = { origin_m: [0, 0, 15e-9], u_axis: [1, 0, 0], v_axis: [0, 1, 0], normal: [0, 0, 1], bounds_uv_m: [0, 1, 0, 1] };
function meta(id = "m"): PlanarFieldMetaResource {
  return { quantity_id: id, generation_id: "g1", mesh_revision: "2", scene_revision: "4", field_revision: "3", carrier_revision: "c1", sample_token: "token1", source: { kind: "default", domain_generation_id: "g1", default_slice_hash: "h1", default_slice_revision: "1" }, frame, section: { normal_axis: "z", stops_kind: "fdm_cell_layers" } } as unknown as PlanarFieldMetaResource;
}
function probe(id = "m"): PlanarFieldProbeResource {
  return { quantity_id: id, source: meta().source, world_m: [...target.centerM], cell_id: 5, occupancy: "occupied", sampling_method: "point_probe", u_m: 3e-9, v_m: 8e-9, scalar: id === "eden_ext" ? -200 : id === "mat_alpha" ? 0 : 1, vector: id === "m" ? [1, 0, 0] : null };
}
function fixture() {
  const fields = ["m", "mat_alpha", "eden_ext"].map((id) => ({ quantity_id: id, label: id, components: id === "m" ? 3 : 1, unit: id === "eden_ext" ? "J/m³" : "1", available: true, stale_by_steps: 0, state: "complete", field_revision: 3, source_step: 7 }));
  const statusRead = vi.fn().mockResolvedValue(status);
  const metadata = vi.fn(async (id: string) => meta(id));
  const sample = vi.fn(async (id: string) => probe(id));
  return { fields, statusRead, metadata, sample, api: { sessions: { current: { status: statusRead } }, data: { fields: { catalog: vi.fn(async () => ({ domain_generation_id: "g1", quantities: fields })), planar: { meta: metadata, probe: sample } } } } as unknown as ControlRoomApi };
}
const options = () => ({ signal: new AbortController().signal, sessionScopeKey: "a:1" });

describe("FDM selected-cell physics", () => {
  it("refreshes the cell inspection for exact energy and magnetization publication events", () => {
    const f = fixture();
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const key = fdmCellPhysicsResourceKey(target, "epoch", { revision: 2, quantities: f.fields } as unknown as FieldCatalogResource);
    resources.subscribe(key, () => {});
    for (const [id, revision] of [["eden_ext", 12], ["m", 13]] as const) {
      bridge.handleEvent({ type: "resource.batch_changed", payload: { changes: [{ resource: "fields", resource_id: "samples", quantity_ids: [id], recommended_fetch: fieldVectorResourceKey(id), revision }] } });
      expect(resources.getRevision(key)).toBe(revision);
    }
  });

  it("seeds inspection from a complete field when another available quantity is pending", async () => {
    const f = fixture(); f.fields[0].state = "pending";
    f.metadata.mockImplementation(async (id) => { if (id === "m") throw new Error("pending"); return meta(id); });
    const r = await loadFdmCellPhysics(f.api, target, options());
    expect(f.metadata.mock.calls[0][0]).toBe("mat_alpha");
    expect(r.rows[0].status).toBe("unavailable");
    expect(r.rows[1].status).toBe("ready");
  });
  it("rejects a changed membership before requesting any cell values", async () => {
    const f = fixture();
    await expect(loadFdmCellPhysics(f.api, { ...target, membershipRevision: "2:0" }, options())).rejects.toThrow("current FDM grid");
    expect(f.metadata).not.toHaveBeenCalled();
  });
  it("tracks field-only publication changes separately from lifecycle status", () => {
    expect(fdmCellPhysicsEpoch({ ...status, resources: { ...status.resources, field_revision: 10 } })).not.toBe(fdmCellPhysicsEpoch(status));
  });

  it("computes exact cell centres using each axis spacing and nonzero origin", () => {
    expect(fdmCellCenter([10, 20, 30], [2, 4, 6], [1, 2, 3])).toEqual([13, 30, 51]);
  });
  it("pins point reads to cell plane, source revisions and sample token, preserving zero and signed energies", async () => {
    const f = fixture();
    const result = await loadFdmCellPhysics(f.api, target, options());
    expect(result.rows.map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
    expect(result.rows[0].vector).toEqual([1, 0, 0]);
    expect(result.rows[1].scalar).toBe(0);
    expect(result.rows[2].scalar).toBe(-200);
    expect(result.volumeM3).toBeCloseTo(48e-27, 35);
    expect(f.metadata.mock.calls[1][0]).toBe("m");
    const call = f.sample.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(call[2]).toMatchObject({ position_m: 15e-9, u_m: 3e-9, v_m: 8e-9, sample_token: "token1", expected_field_revision: "3", expected_carrier_revision: "c1", expected_mesh_revision: "2", expected_scene_revision: "4" });
    const scalarCall = f.sample.mock.calls[2] as unknown as [string, unknown, Record<string, unknown>];
    expect(scalarCall[2].component).toBe("scalar");
  });
  it.each([
    ["another cell", { cell_id: 6 }], ["another generation", { source: { ...meta().source, domain_generation_id: "g2" } }],
    ["different point", { world_m: [3e-9, 8e-9, 16e-9] }], ["empty point", { occupancy: "empty" }],
    ["raster sample", { sampling_method: "raster" }], ["non-finite centre", { world_m: [NaN, 8e-9, 15e-9] }],
  ])("rejects %s even if the field has the same size", (_name, patch) => {
    expect(() => validateFdmCellProbe({ ...probe(), ...patch } as PlanarFieldProbeResource, meta(), target)).toThrow();
  });
  it("withholds a stale selected mesh before any field request", async () => {
    const f = fixture();
    await expect(loadFdmCellPhysics(f.api, { ...target, generationId: "old" }, options())).rejects.toThrow("current FDM grid");
    expect(f.metadata).not.toHaveBeenCalled();
  });
  it("rejects a run/field change during sampling rather than publishing mixed results", async () => {
    const f = fixture();f.statusRead.mockResolvedValueOnce(status).mockResolvedValueOnce({ ...status, run: { run_id: "run2" } });
    await expect(loadFdmCellPhysics(f.api, target, options())).rejects.toThrow("during cell inspection");
  });
  it("leaves unavailable and stale quantities empty without starting computation", async () => {
    const f = fixture(); f.fields[1].available = false; f.fields[2].stale_by_steps = 4;
    const r = await loadFdmCellPhysics(f.api, target, options());
    expect(r.rows[1]).toMatchObject({ status: "unavailable", scalar: null, vector: null });
    expect(r.rows[2]).toMatchObject({ status: "unavailable", scalar: null, vector: null });
    expect(f.sample).toHaveBeenCalledTimes(1);
  });
  it("isolates a missing cell sample to that quantity and never replaces it with zero", async () => {
    const f = fixture();f.sample.mockImplementation(async (id) => id === "mat_alpha" ? { ...probe(id), cell_id: 99 } : probe(id));
    const r = await loadFdmCellPhysics(f.api, target, options());
    expect(r.rows[1]).toMatchObject({ status: "unavailable", scalar: null });
    expect(r.rows[2].status).toBe("ready");
  });
  it("requires current full-grid carrier geometry and supports x/y/z plane coordinates", async () => {
    const f = fixture();f.metadata.mockImplementation(async (id) => ({ ...meta(id), section: { ...meta().section!, normal_axis: "y" }, frame: { ...frame, origin_m: [0, 8e-9, 0], u_axis: [1, 0, 0], v_axis: [0, 0, 1] } }));
    const r = await loadFdmCellPhysics(f.api, target, options());
    expect(r.rows[0].status).toBe("ready");
    const call = f.sample.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(call[2]).toMatchObject({ position_m: 8e-9, u_m: 3e-9, v_m: 15e-9 });
  });
});
