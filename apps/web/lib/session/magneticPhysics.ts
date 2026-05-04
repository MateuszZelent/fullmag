import type {
  ScriptBuilderMagneticInteractionEntry,
  ScriptBuilderMagneticInteractionKind,
} from "./types";

const INTERACTION_ORDER: ScriptBuilderMagneticInteractionKind[] = [
  "exchange",
  "demag",
  "interfacial_dmi",
  "bulk_dmi",
  "uniaxial_anisotropy",
  "cubic_anisotropy",
];

function defaultParamsForKind(
  kind: ScriptBuilderMagneticInteractionKind,
  materialDind: number | null,
): Record<string, unknown> | null {
  if (kind === "interfacial_dmi") {
    return { dind: materialDind ?? 1e-3 };
  }
  if (kind === "uniaxial_anisotropy") {
    return { ku1: 0, ku2: 0, axis: [0, 0, 1] };
  }
  if (kind === "bulk_dmi") {
    return { d: 1e-3 };
  }
  if (kind === "cubic_anisotropy") {
    return { kc1: 0, kc2: 0, kc3: 0, axis1: [1, 0, 0], axis2: [0, 1, 0] };
  }
  return null;
}

function normalizeAxis(raw: unknown): [number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return [0, 0, 1];
  }
  return [
    Number(raw[0] ?? 0),
    Number(raw[1] ?? 0),
    Number(raw[2] ?? 1),
  ];
}

function normalizeEntry(
  raw: unknown,
  materialDind: number | null,
): ScriptBuilderMagneticInteractionEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as {
    kind?: unknown;
    enabled?: unknown;
    params?: unknown;
  };
  const kind = candidate.kind;
  if (
    kind !== "exchange"
    && kind !== "demag"
    && kind !== "interfacial_dmi"
    && kind !== "bulk_dmi"
    && kind !== "uniaxial_anisotropy"
    && kind !== "cubic_anisotropy"
  ) {
    return null;
  }
  let params: Record<string, unknown> | null =
    candidate.params && typeof candidate.params === "object" && !Array.isArray(candidate.params)
      ? { ...candidate.params as Record<string, unknown> }
      : defaultParamsForKind(kind, materialDind);
  if (kind === "interfacial_dmi") {
    params = {
      ...(params ?? {}),
      dind: Number((params ?? {}).dind ?? materialDind ?? 1e-3),
    };
  }
  if (kind === "uniaxial_anisotropy") {
    params = {
      ...(params ?? {}),
      ku1: Number((params ?? {}).ku1 ?? 0),
      ku2: Number((params ?? {}).ku2 ?? 0),
      axis: normalizeAxis((params ?? {}).axis),
    };
  }
  if (kind === "bulk_dmi") {
    params = {
      ...(params ?? {}),
      d: Number((params ?? {}).d ?? 1e-3),
    };
  }
  if (kind === "cubic_anisotropy") {
    params = {
      ...(params ?? {}),
      kc1: Number((params ?? {}).kc1 ?? 0),
      kc2: Number((params ?? {}).kc2 ?? 0),
      kc3: Number((params ?? {}).kc3 ?? 0),
      axis1: normalizeAxis((params ?? {}).axis1),
      axis2: normalizeAxis((params ?? {}).axis2),
    };
  }
  return {
    kind,
    enabled: candidate.enabled !== false,
    params,
  };
}

export function ensureObjectPhysicsStack(
  raw: unknown,
  materialDind: number | null = null,
): ScriptBuilderMagneticInteractionEntry[] {
  const entries: ScriptBuilderMagneticInteractionEntry[] = Array.isArray(raw)
    ? raw.map((entry) => normalizeEntry(entry, materialDind)).filter(Boolean) as ScriptBuilderMagneticInteractionEntry[]
    : [];
  const byKind = new Map<ScriptBuilderMagneticInteractionKind, ScriptBuilderMagneticInteractionEntry>();
  for (const entry of entries) {
    byKind.set(entry.kind, entry);
  }
  if (!byKind.has("exchange")) {
    byKind.set("exchange", { kind: "exchange", enabled: true, params: null });
  }
  if (!byKind.has("demag")) {
    byKind.set("demag", { kind: "demag", enabled: true, params: null });
  }
  const exchange = byKind.get("exchange");
  const demag = byKind.get("demag");
  if (exchange) {
    byKind.set("exchange", { ...exchange, enabled: true, params: null });
  }
  if (demag) {
    byKind.set("demag", { ...demag, enabled: true, params: null });
  }
  return INTERACTION_ORDER
    .map((kind) => byKind.get(kind))
    .filter(Boolean) as ScriptBuilderMagneticInteractionEntry[];
}

export function hasObjectInteraction(
  stack: readonly ScriptBuilderMagneticInteractionEntry[] | null | undefined,
  kind: ScriptBuilderMagneticInteractionKind,
): boolean {
  return Boolean(stack?.some((entry) => entry.kind === kind));
}

export function upsertObjectInteraction(
  stack: readonly ScriptBuilderMagneticInteractionEntry[] | null | undefined,
  kind: ScriptBuilderMagneticInteractionKind,
  patch?: Partial<ScriptBuilderMagneticInteractionEntry>,
): ScriptBuilderMagneticInteractionEntry[] {
  const base = ensureObjectPhysicsStack(stack ?? null);
  const next = base.map((entry) =>
    entry.kind === kind
      ? {
          ...entry,
          ...patch,
          params:
            patch?.params === undefined
              ? entry.params
              : patch.params,
        }
      : entry,
  );
  if (!next.some((entry) => entry.kind === kind)) {
    next.push({
      kind,
      enabled: patch?.enabled ?? true,
      params: patch?.params ?? defaultParamsForKind(kind, null),
    });
  }
  return ensureObjectPhysicsStack(next);
}

export function removeOptionalInteraction(
  stack: readonly ScriptBuilderMagneticInteractionEntry[] | null | undefined,
  kind: ScriptBuilderMagneticInteractionKind,
): ScriptBuilderMagneticInteractionEntry[] {
  if (kind === "exchange" || kind === "demag") {
    return ensureObjectPhysicsStack(stack ?? null);
  }
  return ensureObjectPhysicsStack(
    (stack ?? []).filter((entry) => entry.kind !== kind),
  );
}

export function magneticInteractionLabel(kind: ScriptBuilderMagneticInteractionKind): string {
  if (kind === "exchange") return "Exchange";
  if (kind === "demag") return "Demag";
  if (kind === "interfacial_dmi") return "Interfacial DMI";
  if (kind === "bulk_dmi") return "Bulk DMI";
  if (kind === "uniaxial_anisotropy") return "Uniaxial Ku";
  if (kind === "cubic_anisotropy") return "Cubic Kc";
  return kind;
}
