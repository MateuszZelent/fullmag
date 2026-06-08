import type { JsonObject } from "@/kernel/api/apiTypes";

export type MeshPolicyDiffScope = "airbox" | "object" | "region" | "shared-domain";
export type MeshPolicyDiffState =
  | "added"
  | "changed"
  | "realized-drift"
  | "removed"
  | "unchanged";
export type MeshPolicyDiffImpact =
  | "backend"
  | "cost"
  | "geometry"
  | "quality"
  | "resolution"
  | "unknown";

export interface MeshPolicyDiffRow {
  currentValue: string;
  draftValue: string;
  impact: MeshPolicyDiffImpact;
  label: string;
  path: string;
  realizedValue: string;
  scope: MeshPolicyDiffScope;
  state: MeshPolicyDiffState;
}

export interface MeshPolicyDiffInput {
  current?: JsonObject | null;
  draft?: JsonObject | null;
  impacts?: Partial<Record<string, MeshPolicyDiffImpact>>;
  labels?: Partial<Record<string, string>>;
  realized?: JsonObject | null;
  scope: MeshPolicyDiffScope;
}

const MISSING = Symbol("missing");

type FlatValue = string | number | boolean | null | typeof MISSING;

function flatten(
  value: unknown,
  prefix = "",
  output = new Map<string, FlatValue>(),
): Map<string, FlatValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix.length > 0) output.set(prefix, primitiveValue(value));
    return output;
  }

  for (const [key, nested] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      flatten(nested, path, output);
    } else {
      output.set(path, primitiveValue(nested));
    }
  }
  return output;
}

function primitiveValue(value: unknown): FlatValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function numericEquivalent(value: FlatValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function equivalent(left: FlatValue, right: FlatValue): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  const leftNumber = numericEquivalent(left);
  const rightNumber = numericEquivalent(right);
  if (leftNumber !== null && rightNumber !== null) {
    return Object.is(leftNumber, rightNumber);
  }
  return Object.is(left, right);
}

function displayValue(value: FlatValue): string {
  if (value === MISSING) return "unset";
  if (value === null) return "null";
  return String(value);
}

function impactForPath(
  path: string,
  impacts: MeshPolicyDiffInput["impacts"],
): MeshPolicyDiffImpact {
  const explicit = impacts?.[path];
  if (explicit) return explicit;
  const lower = path.toLowerCase();
  if (
    lower.includes("hmax") ||
    lower.includes("hmin") ||
    lower.includes("element_size") ||
    lower.includes("growth") ||
    lower.includes("resolution")
  ) {
    return "resolution";
  }
  if (lower.includes("algorithm") || lower.includes("optimize")) {
    return "backend";
  }
  if (lower.includes("quality")) return "quality";
  if (lower.includes("padding") || lower.includes("center") || lower === "size") {
    return "geometry";
  }
  return "unknown";
}

function stateForValues(
  current: FlatValue,
  draft: FlatValue,
  realized: FlatValue,
): MeshPolicyDiffState {
  if (current === MISSING && draft !== MISSING) return "added";
  if (current !== MISSING && draft === MISSING) return "removed";
  if (!equivalent(current, draft)) return "changed";
  if (realized !== MISSING && !equivalent(draft, realized)) {
    return "realized-drift";
  }
  return "unchanged";
}

export function diffMeshPolicies(input: MeshPolicyDiffInput): MeshPolicyDiffRow[] {
  const current = flatten(input.current ?? {});
  const draft = flatten(input.draft ?? {});
  const realized = flatten(input.realized ?? {});
  const paths = [...new Set([...current.keys(), ...draft.keys(), ...realized.keys()])]
    .toSorted((left, right) => left.localeCompare(right));

  return paths.map((path) => {
    const currentValue = current.get(path) ?? MISSING;
    const draftValue = draft.get(path) ?? MISSING;
    const realizedValue = realized.get(path) ?? MISSING;
    return {
      currentValue: displayValue(currentValue),
      draftValue: displayValue(draftValue),
      impact: impactForPath(path, input.impacts),
      label: input.labels?.[path] ?? path,
      path,
      realizedValue: displayValue(realizedValue),
      scope: input.scope,
      state: stateForValues(currentValue, draftValue, realizedValue),
    };
  });
}
