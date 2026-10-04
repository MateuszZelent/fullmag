"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { DevelopmentWorkspaceInputBoundary } from "@/kernel/development/DevelopmentWorkspaceInputBoundary";
import type { DevelopmentKernelHost } from "@/kernel/development/DevelopmentKernelHost";
import { KernelProvider } from "@/kernel/KernelProvider";
import { useKernel } from "@/kernel/KernelContext";
import { API_INSTANCE_HEADER } from "@/kernel/api/apiInstancePin";
import {
  API_CONTRACT_VERSION_HEADER,
  EXPECTED_API_CONTRACT_VERSION,
  PLATFORM_DEVELOPMENT_BACKEND_PATH,
  PLATFORM_HEALTH_PATH,
  SESSIONS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  DevelopmentRestartResource,
  HealthResource,
  SessionListResource,
} from "@/kernel/api/apiTypes";
import type { LayoutState } from "@/kernel/layout/layoutTypes";
import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import { resourceRuntimeKeyForClientScope } from "@/kernel/resources/resourceClientScope";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { useResource, useResourceSelector } from "@/kernel/resources/useResource";
import type { KernelApi } from "@/kernel/types";

const FIXTURE_SCHEMA = "fullmag.development-kernel-host.browser-fixture.v1" as const;
const OLD_API_PIN = "11111111-1111-4111-8111-111111111111";
const NEW_API_PIN = "22222222-2222-4222-8222-222222222222";
const OLD_SEED_MARKER = "seeded-old-resource";
const OLD_HEALTH_MARKER = "old-client-health";
const NEW_HEALTH_MARKER = "new-client-health";

type FixtureOwnerSet = ReturnType<DevelopmentKernelHost["createOwners"]>;
type FixtureOwnerCapture = Awaited<ReturnType<FixtureOwnerSet["capture"]>>;

interface ApiRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly apiInstance: string | null;
}

interface DeferredResponse {
  readonly promise: Promise<Response>;
  resolve(response: Response): void;
  readonly settled: boolean;
}

interface FakeApiNetwork {
  readonly requests: ApiRequestRecord[];
  readonly unexpectedApiRequests: ApiRequestRecord[];
  readonly oldHealthResponse: DeferredResponse;
  readonly newHealthResponse: DeferredResponse;
  oldHealthRequestCount: number;
  newHealthRequestCount: number;
  readonly originalFetch: typeof fetch;
}

interface HostReadSnapshot {
  readonly apiInstance: string | null;
  readonly cacheScope: string | null;
  readonly generation: number | null;
  readonly paused: boolean;
  readonly publicationError: string | null;
  readonly mountId: number | null;
  readonly draftValue: string | null;
  readonly inputEvents: number;
  readonly boundaryInert: boolean;
  readonly resourceStatus: string | null;
  readonly resourceMarker: string | null;
  readonly selectorValue: string | null;
  readonly oldCacheMarker: string | null;
  readonly newCacheMarker: string | null;
}

interface LayoutRestorationEvidence {
  readonly captured: unknown;
  readonly actual: LayoutState | null;
  readonly matches: boolean;
}

interface PausedInputEvidence {
  readonly inert: boolean;
  readonly draftPreserved: boolean;
  readonly inputBlocked: boolean;
  readonly mountRetained: boolean;
}

interface PausedApiEvidence {
  readonly commandStatus: string;
  readonly commandMessage: string | null;
  readonly apiErrorCode: string | null;
  readonly noNetworkRequest: boolean;
  readonly wasPaused: boolean;
}

interface PendingReplacementEvidence {
  readonly commandStatus: string;
  readonly apiErrorCode: string | null;
  readonly noNetworkRequest: boolean;
  readonly wasPaused: boolean;
}

interface FixtureCheck {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
}

interface FixtureReport {
  readonly schema: typeof FIXTURE_SCHEMA;
  readonly status: "passed" | "failed";
  readonly fixture_only: true;
  readonly actual_backend_runtime: false;
  readonly checks: FixtureCheck[];
  readonly passed_checks: number;
  readonly total_checks: number;
  readonly evidence: Record<string, unknown>;
}

interface DevelopmentKernelHostFixtureBridge {
  readonly network: FakeApiNetwork;
  activeKernel: KernelApi | null;
  oldKernel: KernelApi | null;
  mountSequence: number;
  activeMountId: number | null;
  initialMountId: number | null;
  initialGeneration: number | null;
  oldScope: string | null;
  oldCacheMarkerAtCapture: string | null;
  captured: FixtureOwnerCapture | null;
  owners: FixtureOwnerSet | null;
  inputEvents: number;
  draftAtPause: string | null;
  inputEventsAtPause: number;
  pausedInputEvidence: PausedInputEvidence | null;
  pausedApiEvidence: PausedApiEvidence | null;
  replacementPauseProbeStarted: boolean;
  replacementPauseEvidence: PendingReplacementEvidence | null;
  oldSeedObserved: boolean;
  newClientInitiallyEmpty: boolean;
  inputAttemptValue?: string;
  hydrated: boolean;
  released: boolean;
  retiredTransportCode: string | null;
  oldRetiredWithoutNetwork: boolean;
  layoutRestored: boolean;
  layoutRestorationEvidence: LayoutRestorationEvidence | null;
  emptyDocumentRestored: boolean;
  captureResult: Record<string, unknown> | null;
  hydrateResult: HostReadSnapshot | null;
}

interface BrowserFixtureControls {
  read(): HostReadSnapshot;
  networkSnapshot(): {
    readonly requests: ApiRequestRecord[];
    readonly unexpectedApiRequests: ApiRequestRecord[];
    readonly oldHealthRequestCount: number;
    readonly newHealthRequestCount: number;
  };
  releaseOldHealth(): void;
  capture(): Promise<Record<string, unknown>>;
  recordPausedInputAttempt(): PausedInputEvidence;
  exercisePaused(): Promise<PausedApiEvidence>;
  hydrate(): Promise<HostReadSnapshot>;
  releaseLease(): void;
  probeOldTransportRetirement(): Promise<{ readonly code: string | null; readonly networkUnchanged: boolean }>;
  releaseNewHealth(): void;
  checks(): Promise<FixtureReport>;
}

declare global {
  interface Window {
    __developmentKernelHostFixture?: BrowserFixtureControls;
    __developmentKernelHostBridge?: DevelopmentKernelHostFixtureBridge;
    __developmentKernelHostChecks?: () => Promise<FixtureReport>;
  }
}

function deferredResponse(): DeferredResponse {
  let resolvePromise!: (response: Response) => void;
  let isSettled = false;
  const promise = new Promise<Response>((resolve) => {
    resolvePromise = (response) => {
      if (isSettled) return;
      isSettled = true;
      resolve(response);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    get settled() { return isSettled; },
  };
}

function jsonResponse(value: unknown, apiInstance: string, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      [API_CONTRACT_VERSION_HEADER]: EXPECTED_API_CONTRACT_VERSION,
      [API_INSTANCE_HEADER]: apiInstance,
    },
  });
}

function healthResource(status: string): HealthResource {
  return {
    active_session: false,
    api_contract_version: EXPECTED_API_CONTRACT_VERSION,
    status,
    uptime_seconds: 1,
  };
}

function developmentBackendResource(apiInstance: string) {
  return {
    configured: true,
    current_build: null,
    ready_build: null,
    reason: "restart_integration_pending",
    restart_available: false,
    revision: 1,
    schema_version: "fullmag.development-backend.v1",
    state: "ready",
    workspace_identity: {
      api_instance_id: apiInstance,
      session_id: null,
      session_epoch: 0,
    },
  };
}

function sameLayoutState(actual: LayoutState, expectedValue: unknown): boolean {
  if (!expectedValue || typeof expectedValue !== "object" || Array.isArray(expectedValue)) {
    return false;
  }
  const expected = expectedValue as Record<string, unknown>;
  const expectedPanels = expected.panelVisible;
  if (!expectedPanels || typeof expectedPanels !== "object" || Array.isArray(expectedPanels)) {
    return false;
  }
  const panels = expectedPanels as Record<string, unknown>;
  return actual.activeModuleTab === expected.activeModuleTab
    && actual.activeBottomPanelTab === expected.activeBottomPanelTab
    && actual.activeViewportMainModuleId === expected.activeViewportMainModuleId
    && actual.lastSpatialViewportMainModuleId === expected.lastSpatialViewportMainModuleId
    && actual.focusedSlot === expected.focusedSlot
    && actual.panelVisible.left === panels.left
    && actual.panelVisible.right === panels.right
    && actual.panelVisible.bottom === panels.bottom;
}

function installFakeWindowFetch(): FakeApiNetwork {
  const existing = window.__developmentKernelHostBridge?.network;
  if (existing) return existing;

  const network: FakeApiNetwork = {
    requests: [],
    unexpectedApiRequests: [],
    oldHealthResponse: deferredResponse(),
    newHealthResponse: deferredResponse(),
    oldHealthRequestCount: 0,
    newHealthRequestCount: 0,
    originalFetch: globalThis.fetch.bind(globalThis),
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v2/")) {
      return network.originalFetch(request);
    }

    const apiInstance = request.headers.get(API_INSTANCE_HEADER);
    const record: ApiRequestRecord = {
      method: request.method,
      path: url.pathname,
      apiInstance,
    };
    network.requests.push(record);
    if (apiInstance !== OLD_API_PIN && apiInstance !== NEW_API_PIN) {
      network.unexpectedApiRequests.push(record);
      return jsonResponse({ code: "fixture_invalid_api_pin", message: "Fixture request omitted an allowed API pin." }, apiInstance ?? "00000000-0000-0000-0000-000000000000", 500);
    }

    if (request.method === "GET" && url.pathname === SESSIONS_PATH) {
      const sessions: SessionListResource = {
        schema_version: "fullmag.session-list.v1",
        sessions: [],
      };
      return jsonResponse(sessions, apiInstance);
    }
    if (request.method === "GET" && url.pathname === PLATFORM_DEVELOPMENT_BACKEND_PATH) {
      return jsonResponse(developmentBackendResource(apiInstance), apiInstance);
    }
    if (request.method === "GET" && url.pathname === PLATFORM_HEALTH_PATH) {
      if (apiInstance === OLD_API_PIN) {
        network.oldHealthRequestCount += 1;
        return network.oldHealthResponse.promise;
      }
      network.newHealthRequestCount += 1;
      return network.newHealthResponse.promise;
    }

    network.unexpectedApiRequests.push(record);
    return jsonResponse({ code: "fixture_unexpected_api_request", message: `Unexpected ${request.method} ${url.pathname}` }, apiInstance, 404);
  };

  window.fetch = fakeFetch;
  globalThis.fetch = fakeFetch;
  window.__developmentKernelHostBridge = {
    network,
    activeKernel: null,
    oldKernel: null,
    mountSequence: 0,
    activeMountId: null,
    initialMountId: null,
    initialGeneration: null,
    oldScope: null,
    oldCacheMarkerAtCapture: null,
    captured: null,
    owners: null,
    inputEvents: 0,
    draftAtPause: null,
    inputEventsAtPause: 0,
    pausedInputEvidence: null,
    pausedApiEvidence: null,
    replacementPauseProbeStarted: false,
    replacementPauseEvidence: null,
    oldSeedObserved: false,
    newClientInitiallyEmpty: false,
    hydrated: false,
    released: false,
    retiredTransportCode: null,
    oldRetiredWithoutNetwork: false,
    layoutRestored: false,
    layoutRestorationEvidence: null,
    emptyDocumentRestored: false,
    captureResult: null,
    hydrateResult: null,
  };
  const controls = createBrowserFixtureControls(window.__developmentKernelHostBridge);
  window.__developmentKernelHostFixture = controls;
  window.__developmentKernelHostChecks = controls.checks;
  return network;
}

function createBrowserFixtureControls(
  bridge: DevelopmentKernelHostFixtureBridge,
): BrowserFixtureControls {
  const read = (): HostReadSnapshot => {
    const kernel = bridge.activeKernel;
    const host = kernel?.developmentWorkspace;
    const hostSnapshot = host?.getSnapshot();
    const resource = document.querySelector<HTMLElement>("[data-health-resource]");
    const selector = document.querySelector<HTMLElement>("[data-health-selector]");
    const input = document.querySelector<HTMLInputElement>("[data-workspace-draft]");
    const boundary = document.querySelector<HTMLElement>("main[aria-busy]");
    const oldScope = bridge.oldScope;
    const newScope = kernel?.api.resourceCacheScope ?? null;
    const oldMarker = oldScope
      ? sharedResourceRuntimeStore.getSnapshot<HealthResource>(
        resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, oldScope),
      ).data?.status ?? null
      : null;
    const newMarker = newScope
      ? sharedResourceRuntimeStore.getSnapshot<HealthResource>(
        resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, newScope),
      ).data?.status ?? null
      : null;
    return {
      apiInstance: kernel?.api.getExpectedApiInstance() ?? null,
      cacheScope: kernel?.api.resourceCacheScope ?? null,
      generation: hostSnapshot?.generation ?? null,
      paused: hostSnapshot?.paused ?? false,
      publicationError: hostSnapshot?.publicationError ?? null,
      mountId: bridge.activeMountId,
      draftValue: input?.value ?? null,
      inputEvents: bridge.inputEvents,
      boundaryInert: boundary?.inert ?? false,
      resourceStatus: resource?.dataset.status ?? null,
      resourceMarker: resource?.dataset.marker === "none"
        ? null
        : resource?.dataset.marker ?? null,
      selectorValue: selector?.textContent ?? null,
      oldCacheMarker: oldMarker,
      newCacheMarker: newMarker,
    };
  };

  return {
    read,
    networkSnapshot: () => ({
      requests: [...bridge.network.requests],
      unexpectedApiRequests: [...bridge.network.unexpectedApiRequests],
      oldHealthRequestCount: bridge.network.oldHealthRequestCount,
      newHealthRequestCount: bridge.network.newHealthRequestCount,
    }),
    releaseOldHealth: () => {
      bridge.network.oldHealthResponse.resolve(jsonResponse(healthResource(OLD_HEALTH_MARKER), OLD_API_PIN));
    },
    capture: async () => {
      if (bridge.captured) throw new Error("This fixture already owns a capture lease.");
      const kernel = bridge.activeKernel;
      const host = kernel?.developmentWorkspace;
      if (!kernel || !host) throw new Error("The mounted production kernel host is unavailable.");
      if (kernel.api.getExpectedApiInstance() !== OLD_API_PIN) {
        throw new Error("The first mounted API client is not pinned to the fixture URL.");
      }
      kernel.layout.setActiveTab("geometry");
      kernel.layout.setFocusedSlot("panel-right");
      bridge.oldKernel = kernel;
      bridge.oldScope = kernel.api.resourceCacheScope;
      bridge.oldCacheMarkerAtCapture = sharedResourceRuntimeStore.getSnapshot<HealthResource>(
        resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, bridge.oldScope),
      ).data?.status ?? null;
      bridge.initialMountId = bridge.activeMountId;
      bridge.initialGeneration = host.getSnapshot().generation;
      bridge.draftAtPause = read().draftValue;
      bridge.inputEventsAtPause = bridge.inputEvents;
      bridge.owners = host.createOwners({
        applyPendingChanges: false,
        carryUnsavedDocument: false,
      });
      bridge.captured = await bridge.owners.capture();
      bridge.captured.assertCurrent();
      bridge.captureResult = {
        session_id: bridge.captured.sessionId,
        session_epoch: bridge.captured.sessionEpoch,
        layout: structuredClone(bridge.captured.workspace.layout),
        project_document: structuredClone(bridge.captured.projectDocument),
        editor: structuredClone(bridge.captured.editor),
      };
      return bridge.captureResult;
    },
    recordPausedInputAttempt: () => {
      const snapshot = read();
      const evidence: PausedInputEvidence = {
        inert: snapshot.boundaryInert,
        draftPreserved: snapshot.draftValue === bridge.draftAtPause,
        inputBlocked: snapshot.inputEvents === bridge.inputEventsAtPause,
        mountRetained: snapshot.mountId === bridge.initialMountId,
      };
      bridge.pausedInputEvidence = evidence;
      return evidence;
    },
    exercisePaused: async () => {
      const kernel = bridge.oldKernel;
      if (!kernel) throw new Error("No old kernel was captured.");
      const countBefore = bridge.network.requests.length;
      const command = await kernel.commands.execute(
        "workspace.theme-toggle",
        createCommandContext("menu", kernel),
      );
      let apiErrorCode: string | null = null;
      try {
        await kernel.api.sessions.list();
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
          apiErrorCode = error.code;
        }
      }
      const snapshot: PausedApiEvidence = {
        commandStatus: command.status,
        commandMessage: command.message ?? null,
        apiErrorCode,
        noNetworkRequest: bridge.network.requests.length === countBefore,
        wasPaused: kernel.developmentWorkspace?.getSnapshot().paused ?? false,
      };
      bridge.pausedApiEvidence = snapshot;
      return snapshot;
    },
    hydrate: async () => {
      const owners = bridge.owners;
      const captured = bridge.captured;
      if (!owners || !captured) throw new Error("Capture owners are unavailable.");
      const outcome: DevelopmentRestartResource = {
        schema: "fullmag.development-ui-restart-resource.v1",
        request_id: crypto.randomUUID(),
        state: "ready",
        new_api_instance_id: NEW_API_PIN,
        session_id: null,
        session_epoch: 0,
        editor: structuredClone(captured.editor),
        workspace: structuredClone(captured.workspace),
        project_document: structuredClone(captured.projectDocument),
      };
      await owners.hydrate(outcome);
      await waitUntil(() => {
        const kernel = bridge.activeKernel;
        const host = kernel?.developmentWorkspace;
        return kernel?.api.getExpectedApiInstance() === NEW_API_PIN
          && host?.getSnapshot().generation === (bridge.initialGeneration ?? 0) + 1
          && bridge.activeMountId !== bridge.initialMountId
          && !host.getSnapshot().paused;
      }, 5_000, "The passive-effect replacement publication did not mount.");
      bridge.hydrated = true;
      const replacement = bridge.activeKernel;
      const actualLayout = replacement ? structuredClone(replacement.layout.get()) : null;
      const capturedLayout = structuredClone(captured.workspace.layout);
      bridge.layoutRestored = Boolean(actualLayout
        && sameLayoutState(actualLayout, capturedLayout));
      bridge.layoutRestorationEvidence = {
        captured: capturedLayout,
        actual: actualLayout,
        matches: bridge.layoutRestored,
      };
      const capturedDocumentSnapshot = captured.projectDocument.snapshot;
      bridge.emptyDocumentRestored = Boolean(replacement
        && replacement.projectDocument
        && replacement.projectDocument.getSnapshot().state === "empty"
        && captured.projectDocument.schema === "fullmag.project-document-development-handoff.v1"
        && typeof capturedDocumentSnapshot === "object"
        && capturedDocumentSnapshot !== null
        && "state" in capturedDocumentSnapshot
        && capturedDocumentSnapshot.state === "empty");
      bridge.hydrateResult = read();
      bridge.newClientInitiallyEmpty = bridge.hydrateResult.resourceMarker === null
        && bridge.hydrateResult.resourceStatus !== "ready"
        && bridge.hydrateResult.selectorValue !== `ready:${OLD_HEALTH_MARKER}`
        && bridge.hydrateResult.oldCacheMarker === null
        && bridge.hydrateResult.newCacheMarker === null;
      return bridge.hydrateResult;
    },
    releaseLease: () => {
      if (!bridge.captured) throw new Error("No capture lease can be released.");
      bridge.captured.release();
      bridge.captured.release();
      bridge.released = true;
    },
    probeOldTransportRetirement: async () => {
      const oldKernel = bridge.oldKernel;
      if (!oldKernel) throw new Error("The old kernel reference was not retained.");
      const requestCount = bridge.network.requests.length;
      let code: string | null = null;
      try {
        await oldKernel.api.sessions.list();
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
          code = error.code;
        }
      }
      bridge.retiredTransportCode = code;
      bridge.oldRetiredWithoutNetwork = bridge.network.requests.length === requestCount;
      return { code, networkUnchanged: bridge.oldRetiredWithoutNetwork };
    },
    releaseNewHealth: () => {
      bridge.network.newHealthResponse.resolve(jsonResponse(healthResource(NEW_HEALTH_MARKER), NEW_API_PIN));
    },
    checks: async () => {
      const snapshot = read();
      const oldKernel = bridge.oldKernel;
      const activeKernel = bridge.activeKernel;
      const initialHydrationSnapshot = bridge.hydrateResult;
      const resourceScopesDiffer = Boolean(
        oldKernel && activeKernel && oldKernel.api.resourceCacheScope !== activeKernel.api.resourceCacheScope,
      );
      const runtimeKeysDiffer = Boolean(
        bridge.oldScope && activeKernel
        && resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, bridge.oldScope)
          !== resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, activeKernel.api.resourceCacheScope),
      );
      const cacheEvidenceIsolated = initialHydrationSnapshot !== null
        && bridge.oldCacheMarkerAtCapture === OLD_HEALTH_MARKER
        && initialHydrationSnapshot.oldCacheMarker === null
        && initialHydrationSnapshot.newCacheMarker === null
        && snapshot.oldCacheMarker === null
        && snapshot.newCacheMarker === NEW_HEALTH_MARKER;
      const checks: FixtureCheck[] = [
        { name: "production KernelProvider mounted with the old URL pin", status: oldKernel?.api.getExpectedApiInstance() === OLD_API_PIN ? "passed" : "failed" },
        { name: "old useResource seed was visible before typed transport settled", status: bridge.oldSeedObserved ? "passed" : "failed" },
        { name: "old scoped runtime cache held the settled response before handoff", status: bridge.oldCacheMarkerAtCapture === OLD_HEALTH_MARKER ? "passed" : "failed" },
        { name: "host pause kept the mounted input inert and retained its local value", status: bridge.pausedInputEvidence?.inert && bridge.pausedInputEvidence.draftPreserved && bridge.pausedInputEvidence.inputBlocked && bridge.pausedInputEvidence.mountRetained ? "passed" : "failed" },
        { name: "command and ordinary API request were refused during pause without network traffic", status: bridge.pausedApiEvidence?.commandStatus === "failed" && bridge.pausedApiEvidence.apiErrorCode === "DEVELOPMENT_TRANSPORT_PAUSED" && bridge.pausedApiEvidence.noNetworkRequest && bridge.pausedApiEvidence.wasPaused ? "passed" : "failed" },
        { name: "fresh replacement command and API read stayed blocked until passive acknowledgement", status: bridge.replacementPauseEvidence?.commandStatus === "failed" && bridge.replacementPauseEvidence.apiErrorCode === "DEVELOPMENT_TRANSPORT_PAUSED" && bridge.replacementPauseEvidence.noNetworkRequest && bridge.replacementPauseEvidence.wasPaused ? "passed" : "failed" },
        { name: "fresh pinned kernel mounted after passive-effect acknowledgement and navigation update", status: bridge.hydrated && activeKernel?.api.getExpectedApiInstance() === NEW_API_PIN && snapshot.generation === (bridge.initialGeneration ?? -2) + 1 && snapshot.mountId !== bridge.initialMountId && !snapshot.paused && snapshot.publicationError === null && new URL(window.location.href).searchParams.get("fullmag_api_instance") === NEW_API_PIN ? "passed" : "failed" },
        { name: "real layout and empty project-document owners were restored into the replacement", status: bridge.layoutRestored && bridge.emptyDocumentRestored ? "passed" : "failed" },
        { name: "new resource hook began empty after old-client unsubscribe cleanup", status: bridge.newClientInitiallyEmpty && Boolean(initialHydrationSnapshot && initialHydrationSnapshot.resourceMarker === null && initialHydrationSnapshot.selectorValue !== `ready:${OLD_HEALTH_MARKER}` && initialHydrationSnapshot.oldCacheMarker === null && initialHydrationSnapshot.newCacheMarker === null && resourceScopesDiffer && runtimeKeysDiffer) ? "passed" : "failed" },
        { name: "old entry was cleaned up and new scoped resource settled independently", status: cacheEvidenceIsolated && snapshot.selectorValue === `ready:${NEW_HEALTH_MARKER}` ? "passed" : "failed" },
        { name: "old API remained retired after idempotent lease release", status: bridge.released && bridge.retiredTransportCode === "DEVELOPMENT_TRANSPORT_RETIRED" && bridge.oldRetiredWithoutNetwork ? "passed" : "failed" },
        { name: "all observed API requests used the matching old or replacement pin", status: bridge.network.requests.length > 0 && bridge.network.requests.every((request) => request.apiInstance === OLD_API_PIN || request.apiInstance === NEW_API_PIN) ? "passed" : "failed" },
        { name: "unknown API routes and project reopen were not used", status: bridge.network.unexpectedApiRequests.length === 0 && !bridge.network.requests.some((request) => request.path.startsWith("/v2/persistence/projects")) ? "passed" : "failed" },
      ];
      const passedChecks = checks.filter((check) => check.status === "passed").length;
      return {
        schema: FIXTURE_SCHEMA,
        status: passedChecks === checks.length ? "passed" : "failed",
        fixture_only: true,
        actual_backend_runtime: false,
        checks,
        passed_checks: passedChecks,
        total_checks: checks.length,
        evidence: {
          old_api_instance: oldKernel?.api.getExpectedApiInstance() ?? null,
          new_api_instance: activeKernel?.api.getExpectedApiInstance() ?? null,
          old_resource_scope: bridge.oldScope,
          old_cache_marker_before_handoff: bridge.oldCacheMarkerAtCapture,
          old_cache_marker_after_unmount: bridge.hydrateResult?.oldCacheMarker ?? null,
          new_cache_marker_before_response: bridge.hydrateResult?.newCacheMarker ?? null,
          new_selector_before_response: bridge.hydrateResult?.selectorValue ?? null,
          new_resource_scope: activeKernel?.api.resourceCacheScope ?? null,
          generation: snapshot.generation,
          mount_id: snapshot.mountId,
          paused_input: bridge.pausedInputEvidence,
          paused_api: bridge.pausedApiEvidence,
          pending_replacement_pause: bridge.replacementPauseEvidence,
          captured_session_id: bridge.captured?.sessionId ?? null,
          captured_session_epoch: bridge.captured?.sessionEpoch ?? null,
          old_cache_marker: snapshot.oldCacheMarker,
          new_cache_marker: snapshot.newCacheMarker,
          old_transport_retirement_code: bridge.retiredTransportCode,
          layout_restored: bridge.layoutRestored,
          layout_restoration: bridge.layoutRestorationEvidence,
          empty_document_restored: bridge.emptyDocumentRestored,
          api_requests: bridge.network.requests,
          unexpected_api_requests: bridge.network.unexpectedApiRequests,
        },
      };
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  throw new Error(message);
}

function HealthResourceProbe() {
  const kernel = useKernel();
  const [draft, setDraft] = useState("workspace draft");
  const healthLoad = useCallback(
    ({ signal }: { signal: AbortSignal }) => kernel.api.platform.health({ signal }),
    [kernel.api],
  );
  const resource = useResource<HealthResource>({
    load: healthLoad,
    resolveRevision: () => null,
    resourceKey: PLATFORM_HEALTH_PATH,
  });
  const selectHealth = useCallback(
    (value: ResourceResult<HealthResource>) => `${value.status}:${value.data?.status ?? "none"}`,
    [],
  );
  const selector = useResourceSelector<HealthResource, string>({
    load: healthLoad,
    resolveRevision: () => null,
    resourceKey: PLATFORM_HEALTH_PATH,
    selector: selectHealth,
  });
  const seededScope = useRef<string | null>(null);

  useLayoutEffect(() => {
    const apiPin = kernel.api.getExpectedApiInstance();
    const clientScope = kernel.api.resourceCacheScope;
    if (typeof window === "undefined" || apiPin !== OLD_API_PIN
      || seededScope.current === clientScope) return;
    seededScope.current = clientScope;
    const oldSeed: HealthResource = {
      ...healthResource(OLD_SEED_MARKER),
      uptime_seconds: 17,
    };
    sharedResourceRuntimeStore.updateData(
      resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, clientScope),
      oldSeed,
      "fixture-old-seed",
    );
  }, [kernel.api]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bridge = window.__developmentKernelHostBridge;
    if (!bridge) return;
    const apiPin = kernel.api.getExpectedApiInstance();
    if (apiPin === OLD_API_PIN && resource.data?.status === OLD_SEED_MARKER) {
      bridge.oldSeedObserved = true;
    }
    if (apiPin === NEW_API_PIN && !bridge.network.newHealthResponse.settled
      && resource.data === null && resource.status !== "ready") {
      const oldCacheMarker = bridge.oldScope
        ? sharedResourceRuntimeStore.getSnapshot<HealthResource>(
          resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, bridge.oldScope),
        ).data?.status ?? null
        : null;
      const newCacheMarker = sharedResourceRuntimeStore.getSnapshot<HealthResource>(
        resourceRuntimeKeyForClientScope(PLATFORM_HEALTH_PATH, kernel.api.resourceCacheScope),
      ).data?.status ?? null;
      bridge.newClientInitiallyEmpty = oldCacheMarker === null && newCacheMarker === null;
    }
  }, [kernel.api, resource.data, resource.status, selector]);

  useEffect(() => {
    const host = kernel.developmentWorkspace;
    if (typeof window === "undefined" || !host) return;
    const bridge = window.__developmentKernelHostBridge;
    if (!bridge) return;
    bridge.activeKernel = kernel;
    bridge.mountSequence += 1;
    bridge.activeMountId = bridge.mountSequence;
    if (kernel.api.getExpectedApiInstance() === NEW_API_PIN
      && host.getSnapshot().paused
      && !bridge.replacementPauseProbeStarted) {
      bridge.replacementPauseProbeStarted = true;
      const wasPaused = host.getSnapshot().paused;
      const sessionRequestsBefore = bridge.network.requests
        .filter((request) => request.method === "GET" && request.path === SESSIONS_PATH).length;
      const commandPromise = kernel.commands.execute(
        "workspace.theme-toggle",
        createCommandContext("menu", kernel),
      );
      const apiPromise = kernel.api.sessions.list().then(
        () => null,
        (error: unknown) => error && typeof error === "object" && "code" in error
          && typeof error.code === "string" ? error.code : null,
      );
      const noNetworkRequest = bridge.network.requests
        .filter((request) => request.method === "GET" && request.path === SESSIONS_PATH).length
        === sessionRequestsBefore;
      void Promise.all([commandPromise, apiPromise]).then(([command, apiErrorCode]) => {
        bridge.replacementPauseEvidence = {
          commandStatus: command.status,
          apiErrorCode,
          noNetworkRequest,
          wasPaused,
        };
      });
    }
    return () => {
      if (bridge.activeKernel === kernel) {
        bridge.activeKernel = null;
        bridge.activeMountId = null;
      }
    };
  }, [kernel]);

  const generation = kernel.developmentWorkspace?.getSnapshot().generation ?? -1;
  return (
    <DevelopmentWorkspaceInputBoundary>
      <section aria-label="Development kernel host browser fixture">
        <label>
          Local draft
          <input
            data-workspace-draft="true"
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              if (typeof window !== "undefined" && window.__developmentKernelHostBridge) {
                window.__developmentKernelHostBridge.inputEvents += 1;
              }
            }}
          />
        </label>
        <output data-provider-generation={generation} data-mount-generation={generation} />
        <output
          data-health-resource="true"
          data-status={resource.status}
          data-marker={resource.data?.status ?? "none"}
        />
        <output data-health-selector="true">{selector}</output>
      </section>
    </DevelopmentWorkspaceInputBoundary>
  );
}

function DevelopmentKernelHostFixtureBody() {
  return (
    <div data-development-kernel-host-fixture="true">
      <h1>Development kernel host handoff fixture</h1>
      <p>Production KernelProvider owner handoff proof. Fake API routes only; no backend runtime or solver is exercised.</p>
      <HealthResourceProbe />
    </div>
  );
}

export default function DevelopmentKernelHostFixture() {
  if (typeof window !== "undefined") {
    installFakeWindowFetch();
  }
  return (
    <KernelProvider>
      <DevelopmentKernelHostFixtureBody />
    </KernelProvider>
  );
}
