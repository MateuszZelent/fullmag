import type { DomainMetaResource } from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type {
  DomainPresentation,
  FdmUniverseOutsideMagneticSupport,
} from "@/shared/domain/mesh/domainPresentation";

export type FdmUniverseExtentStatus =
  | "error"
  | "loading"
  | "not-applicable"
  | "not-materialized"
  | "ready"
  | "stale";

export interface FdmUniverseExtentModel {
  boundsMax: readonly number[] | null;
  boundsMin: readonly number[] | null;
  coordinateSystem: string | null;
  domainId: string | null;
  generationId: string | null;
  gridShape: readonly number[] | null;
  notice: string;
  origin: readonly number[] | null;
  spacing: readonly number[] | null;
  status: FdmUniverseExtentStatus;
  totalCells: number | null;
  universeRole: FdmUniverseOutsideMagneticSupport | null;
  universeRoleSource: "domain-presentation" | "explicit-role-resource" | null;
  units: Readonly<Record<string, string>>;
}

export type FdmUniverseExtentResource = Pick<
  ResourceResult<DomainMetaResource | null>,
  "data" | "error" | "status"
>;

export type FdmUniverseRoleEvidence =
  | {
      presentation: DomainPresentation;
      source: "domain-presentation";
    }
  | {
      domainId: string;
      generationId: string;
      role: FdmUniverseOutsideMagneticSupport | null;
      source: "explicit-role-resource";
    };

function tuple3(values: readonly number[] | null | undefined): readonly number[] | null {
  if (!values || values.length < 3) return null;
  const tuple = values.slice(0, 3);
  return tuple.every((value) => typeof value === "number" && Number.isFinite(value))
    ? tuple
    : null;
}

function publishedCellCount(published: number | null | undefined): number | null {
  return typeof published === "number" && Number.isSafeInteger(published) && published >= 0
    ? published
    : null;
}

function baseModel(): Omit<FdmUniverseExtentModel, "status" | "notice"> {
  return {
    boundsMax: null,
    boundsMin: null,
    coordinateSystem: null,
    domainId: null,
    generationId: null,
    gridShape: null,
    origin: null,
    spacing: null,
    totalCells: null,
    universeRole: null,
    universeRoleSource: null,
    units: {},
  };
}

function resolveUniverseRole(
  domain: DomainMetaResource,
  evidence: FdmUniverseRoleEvidence | null | undefined,
): Pick<FdmUniverseExtentModel, "universeRole" | "universeRoleSource"> {
  if (!evidence) {
    return { universeRole: null, universeRoleSource: null };
  }

  if (evidence.source === "domain-presentation") {
    const presentation = evidence.presentation;
    if (
      presentation.discretization !== "fdm" ||
      presentation.domainId !== domain.domain_id ||
      presentation.generationId !== domain.generation_id
    ) {
      return { universeRole: null, universeRoleSource: null };
    }
    return {
      universeRole: presentation.universeOutsideMagneticSupport,
      universeRoleSource: presentation.universeOutsideMagneticSupport
        ? "domain-presentation"
        : null,
    };
  }

  if (
    evidence.domainId !== domain.domain_id ||
    evidence.generationId !== domain.generation_id
  ) {
    return { universeRole: null, universeRoleSource: null };
  }

  return {
    universeRole: evidence.role,
    universeRoleSource: evidence.role ? "explicit-role-resource" : null,
  };
}

function withStatus(
  status: FdmUniverseExtentStatus,
  notice: string,
  fields: Omit<FdmUniverseExtentModel, "status" | "notice"> = baseModel(),
): FdmUniverseExtentModel {
  return { ...fields, notice, status };
}

/**
 * Resolve the read-only FDM universe view from DomainMeta. No membership,
 * topology, support role, or derived count is inferred here. A support/universe
 * role is shown only when matching presentation/resource evidence is supplied.
 */
export function resolveFdmUniverseExtentModel({
  explicitFdm,
  resource,
  roleEvidence,
}: {
  explicitFdm: boolean;
  resource: FdmUniverseExtentResource;
  roleEvidence?: FdmUniverseRoleEvidence | null;
}): FdmUniverseExtentModel {
  if (!explicitFdm) {
    return withStatus(
      "not-applicable",
      "FDM universe extent is not applicable to the current explicit FEM lane.",
    );
  }

  if (resource.error || resource.status === "error") {
    return withStatus(
      "error",
      resource.error?.message ?? "FDM DomainMeta could not be loaded.",
    );
  }
  if (!resource.data) {
    return withStatus(
      resource.status === "loading" ? "loading" : "not-materialized",
      resource.status === "loading"
        ? "FDM DomainMeta is loading. FEM shared-domain meshing controls remain disabled."
        : "FDM DomainMeta is not materialized; no FEM shared-domain mesh is inferred.",
    );
  }

  const domain = resource.data;
  if (domain.discretization.trim().toLowerCase() !== "fdm") {
    return withStatus(
      "error",
      `Session requested FDM, but DomainMeta resolved '${domain.discretization}'. FEM shared-domain controls remain disabled until the lane is reconciled.`,
      {
        ...baseModel(),
        domainId: domain.domain_id,
        generationId: domain.generation_id,
      },
    );
  }

  const gridShape = tuple3(domain.grid?.shape);
  const origin = tuple3(domain.grid?.origin);
  const spacing = tuple3(domain.grid?.spacing);
  const boundsMin = tuple3(domain.bounds?.min);
  const boundsMax = tuple3(domain.bounds?.max);
  const fields = {
    ...baseModel(),
    boundsMax,
    boundsMin,
    coordinateSystem: domain.coordinate_system,
    domainId: domain.domain_id,
    generationId: domain.generation_id,
    gridShape,
    origin,
    spacing,
    totalCells: publishedCellCount(domain.counts.cells),
    units: domain.units,
    ...resolveUniverseRole(domain, roleEvidence),
  };

  if (!gridShape || !origin || !spacing) {
    return withStatus(
      "error",
      "FDM DomainMeta does not contain a complete structured-grid descriptor; no FEM shared-domain mesh is applicable.",
      fields,
    );
  }

  return withStatus(
    resource.status === "stale" ? "stale" : "ready",
    "Structured FDM universe/grid extent is published; magnetic-support / universe role is not published unless a matching DomainPresentation or explicit role resource provides it.",
    fields,
  );
}
