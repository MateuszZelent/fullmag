"use client";

import { useEffect, useMemo, useState } from "react";
import { PendingFormRegistry, type PendingForm } from "@/kernel/authoring/PendingFormRegistry";
import { createProblemWithPendingFormGuard } from "@/kernel/layout/createProblemWithPendingFormGuard";
import { NewProblemDialog } from "@/kernel/layout/NewProblemDialog";
import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import {
  PLATFORM_DEVELOPMENT_BACKEND_PATH,
  PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH,
  PERSISTENCE_PROJECT_OPEN_PATH,
} from "@/kernel/api/apiPaths";

import type {
  DevelopmentRestartResource,
  ProjectArchiveRequest,
  ProjectAuthoringUpdateRequest,
  ProjectCreateRequest,
  ProjectDocumentResource,
} from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ModuleRegistry } from "@/kernel/module/ModuleRegistry";
import { createDevelopmentRestartController } from "@/kernel/development/DevelopmentRestartController";
import type { DevelopmentRestartOwners } from "@/kernel/development/DevelopmentRestartController";
import {
  bytesToBase64,
  ProjectDocumentController,
  type ProjectDocumentApi,
  type ProjectDocumentSnapshot,
} from "@/kernel/persistence/ProjectDocumentController";
import { createDevelopmentKernelOwners } from "@/kernel/development/DevelopmentKernelOwners";

const HANDOFF_SCHEMA = "fullmag.project-document-development-handoff.v1";
const ARCHIVE_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x66, 0x75, 0x6c, 0x6c,
  0x6d, 0x61, 0x67, 0x2d, 0x68, 0x61, 0x6e, 0x64,
]);
const ARCHIVE_BASE64 = bytesToBase64(ARCHIVE_BYTES);
// Eight MiB of canonical base64 keeps this fixture representative of a real
// project archive while remaining below the handoff's 64 MiB JSON limit. The
// decoded bytes are deliberately zero-filled; this check is about bounded,
// linear transport validation, not archive or solver semantics.
const LARGE_ARCHIVE_BASE64 = "A".repeat(8 * 1024 * 1024);
const HASH = "a".repeat(64);
const PROJECT_ID = "project-development-handoff";
const PROJECT_SCHEMA = "fullmag.project.v1";
const HOST_PATH = "C:\\fullmag\\projects\\handoff.fms";
const OLD_API_PIN = "11111111-1111-4111-8111-111111111111";
const NEW_API_PIN = "22222222-2222-4222-8222-222222222222";
const FOREIGN_API_PIN = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "session-development-owner-fixture";
const SESSION_EPOCH = 43;
const REPLACEMENT_SESSION_ID = "session-development-owner-fixture-restarted";
const REPLACEMENT_SESSION_EPOCH = 1;

type DevelopmentHandoffOptions = { carryUnsaved?: boolean };

type DevelopmentProjectDocumentController = ProjectDocumentController & {
  captureDevelopmentHandoff(
    options?: DevelopmentHandoffOptions,
  ): unknown;
  restoreDevelopmentHandoff(payload: unknown): Promise<void>;
};

type OpenTransform = (
  resource: ProjectDocumentResource,
  request: ProjectArchiveRequest,
) => ProjectDocumentResource;
type AuthoringTransform = (
  resource: ProjectDocumentResource,
  request: ProjectAuthoringUpdateRequest,
) => ProjectDocumentResource;

interface MockApiOptions {
  readonly createResource?: ProjectDocumentResource;
  readonly openResource?: ProjectDocumentResource;
  readonly openTransform?: OpenTransform;
  readonly openDeferred?: Deferred<ProjectDocumentResource>;
  readonly failOpen?: Error;
  readonly failOpenOnce?: Error;
  readonly authoringResource?: ProjectDocumentResource;
  readonly authoringTransform?: AuthoringTransform;
  readonly authoringDeferred?: Deferred<ProjectDocumentResource>;
  readonly failAuthoring?: Error;
}

interface MockApiState {
  readonly api: ProjectDocumentApi;
  readonly calls: {
    readonly create: ProjectCreateRequest[];
    readonly open: ProjectArchiveRequest[];
    readonly authoring: ProjectAuthoringUpdateRequest[];
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

interface FixtureCheck {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
}

interface FixtureReport {
  readonly schema: typeof HANDOFF_SCHEMA;
  readonly status: "passed" | "failed";
  readonly fixture_only: true;
  readonly actual_backend_runtime: false;
  readonly checks: FixtureCheck[];
  readonly passed_checks: number;
  readonly total_checks: number;
}

declare global {
  interface Window {
    __newProblemFixture?: {
      read(): { apiCalls: number; historyClears: number; dirty: boolean };
      failRequest(): void;
    };
    __projectDocumentHandoffChecks?: () => Promise<FixtureReport>;
  }
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migration(overrides: Partial<ProjectDocumentResource["migration"]> = {}) {
  return {
    can_write: true,
    migrated: false,
    preserved_paths: ["project/main.py", "project/assets/mesh.bin"],
    source_schema: PROJECT_SCHEMA,
    target_schema: PROJECT_SCHEMA,
    warnings: ["fixture migration warning is preserved"],
    ...overrides,
  };
}

function resource(
  overrides: Partial<ProjectDocumentResource> = {},
): ProjectDocumentResource {
  const { migration: migrationOverrides, ...rest } = overrides;
  return {
    archive_base64: ARCHIVE_BASE64,
    dirty: false,
    durability: "memory_only",
    migration: migration(migrationOverrides),
    mode: { kind: "read_write" },
    name: "Development handoff project",
    persisted_revision: 7,
    project_id: PROJECT_ID,
    revision: 7,
    schema_version: PROJECT_SCHEMA,
    source_hash: HASH,
    ...rest,
  };
}

function makeMockApi(options: MockApiOptions = {}): MockApiState {
  const calls = {
    create: [] as ProjectCreateRequest[],
    open: [] as ProjectArchiveRequest[],
    authoring: [] as ProjectAuthoringUpdateRequest[],
  };
  let failedOnce = false;

  const api: ProjectDocumentApi = {
    persistence: {
      projects: {
        create: async (request) => {
          calls.create.push(clone(request));
          return clone(
            options.createResource ?? resource({ name: request.name, archive_base64: ARCHIVE_BASE64 }),
          );
        },
        open: async (request) => {
          calls.open.push(clone(request));
          const returned = options.openDeferred
            ? await options.openDeferred.promise
            : options.openResource ?? resource();
          if (options.failOpenOnce && !failedOnce) {
            failedOnce = true;
            throw options.failOpenOnce;
          }
          if (options.failOpen) throw options.failOpen;
          const normalized: ProjectDocumentResource = {
            ...clone(returned),
            // This is the stateless mock's deliberate backend behavior. The
            // real API normalizes an opened bytes archive the same way.
            archive_base64: request.archive_base64,
            dirty: false,
            persisted_revision: returned.revision,
          };
          return clone(options.openTransform?.(normalized, request) ?? normalized);
        },
        fromScript: async () => {
          throw new Error("fromScript is not used by this fixture");
        },
        authoringUpdate: async (request) => {
          calls.authoring.push(clone(request));
          const returned = options.authoringDeferred
            ? await options.authoringDeferred.promise
            : options.authoringResource ?? resource();
          if (options.failAuthoring) throw options.failAuthoring;
          return clone(options.authoringTransform?.(returned, request) ?? returned);
        },
      },
    },
  };
  return { api, calls };
}

interface ConcreteApiFixtureOptions {
  readonly workspaceApiInstance?: string;
  readonly sessionId?: string | null;
  readonly sessionEpoch?: number;
  readonly rejectRestartForChangedWorkspace?: boolean;
}

interface ConcreteApiFixture {
  readonly api: ControlRoomApi;
  readonly calls: {
    readonly requests: Array<{ readonly method: string; readonly path: string }>;
    readonly projectOpens: ProjectArchiveRequest[];
  };
}

type ConcreteOwnerKernel = {
  readonly api: ControlRoomApi;
  readonly bus: EventBus<KernelEventMap>;
  readonly layout: LayoutController;
  readonly modules: ModuleRegistry;
  readonly pendingForms: PendingFormRegistry;
  readonly projectDocument: ProjectDocumentController;
};

type ConcreteOwnerCapture = Awaited<ReturnType<DevelopmentRestartOwners["capture"]>>;

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

function makeConcreteApiFixture(
  apiPin: string,
  options: ConcreteApiFixtureOptions = {},
): ConcreteApiFixture {
  const calls = {
    requests: [] as Array<{ method: string; path: string }>,
    projectOpens: [] as ProjectArchiveRequest[],
  };
  const api = new ControlRoomApi({
    baseUrl: "http://localhost:3251",
    expectedApiInstance: apiPin,
    maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.requests.push({ method: request.method, path });
      if (request.method === "GET" && path === PLATFORM_DEVELOPMENT_BACKEND_PATH) {
        return jsonResponse({
          configured: true,
          state: "ready",
          restart_available: false,
          reason: "restart_integration_pending",
          revision: 1,
          schema_version: "fullmag.development-backend.v1",
          workspace_identity: {
            api_instance_id: options.workspaceApiInstance ?? apiPin,
            session_id: options.sessionId === undefined ? SESSION_ID : options.sessionId,
            session_epoch: options.sessionEpoch ?? SESSION_EPOCH,
          },
        }, apiPin);
      }
      if (request.method === "POST" && path === PERSISTENCE_PROJECT_OPEN_PATH) {
        const body = await request.json() as ProjectArchiveRequest;
        calls.projectOpens.push(clone(body));
        return jsonResponse(resource({ archive_base64: body.archive_base64 }), apiPin);
      }
      if (request.method === "POST" && path === PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH
        && options.rejectRestartForChangedWorkspace) {
        return jsonResponse({
          code: "development_restart_workspace_changed",
          message: "Workspace identity changed before restart acceptance.",
        }, apiPin, 409);
      }
      return jsonResponse({ code: "fixture_unexpected_route", message: `Unexpected ${request.method} ${path}` }, apiPin, 404);
    },
  });
  return { api, calls };
}

function makeConcreteOwnerKernel(
  api: ControlRoomApi,
  pendingForms = new PendingFormRegistry(),
): ConcreteOwnerKernel {
  const bus = new EventBus<KernelEventMap>();
  const layout = new LayoutController(bus);
  const modules = new ModuleRegistry();
  modules.register({
    id: "viewport-3d",
    title: "Fixture viewport",
    version: "1",
    slots: ["viewport-main"],
    component: async () => ({ default: () => null }),
  });
  return {
    api,
    bus,
    layout,
    modules,
    pendingForms,
    projectDocument: new ProjectDocumentController(api),
  };
}

async function openConcreteProject(kernel: ConcreteOwnerKernel): Promise<void> {
  await kernel.projectDocument.open({
    bytes: ARCHIVE_BYTES,
    fileName: "handoff.fms",
    hostPath: HOST_PATH,
  });
}

function developmentRestartOutcome(
  captured: ConcreteOwnerCapture,
  newApiInstanceId: string,
  sessionId = captured.sessionId === null ? null : REPLACEMENT_SESSION_ID,
  sessionEpoch = captured.sessionId === null ? 0 : REPLACEMENT_SESSION_EPOCH,
): DevelopmentRestartResource {
  return {
    schema: "fullmag.development-ui-restart-resource.v1",
    request_id: "33333333-3333-4333-8333-333333333333",
    state: "ready",
    new_api_instance_id: newApiInstanceId,
    session_id: sessionId,
    session_epoch: sessionEpoch,
    editor: clone(captured.editor),
    workspace: clone(captured.workspace),
    project_document: clone(captured.projectDocument),
  };
}

function developmentController(
  controller: ProjectDocumentController,
): DevelopmentProjectDocumentController {
  return controller as DevelopmentProjectDocumentController;
}

function capture(
  controller: ProjectDocumentController,
  options?: DevelopmentHandoffOptions,
): unknown {
  return developmentController(controller).captureDevelopmentHandoff(options);
}

function snapshotFromPayload(payload: unknown): Record<string, unknown> {
  assertCondition(
    payload !== null && typeof payload === "object" && !Array.isArray(payload),
    "Handoff payload must be an object",
  );
  const envelope = payload as Record<string, unknown>;
  assertCondition(envelope.schema === HANDOFF_SCHEMA, "Handoff schema is missing or incorrect");
  const snapshot = envelope.snapshot;
  assertCondition(
    snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot),
    "Handoff snapshot must be an object",
  );
  return snapshot as Record<string, unknown>;
}

async function restore(
  controller: ProjectDocumentController,
  payload: unknown,
): Promise<void> {
  await developmentController(controller).restoreDevelopmentHandoff(payload);
}

function assertEmpty(controller: ProjectDocumentController, label: string): void {
  const snapshot = controller.getSnapshot();
  assertCondition(snapshot.state === "empty", `${label}: controller is not empty`);
  assertCondition(snapshot.resource === null, `${label}: empty controller has a resource`);
  assertCondition(snapshot.fileName === null, `${label}: empty controller has a file name`);
  assertCondition(snapshot.hostPath === null, `${label}: empty controller has a host path`);
}

function assertReadyMatches(
  controller: ProjectDocumentController,
  expected: ProjectDocumentSnapshot,
  label: string,
): void {
  const actual = controller.getSnapshot();
  assertCondition(actual.state === "ready", `${label}: controller is not ready`);
  assertCondition(
    canonical(actual.resource) === canonical(expected.resource),
    `${label}: full resource metadata differs`,
  );
  assertCondition(actual.fileName === expected.fileName, `${label}: file name differs`);
  assertCondition(actual.hostPath === expected.hostPath, `${label}: host path differs`);
}

async function expectRejected(
  operation: () => unknown | Promise<unknown>,
  label: string,
): Promise<void> {
  let value: unknown;
  try {
    value = await operation();
  } catch {
    return;
  }
  if (value === false) return;
  throw new Error(`${label} unexpectedly completed`);
}

async function expectEmptyAfterRejectedRestore(
  payload: unknown,
  options: MockApiOptions,
  label: string,
): Promise<void> {
  const state = makeMockApi(options);
  const controller = new ProjectDocumentController(state.api);
  const notifications: ProjectDocumentSnapshot[] = [];
  const unsubscribe = controller.subscribe(() => notifications.push(clone(controller.getSnapshot())));
  try {
    await expectRejected(() => restore(controller, payload), label);
    assertEmpty(controller, label);
    assertCondition(
      notifications.every((snapshot) => snapshot.state !== "ready"),
      `${label}: a failed restore published a partial ready snapshot`,
    );
  } finally {
    unsubscribe();
  }
}

async function checkEmptyRestore(): Promise<void> {
  const state = makeMockApi();
  const controller = new ProjectDocumentController(state.api);
  const payload = capture(controller, { carryUnsaved: false });
  const snapshot = snapshotFromPayload(payload);
  assertCondition(snapshot.state === "empty", "Empty capture did not contain an empty snapshot");
  await restore(controller, payload);
  assertEmpty(controller, "Empty restore");
  assertCondition(state.calls.open.length === 0, "Empty restore called projects.open");
}

async function checkCleanAndDirtyCapture(): Promise<void> {
  const cleanState = makeMockApi({
    createResource: resource({ dirty: false, persisted_revision: 7 }),
  });
  const cleanController = new ProjectDocumentController(cleanState.api);
  await cleanController.create("Clean handoff");
  const cleanPayload = capture(cleanController, { carryUnsaved: false });
  const cleanSnapshot = snapshotFromPayload(cleanPayload);
  assertCondition(cleanSnapshot.state === "ready", "Clean capture did not contain a ready snapshot");
  assertCondition(
    (cleanSnapshot.resource as Record<string, unknown>).dirty === false,
    "Clean capture unexpectedly marked the project dirty",
  );

  const detachedSnapshot = snapshotFromPayload(cleanPayload);
  const detachedResource = detachedSnapshot.resource as Record<string, unknown>;
  const detachedMigration = detachedResource.migration as Record<string, unknown>;
  (detachedMigration.warnings as string[]).push("mutated detached warning");
  (detachedMigration.preserved_paths as string[]).push("project/new.bin");
  const originalResource = cleanController.getSnapshot().resource as ProjectDocumentResource;
  assertCondition(
    originalResource.migration.warnings.length === 1 &&
      originalResource.migration.preserved_paths.length === 2,
    "Captured resource or nested arrays were not detached",
  );

  const dirtyState = makeMockApi({
    createResource: resource({ dirty: true, persisted_revision: null }),
  });
  const dirtyController = new ProjectDocumentController(dirtyState.api);
  await dirtyController.create("Dirty handoff");
  await expectRejected(
    () => capture(dirtyController, { carryUnsaved: false }),
    "Dirty capture without carryUnsaved",
  );
  const dirtyPayload = capture(dirtyController, { carryUnsaved: true });
  const dirtySnapshot = snapshotFromPayload(dirtyPayload);
  assertCondition(dirtySnapshot.state === "ready", "Dirty capture did not contain a ready snapshot");
  assertCondition(
    (dirtySnapshot.resource as Record<string, unknown>).dirty === true,
    "Dirty capture lost the dirty marker",
  );
}

function metadataResource(): ProjectDocumentResource {
  return resource({
    dirty: true,
    migration: {
      can_write: true,
      migrated: true,
      preserved_paths: ["project/main.py", "project/assets/mesh.bin", "project/opaque.json"],
      source_schema: "fullmag.project.legacy.v1",
      target_schema: PROJECT_SCHEMA,
      warnings: ["legacy source preserved", "migration is reversible in fixture"],
    },
    name: "Metadata handoff project",
    persisted_revision: 4,
    project_id: "project-metadata-handoff",
    revision: 9,
    schema_version: PROJECT_SCHEMA,
    source_hash: HASH,
  });
}

async function makeReadyDirtyPayload(): Promise<unknown> {
  const originalResource = metadataResource();
  const sourceState = makeMockApi({
    openResource: originalResource,
    openTransform: (opened) => ({
      ...opened,
      dirty: true,
      persisted_revision: originalResource.persisted_revision,
      revision: originalResource.revision,
      source_hash: originalResource.source_hash,
      migration: clone(originalResource.migration),
    }),
  });
  const source = new ProjectDocumentController(sourceState.api);
  await source.open({
    bytes: ARCHIVE_BYTES,
    fileName: "handoff-project.fms",
    hostPath: HOST_PATH,
  });
  const payload = capture(source, { carryUnsaved: true });
  const snapshot = snapshotFromPayload(payload);
  assertCondition(snapshot.state === "ready", "Metadata source capture was not ready");
  return payload;
}

async function checkRestorePreservesMetadata(): Promise<void> {
  const payload = await makeReadyDirtyPayload();
  const expected = snapshotFromPayload(payload) as unknown as ProjectDocumentSnapshot;
  const state = makeMockApi({
    // The stateless API intentionally returns clean/current persisted metadata;
    // the controller must restore the captured values after validation.
    openResource: metadataResource(),
  });
  const controller = new ProjectDocumentController(state.api);
  const notifications: ProjectDocumentSnapshot[] = [];
  const unsubscribe = controller.subscribe(() => notifications.push(clone(controller.getSnapshot())));
  try {
    await restore(controller, payload);
    assertReadyMatches(controller, expected, "Metadata restore");
    assertCondition(state.calls.open.length === 1, "Metadata restore did not open exactly once");
    assertCondition(
      state.calls.open[0].archive_base64 ===
        ((expected.resource as ProjectDocumentResource).archive_base64),
      "Metadata restore changed the archive bytes sent to projects.open",
    );
    const ready = notifications.filter((snapshot) => snapshot.state === "ready");
    assertCondition(ready.length === 1, "Metadata restore published more than one ready state");
    assertCondition(
      canonical(ready[0].resource) === canonical(expected.resource),
      "Metadata ready notification: full resource metadata differs",
    );
    assertCondition(ready[0].fileName === expected.fileName, "Metadata ready notification: file name differs");
    assertCondition(ready[0].hostPath === expected.hostPath, "Metadata ready notification: host path differs");
  } finally {
    unsubscribe();
  }
}

async function checkLargeArchiveBase64(): Promise<void> {
  const sourceState = makeMockApi({
    createResource: resource({ archive_base64: LARGE_ARCHIVE_BASE64 }),
  });
  const source = new ProjectDocumentController(sourceState.api);
  await source.create("Large archive handoff");
  const payload = capture(source, { carryUnsaved: false });
  const captured = snapshotFromPayload(payload);
  const capturedResource = captured.resource as Record<string, unknown>;
  assertCondition(
    capturedResource.archive_base64 === LARGE_ARCHIVE_BASE64,
    "Large archive capture changed the canonical base64 string",
  );
  assertCondition(
    LARGE_ARCHIVE_BASE64.length >= 8 * 1024 * 1024,
    "Large archive fixture is smaller than the required 8 MiB base64 string",
  );

  const targetState = makeMockApi({
    openResource: resource({ archive_base64: LARGE_ARCHIVE_BASE64 }),
  });
  const target = new ProjectDocumentController(targetState.api);
  await restore(target, payload);
  assertCondition(target.getSnapshot().state === "ready", "Large archive restore did not become ready");
  assertCondition(targetState.calls.open.length === 1, "Large archive restore did not open exactly once");
  assertCondition(
    targetState.calls.open[0].archive_base64 === LARGE_ARCHIVE_BASE64,
    "Large archive restore changed the bytes sent to projects.open",
  );
}

function payloadWithResourceMutation(
  payload: unknown,
  mutate: (resource: Record<string, unknown>) => void,
): unknown {
  const detached = clone(payload) as Record<string, unknown>;
  const snapshot = detached.snapshot as Record<string, unknown>;
  mutate(snapshot.resource as Record<string, unknown>);
  return detached;
}

async function expectMalformedMetadataRestore(
  payload: unknown,
  label: string,
): Promise<void> {
  const state = makeMockApi({ openResource: metadataResource() });
  const controller = new ProjectDocumentController(state.api);
  await expectRejected(() => restore(controller, payload), label);
  assertEmpty(controller, label);
  assertCondition(state.calls.open.length === 0, `${label}: malformed metadata reached projects.open`);
}

async function checkMalformedRevisionMetadata(): Promise<void> {
  const cleanCases: Array<[string, ProjectDocumentResource]> = [];
  const cleanWithoutPersistedRevision = resource({ dirty: false });
  delete (cleanWithoutPersistedRevision as Record<string, unknown>).persisted_revision;
  cleanCases.push(["clean document without persisted_revision", cleanWithoutPersistedRevision]);
  cleanCases.push([
    "clean document with null persisted_revision",
    resource({ dirty: false, persisted_revision: null }),
  ]);

  for (const [label, invalidResource] of cleanCases) {
    const state = makeMockApi({ createResource: invalidResource });
    const controller = new ProjectDocumentController(state.api);
    await controller.create(label);
    await expectRejected(() => capture(controller), `${label} capture`);
  }

  const dirtyNullState = makeMockApi({
    createResource: resource({ dirty: true, persisted_revision: null }),
  });
  const dirtyNullController = new ProjectDocumentController(dirtyNullState.api);
  await dirtyNullController.create("dirty null persisted_revision");
  const dirtyNullPayload = capture(dirtyNullController, { carryUnsaved: true });
  const dirtyNullSnapshot = snapshotFromPayload(dirtyNullPayload);
  assertCondition(
    (dirtyNullSnapshot.resource as Record<string, unknown>).persisted_revision === null,
    "Dirty document with null persisted_revision was not preserved",
  );

  const futureState = makeMockApi({
    createResource: resource({ dirty: true, persisted_revision: 8, revision: 7 }),
  });
  const futureController = new ProjectDocumentController(futureState.api);
  await futureController.create("future persisted_revision");
  await expectRejected(
    () => capture(futureController, { carryUnsaved: true }),
    "future persisted_revision capture",
  );

  const validPayload = await makeReadyDirtyPayload();
  await expectMalformedMetadataRestore(
    payloadWithResourceMutation(validPayload, (document) => {
      document.dirty = false;
      delete document.persisted_revision;
    }),
    "restore clean document without persisted_revision",
  );
  await expectMalformedMetadataRestore(
    payloadWithResourceMutation(validPayload, (document) => {
      document.dirty = false;
      document.persisted_revision = null;
    }),
    "restore clean document with null persisted_revision",
  );
  await expectMalformedMetadataRestore(
    payloadWithResourceMutation(validPayload, (document) => {
      document.dirty = true;
      document.persisted_revision = 10;
    }),
    "restore future persisted_revision",
  );

  const validDirtyNullPayload = payloadWithResourceMutation(validPayload, (document) => {
    document.dirty = true;
    document.persisted_revision = null;
  });
  const validDirtyNullState = makeMockApi({ openResource: metadataResource() });
  const validDirtyNullController = new ProjectDocumentController(validDirtyNullState.api);
  await restore(validDirtyNullController, validDirtyNullPayload);
  const restored = validDirtyNullController.getSnapshot();
  assertCondition(restored.state === "ready", "Dirty document with null persisted_revision was rejected on restore");
  assertCondition(
    restored.resource.persisted_revision === null,
    "Dirty document with null persisted_revision changed during restore",
  );
}

async function checkMismatchesFailClosed(): Promise<void> {
  const payload = await makeReadyDirtyPayload();
  const mismatchCases: Array<[string, OpenTransform]> = [
    ["archive mismatch", (opened) => ({ ...opened, archive_base64: bytesToBase64(new Uint8Array([1, 2, 3])) })],
    ["project id mismatch", (opened) => ({ ...opened, project_id: "project-foreign" })],
    ["revision mismatch", (opened) => ({ ...opened, revision: opened.revision + 1 })],
    ["mode mismatch", (opened) => ({ ...opened, mode: { kind: "read_only", reason: "fixture mismatch" } })],
  ];
  for (const [label, openTransform] of mismatchCases) {
    await expectEmptyAfterRejectedRestore(
      payload,
      { openResource: metadataResource(), openTransform },
      label,
    );
  }
}

async function checkMalformedPayloadsFailClosed(): Promise<void> {
  const validPayload = await makeReadyDirtyPayload();
  const malformed: Array<[string, unknown]> = [
    ["null payload", null],
    ["wrong schema", { schema: "other.schema.v1", snapshot: {} }],
    ["top-level extra field", { ...(clone(validPayload) as Record<string, unknown>), extra: true }],
    [
      "snapshot extra field",
      {
        ...(clone(validPayload) as Record<string, unknown>),
        snapshot: {
          ...(snapshotFromPayload(validPayload) as Record<string, unknown>),
          extra: true,
        },
      },
    ],
    [
      "resource extra field",
      {
        ...(clone(validPayload) as Record<string, unknown>),
        snapshot: {
          ...(snapshotFromPayload(validPayload) as Record<string, unknown>),
          resource: {
            ...((snapshotFromPayload(validPayload) as Record<string, unknown>).resource as Record<string, unknown>),
            extra: true,
          },
        },
      },
    ],
    [
      "bad base64",
      {
        ...(clone(validPayload) as Record<string, unknown>),
        snapshot: {
          ...(snapshotFromPayload(validPayload) as Record<string, unknown>),
          resource: {
            ...((snapshotFromPayload(validPayload) as Record<string, unknown>).resource as Record<string, unknown>),
            archive_base64: "not base64!",
          },
        },
      },
    ],
    [
      "loading state",
      {
        ...(clone(validPayload) as Record<string, unknown>),
        snapshot: { ...(snapshotFromPayload(validPayload) as Record<string, unknown>), state: "loading" },
      },
    ],
    [
      "error state",
      {
        ...(clone(validPayload) as Record<string, unknown>),
        snapshot: { ...(snapshotFromPayload(validPayload) as Record<string, unknown>), state: "error" },
      },
    ],
  ];
  for (const [label, malformedPayload] of malformed) {
    await expectEmptyAfterRejectedRestore(malformedPayload, {}, label);
  }
}

async function checkBusyOperationGates(): Promise<void> {
  const emptyPayload = capture(new ProjectDocumentController(makeMockApi().api), {
    carryUnsaved: false,
  });
  const openDeferred = makeDeferred<ProjectDocumentResource>();
  const pendingOpenState = makeMockApi({ openDeferred });
  const pendingOpen = new ProjectDocumentController(pendingOpenState.api);
  const opening = pendingOpen.open({ bytes: ARCHIVE_BYTES, fileName: "pending-open.fms" });
  await Promise.resolve();
  await expectRejected(() => pendingOpen.create("blocked create"), "create while open pending");
  await expectRejected(() => pendingOpen.open({ bytes: ARCHIVE_BYTES, fileName: "blocked-open.fms" }), "open while open pending");
  await expectRejected(() => pendingOpen.save(), "save while open pending");
  await expectRejected(() => pendingOpen.close(true), "close while open pending");
  await expectRejected(() => capture(pendingOpen), "capture while open pending");
  await expectRejected(() => restore(pendingOpen, emptyPayload), "restore while open pending");
  openDeferred.resolve(resource());
  await opening;

  const sourcePayload = await makeReadyDirtyPayload();
  const restoreDeferred = makeDeferred<ProjectDocumentResource>();
  const pendingRestoreState = makeMockApi({ openDeferred: restoreDeferred });
  const pendingRestore = new ProjectDocumentController(pendingRestoreState.api);
  const firstRestore = restore(pendingRestore, sourcePayload);
  await Promise.resolve();
  await expectRejected(() => restore(pendingRestore, sourcePayload), "second restore while restore pending");
  await expectRejected(() => pendingRestore.create("blocked create"), "create while restore pending");
  await expectRejected(() => pendingRestore.open({ bytes: ARCHIVE_BYTES, fileName: "blocked-open.fms" }), "open while restore pending");
  await expectRejected(() => pendingRestore.save(), "save while restore pending");
  await expectRejected(() => pendingRestore.close(true), "close while restore pending");
  await expectRejected(() => capture(pendingRestore), "capture while restore pending");
  restoreDeferred.resolve(metadataResource());
  await firstRestore;

  const saveDeferred = makeDeferred<{
    path: string;
    project_id: string;
    revision: number;
    source_hash: string;
  }>();
  const previousTauri = window.__TAURI__;
  const invoke = async <T = unknown>(
    _command: string,
    _args?: Record<string, unknown>,
  ): Promise<T> => saveDeferred.promise as unknown as T;
  window.__TAURI__ = { core: { invoke } };
  try {
    const pendingSaveState = makeMockApi({ createResource: resource({ dirty: true }) });
    const pendingSave = new ProjectDocumentController(pendingSaveState.api);
    await pendingSave.create("pending-save");
    const saving = pendingSave.save();
    await Promise.resolve();
    await expectRejected(() => pendingSave.close(true), "close while save pending");
    await expectRejected(() => capture(pendingSave), "capture while save pending");
    await expectRejected(() => restore(pendingSave, sourcePayload), "restore while save pending");
    saveDeferred.resolve({
      path: HOST_PATH,
      project_id: PROJECT_ID,
      revision: 9,
      source_hash: HASH,
    });
    await saving;
  } finally {
    window.__TAURI__ = previousTauri;
  }
}

async function checkFailedRestoreCanRetry(): Promise<void> {
  const payload = await makeReadyDirtyPayload();
  const state = makeMockApi({
    openResource: metadataResource(),
    failOpenOnce: new Error("temporary project archive failure"),
  });
  const controller = new ProjectDocumentController(state.api);
  await expectRejected(() => restore(controller, payload), "first failed restore");
  assertEmpty(controller, "Failed restore");
  const openCountAfterFailure = state.calls.open.length;
  assertCondition(openCountAfterFailure === 1, "Failed restore retried without explicit user action");
  await restore(controller, payload);
  assertCondition(controller.getSnapshot().state === "ready", "Explicit restore retry did not succeed");
  const openCountAfterRetry = state.calls.open.length;
  assertCondition(openCountAfterRetry === 2, "Explicit restore retry did not issue exactly one new open");
}

async function checkAuthoringUpdatePreservesSourceMetadata(): Promise<void> {
  const updatedArchive = bytesToBase64(new Uint8Array([80, 75, 3, 4, 9, 8, 7]));
  const state = makeMockApi({
    openResource: resource({
      migration: migration({
        migrated: true,
        preserved_paths: ["project/main.py", "project/assets/mesh.bin"],
      }),
      source_hash: "sha256:original-source",
    }),
    authoringResource: resource({
      archive_base64: updatedArchive,
      dirty: true,
      migration: migration({
        migrated: true,
        preserved_paths: ["project/main.py", "project/assets/mesh.bin"],
      }),
      name: "Development handoff project",
      persisted_revision: 8,
      project_id: PROJECT_ID,
      revision: 8,
      source_hash: "sha256:transient-api-source",
    }),
  });
  const controller = new ProjectDocumentController(state.api);
  await controller.open({
    bytes: ARCHIVE_BYTES,
    fileName: "Source handoff.fms",
    hostPath: HOST_PATH,
  });
  const before = controller.getSnapshot();
  assertCondition(before.state === "ready", "Authoring source did not open");
  const originalScene: Record<string, unknown> = {
    version: "scene.v2",
    objects: [{ id: "object-a", material: { saturation: 0.25 } }],
  };
  const callerSceneBefore = canonical(originalScene);

  const updated = await controller.synchronizeAuthoring(originalScene);
  const after = controller.getSnapshot();
  assertCondition(after.state === "ready", "Authoring update did not leave a ready project");
  assertCondition(updated.archive_base64 === updatedArchive, "Updated archive was not installed");
  assertCondition(updated.revision === before.resource.revision + 1, "Updated revision did not advance once");
  assertCondition(updated.dirty, "Updated archive was not marked dirty");
  assertCondition(
    updated.persisted_revision === before.resource.persisted_revision,
    "Authoring update replaced the previous persisted revision",
  );
  assertCondition(
    updated.source_hash === before.resource.source_hash,
    "Authoring update replaced the original source hash",
  );
  assertCondition(after.fileName === before.fileName, "Authoring update changed the project file name");
  assertCondition(after.hostPath === before.hostPath, "Authoring update changed the host file path");
  assertCondition(
    canonical(originalScene) === callerSceneBefore,
    "Authoring update mutated the caller's scene object",
  );

  const request = state.calls.authoring[0];
  assertCondition(state.calls.authoring.length === 1, "Authoring update was not sent exactly once");
  assertCondition(request.archive_base64 === before.resource.archive_base64, "Authoring request archive differs");
  assertCondition(request.display_name === before.fileName, "Authoring request display name differs");
  assertCondition(request.expected_project_id === before.resource.project_id, "Authoring request project id differs");
  assertCondition(request.expected_revision === before.resource.revision, "Authoring request revision differs");
  assertCondition(canonical(request.scene_document) === callerSceneBefore, "Authoring request scene differs");
}

async function checkAuthoringNoOpRetainsSnapshot(): Promise<void> {
  const state = makeMockApi({
    authoringResource: resource({ name: "No-op project" }),
    authoringTransform: (returned) => ({
      ...returned,
      // A stateless API response may normalize bookkeeping even when the
      // canonical archive and definition revision are unchanged.
      source_hash: "sha256:response-only-metadata",
    }),
  });
  const controller = new ProjectDocumentController(state.api);
  await controller.create("No-op project");
  const before = controller.getSnapshot();
  assertCondition(before.state === "ready", "No-op source project did not open");

  const returned = await controller.synchronizeAuthoring({ version: "scene.v2" });
  assertCondition(returned === before.resource, "No-op did not return the original resource");
  assertCondition(controller.getSnapshot() === before, "No-op replaced or notified the controller snapshot");
}

async function checkAuthoringMismatchesFailClosed(): Promise<void> {
  const updatedArchive = bytesToBase64(new Uint8Array([80, 75, 3, 4, 1]));
  const state = makeMockApi({
    authoringResource: resource({
      archive_base64: updatedArchive,
      dirty: true,
      project_id: "project-foreign",
      revision: 8,
    }),
  });
  const controller = new ProjectDocumentController(state.api);
  await controller.create("Mismatch project");
  const before = controller.getSnapshot();
  await expectRejected(
    () => controller.synchronizeAuthoring({ version: "scene.v2" }),
    "foreign authoring response",
  );
  assertCondition(controller.getSnapshot() === before, "Rejected authoring response changed the snapshot");
}

async function checkAuthoringBusyOperationGates(): Promise<void> {
  const emptyPayload = capture(new ProjectDocumentController(makeMockApi().api), {
    carryUnsaved: false,
  });
  const updatedArchive = bytesToBase64(new Uint8Array([80, 75, 3, 4, 4]));
  const deferred = makeDeferred<ProjectDocumentResource>();
  const state = makeMockApi({ authoringDeferred: deferred });
  const controller = new ProjectDocumentController(state.api);
  await controller.create("Busy authoring project");
  const original = controller.getSnapshot();
  assertCondition(original.state === "ready", "Busy authoring source did not open");
  const authoring = controller.synchronizeAuthoring({ version: "scene.v2" });
  await Promise.resolve();

  await expectRejected(() => controller.create("blocked create"), "create while authoring pending");
  await expectRejected(
    () => controller.open({ bytes: ARCHIVE_BYTES, fileName: "blocked-open.fms" }),
    "open while authoring pending",
  );
  await expectRejected(() => controller.save(), "save while authoring pending");
  await expectRejected(() => controller.close(true), "close while authoring pending");
  await expectRejected(() => capture(controller), "capture while authoring pending");
  await expectRejected(
    () => restore(controller, emptyPayload),
    "restore while authoring pending",
  );
  await expectRejected(
    () => controller.synchronizeAuthoring({ version: "scene.v2" }),
    "second authoring while authoring pending",
  );
  assertCondition(controller.getSnapshot() === original, "Busy authoring changed the snapshot before validation");

  deferred.resolve(
    resource({
      archive_base64: updatedArchive,
      dirty: true,
      name: "Busy authoring project",
      persisted_revision: 7,
      revision: 8,
    }),
  );
  await authoring;
}

async function checkAuthoringFailuresLeaveSnapshotUnchanged(): Promise<void> {
  const failure = new Error("fixture authoring transport failure");
  const state = makeMockApi({ failAuthoring: failure });
  const controller = new ProjectDocumentController(state.api);
  await controller.create("Failure project");
  const before = controller.getSnapshot();

  let getterCalls = 0;
  const getterScene: Record<string, unknown> = { version: "scene.v2" };
  Object.defineProperty(getterScene, "trigger", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      controller.close(true);
      return true;
    },
  });
  let toJsonCalls = 0;
  const toJsonScene: Record<string, unknown> = {
    version: "scene.v2",
    toJSON: () => {
      toJsonCalls += 1;
      controller.close(true);
      return { version: "scene.v2" };
    },
  };
  const symbolScene: Record<string, unknown> = { version: "scene.v2" };
  Object.defineProperty(symbolScene, Symbol("extra"), {
    enumerable: true,
    value: true,
  });
  const circularScene: Record<string, unknown> = { version: "scene.v2" };
  circularScene.self = circularScene;
  const invalidScenes: Array<[string, Record<string, unknown>]> = [
    ["accessor scene document", getterScene],
    ["toJSON scene document", toJsonScene],
    ["symbol-key scene document", symbolScene],
    ["circular scene document", circularScene],
    ["non-finite scene document", { version: "scene.v2", value: Number.NaN }],
  ];
  for (const [label, scene] of invalidScenes) {
    await expectRejected(
      () => controller.synchronizeAuthoring(scene),
      label,
    );
    assertCondition(controller.getSnapshot() === before, `${label} changed the snapshot`);
  }
  assertCondition(getterCalls === 0, "Scene getter ran before input rejection");
  assertCondition(toJsonCalls === 0, "Scene toJSON ran before input rejection");
  assertCondition(state.calls.authoring.length === 0, "Invalid scene was sent to the API");

  await expectRejected(
    () => controller.synchronizeAuthoring({ version: "scene.v2" }),
    "authoring API failure",
  );
  assertCondition(controller.getSnapshot() === before, "Authoring API failure changed the snapshot");
  assertCondition(state.calls.authoring.slice().length === 1, "Authoring failure triggered an implicit retry");
}

async function checkAuthoringProxyReentryIsBusyGated(): Promise<void> {
  const state = makeMockApi({
    authoringResource: resource({ name: "Proxy project" }),
  });
  const controller = new ProjectDocumentController(state.api);
  await controller.create("Proxy project");
  let closeResult: boolean | null = null;
  const proxyScene = new Proxy(
    { version: "scene.v2" } as Record<string, unknown>,
    {
      getPrototypeOf(target) {
        closeResult = controller.close(true);
        return Reflect.getPrototypeOf(target);
      },
    },
  );

  await controller.synchronizeAuthoring(proxyScene);
  assertCondition(closeResult === false, "Proxy trap closed the project during authoring validation");
  assertCondition(controller.getSnapshot().state === "ready", "Proxy validation lost the project document");
  assertCondition(state.calls.authoring.length === 1, "Valid proxy scene was not sent exactly once");
}

function pendingForm(patch: Partial<PendingForm> = {}): PendingForm {
  return {
    apply: () => true,
    applying: false,
    dirty: false,
    mode: "staged",
    reset: () => undefined,
    valid: true,
    ...patch,
  };
}

async function checkAllPendingFormsProtectTransition(): Promise<void> {
  const registry = new PendingFormRegistry();
  const hiddenOwner = Symbol("hidden-dirty");
  registry.register(hiddenOwner, pendingForm({ dirty: true }));
  registry.register(Symbol("visible-clean"), pendingForm());
  assertCondition(!registry.getSnapshot().dirty, "Visible form should be clean in this fixture");
  await expectRejected(() => registry.prepareTransition({ applyPendingChanges: false }), "hidden dirty transition");
  registry.update(hiddenOwner, pendingForm({ applying: true }));
  await expectRejected(() => registry.prepareTransition({ applyPendingChanges: true }), "in-flight hidden transition");
  registry.clear();
  const guard = await registry.prepareTransition({ applyPendingChanges: false });
  guard.assertCurrent();
  registry.register(Symbol("new-draft"), pendingForm({ dirty: true }));
  await expectRejected(async () => guard.assertCurrent(), "changed registry guard");
  guard.release();
}

async function checkExplicitPendingApplyAndReentry(): Promise<void> {
  const registry = new PendingFormRegistry();
  const owner = Symbol("apply-owner");
  const finished = makeDeferred<boolean>();
  let calls = 0;
  registry.register(owner, pendingForm({ dirty: true, apply: async () => {
    calls += 1;
    const result = await finished.promise;
    registry.update(owner, pendingForm());
    return result;
  } }));
  const preparation = registry.prepareTransition({ applyPendingChanges: true });
  await expectRejected(() => registry.prepareTransition({ applyPendingChanges: true }), "duplicate transition");
  assertCondition((await registry.apply()).status !== "completed", "Apply bypassed transition ownership");
  assertCondition((await registry.reset()).status !== "completed", "Reset bypassed transition ownership");
  finished.resolve(true);
  const guard = await preparation;
  assertCondition(calls === 1, "Transition applied the same form more than once");
  guard.assertCurrent();
  guard.release();
  registry.register(owner, pendingForm({ dirty: true }));
  await expectRejected(() => registry.prepareTransition({ applyPendingChanges: true }), "unconfirmed clean form");
  assertCondition(registry.getSnapshot().dirty, "Failed preparation discarded the draft");
}

async function checkNewProblemGuardUsesNoImplicitDiscard(): Promise<void> {
  const registry = new PendingFormRegistry();
  const owner = Symbol("new-problem-draft");
  let calls = 0;
  const sessions = { create: async () => {
    calls += 1;
    throw new Error("owned API failure");
  } };
  const request = { backend: "fdm" as const, device: "cpu" as const, name: "Fixture", precision: "double" as const, replace_current: true };
  registry.register(owner, pendingForm({ dirty: true }));
  await expectRejected(() => createProblemWithPendingFormGuard(sessions, registry, request), "dirty new problem");
  assertCondition(calls === 0, "Dirty draft reached session replacement");
  assertCondition(registry.getSnapshot().dirty, "New Problem discarded the draft");
  registry.update(owner, pendingForm());
  await expectRejected(() => createProblemWithPendingFormGuard(sessions, registry, request), "failed new problem");
  assertCondition(Number(calls) === 1, "Session create was retried implicitly");
  const guard = await registry.prepareTransition({ applyPendingChanges: false });
  guard.assertCurrent();
  guard.release();
  await expectRejected(() => createProblemWithPendingFormGuard(sessions, undefined, request), "missing draft owner");
  assertCondition(Number(calls) === 1, "Missing registry reached session create");
}

async function checkPendingTransitionRefusals(): Promise<void> {
  for (const patch of [
    { valid: false }, { lockReason: "fixture conflict" },
    { mode: "liveViewport" as const }, { mode: "immediate" as const },
  ]) {
    const registry = new PendingFormRegistry();
    let calls = 0;
    registry.register(Symbol("blocked"), pendingForm({ ...patch, dirty: true, apply: () => { calls += 1; return true; } }));
    await expectRejected(() => registry.prepareTransition({ applyPendingChanges: true }), "ineligible form");
    assertCondition(calls === 0, "Ineligible transition executed Apply");
    assertCondition(registry.getSnapshot().dirty, "Ineligible transition discarded changes");
  }
  const empty = new PendingFormRegistry();
  const guard = await empty.prepareTransition({ applyPendingChanges: false });
  empty.clear();
  await expectRejected(async () => guard.assertCurrent(), "empty session clear");
  guard.release();
  const registry = new PendingFormRegistry();
  const owner = Symbol("cleared-in-apply");
  registry.register(owner, pendingForm({ dirty: true, apply: () => { registry.clear(); return true; } }));
  await expectRejected(() => registry.prepareTransition({ applyPendingChanges: true }), "owner vanished in Apply");
  const cleanGuard = await registry.prepareTransition({ applyPendingChanges: false });
  cleanGuard.release();
  await expectRejected(async () => cleanGuard.assertCurrent(), "released transition guard");
}

async function checkNewProblemAcknowledgedRacePreservesDraft(): Promise<void> {
  const registry = new PendingFormRegistry();
  const owner = Symbol("ack-race");
  registry.register(owner, pendingForm());
  type Response = Awaited<ReturnType<Parameters<typeof createProblemWithPendingFormGuard>[0]["create"]>>;
  const response: Response = {
    session_id: "fixture-accepted-session",
    revisions: { scene_revision: 0, state_version: 0 },
    scene_document: { schema_version: "0.3", objects: [] },
    status: {
      requested_execution: { backend: "fdm", device: "cpu", precision: "double" },
      effective_execution: { backend: "fdm", device: "cpu", precision: "double" },
      fallback: null,
    },
  };
  const requestFinished = makeDeferred<Response>();
  const requestStarted = makeDeferred<void>();
  let historyClears = 0;
  let calls = 0;
  const creation = createProblemWithPendingFormGuard({ create: () => {
    calls += 1;
    requestStarted.resolve();
    return requestFinished.promise;
  } }, registry, { backend: "fdm", device: "cpu", precision: "double", name: "Ack race", replace_current: true }, () => { historyClears += 1; });
  await requestStarted.promise;
  registry.update(owner, pendingForm({ dirty: true }));
  requestFinished.resolve(response);
  const outcome = await creation;
  assertCondition(outcome.response === response, "Acknowledged session outcome was lost");
  assertCondition(outcome.draftsPreserved, "Changed draft was cleared after positive ACK");
  assertCondition(registry.getSnapshot().dirty && historyClears === 0, "Acknowledged race cleared draft or history");
  assertCondition(calls === 1, "Acknowledged create was submitted twice");
  registry.update(owner, pendingForm());
  const normal = await createProblemWithPendingFormGuard({ create: async () => response }, registry,
    { backend: "fdm", device: "cpu", precision: "double", name: "Clean ack", replace_current: true }, () => { historyClears += 1; });
  assertCondition(!normal.draftsPreserved && normal.finalizationError === null, "Clean ACK did not finish normally");
  assertCondition(Number(historyClears) === 1 && registry.getSnapshot().registeredCount === 0, "Clean ACK did not clear prior form ownership");
}

async function checkPendingApplyCannotHideForeignMutation(): Promise<void> {
  const registry = new PendingFormRegistry();
  const owner = Symbol("self-clean");
  const otherOwner = Symbol("other-owner");
  registry.register(otherOwner, pendingForm());
  registry.register(owner, pendingForm({ dirty: true, apply: () => {
    registry.update(otherOwner, pendingForm());
    registry.update(owner, pendingForm());
    return true;
  } }));
  await expectRejected(() => registry.prepareTransition({ applyPendingChanges: true }), "foreign update hidden by self-clean");
  const second = new PendingFormRegistry();
  const firstOwner = Symbol("first");
  const nextOwner = Symbol("next");
  let nextCalls = 0;
  const next = pendingForm({ dirty: true, apply: () => { nextCalls += 1; return true; } });
  second.register(firstOwner, pendingForm({ dirty: true, apply: () => {
    next.valid = false;
    second.update(firstOwner, pendingForm());
    return true;
  } }));
  second.register(nextOwner, next);
  await expectRejected(() => second.prepareTransition({ applyPendingChanges: true }), "in-place mutation before next Apply");
  assertCondition(nextCalls === 0, "Transition executed a form whose validation changed during preparation");
}

async function checkUnpublishedCommandBlocksTransition(): Promise<void> {
  for (const command of ["apply", "reset"] as const) {
    const registry = new PendingFormRegistry();
    const owner = Symbol(command);
    const finished = makeDeferred<boolean>();
    let calls = 0;
    registry.register(owner, pendingForm({ dirty: true,
      apply: async () => { calls += 1; return await finished.promise; },
      reset: async () => { calls += 1; await finished.promise; },
    }));
    const pending = registry[command]();
    registry.update(owner, pendingForm());
    assertCondition(registry.getTransitionSnapshot().applyingOwnerCount === 1, "In-flight command lost its owner before React publication");
    await expectRejected(() => registry.prepareTransition({ applyPendingChanges: false }), "unpublished in-flight command");
    assertCondition((await registry.apply()).status !== "completed", "Concurrent Apply bypassed in-flight command");
    assertCondition((await registry.reset()).status !== "completed", "Concurrent Reset bypassed in-flight command");
    assertCondition(calls === 1, "In-flight callback was invoked twice");
    finished.resolve(true);
    assertCondition((await pending).status === "completed", "Original command did not finish");
    const guard = await registry.prepareTransition({ applyPendingChanges: false });
    guard.assertCurrent();
    guard.release();
  }
  for (const command of ["apply", "reset"] as const) {
    const registry = new PendingFormRegistry();
    const owner = Symbol("listener-mutation");
    let calls = 0;
    const form = pendingForm({ dirty: true, apply: () => { calls += 1; return true; }, reset: () => { calls += 1; } });
    registry.register(owner, form);
    const stop = registry.subscribe(() => {
      form.valid = false;
      form.apply = () => { calls += 1; return true; };
      form.reset = () => { calls += 1; };
    });
    assertCondition((await registry[command]()).status === "failed", "In-place listener mutation did not refuse the command");
    assertCondition(calls === 0, "Command executed a callback changed by its start notification");
    stop();
  }
}

async function checkDevelopmentDocumentGuard(): Promise<void> {
  const state = makeMockApi();
  const controller = new ProjectDocumentController(state.api);
  await controller.create("Guarded project");
  const original = clone(controller.getSnapshot());
  const guard = controller.beginDevelopmentHandoff();
  guard.assertCurrent();
  assertCondition(!controller.canSave(), "Save remained available during handoff");
  await expectRejected(() => controller.create("Replacement"), "guarded create");
  await expectRejected(() => controller.open({ bytes: ARCHIVE_BYTES, fileName: "other.fms" }), "guarded open");
  await expectRejected(() => controller.save(), "guarded save");
  await expectRejected(() => controller.synchronizeAuthoring({ objects: [] }), "guarded authoring");
  await expectRejected(() => controller.restoreDevelopmentHandoff(guard.handoff), "guarded restore");
  await expectRejected(() => controller.beginDevelopmentHandoff(), "duplicate guard");
  assertCondition(!controller.close(true), "Guarded Close discarded the document");
  assertCondition(canonical(controller.getSnapshot()) === canonical(original), "Guard changed document metadata");
  assertCondition(state.calls.create.length === 1 && state.calls.open.length === 0 && state.calls.authoring.length === 0,
    "Guarded operation reached document API");
  guard.release(); guard.release();
  await expectRejected(() => guard.assertCurrent(), "released guard assertion");
  assertCondition(controller.canSave(), "Release did not restore Save availability");
  const second = controller.beginDevelopmentHandoff();
  guard.release(); second.assertCurrent(); second.release();
  assertCondition(controller.close(true), "Released document could not be closed");
}

async function checkDevelopmentGuardFailureAndDirtyPolicy(): Promise<void> {
  const state = makeMockApi({ createResource: resource({ dirty: true, revision: 8, persisted_revision: 7 }) });
  const controller = new ProjectDocumentController(state.api);
  await controller.create("Dirty guarded project");
  await expectRejected(() => controller.beginDevelopmentHandoff(), "implicit dirty handoff");
  assertCondition(controller.canSave(), "Rejected dirty capture retained an unowned guard");
  const guard = controller.beginDevelopmentHandoff({ carryUnsaved: true });
  assertCondition(guard.handoff.snapshot.state === "ready" && guard.handoff.snapshot.resource.dirty,
    "Explicit dirty capture lost its draft");
  guard.release();
  const unsubscribe = controller.subscribe(() => { throw new Error("Fixture notification failure"); });
  await expectRejected(() => controller.beginDevelopmentHandoff({ carryUnsaved: true }), "notification failure");
  unsubscribe();
  assertCondition(controller.canSave(), "Failed guard notification left the document locked");
  const next = controller.beginDevelopmentHandoff({ carryUnsaved: true });
  next.assertCurrent(); next.release();
}

async function checkConcreteDevelopmentOwnerCaptureAndHydration(): Promise<void> {
  const oldApiFixture = makeConcreteApiFixture(OLD_API_PIN);
  const kernel = makeConcreteOwnerKernel(oldApiFixture.api);
  let pauseCount = 0;
  let resumeCount = 0;
  let publishCount = 0;
  const preparedReplacement: { kernel?: ConcreteOwnerKernel; api?: ConcreteApiFixture } = {};
  const owners = createDevelopmentKernelOwners(kernel, {
    applyPendingChanges: false,
    carryUnsavedDocument: false,
    pauseOldKernel: () => {
      pauseCount += 1;
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        resumeCount += 1;
      };
    },
    prepareReplacement: async (apiInstance) => {
      assertCondition(apiInstance === NEW_API_PIN, "Owner hydrate changed the replacement API pin");
      const api = makeConcreteApiFixture(apiInstance, {
        sessionId: REPLACEMENT_SESSION_ID,
        sessionEpoch: REPLACEMENT_SESSION_EPOCH,
      });
      const replacement = makeConcreteOwnerKernel(api.api);
      preparedReplacement.api = api;
      preparedReplacement.kernel = replacement;
      return replacement;
    },
    publishReplacement: async (published) => {
      assertCondition(published === preparedReplacement.kernel, "Published a different replacement owner");
      publishCount += 1;
    },
  });

  const emptyCapture = await owners.capture();
  const emptyHandoff = emptyCapture.projectDocument.snapshot as Record<string, unknown>;
  assertCondition(emptyHandoff.state === "empty", "Empty owner capture did not preserve the empty document");
  assertCondition(kernel.pendingForms.getTransitionSnapshot().guarded, "Empty owner capture did not guard forms");
  await expectRejected(
    () => kernel.projectDocument.restoreDevelopmentHandoff(emptyCapture.projectDocument),
    "restore during empty owner capture",
  );
  emptyCapture.assertCurrent();
  emptyCapture.release();
  emptyCapture.release();
  assertCondition(!kernel.pendingForms.getTransitionSnapshot().guarded, "Empty owner release retained the form guard");

  await openConcreteProject(kernel);
  kernel.pendingForms.register(Symbol("concrete owner clean form"), pendingForm());
  kernel.layout.replace({
    ...kernel.layout.get(),
    activeModuleTab: "geometry",
    focusedSlot: "panel-right",
    panelVisible: { left: false, right: true, bottom: false },
  });
  const originalDocument = clone(kernel.projectDocument.getSnapshot());
  const captured = await owners.capture();
  assertCondition(captured.sessionId === SESSION_ID && captured.sessionEpoch === SESSION_EPOCH,
    "Capture lost the actual pinned session identity and epoch");
  assertCondition(canonical(captured.editor) === canonical({
    schema: "fullmag.development-editor-handoff.v1",
    state: "absent",
  }), "The absent editor owner marker changed");
  assertCondition(canonical(captured.workspace.layout) === canonical(kernel.layout.get()),
    "Actual layout owner was not captured");
  assertCondition((captured.projectDocument.snapshot as Record<string, unknown>).state === "ready",
    "Ready document owner was not captured");
  assertCondition(kernel.pendingForms.getTransitionSnapshot().guarded, "Ready capture did not guard pending forms");
  assertCondition(!kernel.projectDocument.canSave(), "Ready capture did not freeze project document writes");
  captured.assertCurrent();

  const readyOutcome = developmentRestartOutcome(captured, NEW_API_PIN);
  assertCondition(readyOutcome.session_id === REPLACEMENT_SESSION_ID
    && readyOutcome.session_epoch === REPLACEMENT_SESSION_EPOCH,
  "Ready outcome did not describe a fresh session epoch");
  await owners.hydrate(readyOutcome);
  const hydratedReplacement = preparedReplacement.kernel;
  const hydratedApiFixture = preparedReplacement.api;
  assertCondition(hydratedReplacement !== undefined && hydratedApiFixture !== undefined, "Replacement owners were not prepared");
  assertCondition(hydratedReplacement.api !== kernel.api && hydratedReplacement.api.resourceCacheScope !== kernel.api.resourceCacheScope,
    "Replacement did not use a fresh API/cache owner");
  assertCondition(hydratedReplacement.pendingForms !== kernel.pendingForms
    && hydratedReplacement.projectDocument !== kernel.projectDocument && hydratedReplacement.layout !== kernel.layout,
  "Replacement reused one or more stateful owner instances");
  assertReadyMatches(hydratedReplacement.projectDocument, originalDocument, "Concrete replacement document");
  assertCondition(canonical(hydratedReplacement.layout.get()) === canonical(captured.workspace.layout),
    "Concrete replacement layout differs from captured layout");
  assertCondition(hydratedApiFixture.api.getExpectedApiInstance() === NEW_API_PIN,
    "Replacement API is not pinned to the acknowledged instance");
  assertCondition(hydratedApiFixture.calls.projectOpens.length === 1,
    "Project document hydration did not use the real typed projects.open facade");
  assertCondition(publishCount === 1, "Replacement owners were not published exactly once");
  assertCondition(kernel.pendingForms.getTransitionSnapshot().guarded && !kernel.projectDocument.canSave(),
    "Hydration released old-owner guards before the restart controller finalized");
  captured.release();
  captured.release();
  assertCondition(resumeCount === 2 && pauseCount === 2, "Owner lease release was not idempotent");
  assertCondition(!kernel.pendingForms.getTransitionSnapshot().guarded && kernel.projectDocument.canSave(),
    "Final owner release did not restore old-owner availability");
}

async function checkConcreteDevelopmentOwnerMismatchCleanup(): Promise<void> {
  const apiFixture = makeConcreteApiFixture(OLD_API_PIN, { workspaceApiInstance: FOREIGN_API_PIN });
  const kernel = makeConcreteOwnerKernel(apiFixture.api);
  await openConcreteProject(kernel);
  kernel.pendingForms.register(Symbol("mismatch clean form"), pendingForm());
  const original = clone(kernel.projectDocument.getSnapshot());
  let resumes = 0;
  const owners = createDevelopmentKernelOwners(kernel, {
    applyPendingChanges: false,
    carryUnsavedDocument: false,
    pauseOldKernel: () => () => { resumes += 1; },
    prepareReplacement: async () => { throw new Error("Mismatch capture must not prepare a replacement"); },
    publishReplacement: async () => { throw new Error("Mismatch capture must not publish a replacement"); },
  });
  await expectRejected(() => owners.capture(), "foreign capture identity");
  assertCondition(!kernel.pendingForms.getTransitionSnapshot().guarded, "Identity mismatch leaked the form guard");
  assertCondition(kernel.projectDocument.canSave(), "Identity mismatch leaked the document guard");
  assertCondition(canonical(kernel.projectDocument.getSnapshot()) === canonical(original),
    "Identity mismatch cleanup changed the existing document");
  assertCondition(resumes === 1, "Identity mismatch did not resume the old kernel exactly once");
  assertCondition(apiFixture.calls.requests.filter((request) => request.path === PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH).length === 0,
    "Capture mismatch submitted a restart mutation");
}

async function checkConcreteDevelopmentHydrationRefusals(): Promise<void> {
  const oldApiFixture = makeConcreteApiFixture(OLD_API_PIN);
  const kernel = makeConcreteOwnerKernel(oldApiFixture.api);
  await openConcreteProject(kernel);
  kernel.pendingForms.register(Symbol("refusal clean form"), pendingForm());
  let replacementMode: "fresh" | "foreign-pin" | "shared-pending-forms" = "fresh";
  let prepared = 0;
  let published = 0;
  const replacements: Array<{ kernel: ConcreteOwnerKernel; api: ConcreteApiFixture }> = [];
  const owners = createDevelopmentKernelOwners(kernel, {
    applyPendingChanges: false,
    carryUnsavedDocument: false,
    pauseOldKernel: () => () => undefined,
    prepareReplacement: async (apiInstance) => {
      prepared += 1;
      const pin = replacementMode === "foreign-pin" ? FOREIGN_API_PIN : apiInstance;
      const api = makeConcreteApiFixture(pin, {
        sessionId: REPLACEMENT_SESSION_ID,
        sessionEpoch: REPLACEMENT_SESSION_EPOCH,
      });
      const pendingForms = replacementMode === "shared-pending-forms"
        ? kernel.pendingForms
        : new PendingFormRegistry();
      const replacement = makeConcreteOwnerKernel(api.api, pendingForms);
      replacements.push({ kernel: replacement, api });
      return replacement;
    },
    publishReplacement: async () => { published += 1; },
  });
  const captured = await owners.capture();

  const beforePrepareCases: Array<[string, (value: DevelopmentRestartResource) => void]> = [
    ["invalid editor with extra state", (value) => {
      value.editor = { schema: "fullmag.development-editor-handoff.v1", state: "absent", draft: "foreign" };
    }],
    ["foreign editor schema", (value) => {
      value.editor = { schema: "foreign.editor.v1", state: "absent" };
    }],
    ["invalid workspace schema", (value) => {
      value.workspace = { schema: "foreign.layout.v1", layout: clone(captured.workspace.layout) };
    }],
  ];
  for (const [label, mutate] of beforePrepareCases) {
    const outcome = developmentRestartOutcome(captured, NEW_API_PIN);
    mutate(outcome);
    const previousPrepared = prepared;
    await expectRejected(() => owners.hydrate(outcome), label);
    assertCondition(prepared === previousPrepared, `${label}: invalid owner reached replacement preparation`);
    assertCondition(published === 0, `${label}: invalid owner was published`);
  }

  const afterPrepareCases: Array<{
    readonly label: string;
    readonly mode: "fresh" | "foreign-pin" | "shared-pending-forms";
    readonly mutate: (value: DevelopmentRestartResource) => void;
  }> = [
    { label: "invalid layout preference", mode: "fresh", mutate: (value) => {
      const workspace = clone(value.workspace) as Record<string, unknown>;
      const layout = clone(workspace.layout) as Record<string, unknown>;
      layout.activeModuleTab = "not-a-ribbon-tab";
      workspace.layout = layout;
      value.workspace = workspace;
    } },
    { label: "foreign viewport module", mode: "fresh", mutate: (value) => {
      const workspace = clone(value.workspace) as Record<string, unknown>;
      const layout = clone(workspace.layout) as Record<string, unknown>;
      layout.activeViewportMainModuleId = "foreign-viewport";
      workspace.layout = layout;
      value.workspace = workspace;
    } },
    { label: "foreign-pinned replacement client", mode: "foreign-pin", mutate: () => undefined },
    { label: "replacement reuses the old pending-form registry", mode: "shared-pending-forms", mutate: () => undefined },
  ];
  for (const entry of afterPrepareCases) {
    replacementMode = entry.mode;
    const outcome = developmentRestartOutcome(captured, NEW_API_PIN);
    entry.mutate(outcome);
    const previousPrepared = prepared;
    await expectRejected(() => owners.hydrate(outcome), entry.label);
    assertCondition(prepared === previousPrepared + 1, `${entry.label}: replacement was not inspected`);
    assertCondition(published === 0, `${entry.label}: rejected replacement was published`);
    const replacement = replacements[replacements.length - 1];
    assertCondition(replacement !== undefined, `${entry.label}: missing replacement evidence`);
    assertCondition(replacement.api.calls.requests.length === 0 && replacement.api.calls.projectOpens.length === 0,
      `${entry.label}: rejected replacement reached backend or document hydration`);
  }
  assertCondition(kernel.pendingForms.getTransitionSnapshot().guarded && !kernel.projectDocument.canSave(),
    "Rejected hydration released the captured owners");
  captured.assertCurrent();
  captured.release();
}

async function checkConcreteRestartControllerKnownRejection(): Promise<void> {
  const apiFixture = makeConcreteApiFixture(OLD_API_PIN, { rejectRestartForChangedWorkspace: true });
  const kernel = makeConcreteOwnerKernel(apiFixture.api);
  await openConcreteProject(kernel);
  kernel.pendingForms.register(Symbol("known rejection clean form"), pendingForm());
  let resumes = 0;
  const owners = createDevelopmentKernelOwners(kernel, {
    applyPendingChanges: false,
    carryUnsavedDocument: false,
    pauseOldKernel: () => () => { resumes += 1; },
    prepareReplacement: async () => { throw new Error("A rejected restart cannot prepare a replacement"); },
    publishReplacement: async () => { throw new Error("A rejected restart cannot publish a replacement"); },
  });
  const restart = createDevelopmentRestartController(apiFixture.api, owners);
  await restart.start();
  const snapshot = restart.getSnapshot();
  assertCondition(snapshot.state === "failed" && snapshot.message?.includes("not accepted"),
    "Known pre-publication workspace rejection was not classified as nonacceptance");
  assertCondition(resumes === 1 && !kernel.pendingForms.getTransitionSnapshot().guarded && kernel.projectDocument.canSave(),
    "Known rejection did not release its captured owner guard exactly once");
  assertCondition(apiFixture.calls.requests.filter((request) => request.path === PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH).length === 1,
    "Known rejection retried the restart mutation");
  assertCondition(apiFixture.calls.requests.filter((request) => request.path.includes("development-restart-requests/")).length === 0,
    "Known rejection issued an unnecessary status reconciliation read");
  assertCondition(apiFixture.calls.requests.filter((request) => request.path === PLATFORM_DEVELOPMENT_BACKEND_PATH).length === 1,
    "Known rejection unexpectedly repeated the old workspace identity read");
}

async function checkRestartFacadeAfterPinMismatch(): Promise<void> {
  const oldPin = "11111111-1111-4111-8111-111111111111";
  const newPin = "22222222-2222-4222-8222-222222222222";
  const requestId = "33333333-3333-4333-8333-333333333333";
  const token = "a".repeat(32);
  const calls: Request[] = [];
  const diagnostics = new RequestDiagnosticsController();
  const api = new ControlRoomApi({
    baseUrl: "http://localhost:3251", expectedApiInstance: oldPin, diagnostics, maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return new Response(JSON.stringify({ schema: "fullmag.development-ui-restart-resource.v1", request_id: requestId, state: "pending" }), {
        status: 200, headers: { "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": newPin },
      });
    },
  });
  const requestCount = (): number => calls.length;
  await expectRejected(() => api.platform.health(), "ordinary stale-pin response");
  assertCondition(requestCount() === 1 && calls[0].headers.get("x-fullmag-api-instance") === oldPin,
    "Ordinary request did not carry the old pin");
  const result = await api.platform.developmentRestartRequest(requestId, token);
  assertCondition(result.state === "pending" && requestCount() === 2, "Status could not be reconciled after mismatch latch");
  const statusRequest = calls[1];
  assertCondition(statusRequest.method === "GET" && !statusRequest.headers.has("x-fullmag-api-instance"), "Status retained the stale pin");
  assertCondition(statusRequest.headers.get("authorization") === `Bearer ${token}`, "Status lost its private token");
  assertCondition(!statusRequest.headers.has("x-fullmag-internal-api-instance-policy"), "Internal policy leaked to fetch");
  await expectRejected(() => api.platform.health(), "ordinary request after mismatch latch");
  assertCondition(requestCount() === 2, "Status exemption reopened ordinary API reads");
  assertCondition(!JSON.stringify(diagnostics.list()).includes(token), "Acknowledgement token entered diagnostics");
}

async function checkRestartFacadeSingleMutationAndCancellation(): Promise<void> {
  const oldPin = "11111111-1111-4111-8111-111111111111";
  const token = "b".repeat(32);
  const requestId = "33333333-3333-4333-8333-333333333333";
  let posts = 0;
  const api = new ControlRoomApi({
    baseUrl: "http://localhost:3251", expectedApiInstance: oldPin, maxGetRetries: 2,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      assertCondition(request.method === "POST", "Mutation changed HTTP method");
      assertCondition(request.headers.get("x-fullmag-api-instance") === oldPin && request.headers.get("authorization") === `Bearer ${token}`,
        "Mutation did not bind pin and token");
      posts++; throw new Error("Fixture lost acknowledgement");
    },
  });
  await expectRejected(() => api.platform.submitDevelopmentRestartRequest({
    schema: "fullmag.development-ui-restart-request.v1", request_id: requestId,
    session_id: null, session_epoch: 0, editor: {}, workspace: {}, project_document: {},
  }, token), "lost mutation acknowledgement");
  assertCondition(posts === 1, "Lost mutation ACK caused automatic resubmission");
  await expectRejected(() => api.platform.developmentRestartRequest(requestId, "invalid-token"), "invalid status token");
  assertCondition(posts === 1, "Invalid token reached fetch");
  const abort = new AbortController();
  let cancelled = false;
  const cancellable = new ControlRoomApi({
    baseUrl: "http://localhost:3251", expectedApiInstance: oldPin, maxGetRetries: 0,
    fetchImpl: async (input, init) => new Promise<Response>((_resolve, reject) => {
      const request = new Request(input, init);
      request.signal.addEventListener("abort", () => {
        cancelled = true; reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      abort.abort();
    }),
  });
  await expectRejected(() => cancellable.platform.developmentRestartRequest(requestId, token, { signal: abort.signal }), "cancelled status read");
  assertCondition(cancelled, "Status read did not propagate AbortSignal");
}

async function runChecks(): Promise<FixtureReport> {
  const checks: FixtureCheck[] = [];
  const cases: Array<[string, () => Promise<void>]> = [
    ["token-bound restart status remains readable after the old API mismatch latch", checkRestartFacadeAfterPinMismatch],
    ["restart mutation is single-attempt and status supports cancellation", checkRestartFacadeSingleMutationAndCancellation],
    ["document handoff guard blocks mutations and preserves metadata until release", checkDevelopmentDocumentGuard],
    ["dirty handoff requires explicit carry and failed guard issuance rolls back", checkDevelopmentGuardFailureAndDirtyPolicy],
    ["concrete owner factory captures empty/document/layout and hydrates fresh pinned owners", checkConcreteDevelopmentOwnerCaptureAndHydration],
    ["concrete owner identity mismatch releases every guard without submitting", checkConcreteDevelopmentOwnerMismatchCleanup],
    ["concrete owner hydrate rejects invalid or foreign owners and reused form registries", checkConcreteDevelopmentHydrationRefusals],
    ["restart controller releases guards after the concrete API reports known nonacceptance", checkConcreteRestartControllerKnownRejection],
    ["empty restore performs no API open", checkEmptyRestore],
    ["clean and dirty capture policy plus detached nested payload", checkCleanAndDirtyCapture],
    ["restore preserves resource metadata, file context and provenance", checkRestorePreservesMetadata],
    ["large canonical base64 archives stay bounded and detached", checkLargeArchiveBase64],
    ["clean/dirty persisted revision metadata fails closed or remains valid", checkMalformedRevisionMetadata],
    ["archive/id/revision/mode mismatches fail closed", checkMismatchesFailClosed],
    ["malformed, extra-field, loading/error and bad-base64 payloads fail closed", checkMalformedPayloadsFailClosed],
    ["busy create/open/save/close/capture/restore operations are refused", checkBusyOperationGates],
    ["failed restore retries only after an explicit second call", checkFailedRestoreCanRetry],
    ["authoring update preserves original source metadata and host context", checkAuthoringUpdatePreservesSourceMetadata],
    ["same-revision authoring response is an exact no-op", checkAuthoringNoOpRetainsSnapshot],
    ["foreign authoring identity is rejected without publishing", checkAuthoringMismatchesFailClosed],
    ["authoring busy gate blocks concurrent document operations", checkAuthoringBusyOperationGates],
    ["invalid input and API failure leave the snapshot unchanged", checkAuthoringFailuresLeaveSnapshotUnchanged],
    ["proxy reentry cannot close the document during authoring validation", checkAuthoringProxyReentryIsBusyGated],
    ["all registered forms guard transitions and invalidate stale leases", checkAllPendingFormsProtectTransition],
    ["explicit pending Apply owns callbacks and requires authoritative clean state", checkExplicitPendingApplyAndReentry],
    ["New Problem refuses dirty or unknown drafts without API call or discard", checkNewProblemGuardUsesNoImplicitDiscard],
    ["invalid/live/locked forms and cleared owners never authorize a transition", checkPendingTransitionRefusals],
    ["positive New Problem ACK preserves changed drafts without retry", checkNewProblemAcknowledgedRacePreservesDraft],
    ["self-clean Apply cannot hide a foreign registry or in-place mutation", checkPendingApplyCannotHideForeignMutation],
    ["unpublished in-flight Apply and Reset block transitions and duplicate commands", checkUnpublishedCommandBlocksTransition],
  ];
  for (const [name, check] of cases) {
    try {
      await check();
      checks.push({ name, status: "passed" });
    } catch (error) {
      checks.push({ name, status: "failed", detail: describeError(error) });
    }
  }
  const passedChecks = checks.filter((check) => check.status === "passed").length;
  return {
    schema: HANDOFF_SCHEMA,
    status: passedChecks === checks.length ? "passed" : "failed",
    fixture_only: true,
    actual_backend_runtime: false,
    checks,
    passed_checks: passedChecks,
    total_checks: checks.length,
  };
}

function NewProblemDraftFixture() {
  const [open, setOpen] = useState(false);
  const fixture = useMemo(() => {
    const registry = new PendingFormRegistry();
    const owner = Symbol("modal-draft");
    registry.register(owner, pendingForm({ dirty: true }));
    const request = makeDeferred<never>();
    const state = { apiCalls: 0, historyClears: 0 };
    // This fixture supplies only the services consumed by the production
    // dialog. It does not construct a runtime, resource cache, or renderer.
    const kernel = {
      api: { sessions: { create: () => {
        state.apiCalls += 1;
        return request.promise;
      } } },
      authoringHistory: { clear: () => { state.historyClears += 1; } },
      pendingForms: registry,
      resources: { invalidate: () => undefined, invalidatePrefix: () => undefined },
    } as unknown as KernelApi;
    return { kernel, owner, registry, request, state };
  }, []);
  useEffect(() => {
    window.__newProblemFixture = {
      read: () => ({ ...fixture.state, dirty: fixture.registry.getSnapshot().dirty }),
      failRequest: () => fixture.request.reject(new Error("Fixture session create failed")),
    };
    return () => { delete window.__newProblemFixture; };
  }, [fixture]);
  return (
    <KernelContext.Provider value={fixture.kernel}>
      <section aria-label="New Problem draft fixture">
        <button type="button" data-new-problem-open onClick={() => setOpen(true)}>Open New Problem fixture</button>
        <button type="button" data-new-problem-clean onClick={() => fixture.registry.update(fixture.owner, pendingForm())}>Resolve fixture draft</button>
        <NewProblemDialog hasActiveSession open={open} onOpenChange={setOpen} />
      </section>
    </KernelContext.Provider>
  );
}

export default function ProjectDocumentHandoffFixture() {
  useEffect(() => {
    window.__projectDocumentHandoffChecks = runChecks;
    return () => {
      delete window.__projectDocumentHandoffChecks;
    };
  }, []);

  return (
    <main
      data-project-document-handoff-fixture="true"
      style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}
    >
      <h1>Fullmag project document handoff fixture</h1>
      <p>
        Managed browser fixture only. It combines the real project and
        development-owner controllers with route-scoped fake responses through
        ControlRoomApi; it does not exercise the backend runtime or a solver.
      </p>
      <NewProblemDraftFixture />
    </main>
  );
}
