import { describe, expect, it } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import {
  canonicalFieldVectorQuery,
  serializeCanonicalFieldVectorResourceKey,
} from "../api/fieldQueryIdentity";
import {
  ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELDS_PATH,
  DATA_FIELD_META_PATH,
  DATA_FIELD_VECTOR_PATH,
  DATA_TABLE_ROWS_PATH,
  ANALYSIS_HYSTERESIS_BRANCHES_PATH,
  ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
  ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH,
  ANALYSIS_HYSTERESIS_METRICS_PATH,
  ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
  ANALYSIS_HYSTERESIS_POINT_PATH,
  ANALYSIS_HYSTERESIS_POINTS_PATH,
  ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
  ANALYSIS_HYSTERESIS_SATURATION_PATH,
  ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
  ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_MATERIAL_FIELDS_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
  SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
  SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_CLIENT_ACKS_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

import { RealtimeInvalidationBridge } from "./RealtimeInvalidationBridge";

function dependentRevision(resourceKey: string, revision: string | number): string {
  return `dependent:${resourceKey}:${revision}`;
}

describe("RealtimeInvalidationBridge", () => {
  it("maps backend resource batch events to resource invalidation", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 5,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBe(
      dependentRevision(SIMULATION_COMMANDS_PATH, 5),
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(5);
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      dependentRevision(SIMULATION_COMMANDS_PATH, 5),
    );
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      dependentRevision(SIMULATION_COMMANDS_PATH, 5),
    );
  });

  it("refreshes runtime lifecycle resources when command queue changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 8,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(8);
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      dependentRevision(SIMULATION_COMMANDS_PATH, 8),
    );
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      dependentRevision(SIMULATION_COMMANDS_PATH, 8),
    );
    expect(resources.getRevision("session:status")).toBe(
      dependentRevision(SIMULATION_COMMANDS_PATH, 8),
    );
  });

  it("refreshes scene-derived region resources when scene document changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: MODEL_SCENE_PATH,
            resource: "scene_document",
            revision: 12,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe(12);
    expect(resources.getRevision(MODEL_REGIONS_PATH)).toBe(
      dependentRevision(MODEL_SCENE_PATH, 12),
    );
    expect(resources.getRevision(MODEL_REALIZED_REGIONS_PATH)).toBe(
      dependentRevision(MODEL_SCENE_PATH, 12),
    );
    expect(resources.getRevision(MODEL_REGION_DIAGNOSTICS_PATH)).toBe(
      dependentRevision(MODEL_SCENE_PATH, 12),
    );
    expect(resources.getRevision(MODEL_MATERIAL_FIELDS_PATH)).toBe(
      dependentRevision(MODEL_SCENE_PATH, 12),
    );
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBeNull();
    expect(
      resources.getRevision(MESHING_BUILDS_LATEST_SUCCESSFUL_PATH),
    ).toBeNull();
    expect(resources.getRevision(DATA_DOMAIN_TOPOLOGY_PATH)).toBeNull();
  });

  it("refreshes scene-derived hysteresis stage resources when scene document changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const stageId = "hysteresis-1";
    const stageKeys = [
      SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
      SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
      SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH,
      SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
      SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
      SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
    ].map((path) => path.replace("{stage_id}", stageId));

    for (const key of stageKeys) {
      resources.subscribe(key, () => {});
    }

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: MODEL_SCENE_PATH,
            resource: "scene_document",
            revision: 13,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    for (const key of stageKeys) {
      expect(resources.getRevision(key)).toBe(
        dependentRevision(MODEL_SCENE_PATH, 13),
      );
    }
    expect(
      resources.getRevision(
        SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
          "{stage_id}",
          stageId,
        ),
      ),
    ).toBeNull();
  });

  it("uses dependency revisions that cannot be dropped by older numeric resource namespaces", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    resources.invalidate(SIMULATION_SOLVER_STATUS_PATH, 26);
    resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, 26);

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 4,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(4);
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).not.toBe(26);
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).not.toBe(26);
  });

  it("invalidates session-scoped resources when realtime switches sessions", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const invalidated: Array<{ resourceKey: string; revision: string | number }> = [];

    resources.subscribe(SIMULATION_COMMANDS_PATH, () => {});
    resources.subscribe(SIMULATION_SOLVER_STATUS_PATH, () => {});
    resources.subscribe(SIMULATION_STAGES_EXECUTION_PATH, () => {});
    bus.on("resource:invalidated", (event) => invalidated.push(event));

    expect(
      bridge.handleEvent({
        payload: { resource_revisions: {} },
        seq: 1,
        session_id: "session-old",
        type: "hello",
      }),
    ).toBe(true);
    resources.invalidate(SIMULATION_SOLVER_STATUS_PATH, 99);

    expect(
      bridge.handleEvent({
        payload: { resource_revisions: {} },
        seq: 2,
        session_id: "session-new",
        type: "hello",
      }),
    ).toBe(true);

    expect(resources.getRevision("session:status")).toBe("session:session-new:2");
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(
      "session:session-new:2",
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      "session:session-new:2",
    );
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      "session:session-new:2",
    );
    expect(invalidated).toEqual(
      expect.arrayContaining([
        { resourceKey: "session:status", revision: "session:session-new:2" },
        {
          resourceKey: SIMULATION_SOLVER_STATUS_PATH,
          revision: "session:session-new:2",
        },
      ]),
    );
  });

  it("invalidates session-scoped runtime resources when realtime switches runs", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    resources.subscribe(SIMULATION_RUN_CURRENT_PATH, () => {});
    resources.subscribe(SIMULATION_SOLVER_STATUS_PATH, () => {});
    resources.subscribe(SIMULATION_STAGES_EXECUTION_PATH, () => {});

    expect(
      bridge.handleEvent({
        payload: { resource_revisions: {} },
        run_id: "run-old",
        seq: 1,
        session_id: "session-1",
        type: "hello",
      }),
    ).toBe(true);

    expect(
      bridge.handleEvent({
        payload: {
          changes: [
            {
              recommended_fetch: DATA_FIELDS_PATH,
              resource: "fields",
              revision: 7,
            },
          ],
        },
        run_id: "run-new",
        seq: 2,
        session_id: "session-1",
        type: "resource.batch_changed",
      }),
    ).toBe(true);

    expect(resources.getRevision("session:status")).toBe("session:session-1:2");
    expect(resources.getRevision(SIMULATION_RUN_CURRENT_PATH)).toBe(
      "session:session-1:2",
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      "session:session-1:2",
    );
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(
      "session:session-1:2",
    );
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBe(7);
  });

  it("invalidates session-scoped runtime resources when a run appears in the current session", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    resources.subscribe(SIMULATION_RUN_CURRENT_PATH, () => {});
    resources.subscribe(SIMULATION_SOLVER_STATUS_PATH, () => {});

    bridge.handleEvent({
      payload: { resource_revisions: {} },
      seq: 1,
      session_id: "session-1",
      type: "hello",
    });

    expect(
      bridge.handleEvent({
        payload: {
          changes: [
            {
              recommended_fetch: DATA_FIELDS_PATH,
              resource: "fields",
              revision: 7,
            },
          ],
        },
        run_id: "run-started",
        seq: 2,
        session_id: "session-1",
        type: "resource.batch_changed",
      }),
    ).toBe(true);

    expect(resources.getRevision(SIMULATION_RUN_CURRENT_PATH)).toBe(
      "session:session-1:2",
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      "session:session-1:2",
    );
  });

  it("does not treat heartbeat run ids as runtime identity changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    let statusInvalidations = 0;

    bus.on("resource:invalidated", ({ resourceKey }) => {
      if (resourceKey === "session:status") {
        statusInvalidations += 1;
      }
    });

    bridge.handleEvent({
      payload: { resource_revisions: {} },
      run_id: "run-old",
      seq: 1,
      session_id: "session-1",
      type: "hello",
    });
    bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            resource: "fields",
            revision: 7,
          },
        ],
      },
      run_id: "run-new",
      seq: 2,
      session_id: "session-1",
      type: "resource.batch_changed",
    });

    expect(
      bridge.handleEvent({
        payload: { current_seq: 2 },
        run_id: "run-old",
        seq: 2,
        session_id: "session-1",
        type: "heartbeat",
      }),
    ).toBe(false);
    expect(statusInvalidations).toBe(2);
    expect(resources.getRevision("session:status")).toBe("session:session-1:2");
  });

  it("batches backend invalidations until the scheduled frame and keeps the latest revision", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const scheduled: Array<() => void> = [];
    const bridge = new RealtimeInvalidationBridge(resources, {
      scheduleFlush: (callback) => {
        scheduled.push(callback);
        return () => {};
      },
    });
    let commandInvalidations = 0;

    bus.on("resource:invalidated", ({ resourceKey }) => {
      if (resourceKey === SIMULATION_COMMANDS_PATH) {
        commandInvalidations += 1;
      }
    });

    bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 5,
          },
        ],
      },
      type: "resource.batch_changed",
    });
    bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 6,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(scheduled).toHaveLength(1);
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBeNull();

    scheduled[0]();

    expect(commandInvalidations).toBe(1);
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(6);
  });

  it("coalesces session status invalidation once for status-affecting backend batches", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    let statusInvalidations = 0;

    bus.on("resource:invalidated", ({ resourceKey }) => {
      if (resourceKey === "session:status") {
        statusInvalidations += 1;
      }
    });

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_COMMANDS_PATH,
            resource: "commands",
            revision: 5,
          },
          {
            recommended_fetch: SIMULATION_SOLVER_STATUS_PATH,
            resource: "solver_status",
            revision: 6,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(statusInvalidations).toBe(1);
    expect(resources.getRevision("session:status")).toBe(
      dependentRevision(SIMULATION_SOLVER_STATUS_PATH, 6),
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(
      dependentRevision(SIMULATION_SOLVER_STATUS_PATH, 6),
    );
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(6);
  });

  it("does not refresh session status for visualization client ack batches", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: VISUALIZATION_CLIENT_ACKS_PATH,
            resource: "visualization_client_acks",
            revision: 9,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBeNull();
    expect(resources.getRevision(VISUALIZATION_CLIENT_ACKS_PATH)).toBe(9);
  });

  it("suppresses invalidations that were already satisfied locally", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources, {
      shouldSuppressInvalidation: (resourceKey, revision) =>
        resourceKey === VISUALIZATION_STATE_PATH && revision === 44,
    });

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: VISUALIZATION_STATE_PATH,
            resource: "visualization",
            revision: 44,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBeNull();
    expect(resources.getRevision(VISUALIZATION_STATE_PATH)).toBeNull();
  });

  it("maps resource family changes to subscribed child resources", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const fieldKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full&scope_kind=part&scope_id=body`;

    resources.subscribe(fieldKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            resource: "fields",
            revision: 8,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBeNull();
    expect(resources.getRevision(fieldKey)).toBe(8);
  });

  it("refreshes table row windows for scalar result batches without runtime or field fanout", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const tableRowsPath = DATA_TABLE_ROWS_PATH.replace("{table_id}", "default");
    const tableWindowKey = `${tableRowsPath}?columns=time%2Ce_total&cursor=10&limit=100`;

    resources.subscribe(tableWindowKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: tableRowsPath,
            resource_id: "table:default:rows",
            resource: "scalars",
            revision: 10,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBeNull();
    expect(resources.getRevision(tableRowsPath)).toBe(10);
    expect(resources.getRevision(tableWindowKey)).toBe(10);
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBeNull();
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBeNull();
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBeNull();
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBeNull();
  });

  it("emits scalar sample payload events without invalidating resources", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const samples: KernelEventMap["telemetry:scalar-sample"][] = [];
    bus.on("telemetry:scalar-sample", (sample) => samples.push(sample));
    const bridge = new RealtimeInvalidationBridge(resources, { bus });

    const handled = bridge.handleEvent({
      payload: { revision: 12, row: { e_total: 0.3, step: 7, time: 0.2 } },
      run_id: "run-1",
      session_id: "session-1",
      type: "scalar.sample",
    });

    expect(handled).toBe(true);
    expect(samples).toEqual([
      {
        revision: 12,
        row: { e_total: 0.3, step: 7, time: 0.2 },
        runId: "run-1",
        sessionId: "session-1",
        step: 7,
        time: 0.2,
      },
    ]);
    expect(resources.getRevision("session:status")).toBeNull();
    expect(resources.getRevision(DATA_TABLE_ROWS_PATH)).toBeNull();
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBeNull();
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBeNull();
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBeNull();
  });

  it("maps semantic field sample invalidations to subscribed field resources without invalidating the catalog", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const fieldKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=magnitude`;

    resources.subscribe(fieldKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            resource: "fields",
            resource_id: "samples",
            revision: 11,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBeNull();
    expect(resources.getRevision(fieldKey)).toBe(11);
  });

  it("refreshes subscribed field resources when only domain generation changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const fieldKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full`;

    resources.subscribe(fieldKey, () => {});

    for (const domainGenerationId of ["7", "8"]) {
      expect(
        bridge.handleEvent({
          payload: {
            changes: [
              {
                domain_generation_id: domainGenerationId,
                resource: "fields",
                resource_id: "samples",
                revision: 11,
              },
            ],
          },
          type: "resource.batch_changed",
        }),
      ).toBe(true);
    }

    expect(resources.getRevision(fieldKey)).toBe("generation:8:revision:11");
  });

  it("treats unsafe numeric domain generation IDs as unknown", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const fieldKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full`;

    resources.subscribe(fieldKey, () => {});

    expect(
      bridge.handleEvent({
        payload: {
          changes: [
            {
              domain_generation_id: Number.MAX_SAFE_INTEGER + 2,
              resource: "fields",
              resource_id: "samples",
              revision: 11,
            },
          ],
        },
        type: "resource.batch_changed",
      }),
    ).toBe(true);

    expect(resources.getRevision(fieldKey)).toBe(11);
  });

  it("maps quantity-scoped field sample invalidations only to matching field resources", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const mFieldKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=full&scope_kind=full`;
    const hEffFieldKey = `${DATA_FIELD_VECTOR_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=full&scope_kind=airbox&max_samples=1200`;
    const mCollectionKey = `${DATA_FIELDS_PATH}#viewport-3d:quantity-field-vectors:${mFieldKey}`;
    const hEffCollectionKey = `${DATA_FIELDS_PATH}#viewport-3d:airbox-field-vectors:${hEffFieldKey}`;

    resources.subscribe(mFieldKey, () => {});
    resources.subscribe(hEffFieldKey, () => {});
    resources.subscribe(mCollectionKey, () => {});
    resources.subscribe(hEffCollectionKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            quantity_ids: ["m"],
            resource: "fields",
            resource_id: "samples",
            revision: 12,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(DATA_FIELDS_PATH)).toBeNull();
    expect(resources.getRevision(mFieldKey)).toBe(12);
    expect(resources.getRevision(mCollectionKey)).toBe(12);
    expect(resources.getRevision(hEffFieldKey)).toBeNull();
    expect(resources.getRevision(hEffCollectionKey)).toBeNull();
  });

  it("uses an exact recommended field fetch before the quantity fallback", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const exactKey = serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery("H_eff", {
        component: "x",
        max_samples: 1200,
        phase_rad: 1.5,
        scope_id: "film",
        scope_kind: "object",
        snapshot_id: "snapshot-1",
        stage_id: "stage-1",
        view: "phase_rotated_real",
      }),
    );
    const otherObjectKey = serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery("H_eff", {
        component: "x",
        scope_id: "bar",
        scope_kind: "object",
      }),
    );
    const otherComponentKey = serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery("H_eff", {
        component: "y",
        scope_id: "film",
        scope_kind: "object",
      }),
    );
    const exactCollectionKey = `${DATA_FIELDS_PATH}#viewport-3d:quantity-field-vectors:${exactKey}`;
    const aggregateCollectionKey = `${DATA_FIELDS_PATH}#viewport-3d:quantity-field-vectors:${otherObjectKey}|${exactKey}|${otherComponentKey}`;

    resources.subscribe(exactKey, () => {});
    resources.subscribe(otherObjectKey, () => {});
    resources.subscribe(otherComponentKey, () => {});
    resources.subscribe(exactCollectionKey, () => {});
    resources.subscribe(aggregateCollectionKey, () => {});

    bridge.handleEvent({
      payload: {
        changes: [
          {
            quantity_ids: ["H_eff"],
            recommended_fetch:
              "/v2/sessions/current/data/fields/H_eff/samples/vector?view=phase_rotated_real&stage_id=stage-1&scope_kind=object&scope_id=object%3Afilm&snapshot_id=snapshot-1&phase_rad=1.5&max_samples=1200&component=x",
            resource: "fields",
            resource_id: "samples",
            revision: 14,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(resources.getRevision(exactKey)).toBe(14);
    expect(resources.getRevision(exactCollectionKey)).toBe(14);
    expect(resources.getRevision(aggregateCollectionKey)).toBe(14);
    expect(resources.getRevision(otherObjectKey)).toBeNull();
    expect(resources.getRevision(otherComponentKey)).toBeNull();
    expect(bridge.getFieldInvalidationTelemetry()).toEqual({
      broadInvalidations: 0,
      exactInvalidations: 1,
      refetches: 1,
    });
  });

  it("keeps topological-charge dependents current for exact magnetization events", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const topologicalChargeKey = ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH.replace(
      "{object_id}",
      "film",
    );
    resources.subscribe(topologicalChargeKey, () => {});

    bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch:
              "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=full",
            resource: "fields",
            resource_id: "samples",
            revision: 15,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(resources.getRevision(topologicalChargeKey)).toBe(15);
  });

  it("refreshes component field metadata when matching quantity samples change", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const hEffMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=y&scope_id=object%3Apermalloy_layer&scope_kind=object`;
    const hEffRawObjectMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=y&scope_id=permalloy_layer&scope_kind=object`;
    const mMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=y&scope_id=object%3Apermalloy_layer&scope_kind=object`;

    resources.subscribe(hEffMetaKey, () => {});
    resources.subscribe(hEffRawObjectMetaKey, () => {});
    resources.subscribe(mMetaKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            quantity_ids: ["H_eff"],
            resource: "fields",
            resource_id: "samples",
            revision: 13,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(hEffMetaKey)).toBe(13);
    expect(resources.getRevision(hEffRawObjectMetaKey)).toBe(13);
    expect(resources.getRevision(mMetaKey)).toBeNull();
  });

  it("refreshes object topological charge when magnetization samples change", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const topologicalChargeKey =
      ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH.replace("{object_id}", "body");
    const hEffMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=y&scope_id=body&scope_kind=object`;

    resources.subscribe(topologicalChargeKey, () => {});
    resources.subscribe(hEffMetaKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            quantity_ids: ["m"],
            resource: "fields",
            resource_id: "samples",
            revision: 17,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(topologicalChargeKey)).toBe(17);
    expect(resources.getRevision(hEffMetaKey)).toBeNull();
  });

  it("refreshes viewport 3D part scalar range collections when matching quantity samples change", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const hEffMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "H_eff",
    )}?component=x&scope_id=cofeb_top_ring&scope_kind=object`;
    const hEffPartScalarRangesKey = `${DATA_FIELDS_PATH}#viewport-3d:part-scalar-ranges:${hEffMetaKey}`;
    const mMetaKey = `${DATA_FIELD_META_PATH.replace(
      "{quantity_id}",
      "m",
    )}?component=x&scope_id=cofeb_top_ring&scope_kind=object`;
    const mPartScalarRangesKey = `${DATA_FIELDS_PATH}#viewport-3d:part-scalar-ranges:${mMetaKey}`;

    resources.subscribe(hEffPartScalarRangesKey, () => {});
    resources.subscribe(mPartScalarRangesKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: DATA_FIELDS_PATH,
            quantity_ids: ["H_eff"],
            resource: "fields",
            resource_id: "samples",
            revision: 14,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(hEffPartScalarRangesKey)).toBe(14);
    expect(resources.getRevision(mPartScalarRangesKey)).toBeNull();
  });

  it("refreshes mesh build dependents after latest successful build changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const objectTopologyKey = MESHING_OBJECT_TOPOLOGY_PATH.replace(
      "{object_id}",
      "box",
    );
    const objectReportKey = MESHING_OBJECT_REPORT_PATH.replace(
      "{object_id}",
      "box",
    );
    const objectQualityKey = MESHING_OBJECT_QUALITY_PATH.replace(
      "{object_id}",
      "box",
    );
    const objectSizeFieldKey = MESHING_OBJECT_SIZE_FIELD_PATH.replace(
      "{object_id}",
      "box",
    );
    const topologicalChargeKey =
      ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH.replace("{object_id}", "box");

    for (const resourceKey of [
      objectTopologyKey,
      objectReportKey,
      objectQualityKey,
      objectSizeFieldKey,
      topologicalChargeKey,
    ]) {
      resources.subscribe(resourceKey, () => {});
    }

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
            resource: "mesh-builds",
            revision: "mesh-build-9",
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(MESHING_BUILDS_LATEST_SUCCESSFUL_PATH)).toBe(
      "mesh-build-9",
    );
    expect(resources.getRevision(MODEL_SCENE_PATH)).toBe("mesh-build-9");
    expect(resources.getRevision(MESHING_BUILDS_CURRENT_PATH)).toBe(
      "mesh-build-9",
    );
    expect(resources.getRevision(MESHING_SUMMARY_PATH)).toBe("mesh-build-9");
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(
      "mesh-build-9",
    );
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_QUALITY_PATH)).toBe(
      "mesh-build-9",
    );
    expect(
      resources.getRevision(MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH),
    ).toBe("mesh-build-9");
    expect(resources.getRevision(VISUALIZATION_STATE_PATH)).toBe("mesh-build-9");
    expect(resources.getRevision(objectTopologyKey)).toBe("mesh-build-9");
    expect(resources.getRevision(objectReportKey)).toBe("mesh-build-9");
    expect(resources.getRevision(objectQualityKey)).toBe("mesh-build-9");
    expect(resources.getRevision(objectSizeFieldKey)).toBe("mesh-build-9");
    expect(resources.getRevision(topologicalChargeKey)).toBe("mesh-build-9");
  });

  it("ignores realtime lifecycle events without resource changes", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    expect(bridge.handleEvent({ type: "heartbeat" })).toBe(false);
  });

  it("maps resync-required events to status invalidation", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);

    const handled = bridge.handleEvent({
      payload: {
        reason: "sequence_gap",
        replay_available_after_seq: 12,
      },
      type: "resync.required",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBe(12);
  });

  it("invalidates runtime lifecycle resources when realtime recommends the stage resource", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const hysteresisProgressKey =
      SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace("{stage_id}", "stage-000");
    const hysteresisTreeKey = `${SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH.replace(
      "{stage_id}",
      "stage-000",
    )}:window=active:before=2:after=3`;
    const hysteresisPointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const hysteresisMetricsKey = ANALYSIS_HYSTERESIS_METRICS_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const hysteresisPointKey = ANALYSIS_HYSTERESIS_POINT_PATH.replace(
      "{stage_id}",
      "stage-000",
    ).replace("{point_id}", "12");
    const hysteresisSettleTraceKey = ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH.replace(
      "{stage_id}",
      "stage-000",
    ).replace("{point_id}", "12");
    const hysteresisStageSettleTraceKey =
      ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH.replace(
        "{stage_id}",
        "stage-000",
      );

    resources.subscribe(hysteresisProgressKey, () => {});
    resources.subscribe(hysteresisTreeKey, () => {});
    resources.subscribe(hysteresisPointsKey, () => {});
    resources.subscribe(hysteresisMetricsKey, () => {});
    resources.subscribe(hysteresisPointKey, () => {});
    resources.subscribe(hysteresisSettleTraceKey, () => {});
    resources.subscribe(hysteresisStageSettleTraceKey, () => {});

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: SIMULATION_STAGES_EXECUTION_PATH,
            resource: "stages",
            revision: 44,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision("session:status")).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(44);
    expect(resources.getRevision(SIMULATION_SOLVER_STATUS_PATH)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(SIMULATION_COMMANDS_PATH)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(hysteresisProgressKey)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(hysteresisTreeKey)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(hysteresisPointsKey)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(hysteresisMetricsKey)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(hysteresisPointKey)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(hysteresisSettleTraceKey)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
    expect(resources.getRevision(hysteresisStageSettleTraceKey)).toBe(
      dependentRevision(SIMULATION_STAGES_EXECUTION_PATH, 44),
    );
  });

  it("refreshes stage hysteresis analysis dependents when points update", () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources);
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const branchesKey = ANALYSIS_HYSTERESIS_BRANCHES_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const metricsKey = ANALYSIS_HYSTERESIS_METRICS_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const saturationKey = ANALYSIS_HYSTERESIS_SATURATION_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const adaptiveRefinementKey =
      ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH.replace(
        "{stage_id}",
        "stage-000",
      );
    const bookmarksKey = ANALYSIS_HYSTERESIS_BOOKMARKS_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const familyKey = ANALYSIS_HYSTERESIS_FAMILY_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const familyVariantPointsKey =
      ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH.replace(
        "{stage_id}",
        "stage-000",
      ).replace("{variant_id}", "oop");
    const minorLoopsKey = ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const reversalFieldsKey = ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH.replace(
      "{stage_id}",
      "stage-000",
    );
    const pointKey = ANALYSIS_HYSTERESIS_POINT_PATH.replace(
      "{stage_id}",
      "stage-000",
    ).replace("{point_id}", "12");
    const settleTraceKey = ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH.replace(
      "{stage_id}",
      "stage-000",
    ).replace("{point_id}", "12");
    const stageSettleTraceKey =
      ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH.replace(
        "{stage_id}",
        "stage-000",
      );
    const otherStagePointKey = ANALYSIS_HYSTERESIS_POINT_PATH.replace(
      "{stage_id}",
      "stage-999",
    ).replace("{point_id}", "12");

    for (const resourceKey of [
      pointsKey,
      branchesKey,
      metricsKey,
      saturationKey,
      adaptiveRefinementKey,
      bookmarksKey,
      familyKey,
      familyVariantPointsKey,
      minorLoopsKey,
      reversalFieldsKey,
      pointKey,
      settleTraceKey,
      stageSettleTraceKey,
      otherStagePointKey,
    ]) {
      resources.subscribe(resourceKey, () => {});
    }

    const handled = bridge.handleEvent({
      payload: {
        changes: [
          {
            recommended_fetch: pointsKey,
            resource: "analysis.hysteresis.points",
            revision: 51,
          },
        ],
      },
      type: "resource.batch_changed",
    });

    expect(handled).toBe(true);
    expect(resources.getRevision(pointsKey)).toBe(51);
    expect(resources.getRevision(branchesKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(metricsKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(saturationKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(adaptiveRefinementKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(bookmarksKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(familyKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(familyVariantPointsKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(minorLoopsKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(reversalFieldsKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(pointKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(settleTraceKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(stageSettleTraceKey)).toBe(
      dependentRevision(pointsKey, 51),
    );
    expect(resources.getRevision(otherStagePointKey)).toBeNull();
  });
});
