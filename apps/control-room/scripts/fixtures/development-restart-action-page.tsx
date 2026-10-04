"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { API_INSTANCE_HEADER } from "@/kernel/api/apiInstancePin";
import {
  API_CONTRACT_VERSION_HEADER,
  EXPECTED_API_CONTRACT_VERSION,
  PLATFORM_DEVELOPMENT_BACKEND_PATH,
  PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH,
  PLATFORM_HEALTH_PATH,
  SESSIONS_PATH,
} from "@/kernel/api/apiPaths";
import type { DevelopmentBackendResource, DevelopmentRestartRequest, DevelopmentRestartResource } from "@/kernel/api/apiTypes";
import { DevelopmentWorkspaceInputBoundary } from "@/kernel/development/DevelopmentWorkspaceInputBoundary";
import type { DevelopmentRestartActionService } from "@/kernel/development/DevelopmentRestartActionService";
import { useKernel } from "@/kernel/KernelContext";
import { KernelProvider } from "@/kernel/KernelProvider";
import { DevelopmentBackendBanner } from "@/kernel/layout/DevelopmentBackendBanner";
import { developmentBackendResourceKey } from "@/kernel/resources/developmentBackendResource";
import type { KernelApi } from "@/kernel/types";

const PINS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const SOURCES = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)];

interface CapturedIntent {
  readonly request: DevelopmentRestartRequest;
  readonly token: string;
  readonly newPin: string;
  ready: boolean;
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

/** Controlled HTTP outcomes, not a native launcher or a solver implementation. */
class RestartActionFixture {
  private readonly originalFetch = globalThis.fetch.bind(globalThis);
  private activeKernel: KernelApi | null = null;
  private initialKernel: KernelApi | null = null;
  private initialService: DevelopmentRestartActionService | null = null;
  private readonly intents: CapturedIntent[] = [];
  private mode: "unavailable" | "ready" | "building" = "unavailable";
  private candidate = 1;
  private revision = 1;
  private holdStatus = false;
  private heldStatus: Array<() => void> = [];
  private readonly statusReads: Array<{ requestId: string; tokenMatches: boolean }> = [];
  private readonly unexpected: string[] = [];
  private readonly requests: Array<{ method: string; path: string }> = [];
  private mounts = 0;
  private readonly dirtyFormOwner = Symbol("restart action fixture dirty form");
  private formApplyCalls = 0;
  private formResetCalls = 0;
  private cleanupFaultUnsubscribe: (() => void) | null = null;
  private guardedCaptureReads = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/v2/")) return this.originalFetch(request);
    this.requests.push({ method: request.method, path });
    const pin = request.headers.get(API_INSTANCE_HEADER) ?? PINS[0];
    if (!PINS.includes(pin)) return this.unexpectedRequest(request, pin);
    if (request.method === "GET" && path === SESSIONS_PATH) {
      return jsonResponse({ schema_version: "fullmag.session-list.v1", sessions: [] }, pin);
    }
    if (request.method === "GET" && path === PLATFORM_HEALTH_PATH) {
      return jsonResponse({ active_session: false, api_contract_version: EXPECTED_API_CONTRACT_VERSION, status: "ok", uptime_seconds: 1 }, pin);
    }
    if (request.method === "GET" && path === PLATFORM_DEVELOPMENT_BACKEND_PATH) {
      if (this.holdStatus) await new Promise<void>((resolve) => this.heldStatus.push(resolve));
      const observation = this.backend(pin);
      const action = this.activeKernel?.developmentWorkspace?.restartAction.getSnapshot();
      if (this.cleanupFaultUnsubscribe && action?.busy && ["checking", "capturing"].includes(action.state)) {
        this.guardedCaptureReads += 1;
        if (this.guardedCaptureReads === 3) {
          return jsonResponse({ ...observation, ready_build: { id: "changed-during-capture", source_sha256: SOURCES[4] } }, pin);
        }
      }
      return jsonResponse(observation, pin);
    }
    if (request.method === "POST" && path === PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH) {
      const body = await request.json() as DevelopmentRestartRequest;
      const token = request.headers.get("authorization") ?? "";
      if (!/^Bearer [0-9a-f]{32}$/.test(token) || body.schema !== "fullmag.development-ui-restart-request.v1"
        || body.session_id !== null || body.session_epoch !== 0 || !body.request_id) {
        return this.unexpectedRequest(request, pin);
      }
      this.intents.push({ request: body, token, newPin: PINS[this.intents.length + 1], ready: false });
      // The durable intent is recorded before the response is deliberately lost.
      throw new TypeError("Fixture lost restart acknowledgement");
    }
    const statusPrefix = `${PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH}/`;
    if (request.method === "GET" && path.startsWith(statusPrefix)) {
      const requestId = path.slice(statusPrefix.length);
      const intent = this.intents.find((item) => item.request.request_id === requestId);
      const tokenMatches = !!intent && request.headers.get("authorization") === intent.token;
      this.statusReads.push({ requestId, tokenMatches });
      if (!intent || !tokenMatches) return this.unexpectedRequest(request, pin);
      const response: DevelopmentRestartResource = intent.ready ? {
        ...intent.request,
        schema: "fullmag.development-ui-restart-resource.v1",
        state: "ready",
        new_api_instance_id: intent.newPin,
      } : {
        schema: "fullmag.development-ui-restart-resource.v1", request_id: requestId, state: "pending",
      };
      return jsonResponse(response, intent.ready ? intent.newPin : pin);
    }
    return this.unexpectedRequest(request, pin);
  };

  mount(kernel: KernelApi): () => void {
    this.activeKernel = kernel;
    this.mounts += 1;
    this.initialKernel ??= kernel;
    this.initialService ??= kernel.developmentWorkspace?.restartAction ?? null;
    return () => { if (this.activeKernel === kernel) this.activeKernel = null; };
  }

  backend(pin: string): DevelopmentBackendResource {
    const current = Math.max(0, PINS.indexOf(pin));
    return {
      schema_version: "1.0.0", configured: true,
      current_build: { id: `running-${current}`, source_sha256: SOURCES[current] },
      ready_build: { id: `candidate-${this.candidate}`, source_sha256: SOURCES[this.candidate] },
      reason: "restart_integration_pending", state: this.mode === "building" ? "building" : "ready",
      restart_available: this.mode === "ready", revision: this.revision,
      workspace_identity: { api_instance_id: pin, session_id: null, session_epoch: 0 },
    };
  }

  setMode(mode: "unavailable" | "ready" | "building", candidate = this.candidate): void {
    this.mode = mode;
    this.candidate = candidate;
    this.revision += 1;
    const kernel = this.activeKernel;
    if (kernel) kernel.resources.invalidate(developmentBackendResourceKey(kernel.api.resourceCacheScope), this.revision);
  }

  beginHeldRefresh(): void {
    this.holdStatus = true;
    this.setMode("ready");
  }

  releaseHeldRefresh(): void {
    this.holdStatus = false;
    const held = this.heldStatus;
    this.heldStatus = [];
    for (const release of held) release();
  }

  allowReady(): void {
    const intent = this.intents.at(-1);
    if (!intent) throw new Error("Fixture has no restart intent");
    intent.ready = true;
  }

  remountBanner(): void {
    window.dispatchEvent(new Event("fixture-remount-banner"));
  }

  setPendingForm(enabled: boolean): void {
    const forms = this.activeKernel?.pendingForms;
    if (!forms) throw new Error("Fixture pending forms owner is unavailable");
    if (!enabled) { forms.unregister(this.dirtyFormOwner); return; }
    forms.register(this.dirtyFormOwner, {
      mode: "staged", dirty: true, valid: true, applying: false,
      apply: () => { this.formApplyCalls += 1; return true; },
      reset: () => { this.formResetCalls += 1; },
    });
  }

  armPreIntentCleanupFault(): void {
    const kernel = this.activeKernel;
    if (!kernel?.pendingForms || !kernel.developmentWorkspace) throw new Error("Fixture owners are unavailable");
    const forms = kernel.pendingForms;
    const host = kernel.developmentWorkspace;
    let observedGuard = false;
    this.guardedCaptureReads = 0;
    this.cleanupFaultUnsubscribe = forms.subscribe(() => {
      const guarded = forms.getTransitionSnapshot().guarded;
      if (guarded) observedGuard = true;
      if (observedGuard && !guarded && host.getSnapshot().paused) throw new Error("Fixture forms cleanup observer failed");
    });
  }

  clearCleanupFault(): void {
    this.cleanupFaultUnsubscribe?.();
    this.cleanupFaultUnsubscribe = null;
  }

  async probeBlockedStart(): Promise<void> {
    const kernel = this.activeKernel;
    if (!kernel?.developmentWorkspace) throw new Error("Fixture host is unavailable");
    await kernel.developmentWorkspace.restartAction.start(kernel, {
      data: this.backend(kernel.api.getExpectedApiInstance()!),
      error: null, status: "ready", revision: this.revision, refetch: () => {},
    });
  }

  read() {
    const kernel = this.activeKernel;
    const host = kernel?.developmentWorkspace;
    return {
      pin: kernel?.api.getExpectedApiInstance() ?? null,
      generation: host?.getSnapshot().generation ?? null,
      paused: host?.getSnapshot().paused ?? false,
      publicationError: host?.getSnapshot().publicationError ?? null,
      action: host?.restartAction.getSnapshot() ?? null,
      sameService: !!host && host.restartAction === this.initialService,
      mounts: this.mounts,
      posts: this.intents.map(({ request }) => ({ requestId: request.request_id, projectDocument: request.project_document, workspace: request.workspace })),
      statusReads: [...this.statusReads], unexpected: [...this.unexpected],
      requests: [...this.requests], heldReads: this.heldStatus.length,
      boundaryInert: document.querySelector("[data-fixture-workspace] main")?.hasAttribute("inert") ?? false,
      emptyDocument: kernel?.projectDocument?.getSnapshot().state === "empty",
      navigationPin: new URL(window.location.href).searchParams.get("fullmag_api_instance"),
      originalKernelRetained: kernel === this.initialKernel,
      formApplyCalls: this.formApplyCalls, formResetCalls: this.formResetCalls,
      guardedCaptureReads: this.guardedCaptureReads,
    };
  }

  async probeRetiredTransport() {
    const countBefore = this.requests.length;
    let code: string | null = null;
    try { await this.initialKernel?.api.sessions.list(); }
    catch (error) { if (error && typeof error === "object" && "code" in error && typeof error.code === "string") code = error.code; }
    return { code, noNetwork: this.requests.length === countBefore };
  }

  private unexpectedRequest(request: Request, pin: string): Response {
    this.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
    return jsonResponse({ code: "fixture_unexpected_request", message: "Unexpected restart action fixture request" }, pin, 404);
  }
}

declare global {
  interface Window { __developmentRestartActionFixture?: RestartActionFixture }
}

/** Install the controlled network through subscription, before mounting API consumers. */
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
      const fixture = window.__developmentRestartActionFixture ??= new RestartActionFixture();
      globalThis.fetch = fixture.fetch;
      this.restoreFetch = () => { if (globalThis.fetch === fixture.fetch) globalThis.fetch = original; };
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

const bootstrap = new FixtureBootstrap();

function FixtureBody() {
  const kernel = useKernel();
  const host = kernel.developmentWorkspace!;
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const [bannerGeneration, setBannerGeneration] = useState(0);
  useEffect(() => window.__developmentRestartActionFixture?.mount(kernel), [kernel]);
  useEffect(() => {
    const remount = () => setBannerGeneration((value) => value + 1);
    window.addEventListener("fixture-remount-banner", remount);
    return () => window.removeEventListener("fixture-remount-banner", remount);
  }, []);
  return (
    <main data-development-restart-action-fixture="true" className="p-6">
      <h1>Development restart action browser fixture</h1>
      <p>Production banner, KernelProvider, owners and typed client with controlled HTTP outcomes. No native backend or solver.</p>
      <DevelopmentBackendBanner key={bannerGeneration} />
      <div data-fixture-workspace="true">
        <DevelopmentWorkspaceInputBoundary>
          <label>Local workspace input <input defaultValue="fixture draft" /></label>
        </DevelopmentWorkspaceInputBoundary>
      </div>
      <output data-fixture-generation={snapshot.generation}>{snapshot.kernel.api.getExpectedApiInstance()}</output>
    </main>
  );
}

export default function DevelopmentRestartActionFixturePage() {
  const ready = useSyncExternalStore(bootstrap.subscribe, bootstrap.getSnapshot, bootstrap.getServerSnapshot);
  return ready ? <KernelProvider><FixtureBody /></KernelProvider> : <p>Initializing controlled browser fixture.</p>;
}
