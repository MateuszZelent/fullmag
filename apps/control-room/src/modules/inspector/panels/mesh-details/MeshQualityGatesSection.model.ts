import { asRecord } from "../MeshResourceView";

export type FamilyGateStatus = "pass" | "warn" | "failed";

export interface MixedCertificateFamilyGate {
  family: string;
  metric: string;
  minimumJacobianM3: number;
  p05: number;
  passed: boolean;
  positiveJacobian: boolean;
  status: FamilyGateStatus;
  threshold: number;
}

export interface MixedCertificateQualityPresentation {
  certificateFingerprint: string;
  certificateSchemaVersion: string;
  certificateStatus: string;
  familyGates: readonly MixedCertificateFamilyGate[];
  meshRevision: number | null;
  reason: string;
  status: "valid" | "stale" | "rejected" | "unavailable";
  topologyFingerprint: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const FAMILY_GATE_STATUS_RANK: Readonly<Record<FamilyGateStatus, number>> = {
  failed: 0,
  warn: 1,
  pass: 2,
};

function resolveFamilyGateStatus(
  rawStatus: string | null,
  passed: boolean,
  positiveJacobian: boolean,
): FamilyGateStatus {
  const normalized = rawStatus?.trim().toLowerCase() ?? "";
  if (
    !passed ||
    !positiveJacobian ||
    normalized === "failed" ||
    normalized === "fail" ||
    normalized === "rejected"
  ) {
    return "failed";
  }
  if (normalized === "warn" || normalized === "warning") {
    return "warn";
  }
  return "pass";
}

export function resolveMixedCertificateQualityPresentation(
  value: unknown,
): MixedCertificateQualityPresentation {
  const record = asRecord(value);
  const publishedStatus = nonEmptyString(record?.status);
  const explicitValid = typeof record?.valid === "boolean" ? record.valid : null;
  const topologyFingerprint = nonEmptyString(record?.topology_fingerprint);
  const certificateFingerprint = nonEmptyString(record?.certificate_fingerprint);
  const certificateStatus = nonEmptyString(record?.certificate_status);
  const meshRevision = finiteNumber(record?.mesh_revision);
  const reason = nonEmptyString(record?.reason) ?? "No mixed-certificate evidence published.";
  const identityIsCurrent =
    topologyFingerprint !== null &&
    certificateFingerprint !== null &&
    topologyFingerprint === certificateFingerprint;
  const rows = Array.isArray(record?.family_gates) ? record.family_gates : [];
  const parsedFamilyGates: MixedCertificateFamilyGate[] = rows.flatMap((entry) => {
    const row = asRecord(entry);
    const family = nonEmptyString(row?.family);
    const metric = nonEmptyString(row?.metric);
    const p05 = finiteNumber(row?.p05);
    const threshold = finiteNumber(row?.threshold);
    const minimumJacobianM3 = finiteNumber(row?.minimum_jacobian_m3);
    if (
      family === null ||
      metric === null ||
      p05 === null ||
      threshold === null ||
      minimumJacobianM3 === null ||
      typeof row?.passed !== "boolean" ||
      typeof row?.positive_jacobian !== "boolean"
    ) {
      return [];
    }
    const gateStatus = resolveFamilyGateStatus(
      nonEmptyString(row?.status),
      row.passed,
      row.positive_jacobian,
    );
    return [{
      family,
      metric,
      minimumJacobianM3,
      p05,
      passed: row.passed,
      positiveJacobian: row.positive_jacobian,
      status: gateStatus,
      threshold,
    }];
  });

  const sortedFamilyGates = [...parsedFamilyGates].sort(
    (left, right) =>
      FAMILY_GATE_STATUS_RANK[left.status] - FAMILY_GATE_STATUS_RANK[right.status],
  );
  const allGatesPassed = sortedFamilyGates.every((gate) => gate.status !== "failed");

  const valid =
    explicitValid !== false &&
    publishedStatus === "valid" &&
    certificateStatus === "accepted" &&
    identityIsCurrent &&
    sortedFamilyGates.length > 0 &&
    sortedFamilyGates.length === rows.length &&
    allGatesPassed;

  const status = valid
    ? "valid"
    : publishedStatus === "stale" ||
        (publishedStatus === "valid" && !identityIsCurrent)
      ? "stale"
      : publishedStatus === "rejected" ||
          certificateStatus === "rejected" ||
          explicitValid === false ||
          publishedStatus === "valid"
        ? "rejected"
        : "unavailable";

  return {
    certificateFingerprint: certificateFingerprint ?? "not published",
    certificateSchemaVersion:
      nonEmptyString(record?.certificate_schema_version) ?? "not published",
    certificateStatus: certificateStatus ?? "not published",
    familyGates: sortedFamilyGates,
    meshRevision,
    reason: valid ? "Current certificate evidence is complete." : reason,
    status,
    topologyFingerprint: topologyFingerprint ?? "not published",
  };
}
