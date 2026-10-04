import type { ProjectDocumentResource } from "../api/apiTypes";
import type { ProjectDocumentSnapshot } from "./ProjectDocumentController";

export const PROJECT_DOCUMENT_DEVELOPMENT_HANDOFF_SCHEMA =
  "fullmag.project-document-development-handoff.v1" as const;

const MAX_HANDOFF_JSON_BYTES = 64 * 1024 * 1024;
const MAX_HANDOFF_DEPTH = 32;
const MAX_HANDOFF_NODES = 200_000;
const MAX_ARCHIVE_BASE64_CHARS = MAX_HANDOFF_JSON_BYTES;

export type ProjectDocumentDevelopmentSnapshot = Extract<
  ProjectDocumentSnapshot,
  { readonly state: "empty" | "ready" }
>;

export interface ProjectDocumentDevelopmentHandoff {
  readonly schema: typeof PROJECT_DOCUMENT_DEVELOPMENT_HANDOFF_SCHEMA;
  readonly snapshot: ProjectDocumentDevelopmentSnapshot;
}

export interface CaptureProjectDocumentDevelopmentHandoffOptions {
  readonly carryUnsaved?: boolean;
}

/** Validate and detach one bounded plain JSON object from caller-owned input. */
export function cloneBoundedProjectJsonObject(
  value: unknown,
): Record<string, unknown> {
  const detached = cloneJsonValue(value);
  const record = requireRecord(detached, "project JSON object");
  ensureBoundedJson(record);
  return record;
}

/** Capture a detached, bounded snapshot of the current project document. */
export function captureProjectDocumentDevelopmentHandoff(
  snapshot: ProjectDocumentSnapshot,
  options: CaptureProjectDocumentDevelopmentHandoffOptions = {},
): ProjectDocumentDevelopmentHandoff {
  if (snapshot.state === "loading" || snapshot.state === "error") {
    throw new Error("A loading or failed project document cannot be handed off.");
  }

  const detachedSnapshot = normalizeSnapshot(cloneJsonValue(snapshot));
  if (
    detachedSnapshot.state === "ready" &&
    detachedSnapshot.resource.dirty &&
    options.carryUnsaved !== true
  ) {
    throw new Error("Unsaved project changes require explicit carryUnsaved approval.");
  }

  const handoff: ProjectDocumentDevelopmentHandoff = {
    schema: PROJECT_DOCUMENT_DEVELOPMENT_HANDOFF_SCHEMA,
    snapshot: detachedSnapshot,
  };
  ensureBoundedJson(handoff);
  return handoff;
}

/** Validate and detach an untrusted handoff before it reaches controller state. */
export function validateProjectDocumentDevelopmentHandoff(
  value: unknown,
): ProjectDocumentDevelopmentHandoff {
  const detached = cloneJsonValue(value);
  const record = requireRecord(detached, "project document handoff");
  requireExactKeys(record, ["schema", "snapshot"]);
  if (record.schema !== PROJECT_DOCUMENT_DEVELOPMENT_HANDOFF_SCHEMA) {
    throw new Error("Unsupported project document handoff schema.");
  }

  const handoff: ProjectDocumentDevelopmentHandoff = {
    schema: PROJECT_DOCUMENT_DEVELOPMENT_HANDOFF_SCHEMA,
    snapshot: normalizeSnapshot(record.snapshot),
  };
  ensureBoundedJson(handoff);
  return handoff;
}

/** Validate a resource returned by the typed persistence facade. */
export function validateProjectDocumentResource(
  value: unknown,
): ProjectDocumentResource {
  const resource = normalizeResource(cloneJsonValue(value));
  ensureBoundedJson(resource);
  return resource;
}

/** Require the bytes-only open operation to reproduce the captured document. */
export function assertProjectDocumentReopenMatches(
  captured: ProjectDocumentResource,
  reopened: ProjectDocumentResource,
): void {
  if (
    reopened.project_id !== captured.project_id ||
    reopened.name !== captured.name ||
    reopened.schema_version !== captured.schema_version ||
    reopened.revision !== captured.revision ||
    reopened.mode.kind !== captured.mode.kind ||
    (reopened.mode.kind === "read_only" &&
      captured.mode.kind === "read_only" &&
      reopened.mode.reason !== captured.mode.reason) ||
    reopened.migration.target_schema !== captured.migration.target_schema ||
    reopened.migration.can_write !== captured.migration.can_write ||
    !sameCanonicalArchiveBytes(
      reopened.archive_base64,
      captured.archive_base64,
    )
  ) {
    throw new Error(
      "Reopened project document differs from the captured handoff snapshot.",
    );
  }
}

function normalizeSnapshot(value: unknown): ProjectDocumentDevelopmentSnapshot {
  const record = requireRecord(value, "project document snapshot");
  requireExactKeys(record, ["error", "fileName", "hostPath", "resource", "state"]);

  if (record.state === "empty") {
    if (
      record.error !== null ||
      record.fileName !== null ||
      record.hostPath !== null ||
      record.resource !== null
    ) {
      throw new Error("Invalid empty project document snapshot.");
    }
    return {
      error: null,
      fileName: null,
      hostPath: null,
      resource: null,
      state: "empty",
    };
  }

  if (record.state !== "ready" || record.error !== null) {
    throw new Error("Only empty or ready project document snapshots are supported.");
  }
  const fileName = boundedString(record.fileName, "project document file name", 1024);
  const hostPath = nullableBoundedString(
    record.hostPath,
    "project document host path",
    32_768,
  );
  const resource = normalizeResource(record.resource);
  return {
    error: null,
    fileName,
    hostPath,
    resource,
    state: "ready",
  };
}

function normalizeResource(value: unknown): ProjectDocumentResource {
  const record = requireRecord(value, "project document resource");
  requireExactKeys(
    record,
    [
      "archive_base64",
      "dirty",
      "durability",
      "migration",
      "mode",
      "name",
      "project_id",
      "revision",
      "schema_version",
    ],
    ["persisted_revision", "source_hash"],
  );

  const archiveBase64 = boundedString(
    record.archive_base64,
    "project archive base64",
    MAX_ARCHIVE_BASE64_CHARS,
  );
  validateCanonicalBase64(archiveBase64);
  if (typeof record.dirty !== "boolean") {
    throw new Error("Invalid project document dirty flag.");
  }
  if (record.durability !== "memory_only") {
    throw new Error("Unsupported project archive durability.");
  }

  const migration = normalizeMigration(record.migration);
  const mode = normalizeMode(record.mode);
  if (
    (mode.kind === "read_write" && !migration.can_write) ||
    (!migration.can_write && mode.kind !== "read_only")
  ) {
    throw new Error("Project document mode disagrees with migration writability.");
  }

  const resource: ProjectDocumentResource = {
    archive_base64: archiveBase64,
    dirty: record.dirty,
    durability: "memory_only",
    migration,
    mode,
    name: boundedString(record.name, "project document name", 4096),
    project_id: boundedString(record.project_id, "project document id", 512),
    revision: safeRevision(record.revision, "project document revision"),
    schema_version: boundedString(
      record.schema_version,
      "project document schema version",
      256,
    ),
  };

  if (Object.hasOwn(record, "persisted_revision")) {
    resource.persisted_revision =
      record.persisted_revision === null
        ? null
        : safeRevision(
            record.persisted_revision,
            "project document persisted revision",
          );
    if (
      (resource.persisted_revision !== null &&
        resource.persisted_revision !== undefined &&
        resource.persisted_revision > resource.revision) ||
      (!resource.dirty && resource.persisted_revision !== resource.revision)
    ) {
      throw new Error("Project document persisted revision is inconsistent.");
    }
  } else if (!resource.dirty) {
    throw new Error("A clean project document requires a persisted revision.");
  }
  if (Object.hasOwn(record, "source_hash")) {
    resource.source_hash =
      record.source_hash === null
        ? null
        : boundedString(record.source_hash, "project document source hash", 512);
  }
  return resource;
}

function normalizeMode(value: unknown): ProjectDocumentResource["mode"] {
  const record = requireRecord(value, "project document mode");
  if (record.kind === "read_write") {
    requireExactKeys(record, ["kind"]);
    return { kind: "read_write" };
  }
  if (record.kind === "read_only") {
    requireExactKeys(record, ["kind", "reason"]);
    return {
      kind: "read_only",
      reason: boundedString(record.reason, "project document mode reason", 4096),
    };
  }
  throw new Error("Unsupported project document mode.");
}

function normalizeMigration(value: unknown): ProjectDocumentResource["migration"] {
  const record = requireRecord(value, "project document migration");
  requireExactKeys(record, [
    "can_write",
    "migrated",
    "preserved_paths",
    "source_schema",
    "target_schema",
    "warnings",
  ]);
  if (typeof record.can_write !== "boolean" || typeof record.migrated !== "boolean") {
    throw new Error("Invalid project migration flags.");
  }
  return {
    can_write: record.can_write,
    migrated: record.migrated,
    preserved_paths: boundedStringArray(
      record.preserved_paths,
      "project migration preserved paths",
    ),
    source_schema: boundedString(record.source_schema, "project source schema", 256),
    target_schema: boundedString(record.target_schema, "project target schema", 256),
    warnings: boundedStringArray(record.warnings, "project migration warnings"),
  };
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 4096) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.map((entry) => boundedString(entry, label, 4096, true));
}

function boundedString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    (!allowEmpty && value.trim().length === 0) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function nullableBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  return value === null ? null : boundedString(value, label, maximumLength);
}

function safeRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function validateCanonicalBase64(value: string): void {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new Error("Project archive must be nonempty canonical base64.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  if (
    (padding === 2 && dataLength % 4 !== 2) ||
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 0 && dataLength % 4 !== 0)
  ) {
    throw new Error("Project archive base64 padding is not canonical.");
  }
  for (let index = 0; index < dataLength; index += 1) {
    if (base64Digit(value.charCodeAt(index)) < 0) {
      throw new Error("Project archive must be nonempty canonical base64.");
    }
  }
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength <= 0) {
    throw new Error("Project archive must contain bytes.");
  }
  if (padding > 0) {
    const significantBits = base64Digit(
      value.charCodeAt(value.length - padding - 1),
    );
    const unusedMask = padding === 2 ? 0b1111 : 0b11;
    if (significantBits < 0 || (significantBits & unusedMask) !== 0) {
      throw new Error("Project archive base64 padding is not canonical.");
    }
  }
}

function base64Digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function sameCanonicalArchiveBytes(left: string, right: string): boolean {
  validateCanonicalBase64(left);
  validateCanonicalBase64(right);
  // Canonical base64 has exactly one textual representation per byte sequence.
  return left === right;
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(record);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("Project document handoff contains missing or unknown fields.");
  }
}

function cloneJsonValue(value: unknown): unknown {
  const ancestors = new Set<object>();
  const budget = { nodes: 0 };
  return cloneJsonNode(value, ancestors, budget, 0);
}

function cloneJsonNode(
  value: unknown,
  ancestors: Set<object>,
  budget: { nodes: number },
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_HANDOFF_NODES || depth > MAX_HANDOFF_DEPTH) {
    throw new Error("Project document handoff is too complex.");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Handoff numbers must be finite.");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("Project document handoff must contain only JSON values.");
  }
  if (ancestors.has(value)) {
    throw new Error("Project document handoff cannot contain cycles.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_HANDOFF_NODES
      ) {
        throw new Error("Invalid project document handoff array.");
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.some((key) => typeof key !== "string") ||
        keys.some((key) => {
          if (key === "length") return false;
          if (typeof key !== "string") return true;
          const index = Number(key);
          return (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          );
        })
      ) {
        throw new Error("Invalid project document handoff array fields.");
      }
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("Project document handoff arrays cannot contain holes or accessors.");
        }
        clone.push(cloneJsonNode(descriptor.value, ancestors, budget, depth + 1));
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Project document handoff objects must be plain JSON records.");
    }
    const clone: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error("Project document handoff cannot contain symbol keys.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("Project document handoff cannot contain accessors.");
      }
      clone[key] = cloneJsonNode(descriptor.value, ancestors, budget, depth + 1);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function ensureBoundedJson(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new Error("Project document handoff is not JSON serializable.");
  }
  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > MAX_HANDOFF_JSON_BYTES) {
    throw new Error("Project document handoff exceeds the 64 MiB limit.");
  }
}
