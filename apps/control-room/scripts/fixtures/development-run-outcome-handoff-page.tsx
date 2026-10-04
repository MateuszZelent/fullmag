"use client";

import { useCallback, useEffect, useState } from "react";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import { PERSISTENCE_PROJECT_OPEN_PATH, SESSION_STATUS_PATH } from "@/kernel/api/apiPaths";
import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ProjectDocumentController } from "@/kernel/persistence/ProjectDocumentController";
import { RunOutcomeConnector, RUN_OUTCOME_THUMBNAIL_SETTLE_MS } from "@/kernel/persistence/RunOutcomeConnector";
import type { RunOutcomeRecord } from "@/kernel/persistence/runOutcome";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import type { KernelApi } from "@/kernel/types";
import type { Viewport3DThumbnail } from "@/modules/viewport-3d/viewport3dThumbnail";
import { registerViewport3DThumbnailCapture } from "@/modules/viewport-3d/viewport3dThumbnailRegistry";

const REPORT_SCHEMA = "fullmag.development-run-outcome-handoff.browser-fixture.v1";
const PROJECT_SCHEMA = "fullmag.project.v1";
const PROJECT_ID = "project-run-outcome-handoff-fixture";
const HOST_PATH_PREFIX = "C:\\fullmag\\fixture\\run-outcome";
const REWRITTEN_ARCHIVE_BASE64 = "UEsDBEZ1bGxtYWctcmV3cml0dGVu";
const API_PINS = {
  guarded: "11111111-1111-4111-8111-111111111111",
  paused: "22222222-2222-4222-8222-222222222222",
  reserved: "33333333-3333-4333-8333-333333333333",
} as const;
const SESSION_ID = "session-run-outcome-handoff-fixture";
const SESSION_EPOCH = "fixture-session-epoch-1";
const REQUEST_SCOPE_EPOCH = "run-outcome-fixture:0";
const TIMING_INSTRUMENTATION =
  "The fixture observes the production ProjectDocumentController.tryReserveRunOutcome method; every call delegates to the original method and every wrapped release delegates to its original idempotent release.";

type SolverState = "running" | "completed";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error?: unknown) => void;
}

interface FixtureProjectArchive {
  readonly archive_base64: string;
  readonly file_name: string;
  readonly path: string;
}

interface FixtureTauriRequest {
  readonly path?: unknown;
  readonly preview?: unknown;
  readonly run?: unknown;
}

interface FixtureTauriApi {
  readonly core: {
    invoke<T>(command: string, args: unknown): Promise<T>;
  };
}

interface FixtureCheck {
  readonly detail?: string;
  readonly name: string;
  readonly status: "passed" | "failed";
}

interface FixtureReport {
  readonly actual_backend_runtime: false;
  readonly checks: FixtureCheck[];
  readonly diagnostics: Record<string, unknown>;
  readonly error: string | null;
  readonly fixture_only: true;
  readonly passed_checks: number;
  readonly schema: typeof REPORT_SCHEMA;
  readonly status: "passed" | "failed";
  readonly timing_instrumentation: typeof TIMING_INSTRUMENTATION;
  readonly total_checks: number;
}

interface FixtureWindow extends Window {
  __developmentRunOutcomeHandoffChecks?: () => Promise<FixtureReport>;
  __developmentRunOutcomeHandoffDiagnostics?: () => Record<string, unknown>;
}

interface CaseRuntime {
  readonly api: ControlRoomApi;
  readonly caseId: keyof typeof API_PINS;
  readonly diagnosticRecorder: DiagnosticRecorderController;
  readonly fetchTrace: Array<{ readonly method: string; readonly path: string }>;
  readonly hostPath: string;
  readonly kernel: KernelApi;
  readonly projectDocument: ProjectDocumentController;
  readonly observation: FixtureObservationService;
  readonly projectOpenRequests: Array<{ readonly display_name: string; readonly archive_base64: string }>;
  readonly resources: ResourceInvalidationController;
  readonly sessionIdentity: SessionResourceIdentity;
  readonly reservationTimeline: Array<{
    readonly granted_at_ms: number;
    released_at_ms: number | null;
  }>;
  readonly tauriCalls: Array<{
    readonly command: string;
    readonly preview: { readonly colouring: string; readonly png_base64: string } | null;
    readonly run_id: string | null;
  }>;
  readonly tauriWrite: Deferred<FixtureProjectArchive>;
  readonly thumbnailWrite: Deferred<Viewport3DThumbnail | null>;
  readonly unknownTransport: Array<{ readonly method: string; readonly path: string }>;
  openCount: number;
  activeReservationCount: number;
  activeReservationStartedAtMs: number | null;
  reservationGrantCount: number;
  reservationDeniedCount: number;
  reservationReleaseCount: number;
  serverRevision: number;
  serverSolver: SolverState;
  thumbnailCalls: number;
  thumbnailStartedAtMs: number | null;
}

interface FixtureObservationSnapshot {
  readonly observedSolver: string | null;
  readonly pausedCommitted: boolean;
  readonly statusHistory: readonly string[];
}

interface FixtureObservationService {
  observePaused(paused: boolean): void;
  observeSolver(solver: string | null): void;
  read(): FixtureObservationSnapshot;
}

declare global {
  interface Window {
    __developmentRunOutcomeHandoffChecks?: () => Promise<FixtureReport>;
  }
}

let activeThumbnailRuntime: CaseRuntime | null = null;

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await delay(10);
  }
}

function jsonResponse(value: unknown, apiPin: string, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "x-api-contract-version": "1.0.0",
      "x-fullmag-api-instance": apiPin,
    },
  });
}

function createFixtureObservationService(): FixtureObservationService {
  let snapshot: FixtureObservationSnapshot = {
    observedSolver: null,
    pausedCommitted: false,
    statusHistory: [],
  };
  return {
    observePaused(paused) {
      snapshot = { ...snapshot, pausedCommitted: paused };
    },
    observeSolver(solver) {
      snapshot = {
        ...snapshot,
        observedSolver: solver,
        statusHistory: solver === null
          ? snapshot.statusHistory
          : [...snapshot.statusHistory, solver],
      };
    },
    read() {
      return snapshot;
    },
  };
}

function projectResource(archiveBase64: string, revision: number) {
  return {
    archive_base64: archiveBase64,
    dirty: false,
    durability: "memory_only",
    migration: {
      can_write: true,
      migrated: false,
      preserved_paths: ["project/main.py"],
      source_schema: PROJECT_SCHEMA,
      target_schema: PROJECT_SCHEMA,
      warnings: [],
    },
    mode: { kind: "read_write" },
    name: "Run outcome fixture project",
    persisted_revision: revision,
    project_id: PROJECT_ID,
    revision,
    schema_version: PROJECT_SCHEMA,
    source_hash: "a".repeat(64),
  };
}

function liveStatus(runtime: CaseRuntime): LiveStatusResource {
  return {
    domain: { discretization: "fdm", generation_id: "0" },
    lifecycle: {
      commandability: "allowed",
      connectivity: "connected",
      session_resource: "active",
      solver: runtime.serverSolver,
    },
    resources: { solver_profile_revision: runtime.serverRevision },
    run: {
      resolved_device: "cpu",
      run_id: `${runtime.caseId}-run-1`,
      started_at: "2026-10-04T12:00:00.000Z",
    },
    session: {
      created_at: "2026-10-04T12:00:00.000Z",
      name: "Run outcome fixture",
      request_scope_epoch: REQUEST_SCOPE_EPOCH,
      session_epoch: SESSION_EPOCH,
      session_id: SESSION_ID,
      workspace_root: "C:\\fullmag\\fixture",
    },
    solver: { state: runtime.serverSolver },
  } as unknown as LiveStatusResource;
}

function makeCaseRuntime(caseId: keyof typeof API_PINS): CaseRuntime {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const diagnostics = new RequestDiagnosticsController();
  const diagnosticRecorder = new DiagnosticRecorderController({
    config: { enabled: false },
    diagnostics,
  });
  const fetchTrace: Array<{ method: string; path: string }> = [];
  const projectOpenRequests: Array<{ display_name: string; archive_base64: string }> = [];
  const tauriCalls: Array<{
    command: string;
    preview: { colouring: string; png_base64: string } | null;
    run_id: string | null;
  }> = [];
  const unknownTransport: Array<{ method: string; path: string }> = [];
  const tauriWrite = makeDeferred<FixtureProjectArchive>();
  const thumbnailWrite = makeDeferred<Viewport3DThumbnail | null>();
  const observation = createFixtureObservationService();
  const api = new ControlRoomApi({
    baseUrl: "http://localhost:3253",
    expectedApiInstance: API_PINS[caseId],
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      fetchTrace.push({ method: request.method, path });
      if (request.method === "GET" && path === SESSION_STATUS_PATH) {
      return jsonResponse(liveStatus(runtime), API_PINS[caseId]);
      }
      if (request.method === "POST" && path === PERSISTENCE_PROJECT_OPEN_PATH) {
        const body = await request.json() as { archive_base64: string; display_name: string };
        projectOpenRequests.push({
          archive_base64: body.archive_base64,
          display_name: body.display_name,
        });
        runtime.openCount += 1;
        return jsonResponse(
          projectResource(body.archive_base64, runtime.openCount),
          API_PINS[caseId],
        );
      }
      unknownTransport.push({ method: request.method, path });
      return jsonResponse(
        { code: "fixture_unexpected_route", message: `Unexpected ${request.method} ${path}` },
        API_PINS[caseId],
        404,
      );
    },
    maxGetRetries: 0,
    diagnostics,
  });
  const projectDocument = new ProjectDocumentController(api);
  const hostPath = `${HOST_PATH_PREFIX}-${caseId}.fms`;
  const sessionIdentity: SessionResourceIdentity = {
    requestScopeEpoch: REQUEST_SCOPE_EPOCH,
    sessionEpoch: SESSION_EPOCH,
    sessionId: SESSION_ID,
  };
  const kernel = {
    api,
    bus,
    diagnosticRecorder,
    projectDocument,
    resources,
  } as unknown as KernelApi;
  const runtime: CaseRuntime = {
    api,
    caseId,
    diagnosticRecorder,
    fetchTrace,
    hostPath,
    kernel,
    observation,
    projectDocument,
    projectOpenRequests,
    resources,
    sessionIdentity,
    reservationTimeline: [],
    tauriCalls,
    tauriWrite,
    thumbnailWrite,
    unknownTransport,
    openCount: 0,
    activeReservationCount: 0,
    activeReservationStartedAtMs: null,
    reservationGrantCount: 0,
    reservationDeniedCount: 0,
    reservationReleaseCount: 0,
    serverRevision: 1,
    serverSolver: "running",
    thumbnailCalls: 0,
    thumbnailStartedAtMs: null,
  };
  instrumentReservationTiming(runtime);
  return runtime;
}

/** Observe real reservations without replacing or bypassing controller behavior. */
function instrumentReservationTiming(runtime: CaseRuntime): void {
  const controller = runtime.projectDocument;
  const originalTryReserve = controller.tryReserveRunOutcome.bind(controller);
  controller.tryReserveRunOutcome = () => {
    const originalRelease = originalTryReserve();
    if (!originalRelease) {
      runtime.reservationDeniedCount += 1;
      return null;
    }

    const observation = { granted_at_ms: Date.now(), released_at_ms: null as number | null };
    runtime.reservationTimeline.push(observation);
    runtime.reservationGrantCount += 1;
    runtime.activeReservationCount += 1;
    runtime.activeReservationStartedAtMs ??= observation.granted_at_ms;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        originalRelease();
      } finally {
        observation.released_at_ms = Date.now();
        runtime.reservationReleaseCount += 1;
        const activeReservations = runtime.reservationTimeline.filter(
          (item) => item.released_at_ms === null,
        );
        runtime.activeReservationCount = activeReservations.length;
        runtime.activeReservationStartedAtMs = activeReservations[0]?.granted_at_ms ?? null;
      }
    };
  };
}

function setServerSolver(runtime: CaseRuntime, solver: SolverState): void {
  runtime.serverSolver = solver;
  runtime.serverRevision += 1;
  runtime.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, runtime.serverRevision);
}

function handoffCaptureBlocked(runtime: CaseRuntime): boolean {
  try {
    runtime.projectDocument.captureDevelopmentHandoff();
    return false;
  } catch {
    return true;
  }
}

function expectCaptureAndBeginBlocked(runtime: CaseRuntime): void {
  assertCondition(
    handoffCaptureBlocked(runtime),
    `${runtime.caseId}: development handoff capture was not blocked`,
  );
  let beginBlocked = false;
  try {
    const guard = runtime.projectDocument.beginDevelopmentHandoff();
    guard.release();
  } catch {
    beginBlocked = true;
  }
  assertCondition(
    beginBlocked,
    `${runtime.caseId}: development handoff begin was not blocked`,
  );
}

function expectTauriOutcomePayload(runtime: CaseRuntime): void {
  const call = runtime.tauriCalls[0];
  assertCondition(
    call?.run_id === `${runtime.caseId}-run-1`,
    `${runtime.caseId}: host write did not receive the terminal run identity`,
  );
  assertCondition(
    call.preview?.png_base64 === "AA==" && call.preview.colouring === "none",
    `${runtime.caseId}: host write did not receive the captured thumbnail payload`,
  );
}

function snapshotSummary(runtime: CaseRuntime): Record<string, unknown> {
  const snapshot = runtime.projectDocument.getSnapshot() as {
    readonly hostPath?: string | null;
    readonly resource?: {
      readonly dirty?: boolean;
      readonly project_id?: string;
      readonly revision?: number;
    } | null;
    readonly state: string;
  };
  return {
    dirty: snapshot.resource?.dirty ?? null,
    has_host_path: Boolean(snapshot.hostPath),
    project_id: snapshot.resource?.project_id ?? null,
    revision: snapshot.resource?.revision ?? null,
    state: snapshot.state,
  };
}

function diagnosticsFor(runtimes: readonly CaseRuntime[]): Record<string, unknown> {
  return {
    timing_instrumentation: TIMING_INSTRUMENTATION,
    cases: runtimes.map((runtime) => {
      const observation = runtime.observation.read();
      return {
        case_id: runtime.caseId,
        controller: snapshotSummary(runtime),
        fetches: [...runtime.fetchTrace],
        observed_solver: observation.observedSolver,
        observed_solver_history: [...observation.statusHistory],
        paused_committed: observation.pausedCommitted,
        outcome_reservation_observation: {
          active_count: runtime.activeReservationCount,
          denied_calls: runtime.reservationDeniedCount,
          granted_calls: runtime.reservationGrantCount,
          released_calls: runtime.reservationReleaseCount,
          timeline: runtime.reservationTimeline.map((item) => ({ ...item })),
        },
        project_open_count: runtime.projectOpenRequests.length,
        project_open_revisions: runtime.projectOpenRequests.map((request) => ({
          has_archive: request.archive_base64.length > 0,
          display_name: request.display_name,
        })),
        tauri_calls: [...runtime.tauriCalls],
        thumbnail_calls: runtime.thumbnailCalls,
        unknown_transport: [...runtime.unknownTransport],
      };
    }),
  };
}

async function recordCheck(
  checks: FixtureCheck[],
  name: string,
  operation: () => void | Promise<void>,
): Promise<void> {
  try {
    await operation();
    checks.push({ name, status: "passed" });
  } catch (error) {
    checks.push({ detail: describeError(error), name, status: "failed" });
    throw error;
  }
}

async function waitForActive(runtime: CaseRuntime): Promise<void> {
  await waitFor(
    () => runtime.observation.read().observedSolver === "running",
    `${runtime.caseId} real session status hook to observe running`,
  );
}

async function waitForRecordedOutcome(runtime: CaseRuntime): Promise<void> {
  await waitFor(
    () => {
      const snapshot = runtime.projectDocument.getSnapshot();
      return snapshot.state === "ready"
        && snapshot.resource.revision === 2
        && runtime.tauriCalls.length === 1;
    },
    `${runtime.caseId} rewritten project revision and Tauri outcome`,
  );
  await waitFor(() => !handoffCaptureBlocked(runtime), `${runtime.caseId} reservation release`);
}

async function runChecks(
  runtimes: readonly CaseRuntime[],
  setPaused: (caseId: keyof typeof API_PINS, paused: boolean) => void,
): Promise<FixtureReport> {
  const checks: FixtureCheck[] = [];
  let failure: string | null = null;
  const guarded = runtimes.find((runtime) => runtime.caseId === "guarded");
  const paused = runtimes.find((runtime) => runtime.caseId === "paused");
  const reserved = runtimes.find((runtime) => runtime.caseId === "reserved");
  assertCondition(guarded && paused && reserved, "Fixture cases are incomplete.");

  try {
    await recordCheck(checks, "all three mounted real status consumers observe the active run", async () => {
      await Promise.all(runtimes.map(waitForActive));
      assertCondition(
        runtimes.every((runtime) => runtime.projectDocument.getSnapshot().state === "ready"),
        "A fixture project document did not open before the run transition.",
      );
    });

    activeThumbnailRuntime = guarded;
    let guardedReservationAt: number | null = null;
    setServerSolver(guarded, "completed");
    await recordCheck(checks, "case 1 reserves before the settle delay and blocks capture and begin", async () => {
      await waitFor(() => guarded.observation.read().observedSolver === "completed", "guarded terminal status");
      await waitFor(
        () => guarded.activeReservationCount > 0 && guarded.activeReservationStartedAtMs !== null,
        "active reservation granted by the real run outcome connector",
      );
      guardedReservationAt = guarded.activeReservationStartedAtMs;
      await delay(80);
      assertCondition(guarded.thumbnailCalls === 0, "Thumbnail capture started before the 400 ms settle delay.");
      assertCondition(
        guardedReservationAt !== null
          && guarded.activeReservationCount > 0
          && guarded.activeReservationStartedAtMs === guardedReservationAt
          && Date.now() - guardedReservationAt < RUN_OUTCOME_THUMBNAIL_SETTLE_MS,
        "The real connector reservation was not still active inside its settle window.",
      );
      expectCaptureAndBeginBlocked(guarded);
    });

    await recordCheck(checks, "case 1 keeps the reservation through deferred thumbnail capture", async () => {
      await waitFor(() => guarded.thumbnailCalls === 1, "registered viewport thumbnail capture");
      assertCondition(
        guardedReservationAt !== null
          && guarded.thumbnailStartedAtMs !== null
          && guarded.thumbnailStartedAtMs - guardedReservationAt >= RUN_OUTCOME_THUMBNAIL_SETTLE_MS,
        "Registered thumbnail capture did not wait for the full settle interval.",
      );
      expectCaptureAndBeginBlocked(guarded);
      assertCondition(guarded.tauriCalls.length === 0, "Tauri write began before thumbnail capture resolved.");
      setPaused("guarded", true);
      await waitFor(() => guarded.observation.read().pausedCommitted, "case 1 paused connector prop commit");
      guarded.thumbnailWrite.resolve({
        colouring: "none",
        height: 1,
        pngBase64: "AA==",
        width: 1,
      });
      await waitFor(() => guarded.tauriCalls.length === 1, "deferred Tauri outcome write");
      expectCaptureAndBeginBlocked(guarded);
      expectTauriOutcomePayload(guarded);
      assertCondition(guarded.projectOpenRequests.length === 1,
        "Project archive reopened before the deferred Tauri write completed.");
    });

    await recordCheck(checks, "case 1 keeps the reservation until the rewritten archive is reopened", async () => {
      guarded.tauriWrite.resolve({
        archive_base64: REWRITTEN_ARCHIVE_BASE64,
        file_name: "guarded-rewritten.fms",
        path: guarded.hostPath,
      });
      await waitForRecordedOutcome(guarded);
      assertCondition(guarded.observation.read().pausedCommitted, "Pausing canceled a run outcome after its recorder started.");
      assertCondition(guarded.projectOpenRequests.length === 2, "The rewritten archive was not reopened exactly once.");
      assertCondition(
        guarded.projectOpenRequests[1]?.archive_base64 === REWRITTEN_ARCHIVE_BASE64,
        "The project API did not receive the archive returned by the host write.",
      );
      const capture = guarded.projectDocument.captureDevelopmentHandoff();
      assertCondition(
        JSON.stringify(capture).includes(REWRITTEN_ARCHIVE_BASE64),
        "A guarded handoff capture omitted the rewritten archive.",
      );
      const guard = guarded.projectDocument.beginDevelopmentHandoff();
      guard.assertCurrent();
      guard.release();
      guard.release();
      assertCondition(guarded.tauriCalls.length === 1, "Case 1 recorded more than one Tauri outcome.");
    });

    activeThumbnailRuntime = paused;
    setPaused("paused", true);
    await waitFor(() => paused.observation.read().pausedCommitted, "paused connector prop commit");
    setServerSolver(paused, "completed");
    await recordCheck(checks, "case 2 does not consume terminal status while paused", async () => {
      await waitFor(() => paused.observation.read().observedSolver === "completed", "paused terminal status");
      await delay(RUN_OUTCOME_THUMBNAIL_SETTLE_MS + 120);
      assertCondition(paused.thumbnailCalls === 0, "Paused connector requested a thumbnail.");
      assertCondition(paused.tauriCalls.length === 0, "Paused connector wrote the run outcome.");
      assertCondition(paused.projectOpenRequests.length === 1, "Paused connector reopened the archive.");
    });

    paused.thumbnailWrite.resolve({
      colouring: "none",
      height: 1,
      pngBase64: "AA==",
      width: 1,
    });
    paused.tauriWrite.resolve({
      archive_base64: REWRITTEN_ARCHIVE_BASE64,
      file_name: "paused-rewritten.fms",
      path: paused.hostPath,
    });
    setPaused("paused", false);
    await waitFor(() => !paused.observation.read().pausedCommitted, "resumed connector prop commit");
    await recordCheck(checks, "case 2 records the retained terminal transition exactly once after resume", async () => {
      await waitForRecordedOutcome(paused);
      await delay(RUN_OUTCOME_THUMBNAIL_SETTLE_MS + 100);
      assertCondition(paused.thumbnailCalls === 1, "Resuming did not capture exactly one thumbnail.");
      assertCondition(paused.tauriCalls.length === 1, "Resuming did not write exactly one run outcome.");
      expectTauriOutcomePayload(paused);
      assertCondition(paused.projectOpenRequests.length === 2, "Resuming did not reopen exactly one archive.");
      assertCondition(paused.projectOpenRequests[1]?.archive_base64 === REWRITTEN_ARCHIVE_BASE64,
        "Resuming did not adopt the host-rewritten archive.");
    });

    activeThumbnailRuntime = reserved;
    const documentGuard = reserved.projectDocument.beginDevelopmentHandoff();
    const reservationWhileGuarded = reserved.projectDocument.tryReserveRunOutcome();
    if (reservationWhileGuarded) reservationWhileGuarded();
    setServerSolver(reserved, "completed");
    await recordCheck(checks, "case 3 leaves the active tracker untouched while a document guard owns the snapshot", async () => {
      await waitFor(() => reserved.observation.read().observedSolver === "completed", "guarded terminal status");
      await delay(RUN_OUTCOME_THUMBNAIL_SETTLE_MS + 120);
      assertCondition(reservationWhileGuarded === null,
        "A run outcome reservation was granted while a document handoff guard was active.");
      assertCondition(reserved.thumbnailCalls === 0, "Guarded terminal observation captured a thumbnail.");
      assertCondition(reserved.tauriCalls.length === 0, "Guarded terminal observation wrote an outcome.");
      assertCondition(reserved.projectOpenRequests.length === 1, "Guarded terminal observation reopened the project.");
      documentGuard.release();
    });

    reserved.thumbnailWrite.resolve({
      colouring: "none",
      height: 1,
      pngBase64: "AA==",
      width: 1,
    });
    reserved.tauriWrite.resolve({
      archive_base64: REWRITTEN_ARCHIVE_BASE64,
      file_name: "reserved-rewritten.fms",
      path: reserved.hostPath,
    });
    await recordCheck(checks, "case 3 retries exactly once after guard release notifies the connector", async () => {
      await waitForRecordedOutcome(reserved);
      await delay(RUN_OUTCOME_THUMBNAIL_SETTLE_MS + 100);
      assertCondition(reserved.thumbnailCalls === 1, "Guard release did not produce exactly one thumbnail.");
      assertCondition(reserved.tauriCalls.length === 1, "Guard release did not write exactly one run outcome.");
      expectTauriOutcomePayload(reserved);
      assertCondition(reserved.projectOpenRequests.length === 2, "Guard release did not reopen exactly one archive.");
      assertCondition(reserved.projectOpenRequests[1]?.archive_base64 === REWRITTEN_ARCHIVE_BASE64,
        "Guard release did not adopt the host-rewritten archive.");
    });

    await recordCheck(checks, "API and Tauri fixtures observed no unhandled requests", () => {
      assertCondition(runtimes.every((runtime) => runtime.unknownTransport.length === 0),
        "A fixture API client called an unhandled route or Tauri command.");
    });
  } catch (error) {
    failure = describeError(error);
  }

  const passedChecks = checks.filter((check) => check.status === "passed").length;
  return {
    actual_backend_runtime: false,
    checks,
    diagnostics: diagnosticsFor(runtimes),
    error: failure,
    fixture_only: true,
    passed_checks: passedChecks,
    schema: REPORT_SCHEMA,
    status: failure === null && passedChecks === checks.length ? "passed" : "failed",
    timing_instrumentation: TIMING_INSTRUMENTATION,
    total_checks: checks.length,
  };
}

function StatusObserver({ runtime }: { readonly runtime: CaseRuntime }) {
  const solver = useSessionStatusSelector((status) => status.data?.lifecycle?.solver ?? null);
  useEffect(() => {
    runtime.observation.observeSolver(solver);
  }, [runtime, solver]);
  return null;
}

function CaseMount({ runtime, paused }: { readonly paused: boolean; readonly runtime: CaseRuntime }) {
  useEffect(() => {
    runtime.observation.observePaused(paused);
  }, [paused, runtime]);
  return (
    <KernelContext.Provider value={runtime.kernel}>
      <RunOutcomeConnector
        kernel={runtime.kernel}
        paused={paused}
        sessionIdentity={runtime.sessionIdentity}
      />
      <StatusObserver runtime={runtime} />
    </KernelContext.Provider>
  );
}

export default function DevelopmentRunOutcomeHandoffFixture() {
  const [runtimes] = useState(() => [
    makeCaseRuntime("guarded"),
    makeCaseRuntime("paused"),
    makeCaseRuntime("reserved"),
  ]);
  const [pausedCases, setPausedCases] = useState<Record<string, boolean>>({});
  const setPaused = useCallback((caseId: keyof typeof API_PINS, paused: boolean) => {
    setPausedCases((current) => ({ ...current, [caseId]: paused }));
  }, []);

  useEffect(() => {
    const unregisterCapture = registerViewport3DThumbnailCapture(
      "development-run-outcome-fixture",
      async () => {
        const runtime = activeThumbnailRuntime;
        if (!runtime) return null;
        runtime.thumbnailCalls += 1;
        runtime.thumbnailStartedAtMs = Date.now();
        return runtime.thumbnailWrite.promise;
      },
    );
    const tauriHost = window as unknown as { __TAURI__?: FixtureTauriApi };
    const previousTauri = tauriHost.__TAURI__;
    const fixtureTauri: FixtureTauriApi = {
      core: {
        invoke: async function invoke<T>(command: string, args: unknown): Promise<T> {
          const request = (args as { readonly request?: FixtureTauriRequest } | null)?.request;
          const path = typeof request?.path === "string" ? request.path : "";
          const runtime = runtimes.find((item) => item.hostPath === path);
          if (command !== "project_record_outcome" || !runtime) {
            runtimes.forEach((item) => item.unknownTransport.push({
              method: `tauri:${command}`,
              path,
            }));
            throw new Error(`Unexpected fixture Tauri command: ${command}`);
          }
          const run = request?.run as RunOutcomeRecord | undefined;
          runtime.tauriCalls.push({
            command,
            preview: request?.preview && typeof request.preview === "object"
              ? request.preview as { colouring: string; png_base64: string }
              : null,
            run_id: run?.run_id ?? null,
          });
          return await runtime.tauriWrite.promise as T;
        },
      },
    };
    tauriHost.__TAURI__ = fixtureTauri;

    const initialized = Promise.all(runtimes.map((runtime) => runtime.projectDocument.open({
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65]),
      fileName: `${runtime.caseId}.fms`,
      hostPath: runtime.hostPath,
    })));
    const fixtureWindow = window as FixtureWindow;
    fixtureWindow.__developmentRunOutcomeHandoffChecks = async () => {
      try {
        await initialized;
        return await runChecks(runtimes, setPaused);
      } catch (error) {
        const message = describeError(error);
        return {
          actual_backend_runtime: false,
          checks: [{ detail: message, name: "fixture initialization", status: "failed" }],
          diagnostics: diagnosticsFor(runtimes),
          error: message,
          fixture_only: true,
          passed_checks: 0,
          schema: REPORT_SCHEMA,
          status: "failed",
          timing_instrumentation: TIMING_INSTRUMENTATION,
          total_checks: 1,
        };
      }
    };
    fixtureWindow.__developmentRunOutcomeHandoffDiagnostics = () => diagnosticsFor(runtimes);
    return () => {
      unregisterCapture();
      activeThumbnailRuntime = null;
      if (fixtureWindow.__developmentRunOutcomeHandoffChecks) {
        delete fixtureWindow.__developmentRunOutcomeHandoffChecks;
      }
      if (fixtureWindow.__developmentRunOutcomeHandoffDiagnostics) {
        delete fixtureWindow.__developmentRunOutcomeHandoffDiagnostics;
      }
      if (tauriHost.__TAURI__ === fixtureTauri) tauriHost.__TAURI__ = previousTauri;
    };
  }, [runtimes, setPaused]);

  return (
    <main
      data-development-run-outcome-handoff-fixture="true"
      style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}
    >
      <h1>Development run outcome handoff fixture</h1>
      <p>Three real status connectors exercise pause, reservation, thumbnail, Tauri-write, and document-guard boundaries.</p>
      <div aria-hidden="true" style={{ display: "none" }}>
        {runtimes.map((runtime) => (
          <CaseMount key={runtime.caseId} paused={pausedCases[runtime.caseId] === true} runtime={runtime} />
        ))}
      </div>
      <output data-fixture-case-count={runtimes.length}>Fixture-only browser proof; no native backend or solver is running.</output>
    </main>
  );
}
