"use client";

import { useEffect } from "react";

import type {
  ProjectArchiveRequest,
  ProjectAuthoringUpdateRequest,
  ProjectCreateRequest,
  ProjectDocumentResource,
} from "@/kernel/api/apiTypes";
import {
  bytesToBase64,
  ProjectDocumentController,
  type ProjectDocumentApi,
  type ProjectDocumentSnapshot,
} from "@/kernel/persistence/ProjectDocumentController";

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

async function runChecks(): Promise<FixtureReport> {
  const checks: FixtureCheck[] = [];
  const cases: Array<[string, () => Promise<void>]> = [
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
        Managed browser fixture only. It uses the real project controller with
        a stateless typed projects.open mock; it does not exercise the backend
        runtime or a solver.
      </p>
    </main>
  );
}
