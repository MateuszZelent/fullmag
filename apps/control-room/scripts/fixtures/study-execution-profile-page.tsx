"use client";

import { useEffect, useSyncExternalStore } from "react";

import { API_INSTANCE_HEADER } from "@/kernel/api/apiInstancePin";
import {
  API_CONTRACT_VERSION_HEADER,
  EXPECTED_API_CONTRACT_VERSION,
  MODEL_SCENE_PATH,
  MODEL_TRANSACTIONS_PATH,
  PLATFORM_COMPUTE_PROFILES_PATH,
  PLATFORM_HEALTH_PATH,
  SESSION_STATUS_PATH,
  SESSIONS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  ExecutionProfile,
  ExecutionProfileVersionResource,
  LiveStatusResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { KernelProvider } from "@/kernel/KernelProvider";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { KernelApi } from "@/kernel/types";
import type { InspectorEditSession } from "@/modules/inspector/InspectorEditSession";
import {
  InspectorEditSessionProvider,
  useInspectorEditSession,
} from "@/modules/inspector/InspectorEditSession";
import { StudyInspectorPanel } from "@/modules/inspector/panels/StudyInspectorPanel";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";

const API_INSTANCE = "11111111-1111-4111-8111-111111111111";
const SECOND_API_INSTANCE = "22222222-2222-4222-8222-222222222222";
const SESSION_IDS = ["fixture-study-session-one", "fixture-study-session-two"] as const;
const SESSION_EPOCHS = ["study-epoch-one", "study-epoch-two"] as const;
const REQUEST_SCOPE_EPOCHS = ["scope-one", "scope-two"] as const;

const SESSION_ONE_PROFILE: ExecutionProfile = {
  schema_version: "execution_profile.v1",
  profile_id: "exec:session-one",
  version: "1",
  description: "Profile already bound to the first scene",
  defaults: { backend: "fem", device: "cpu", precision: "double", mode: "strict" },
};

const SESSION_TWO_PROFILE: ExecutionProfile = {
  schema_version: "execution_profile.v1",
  profile_id: "exec:session-two",
  version: "1",
  description: "Profile already bound to the second scene",
  defaults: { backend: "fdm", device: "cpu", precision: "double", mode: "strict" },
};

const ADVANCED_PROFILE: ExecutionProfile = {
  schema_version: "execution_profile.v1",
  profile_id: "exec:catalog-advanced",
  version: "7",
  description: "Immutable version with advanced resources",
  defaults: {
    backend: "fem",
    device: "gpu",
    precision: "double",
    mode: "strict",
    resources: {
      target: { kind: "local" },
      cpu: {
        threads: 12,
        core_policy: "physical_first",
        affinity: "numa",
        numa_node: 2,
        native_threads: "auto",
        blas_threads: 3,
      },
      gpu: {
        selector: "allow_list",
        device_uuids: ["GPU-study-fixture-1"],
        devices_per_task: 1,
        vram_per_device_bytes: 8_589_934_592,
      },
      ram: { reservation_bytes: 17_179_869_184 },
      scratch: { reservation_bytes: 2_147_483_648 },
      parallelism: { kind: "single_process" },
      placement: "pinned",
    },
  },
};

const ALTERNATE_PROFILE: ExecutionProfile = {
  schema_version: "execution_profile.v1",
  profile_id: "exec:catalog-alternate",
  version: "2",
  description: "Second catalogue version used for scoped draft checks",
  defaults: { backend: "auto", device: "auto", precision: "single", mode: "extended" },
};

const CONFLICT_PROFILE: ExecutionProfile = {
  schema_version: "execution_profile.v1",
  profile_id: "exec:conflict-target",
  version: "3",
  description: "Version used for revision conflict coverage",
  defaults: { backend: "fem", device: "auto", precision: "double", mode: "strict" },
};

const ADVANCED_LAYERS = [
  {
    origin: { kind: "script", location: "fixture/script.py:study" },
    request: {
      backend: "fem",
      resources: {
        target: { kind: "local" },
        cpu: {
          core_policy: "logical",
          affinity: "numa",
          numa_node: 3,
          native_threads: "auto",
          blas_threads: 6,
        },
        gpu: {
          selector: "required",
          device_uuids: ["GPU-script-fixture"],
          devices_per_task: 1,
          vram_per_device_bytes: 4_294_967_296,
        },
        ram: { reservation_bytes: 4_294_967_296 },
        scratch: { reservation_bytes: 1_073_741_824 },
        parallelism: { kind: "single_process" },
        placement: "throughput",
      },
    },
  },
  {
    origin: { kind: "study", location: "Existing Study override" },
    request: {
      device: "cpu",
      resources: {
        cpu: {
          threads: 8,
          core_policy: "physical_first",
          affinity: "compact",
          numa_node: 1,
          native_threads: "auto",
          blas_threads: 4,
        },
      },
    },
  },
] as const;

type FixtureTransaction = {
  readonly body: AuthoringTransactionRequest;
  readonly baseRevision: number | null;
  readonly currentSessionId: string;
  readonly outcome: "committed" | "conflict" | "scope-conflict";
  readonly sessionScope: string | null;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonResponse(body: unknown, pin: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      [API_INSTANCE_HEADER]: pin,
      [API_CONTRACT_VERSION_HEADER]: EXPECTED_API_CONTRACT_VERSION,
    },
  });
}

function profileEntry(
  profile: ExecutionProfile,
  clientIntentId: string,
  revision: number,
): ExecutionProfileVersionResource {
  return {
    profile: clone(profile),
    profile_sha256: "a".repeat(64),
    client_intent_id: clientIntentId,
    published_at: "2026-10-05T12:00:00Z",
    revision,
  };
}

function sceneForSession(index: 0 | 1): SceneResource {
  const revision = 1;
  return {
    revision,
    scene_revision: revision,
    objects: [],
    materials: [],
    study: {
      requested_backend: index === 0 ? "fem" : "fdm",
      requested_device: "cpu",
      requested_mode: "strict",
      requested_precision: "double",
      requested_cpu_threads: 4,
      exchange_enabled: true,
      demag_enabled: true,
      solver: {},
      stages: index === 0 ? [] : [{
        device: "gpu",
        entrypoint_kind: "flat_change_device",
        kind: "change_device",
        stage_id: "fixture-existing-change-device",
      }],
      execution_profile: clone(index === 0 ? SESSION_ONE_PROFILE : SESSION_TWO_PROFILE),
      execution_layers: clone(ADVANCED_LAYERS),
    },
  };
}

function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = clone(target);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const existing = result[key];
      result[key] = mergePatch(
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? existing as Record<string, unknown>
          : {},
        value as Record<string, unknown>,
      );
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

class StudyExecutionProfileFixture {
  private readonly originalFetch = globalThis.fetch.bind(globalThis);
  private activeKernel: KernelApi | null = null;
  private editSession: InspectorEditSession | null = null;
  private currentSessionIndex: 0 | 1 = 0;
  private invalidationRevision = 1;
  private nextConflict = false;
  private readonly scenes = [sceneForSession(0), sceneForSession(1)];
  private readonly profiles = [
    profileEntry(SESSION_ONE_PROFILE, "fixture-session-one", 1),
    profileEntry(SESSION_TWO_PROFILE, "fixture-session-two", 1),
    profileEntry(ADVANCED_PROFILE, "fixture-advanced", 1),
    profileEntry(ALTERNATE_PROFILE, "fixture-alternate", 1),
    profileEntry(CONFLICT_PROFILE, "fixture-conflict", 1),
  ];
  private readonly requests: Array<{
    method: string;
    path: string;
    pin: string | null;
    sessionScope: string | null;
  }> = [];
  private readonly transactions: FixtureTransaction[] = [];
  private readonly unhandled: string[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v2/")) return this.originalFetch(request);

    const pin = request.headers.get(API_INSTANCE_HEADER);
    const sessionScope = request.headers.get("x-fullmag-session-scope");
    this.requests.push({ method: request.method, path: url.pathname, pin, sessionScope });
    if (pin !== API_INSTANCE && pin !== SECOND_API_INSTANCE) {
      return jsonResponse({ code: "fixture_api_instance_mismatch", message: "Unexpected API instance pin." }, API_INSTANCE, 409);
    }

    if (request.method === "GET" && url.pathname === SESSIONS_PATH) {
      return jsonResponse(this.sessionCollection(), pin);
    }
    if (request.method === "GET" && url.pathname === PLATFORM_HEALTH_PATH) {
      return jsonResponse({
        active_session: true,
        api_contract_version: EXPECTED_API_CONTRACT_VERSION,
        status: "ok",
        uptime_seconds: 1,
      }, pin);
    }
    if (request.method === "GET" && url.pathname === SESSION_STATUS_PATH) {
      return jsonResponse(this.sessionStatus(), pin);
    }
    if (request.method === "GET" && url.pathname === PLATFORM_COMPUTE_PROFILES_PATH) {
      return jsonResponse({
        schema_version: "execution_profile_catalog.v1",
        revision: 1,
        total: this.profiles.length,
        offset: 0,
        next_offset: null,
        entries: clone(this.profiles),
      }, pin);
    }
    if (request.method === "GET" && url.pathname === MODEL_SCENE_PATH) {
      return jsonResponse(clone(this.currentScene()), pin);
    }
    if (request.method === "POST" && url.pathname === MODEL_TRANSACTIONS_PATH) {
      const body = await request.json() as AuthoringTransactionRequest;
      return this.commitTransaction(body, pin, sessionScope);
    }
    if (request.method === "GET" && url.pathname.includes("/platform/")) {
      return jsonResponse({}, pin, 404);
    }
    this.unhandled.push(`${request.method} ${url.pathname}`);
    return jsonResponse({
      code: "fixture_resource_not_materialized",
      message: "This runtime resource is outside the Study profile browser fixture.",
    }, pin, 404);
  };

  attach(kernel: KernelApi, editSession: InspectorEditSession | null): () => void {
    this.activeKernel = kernel;
    this.editSession = editSession;
    return () => {
      if (this.activeKernel === kernel) this.activeKernel = null;
      this.editSession = null;
    };
  }

  private currentSessionId(): string {
    return SESSION_IDS[this.currentSessionIndex];
  }

  private currentSessionScope(): string {
    return `session=${encodeURIComponent(SESSION_IDS[this.currentSessionIndex])}&epoch=${encodeURIComponent(SESSION_EPOCHS[this.currentSessionIndex])}&request_scope_epoch=${encodeURIComponent(REQUEST_SCOPE_EPOCHS[this.currentSessionIndex])}`;
  }

  private currentScene(): SceneResource {
    return this.scenes[this.currentSessionIndex];
  }

  private sessionCollection() {
    return {
      schema_version: "fullmag.session-list.v1",
      sessions: SESSION_IDS.map((sessionId, index) => ({
        current: index === this.currentSessionIndex,
        name: `Study fixture ${index + 1}`,
        session_id: sessionId,
        status: "active",
      })),
    };
  }

  private sessionStatus(): LiveStatusResource {
    const scene = this.currentScene();
    const revision = scene.revision ?? 1;
    return {
      api_contract_version: EXPECTED_API_CONTRACT_VERSION,
      runtime_bundle_version: "study-profile-browser-fixture",
      session: {
        created_at: "2026-10-05T11:00:00Z",
        name: `Study fixture ${this.currentSessionIndex + 1}`,
        request_scope_epoch: REQUEST_SCOPE_EPOCHS[this.currentSessionIndex],
        session_epoch: SESSION_EPOCHS[this.currentSessionIndex],
        session_id: SESSION_IDS[this.currentSessionIndex],
        workspace_root: "fixture://study-profile",
      },
      capabilities: {
        active_lane: {
          schema_version: "active-lane-capabilities.v2",
          authored: {
            backend: "not_evaluated",
            discretization: "not_evaluated",
            device: "not_evaluated",
            precision: "not_evaluated",
            mode: "not_evaluated",
          },
          requested: {
            backend: "not_evaluated",
            discretization: "not_evaluated",
            device: "not_evaluated",
            precision: "not_evaluated",
            mode: "not_evaluated",
          },
          source: {
            kind: "unavailable",
            authored_intent: "not_evaluated",
            effective_request: "not_evaluated",
          },
          qualification: {
            status: "not_evaluated",
            reason: "This browser fixture does not resolve or evaluate execution admission.",
          },
          operations: {},
        },
        algorithms_available: ["llg_overdamped"],
        binary_fields: false,
        cell_fields: false,
        eigen_modes: false,
        explicit_topology: false,
        gpu_telemetry: false,
        node_fields: false,
        preview_2d: false,
        preview_3d: false,
        scalar_history: false,
        structured_grid: false,
      },
      display: {
        active_quantity_id: "magnetization",
        auto_contrast: true,
        colormap: "viridis",
        field_component: "magnitude",
        max_points: 1000,
        slice_layer: 0,
        slice_mode: "xy",
        vector_density: 12,
        vector_glyphs: false,
        view_mode: "3d",
        x_chosen_size: 800,
        y_chosen_size: 600,
      },
      domain: { cell_count: 0, discretization: "fem", generation_id: `fixture-domain-${this.currentSessionIndex + 1}` },
      energies: {},
      lifecycle: {
        commandability: "allowed",
        connectivity: "connected",
        session_resource: "active",
        solver: "idle",
      },
      metrics: { total_steps: 0, uptime_seconds: 1 },
      resources: {
        artifact_revision: 0,
        artifacts_revision: 0,
        command_completion_revision: 0,
        commands_revision: 0,
        display_revision: 0,
        domain_generation_id: `fixture-domain-${this.currentSessionIndex + 1}`,
        engine_log_revision: 0,
        field_catalog_revision: 0,
        field_revision: 0,
        fields_revision: 0,
        mesh_build_revision: 0,
        mesh_revision: 0,
        mode_composition_revision: 0,
        region_coefficients_revision: 0,
        region_initial_state_revision: 0,
        region_membership_revision: 0,
        region_topology_revision: 0,
        scalars_revision: 0,
        scene_revision: revision,
        simulation_preparation_revision: 0,
        slice_revision: 0,
        solver_profile_revision: 0,
        stages_revision: 0,
        topology_revision: 0,
        visualization_state_revision: 0,
        workspace_revision: 0,
      },
      run: null,
      solver: { state: "idle" },
    };
  }

  private commitTransaction(
    body: AuthoringTransactionRequest,
    pin: string,
    sessionScope: string | null,
  ): Response {
    const scene = this.currentScene();
    const currentSessionId = this.currentSessionId();
    const baseRevision = body.base_revision ?? null;
    const expectedScope = this.currentSessionScope();
    if (sessionScope !== expectedScope) {
      this.transactions.push({ body: clone(body), baseRevision, currentSessionId, outcome: "scope-conflict", sessionScope });
      return jsonResponse({ code: "session_scope_conflict", message: "The fixture session scope changed." }, pin, 409);
    }
    if (this.nextConflict || baseRevision !== scene.revision) {
      this.nextConflict = false;
      scene.revision = (scene.revision ?? 0) + 1;
      scene.scene_revision = scene.revision;
      this.transactions.push({ body: clone(body), baseRevision, currentSessionId, outcome: "conflict", sessionScope });
      return jsonResponse({ code: "scene_revision_conflict", message: "Fixture scene changed before this transaction." }, pin, 409);
    }

    if (body.kind === "assign_study_execution") {
      const nextStudy = {
        ...(scene.study ?? {}),
        execution_profile: clone(body.execution_profile),
        execution_layers: clone(body.execution_layers),
      };
      scene.study = nextStudy;
    } else if (body.kind === "merge_patch") {
      const patched = mergePatch(
        { study: scene.study ?? {} },
        body.merge_patch,
      );
      scene.study = patched.study as SceneResource["study"];
    } else {
      this.unhandled.push(`POST ${MODEL_TRANSACTIONS_PATH} kind=${body.kind}`);
      return jsonResponse({ code: "fixture_transaction_kind_unavailable", message: "Unsupported fixture transaction." }, pin, 400);
    }

    scene.revision = (scene.revision ?? 0) + 1;
    scene.scene_revision = scene.revision;
    this.transactions.push({ body: clone(body), baseRevision, currentSessionId, outcome: "committed", sessionScope });
    return jsonResponse({
      committed_scene: clone(scene),
      scene_revision: scene.revision,
      transaction_kind: body.kind,
    }, pin);
  }

  armNextConflict(): void {
    this.nextConflict = true;
  }

  switchSession(): void {
    this.currentSessionIndex = this.currentSessionIndex === 0 ? 1 : 0;
    this.invalidationRevision += 1;
    this.activeKernel?.resources.invalidate(SESSIONS_PATH, this.invalidationRevision);
    this.activeKernel?.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, this.invalidationRevision);
  }

  async applyRegisteredEdit(): Promise<boolean> {
    return (await this.editSession?.apply()) === true;
  }

  read() {
    return {
      api_instance: this.activeKernel?.api.getExpectedApiInstance() ?? null,
      current_session_id: this.currentSessionId(),
      current_session_scope: this.currentSessionScope(),
      history: this.activeKernel?.authoringHistory?.getSnapshot() ?? null,
      edit_session: this.editSession
        ? { dirty: this.editSession.dirty, valid: this.editSession.valid, mode: this.editSession.mode }
        : null,
      scene: clone(this.currentScene()),
      transactions: clone(this.transactions),
      requests: clone(this.requests),
      unhandled: [...this.unhandled],
    };
  }
}

declare global {
  interface Window {
    __studyExecutionProfileFixture?: StudyExecutionProfileFixture;
  }
}

class FixtureBootstrap {
  private ready = false;
  private readonly listeners = new Set<() => void>();
  private restoreFetch: (() => void) | null = null;

  readonly getSnapshot = () => this.ready;
  readonly getServerSnapshot = () => false;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.ready) {
      const original = globalThis.fetch;
      const fixture = window.__studyExecutionProfileFixture ??= new StudyExecutionProfileFixture();
      globalThis.fetch = fixture.fetch;
      this.restoreFetch = () => {
        if (globalThis.fetch === fixture.fetch) globalThis.fetch = original;
      };
      this.ready = true;
      for (const notify of this.listeners) notify();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.restoreFetch?.();
        this.restoreFetch = null;
        this.ready = false;
      }
    };
  };
}

const fixtureBootstrap = new FixtureBootstrap();
const studySelection: Selection = {
  kind: "study",
  label: "Study",
  objectId: null,
  nodeId: "study:root",
  ref: null,
  moduleSource: "study",
};

export default function StudyExecutionProfileFixturePage() {
  const ready = useSyncExternalStore(
    fixtureBootstrap.subscribe,
    fixtureBootstrap.getSnapshot,
    fixtureBootstrap.getServerSnapshot,
  );

  return ready ? (
    <KernelProvider>
      <InspectorEditSessionProvider>
        <StudyExecutionProfileFixtureHost />
      </InspectorEditSessionProvider>
    </KernelProvider>
  ) : (
    <p>Initializing controlled Study profile fixture.</p>
  );
}

function StudyExecutionProfileFixtureHost() {
  const kernel = useKernel();
  const editSession = useInspectorEditSession();
  const fixture = window.__studyExecutionProfileFixture;

  useEffect(() => fixture?.attach(kernel, editSession), [editSession, fixture, kernel]);

  return (
    <main className="grid gap-4 p-6" data-study-execution-profile-fixture="true">
      <p className="sr-only">Controlled HTTP and authoring-history fixture; no solver or backend runtime is started.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => fixture?.switchSession()} size="sm" type="button" variant="secondary">
          Switch fixture session
        </Button>
        <Button onClick={() => fixture?.armNextConflict()} size="sm" type="button" variant="secondary">
          Arm scene revision conflict
        </Button>
        <Button onClick={() => void fixture?.applyRegisteredEdit()} size="sm" type="button" variant="secondary">
          Apply registered Inspector changes
        </Button>
      </div>
      <output
        data-study-profile-edit-session={editSession?.dirty ? "dirty" : "clean"}
        data-study-profile-session-id={fixture?.read().current_session_id ?? "loading"}
        data-study-profile-session-scope={kernel.commands.getSessionScopeKey() ?? "none"}
      >
        {editSession?.dirty ? "Study profile draft is dirty" : "Study profile draft is clean"}
      </output>
      <div className="max-w-xl">
        <StudyInspectorPanel selection={studySelection} />
      </div>
    </main>
  );
}
