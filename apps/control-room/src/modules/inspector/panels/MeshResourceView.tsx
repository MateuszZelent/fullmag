import type { ReactNode } from "react";

import type { JsonObject, JsonValue } from "@/kernel/api/apiTypes";

import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

export type JsonRecord = Record<string, unknown>;

export interface MeshResourceField {
  label: string;
  unit?: string;
  value: ReactNode;
}

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function formatCount(value: unknown): string {
  const count = asNumber(value);
  return count === null ? "unknown" : count.toLocaleString("en-US");
}

export function formatLength(value: unknown): string {
  const number = asNumber(value);
  if (number === null) return "unset";
  const abs = Math.abs(number);
  if (abs >= 1e-3) return `${(number * 1e3).toPrecision(4)} mm`;
  if (abs >= 1e-6) return `${(number * 1e6).toPrecision(4)} um`;
  if (abs >= 1e-9) return `${(number * 1e9).toPrecision(4)} nm`;
  return `${number.toExponential(3)} m`;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "unset";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "invalid";
    if (Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3) {
      return value.toExponential(3);
    }
    return String(value);
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object") return "object";
  return String(value);
}

export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value, null, 2);
}

export function firstRecord(...values: unknown[]): JsonRecord | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

export function recordField(
  record: JsonRecord | null | undefined,
  key: string,
): unknown {
  return record ? record[key] : undefined;
}

export function nestedRecord(
  record: unknown,
  ...path: string[]
): JsonRecord | null {
  let current: unknown = record;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return asRecord(current);
}

export function maybeJsonObject(value: unknown): JsonObject | null {
  const record = asRecord(value);
  return record ? (record as JsonObject) : null;
}

export function MeshResourceFields({
  fields,
}: {
  fields: readonly MeshResourceField[];
}) {
  return (
    <>
      {fields.map((field) => (
        <FieldRow
          key={field.label}
          label={field.label}
          unit={field.unit}
          value={field.value}
        />
      ))}
    </>
  );
}

export function JsonResourceSection({
  badge,
  defaultCollapsed = true,
  title,
  value,
}: {
  badge?: string;
  defaultCollapsed?: boolean;
  title: string;
  value: unknown;
}) {
  return (
    <InspectorSection
      badge={badge}
      collapsible
      defaultCollapsed={defaultCollapsed}
      title={title}
    >
      <pre className="fm-mesh-json-preview">{formatJson(value)}</pre>
    </InspectorSection>
  );
}

export function MeshResourceEmpty({ label }: { label: string }) {
  return (
    <p className="fm-mesh-empty" role="note">
      {label}
    </p>
  );
}

export function jsonValue(value: unknown): JsonValue | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const entry of value) {
      const converted = jsonValue(entry);
      if (converted !== undefined) {
        result.push(converted);
      }
    }
    return result;
  }
  const record = asRecord(value);
  if (!record) return null;
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(record)) {
    const converted = jsonValue(entry);
    if (converted !== undefined) {
      result[key] = converted;
    }
  }
  return result;
}
