"use client";

import { Atom, ShieldAlert } from "lucide-react";

import type { resolveCouplingInspectorModel } from "../../../panels/CouplingInspectorPanelModel";
import {
  EXCHANGE_UNITS,
  formatAreaAuto,
  INTERLAYER_UNITS,
} from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorSectionSpec } from "../../../template";
import {
  asJsonRecord,
  encodeEndpointKey,
  formatEndpointResolutionStatus,
  formatToleranceMeters,
  type CouplingSpecDraft,
} from "./physicsShared";

export function hydrateCouplingBaseline(input: {
  endpointOptions: readonly { value: string; label: string }[];
  isDraftRoute: boolean;
  matchedResourceRecord: Record<string, unknown> | null;
  matchedSceneRecord: Record<string, unknown> | null;
  requestedCouplingId: string;
}): CouplingSpecDraft {
  const {
    endpointOptions,
    isDraftRoute,
    matchedResourceRecord,
    matchedSceneRecord,
    requestedCouplingId,
  } = input;
  const objectOnlyOpts = endpointOptions.filter((o) =>
    o.value.startsWith("object::"),
  );
  const fallbackAObj = (objectOnlyOpts[0]?.value ?? "object::layer-a").split(
    "::",
  )[1]!;
  const fallbackBObj = (
    objectOnlyOpts[1]?.value ??
    objectOnlyOpts[0]?.value ??
    "object::layer-b"
  ).split("::")[1]!;

  const exists =
    !isDraftRoute && Boolean(matchedResourceRecord || matchedSceneRecord);
  const rawKind = String(
    matchedResourceRecord?.coupling_kind ??
      matchedResourceRecord?.kind ??
      matchedSceneRecord?.kind ??
      matchedSceneRecord?.coupling_kind ??
      "rkky",
  );
  const kind: CouplingSpecDraft["kind"] =
    rawKind === "interlayer_exchange" || rawKind === "exchange"
      ? rawKind
      : "rkky";

  const params =
    asJsonRecord(
      matchedSceneRecord?.parameters ??
        matchedResourceRecord?.params ??
        matchedResourceRecord?.parameters ??
        matchedSceneRecord?.params ??
        matchedResourceRecord ??
        matchedSceneRecord,
    ) ?? {};

  const rawPolicy =
    matchedSceneRecord?.capability_policy ??
    matchedResourceRecord?.capability_policy;
  const capabilityPolicy: CouplingSpecDraft["capabilityPolicy"] =
    rawPolicy === "require_runtime" || rawPolicy === "authored_only"
      ? rawPolicy
      : "";

  const encodedA = encodeEndpointKey(
    asJsonRecord(
      matchedSceneRecord?.source ??
        matchedResourceRecord?.source ??
        matchedSceneRecord?.endpoint_a ??
        matchedResourceRecord?.endpoint_a ??
        matchedSceneRecord?.side_a,
    ),
    fallbackAObj,
  );
  const encodedB = encodeEndpointKey(
    asJsonRecord(
      matchedSceneRecord?.target ??
        matchedResourceRecord?.target ??
        matchedSceneRecord?.endpoint_b ??
        matchedResourceRecord?.endpoint_b ??
        matchedSceneRecord?.side_b,
    ),
    fallbackBObj,
  );

  const hasScale =
    typeof params.scale === "number" && Number.isFinite(params.scale);

  return {
    couplingId: requestedCouplingId,
    exists,
    enabled: (matchedResourceRecord ?? matchedSceneRecord)?.enabled !== false,
    kind,
    capabilityPolicy,
    endpointAKey: encodedA.key,
    endpointASurfaceSelector: encodedA.surfaceSelector,
    endpointBKey: encodedB.key,
    endpointBSurfaceSelector: encodedB.surfaceSelector,
    jRkky:
      typeof params.j1 === "number" && kind === "rkky"
        ? params.j1
        : typeof params.j_rkky === "number"
          ? params.j_rkky
          : typeof params.sigma === "number"
            ? params.sigma
            : -1.0e-3,
    j1: typeof params.j1 === "number" ? params.j1 : -1.0e-3,
    j2: typeof params.j2 === "number" ? params.j2 : -0.2e-3,
    exchangeMode:
      params.mode === "explicit" || params.mode === "disabled"
        ? params.mode
        : "harmonic_mean",
    explicitAex:
      typeof params.inter_exchange === "number"
        ? params.inter_exchange
        : typeof params.aex === "number"
          ? params.aex
          : 10e-12,
    hasExchangeScale: hasScale,
    exchangeScale: hasScale ? (params.scale as number) : 1,
  };
}

export const COUPLING_PARAMETERS_SECTION: InspectorSectionSpec<CouplingSpecDraft> =
  {
    id: "coupling-parameters",
    title: "Interfacial coupling strength",
    icon: Atom,
    defaultOpen: true,
    rows: [
      {
        key: "jRkky",
        type: "quantity",
        label: "RKKY bilinear constant",
        symbol: (
          <>
            J<sub>RKKY</sub>
          </>
        ),
        hint: "Negative values favor antiparallel (synthetic antiferromagnet) alignment.",
        units: INTERLAYER_UNITS,
        defaultDisplayUnit: "mJ/m\u00b2",
        showWhen: (d) => d.kind === "rkky",
      },
      {
        key: "j1",
        type: "quantity",
        label: "Bilinear interlayer constant",
        symbol: (
          <>
            J<sub>1</sub>
          </>
        ),
        units: INTERLAYER_UNITS,
        defaultDisplayUnit: "mJ/m\u00b2",
        showWhen: (d) => d.kind === "interlayer_exchange",
      },
      {
        key: "j2",
        type: "quantity",
        label: "Biquadratic 90° constant",
        symbol: (
          <>
            J<sub>2</sub>
          </>
        ),
        units: INTERLAYER_UNITS,
        defaultDisplayUnit: "mJ/m\u00b2",
        showWhen: (d) => d.kind === "interlayer_exchange",
      },
      {
        key: "exchangeMode",
        type: "segmented",
        label: "Interface stiffness rule",
        structural: true,
        showWhen: (d) => d.kind === "exchange",
        options: [
          { value: "harmonic_mean", label: "Harmonic mean" },
          { value: "explicit", label: "Explicit A_int" },
          { value: "disabled", label: "Decoupled" },
        ],
      },
      {
        key: "explicitAex",
        type: "quantity",
        label: "Explicit interface stiffness",
        symbol: (
          <>
            A<sub>int</sub>
          </>
        ),
        units: EXCHANGE_UNITS,
        defaultDisplayUnit: "pJ/m",
        min: 0,
        showWhen: (d) => d.kind === "exchange" && d.exchangeMode === "explicit",
      },
      {
        key: "hasExchangeScale",
        type: "switch",
        label: "Apply dimensionless exchange scale",
        structural: true,
        showWhen: (d) => d.kind === "exchange" && d.exchangeMode !== "disabled",
      },
      {
        key: "exchangeScale",
        type: "number",
        label: "Exchange scale factor",
        step: 0.05,
        showWhen: (d) =>
          d.kind === "exchange" &&
          d.exchangeMode !== "disabled" &&
          d.hasExchangeScale,
      },
    ],
  };

export function buildCouplingDiagnosticsSection(
  diagModel: ReturnType<typeof resolveCouplingInspectorModel>,
): InspectorSectionSpec<CouplingSpecDraft> {
  return {
    id: "coupling-mesh-diagnostics",
    title: "Endpoint resolution & diagnostics",
    icon: ShieldAlert,
    defaultOpen: true,
    live: true,
    showWhen: (d) => d.exists && diagModel.mode === "found",
    rows: [
      {
        type: "readonly",
        label: "Realization status",
        format: () => diagModel.realizationStatus.replace(/_/g, " "),
      },
      {
        type: "readonly",
        label: "Runtime policy",
        format: () =>
          diagModel.realizationStatus.includes("requires")
            ? "Requires backend capability"
            : "Authored intent",
      },
      {
        type: "readonly",
        label: "Source resolution",
        format: () =>
          `${diagModel.source?.label ?? "Source"} (${diagModel.source?.kind ?? "object"}) · ${formatEndpointResolutionStatus(diagModel.source?.resolutionStatus)}`,
      },
      {
        type: "readonly",
        label: "Source matched faces & area",
        mono: true,
        format: () => {
          const faces =
            diagModel.source?.resolvedFaceCount !== null &&
            diagModel.source?.resolvedFaceCount !== undefined
              ? `${diagModel.source.resolvedFaceCount} faces`
              : "Faces pending";
          const area =
            formatAreaAuto(diagModel.source?.area) ??
            (typeof diagModel.source?.area === "number"
              ? `${diagModel.source.area.toExponential(4)} m\u00b2`
              : "Area pending");
          return `${faces} · ${area}`;
        },
      },
      {
        type: "readonly",
        label: "Source detail & tolerance",
        format: () =>
          `${diagModel.source?.resolutionReason ?? "No blocker"} · tol ${formatToleranceMeters(diagModel.source?.tolerance)}`,
      },
      {
        type: "readonly",
        label: "Target resolution",
        format: () =>
          `${diagModel.target?.label ?? "Target"} (${diagModel.target?.kind ?? "object"}) · ${formatEndpointResolutionStatus(diagModel.target?.resolutionStatus)}`,
      },
      {
        type: "readonly",
        label: "Target matched faces & area",
        mono: true,
        format: () => {
          const faces =
            diagModel.target?.resolvedFaceCount !== null &&
            diagModel.target?.resolvedFaceCount !== undefined
              ? `${diagModel.target.resolvedFaceCount} faces`
              : "Faces pending";
          const area =
            formatAreaAuto(diagModel.target?.area) ??
            (typeof diagModel.target?.area === "number"
              ? `${diagModel.target.area.toExponential(4)} m\u00b2`
              : "Area pending");
          return `${faces} · ${area}`;
        },
      },
      {
        type: "readonly",
        label: "Target detail & tolerance",
        format: () =>
          `${diagModel.target?.resolutionReason ?? "No blocker"} · tol ${formatToleranceMeters(diagModel.target?.tolerance)}`,
      },
    ],
  };
}
