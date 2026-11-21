"use client";

import {
  Activity,
  ArrowRight,
  Cpu,
  FileCode2,
  GitBranch,
  Layers,
  Magnet,
  Plus,
  Scissors,
  Sliders,
  Zap,
} from "lucide-react";
import { useMemo } from "react";

import {
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  CurrentTransportMutationRequest,
  KnownSceneCurrentTransport,
  KnownSceneSpinTransport,
  OerstedFieldMutationRequest,
  SceneOerstedField,
  SceneResource,
  SceneSpinTorque,
  SceneStructuredCurrentClosure,
  SceneStructuredCurrentSourceCut,
  SpinTorqueMutationRequest,
  SpinTransportMutationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  invalidateSpinAuthoringResources,
  OERSTED_FIELDS_RESOURCE_KEY,
  SPIN_TORQUES_RESOURCE_KEY,
  transportMutationResourceKeys,
  useCurrentTransportsResource,
  useOerstedFieldsResource,
  useSpinInterfacesResource,
  useSpinInterfaceMeshEvidenceResource,
  useSpinTorquesResource,
  useSpinTransportsResource,
} from "@/kernel/resources/spinAuthoringResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorSpec,
} from "../../template";
import { INTERFACE_TRACE_DIRECTIONS } from "../SpinInterfaceInspectorModel";
import { verifySpinInterfaceMeshOrientation } from "../SpinInterfaceMeshEvidenceModel";
import {
  buildObjectSelection,
  buildRootSelection,
  CONDUCTIVITY_UNITS,
  CURRENT_DENSITY_UNITS,
  CURRENT_UNITS,
  FREQUENCY_UNITS,
  InspectorShortcutCards,
  LENGTH_UNITS,
  MIXING_CONDUCTANCE_UNITS,
  MU0_SI,
  normalizeVector3,
  SpecInspectorHost,
  TIME_UNITS,
  vectorNorm,
  VOLTAGE_UNITS,
} from "../model-roots/SpecInspectorHost";

/* ── Shared Target Option Helpers (Zero "unknown" labels!) ── */

function buildTargetScopeSelectOptions(
  scene: SceneResource | null | undefined,
): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  for (const obj of scene?.objects ?? []) {
    if (obj.role === "airbox" || obj.role === "air") continue;
    const objLabel = obj.name?.trim() || obj.id;
    opts.push({ value: `${obj.id}::`, label: `${objLabel} (${obj.id})` });
    for (const reg of obj.regions ?? []) {
      const regLabel = reg.name?.trim() || reg.region_id;
      opts.push({
        value: `${obj.id}::${reg.region_id}`,
        label: `${objLabel} / ${regLabel}`,
      });
    }
  }
  return opts.length > 0 ? opts : [{ value: "layer-1::", label: "Layer 1 (whole object)" }];
}

function encodeScope(objId?: string | null, regId?: string | null): string {
  return `${objId ?? ""}::${regId ?? ""}`;
}

function decodeScope(key: string): { object_id: string; region_id?: string } {
  const [object_id = "", region_id = ""] = key.split("::");
  return region_id ? { object_id, region_id } : { object_id };
}

function formatReadableScopeLabel(
  side: Record<string, unknown> | null | undefined,
  scene: SceneResource | null | undefined,
  fallback: string,
): string {
  if (!side) return fallback;
  const objId = typeof side.object_id === "string" ? side.object_id : "";
  const regId = typeof side.region_id === "string" ? side.region_id : "";
  if (!objId) return fallback;
  const obj = scene?.objects?.find((o) => o.id === objId);
  const objName = obj?.name?.trim() || objId;
  if (!regId) return objName;
  const reg = obj?.regions?.find((r) => r.region_id === regId);
  return `${objName}/${reg?.name?.trim() || regId}`;
}

type SceneSpinInterfaceItem = NonNullable<KnownSceneSpinTransport["interfaces"]>[number];
type SceneRegionRefItem = KnownSceneSpinTransport["domain"][number];

function extractDomainScope(
  rec: Record<string, unknown>,
  fallbackScope: SceneRegionRefItem,
): SceneRegionRefItem {
  const domainArr = Array.isArray(rec.domain)
    ? (rec.domain as Record<string, unknown>[])
    : [];
  const firstDom = domainArr[0];
  if (firstDom && typeof firstDom.object_id === "string" && firstDom.object_id) {
    return typeof firstDom.region_id === "string" && firstDom.region_id
      ? { object_id: firstDom.object_id, region_id: firstDom.region_id }
      : { object_id: firstDom.object_id };
  }
  if (typeof rec.object_id === "string" && rec.object_id) {
    return typeof rec.region_id === "string" && rec.region_id
      ? { object_id: rec.object_id, region_id: rec.region_id }
      : { object_id: rec.object_id };
  }
  return fallbackScope;
}

function normalizeSourceCutRecord(
  rawCut: Record<string, unknown>,
  idx: number,
  fallbackRegion: SceneRegionRefItem,
): SceneStructuredCurrentSourceCut {
  const plane = (rawCut.plane ?? null) as Record<string, unknown> | null;
  const drive = (rawCut.drive ?? null) as Record<string, unknown> | null;
  const reg = (rawCut.region ?? null) as Record<string, unknown> | null;
  const rawAxis = String(plane?.axis ?? "x").toLowerCase();
  const axis: "x" | "y" | "z" = rawAxis === "y" || rawAxis === "z" ? rawAxis : "x";
  const isNegative =
    plane?.normal === "negative_axis" || plane?.orientation === -1;
  const region: SceneRegionRefItem =
    reg && typeof reg.object_id === "string" && reg.object_id
      ? typeof reg.region_id === "string" && reg.region_id
        ? { object_id: reg.object_id, region_id: reg.region_id }
        : { object_id: reg.object_id }
      : fallbackRegion;
  return {
    source_cut_id: String(rawCut.source_cut_id ?? `cut-${idx + 1}`),
    circuit_id: String(rawCut.circuit_id ?? "loop-1"),
    region,
    plane: {
      axis,
      normal: isNegative ? "negative_axis" : "positive_axis",
      offset_m: typeof plane?.offset_m === "number" ? plane.offset_m : 0,
    },
    drive: {
      kind: "impressed_potential_jump",
      drive_id: String(drive?.drive_id ?? rawCut.drive_id ?? `drive-${idx + 1}`),
      potential_jump_V:
        typeof drive?.potential_jump_V === "number" ? drive.potential_jump_V : 0.01,
      schema_version:
        typeof drive?.schema_version === "string"
          ? drive.schema_version
          : "impressed_potential_jump.v1",
    },
  };
}

function normalizeCurrentTransportOwner(
  raw: Record<string, unknown>,
  fallbackId: string,
  fallbackScope: SceneRegionRefItem,
  closureOverride?: SceneStructuredCurrentClosure | null,
): KnownSceneCurrentTransport {
  const scope = extractDomainScope(raw, fallbackScope);
  const rawModel = String(raw.model ?? "prescribed_density");
  const model: KnownSceneCurrentTransport["model"] =
    rawModel === "ohmic_poisson" || rawModel === "ohmic_steady_state"
      ? "ohmic_poisson"
      : rawModel === "magnetoresistive_poisson" || rawModel === "anisotropic_amr_ahe"
        ? "magnetoresistive_poisson"
        : "prescribed_density";
  const rawClosure = (raw.structured_current_closure ?? null) as Record<
    string,
    unknown
  > | null;
  const resolvedClosure: SceneStructuredCurrentClosure | null =
    closureOverride !== undefined
      ? closureOverride
      : rawClosure
        ? {
            closure_id: String(rawClosure.closure_id ?? `${fallbackId}-closure`),
            kind: "closed_geometry",
            schema_version:
              typeof rawClosure.schema_version === "string"
                ? rawClosure.schema_version
                : "structured_current_closure.v1",
            source_cuts: (Array.isArray(rawClosure.source_cuts)
              ? (rawClosure.source_cuts as Record<string, unknown>[])
              : []
            ).map((c, idx) => normalizeSourceCutRecord(c, idx, scope)),
          }
        : null;

  const rawSolver = (raw.solver ?? null) as Record<string, unknown> | null;
  const rawLinear = (rawSolver?.linear ?? null) as Record<string, unknown> | null;
  const relTol =
    typeof rawLinear?.relative_tolerance === "number"
      ? rawLinear.relative_tolerance
      : typeof raw.solver_tolerance === "number"
        ? raw.solver_tolerance
        : 1e-9;

  const jVec = Array.isArray(raw.current_density ?? raw.current_density_Apm2)
    ? ((raw.current_density ?? raw.current_density_Apm2) as unknown[]).map(
        (v) => Number(v) || 0,
      )
    : [1e11, 0, 0];
  const mats = Array.isArray(raw.materials)
    ? (raw.materials as Record<string, unknown>[])
    : [];
  const firstMat = (mats[0]?.material ?? null) as Record<string, unknown> | null;
  const sigma =
    typeof raw.conductivity_s_per_m === "number"
      ? raw.conductivity_s_per_m
      : typeof firstMat?.sigma_Spm === "number"
        ? firstMat.sigma_Spm
        : typeof raw.sigma_Spm === "number"
          ? raw.sigma_Spm
          : 6.25e6;

  const rawLeadPrep = raw.external_lead_preparation;
  const external_lead_preparation: Record<string, unknown> | null =
    rawLeadPrep && typeof rawLeadPrep === "object" && !Array.isArray(rawLeadPrep)
      ? (rawLeadPrep as Record<string, unknown>)
      : typeof rawLeadPrep === "string" && rawLeadPrep !== "disabled"
        ? { mode: rawLeadPrep }
        : null;

  const rawConsView = raw.conservative_current_view;
  const conservative_current_view: Record<string, unknown> | null =
    resolvedClosure
      ? null
      : rawConsView && typeof rawConsView === "object" && !Array.isArray(rawConsView)
        ? (rawConsView as Record<string, unknown>)
        : rawConsView === true
          ? { enabled: true }
          : null;

  return {
    kind: "current_transport",
    name: String(raw.name ?? raw.id ?? fallbackId),
    model,
    domain: [scope],
    coupling: raw.coupling === "bidirectional" ? "bidirectional" : "one_way",
    gauge:
      raw.gauge === "zero_mean" || raw.gauge === "terminal_reference"
        ? raw.gauge
        : "dirichlet_reference",
    ...(model === "prescribed_density"
      ? { current_density: jVec }
      : {
          conductivity_s_per_m: sigma,
          materials: [
            {
              region: scope,
              material: {
                sigma_Spm: sigma,
                ...(typeof firstMat?.sigma_parallel_Spm === "number"
                  ? { sigma_parallel_Spm: firstMat.sigma_parallel_Spm }
                  : {}),
                ...(typeof firstMat?.sigma_perpendicular_Spm === "number"
                  ? { sigma_perpendicular_Spm: firstMat.sigma_perpendicular_Spm }
                  : {}),
                ...(typeof firstMat?.sigma_AHE_Spm === "number"
                  ? { sigma_AHE_Spm: firstMat.sigma_AHE_Spm }
                  : {}),
              },
            },
          ],
        }),
    external_lead_preparation,
    conservative_current_view,
    solver: {
      engine: typeof rawSolver?.engine === "string" ? rawSolver.engine : "gmres",
      linear: {
        absolute_tolerance:
          typeof rawLinear?.absolute_tolerance === "number"
            ? rawLinear.absolute_tolerance
            : 1e-14,
        max_iterations:
          typeof rawLinear?.max_iterations === "number"
            ? rawLinear.max_iterations
            : 1000,
        relative_tolerance: relTol,
      },
      operator_version: resolvedClosure
        ? "fv_charge_harmonic_source_cut_v1"
        : "fv_charge_harmonic_v1",
      physical_residual_version: "charge_balance_integrated_l2.v1",
    },
    structured_current_closure: resolvedClosure,
  };
}

function normalizeSpinInterfaceRecord(
  rawIface: Record<string, unknown>,
  idx: number,
  fallbackSideA: SceneRegionRefItem,
  fallbackSideB: SceneRegionRefItem,
): SceneSpinInterfaceItem {
  const id = String(rawIface.id ?? rawIface.interface_id ?? `iface-${idx + 1}`);
  const rawSideA = (rawIface.normal_side ?? rawIface.side_a ?? null) as Record<
    string,
    unknown
  > | null;
  const rawSideB = (rawIface.ferromagnet_side ?? rawIface.side_b ?? null) as Record<
    string,
    unknown
  > | null;
  const sideA: SceneRegionRefItem =
    rawSideA && typeof rawSideA.object_id === "string" && rawSideA.object_id
      ? typeof rawSideA.region_id === "string" && rawSideA.region_id
        ? { object_id: rawSideA.object_id, region_id: rawSideA.region_id }
        : { object_id: rawSideA.object_id }
      : fallbackSideA;
  const sideB: SceneRegionRefItem =
    rawSideB && typeof rawSideB.object_id === "string" && rawSideB.object_id
      ? typeof rawSideB.region_id === "string" && rawSideB.region_id
        ? { object_id: rawSideB.object_id, region_id: rawSideB.region_id }
        : { object_id: rawSideB.object_id }
      : fallbackSideB;
  const rawNorm = Array.isArray(rawIface.normal_to_ferromagnet ?? rawIface.normal_a_to_b)
    ? ((rawIface.normal_to_ferromagnet ?? rawIface.normal_a_to_b) as unknown[])
    : [0, 0, 1];
  const norm = normalizeVector3(
    [Number(rawNorm[0]) || 0, Number(rawNorm[1]) || 0, Number(rawNorm[2]) || 1],
    [0, 0, 1],
  );
  if (rawIface.kind === "transparent") {
    return {
      id,
      kind: "transparent",
      side_a: sideA,
      side_b: sideB,
      normal_a_to_b: norm,
    };
  }
  return {
    id,
    kind: "mixing_conductance",
    absorption:
      typeof rawIface.absorption === "string" ? rawIface.absorption : "ideal_transverse",
    formula_version:
      typeof rawIface.formula_version === "string"
        ? rawIface.formula_version
        : "magnetoelectronic_circuit.v1",
    normal_side: sideA,
    ferromagnet_side: sideB,
    normal_to_ferromagnet: norm,
    g_up_Spm2: typeof rawIface.g_up_Spm2 === "number" ? rawIface.g_up_Spm2 : 1.0e15,
    g_down_Spm2: typeof rawIface.g_down_Spm2 === "number" ? rawIface.g_down_Spm2 : 0.2e15,
    g_r_Spm2:
      typeof rawIface.g_r_Spm2 === "number"
        ? rawIface.g_r_Spm2
        : typeof rawIface.re_g_mix_Spm2 === "number"
          ? rawIface.re_g_mix_Spm2
          : 0.5e15,
    g_i_Spm2:
      typeof rawIface.g_i_Spm2 === "number"
        ? rawIface.g_i_Spm2
        : typeof rawIface.im_g_mix_Spm2 === "number"
          ? rawIface.im_g_mix_Spm2
          : 0.05e15,
    ...(typeof rawIface.g_sml_Spm2 === "number"
      ? { g_sml_Spm2: rawIface.g_sml_Spm2 }
      : {}),
  };
}

function normalizeSpinTransportOwner(
  raw: Record<string, unknown>,
  fallbackId: string,
  fallbackScope: SceneRegionRefItem,
  interfacesOverride?: SceneSpinInterfaceItem[],
): KnownSceneSpinTransport {
  const mats = Array.isArray(raw.materials)
    ? (raw.materials as Record<string, unknown>[])
    : [];
  const firstMatEntry = mats[0] ?? {};
  const firstMatRegion = (firstMatEntry.region ?? firstMatEntry) as Record<string, unknown>;
  const scope =
    typeof firstMatRegion.object_id === "string" && firstMatRegion.object_id
      ? typeof firstMatRegion.region_id === "string" && firstMatRegion.region_id
        ? { object_id: firstMatRegion.object_id, region_id: firstMatRegion.region_id }
        : { object_id: firstMatRegion.object_id }
      : extractDomainScope(raw, fallbackScope);
  const firstMat = ((firstMatEntry.material ?? raw) as Record<string, unknown>);
  const rawIfaces = Array.isArray(raw.interfaces)
    ? (raw.interfaces as Record<string, unknown>[])
    : [];
  const interfaces =
    interfacesOverride ??
    rawIfaces.map((iface, idx) =>
      normalizeSpinInterfaceRecord(iface, idx, scope, scope),
    );
  const rawSolver = (raw.solver ?? null) as Record<string, unknown> | null;
  const rawLinear = (rawSolver?.linear ?? null) as Record<string, unknown> | null;

  return {
    id: String(raw.id ?? raw.name ?? fallbackId),
    schema_version:
      typeof raw.schema_version === "string" ? raw.schema_version : "spin_transport.v1",
    constitutive_version:
      typeof raw.constitutive_version === "string"
        ? raw.constitutive_version
        : "drift_diffusion_spin_hall.v1",
    current_source_id:
      typeof raw.current_source_id === "string"
        ? raw.current_source_id
        : typeof raw.current_transport_id === "string"
          ? raw.current_transport_id
          : "",
    domain: [scope],
    materials: [
      {
        region: scope,
        material: {
          sigma_s_Spm: typeof firstMat.sigma_s_Spm === "number" ? firstMat.sigma_s_Spm : 5.0e6,
          lambda_sf_m: typeof firstMat.lambda_sf_m === "number" ? firstMat.lambda_sf_m : 3.5e-9,
          lambda_j_m: typeof firstMat.lambda_j_m === "number" ? firstMat.lambda_j_m : 1.2e-9,
          lambda_phi_m:
            typeof firstMat.lambda_phi_m === "number" ? firstMat.lambda_phi_m : 2.0e-9,
          polarization_p:
            typeof firstMat.polarization_p === "number" ? firstMat.polarization_p : 0.45,
          theta_sh: typeof firstMat.theta_sh === "number" ? firstMat.theta_sh : 0.08,
        },
      },
    ],
    boundaries: [],
    interfaces,
    mode: raw.mode === "transient" ? "transient" : "steady",
    requested_execution: {
      device: "auto",
      discretization: "auto",
      execution_mode: "strict",
      precision: "double",
    },
    solver: {
      default_external_boundary:
        typeof rawSolver?.default_external_boundary === "string"
          ? rawSolver.default_external_boundary
          : "spin_insulating",
      engine: typeof rawSolver?.engine === "string" ? rawSolver.engine : "gmres",
      linear: {
        absolute_tolerance:
          typeof rawLinear?.absolute_tolerance === "number"
            ? rawLinear.absolute_tolerance
            : 1e-14,
        max_iterations:
          typeof rawLinear?.max_iterations === "number" ? rawLinear.max_iterations : 1000,
        relative_tolerance:
          typeof rawLinear?.relative_tolerance === "number"
            ? rawLinear.relative_tolerance
            : 1e-10,
      },
      operator_version:
        typeof rawSolver?.operator_version === "string"
          ? rawSolver.operator_version
          : "fv_spin_accumulation_v1",
      physical_residual_version:
        typeof rawSolver?.physical_residual_version === "string"
          ? rawSolver.physical_residual_version
          : "spin_balance_integrated_l2.v1",
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 1. CurrentTransportInspectorPanel (`physics.current-transport`)
 *    Title in route: "Charge transport"
 *    Zero M10 cloning — closure & cuts live in their dedicated child inspectors!
 * ══════════════════════════════════════════════════════════════════════════════ */

interface CurrentTransportSpecDraft {
  id: string;
  exists: boolean;
  targetScopeKey: string;
  modelKind: "prescribed_current_density" | "ohmic_steady_state" | "anisotropic_amr_ahe";
  // Prescribed J
  currentDensityVec: readonly [number, number, number];
  envelopeKind: "constant" | "pulse" | "sinusoidal" | "expression";
  pulseDurationS: number;
  rfFrequencyHz: number;
  envelopeExpr: string;
  // Ohmic / Anisotropic conductivity
  sigma: number;
  sigmaParallel: number;
  sigmaPerp: number;
  sigmaAhe: number;
  // Electrodes & Structured Closure toggle
  electrodeMode: "voltage_pair" | "current_pair" | "structured_closure";
  anodePotentialV: number;
  cathodePotentialV: number;
  terminalCurrentA: number;
  structuredClosureEnabled: boolean;
  closureId: string;
  sourceCutCount: number;
  // Solver & Lead preparation (explicitly surfaced per Task 17!)
  externalLeadPreparation: "disabled" | "extend_contacts" | "full_lead_padding";
  conservativeCurrentView: boolean;
  solverTolerance: number;
  preservedRaw: Record<string, unknown> | null;
}

export function CurrentTransportInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const transports = useCurrentTransportsResource({ enabled: true });

  const scopeOptions = useMemo(
    () => buildTargetScopeSelectOptions(scene.data),
    [scene.data],
  );

  const selectedId =
    selection.ref?.type === "current-transport"
      ? selection.ref.currentTransportId ?? null
      : selection.nodeId?.includes(":module:")
        ? decodeURIComponent(selection.nodeId.split(":module:").at(-1) ?? "")
        : null;

  const matched = useMemo(() => {
    const items = (transports.data?.items ?? []) as Record<string, unknown>[];
    if (selectedId) {
      return items.find((it) => (it.name ?? it.id) === selectedId) ?? null;
    }
    return items[0] ?? null;
  }, [selectedId, transports.data?.items]);

  const baseline = useMemo<CurrentTransportSpecDraft>(() => {
    const rec = matched ?? {};
    const id = String(rec.name ?? rec.id ?? selectedId ?? "charge-transport-1");
    const rawModel = String(rec.model ?? "prescribed_density");
    const modelKind: CurrentTransportSpecDraft["modelKind"] =
      rawModel === "ohmic_steady_state" || rawModel === "ohmic_poisson"
        ? "ohmic_steady_state"
        : rawModel === "anisotropic_amr_ahe" || rawModel === "magnetoresistive_poisson"
          ? "anisotropic_amr_ahe"
          : "prescribed_current_density";
    const jRaw = Array.isArray(rec.current_density ?? rec.current_density_Apm2)
      ? ((rec.current_density ?? rec.current_density_Apm2) as unknown[])
      : [1e11, 0, 0];
    const closure = (rec.structured_current_closure ?? null) as Record<string, unknown> | null;
    const cuts = Array.isArray(closure?.source_cuts) ? closure.source_cuts : [];
    const defaultScope = selection.objectId
      ? encodeScope(selection.objectId, null)
      : scopeOptions[0]!.value;
    const domScope = extractDomainScope(rec, decodeScope(defaultScope));
    const mats = Array.isArray(rec.materials)
      ? (rec.materials as Record<string, unknown>[])
      : [];
    const firstMat = (mats[0]?.material ?? null) as Record<string, unknown> | null;
    const leadPrepRaw = rec.external_lead_preparation;
    const leadPrepMode =
      leadPrepRaw && typeof leadPrepRaw === "object" && !Array.isArray(leadPrepRaw)
        ? String((leadPrepRaw as Record<string, unknown>).mode ?? "disabled")
        : String(leadPrepRaw ?? "disabled");
    const rawSolver = (rec.solver ?? null) as Record<string, unknown> | null;
    const rawLinear = (rawSolver?.linear ?? null) as Record<string, unknown> | null;

    return {
      id,
      exists: Boolean(matched),
      targetScopeKey: encodeScope(domScope.object_id, domScope.region_id ?? null),
      modelKind,
      currentDensityVec: [
        Number(jRaw[0]) || 0,
        Number(jRaw[1]) || 0,
        Number(jRaw[2]) || 0,
      ],
      envelopeKind: "constant",
      pulseDurationS: 1e-9,
      rfFrequencyHz: 5e9,
      envelopeExpr: "sin(2 * pi * 5e9 * t)",
      sigma:
        typeof rec.conductivity_s_per_m === "number"
          ? rec.conductivity_s_per_m
          : typeof firstMat?.sigma_Spm === "number"
            ? firstMat.sigma_Spm
            : typeof rec.sigma_Spm === "number"
              ? rec.sigma_Spm
              : 6.25e6,
      sigmaParallel:
        typeof firstMat?.sigma_parallel_Spm === "number"
          ? firstMat.sigma_parallel_Spm
          : typeof rec.sigma_parallel_Spm === "number"
            ? rec.sigma_parallel_Spm
            : 6.4e6,
      sigmaPerp:
        typeof firstMat?.sigma_perpendicular_Spm === "number"
          ? firstMat.sigma_perpendicular_Spm
          : typeof rec.sigma_perpendicular_Spm === "number"
            ? rec.sigma_perpendicular_Spm
            : 6.1e6,
      sigmaAhe:
        typeof firstMat?.sigma_AHE_Spm === "number"
          ? firstMat.sigma_AHE_Spm
          : typeof rec.sigma_AHE_Spm === "number"
            ? rec.sigma_AHE_Spm
            : 1.2e4,
      electrodeMode: closure ? "structured_closure" : "voltage_pair",
      anodePotentialV: 0.05,
      cathodePotentialV: 0,
      terminalCurrentA: 1e-3,
      structuredClosureEnabled: Boolean(closure),
      closureId: typeof closure?.closure_id === "string" ? closure.closure_id : `${id}-closure`,
      sourceCutCount: cuts.length,
      externalLeadPreparation:
        leadPrepMode === "extend_contacts" || leadPrepMode === "full_lead_padding"
          ? leadPrepMode
          : "disabled",
      conservativeCurrentView:
        rec.conservative_current_view === undefined
          ? true
          : Boolean(rec.conservative_current_view),
      solverTolerance:
        typeof rawLinear?.relative_tolerance === "number"
          ? rawLinear.relative_tolerance
          : typeof rec.solver_tolerance === "number"
            ? rec.solver_tolerance
            : 1e-9,
      preservedRaw: matched,
    };
  }, [matched, scopeOptions, selectedId, selection.objectId]);

  const spec = useMemo<InspectorSpec<CurrentTransportSpecDraft>>(
    () => ({
      id: "physics.current-transport",
      header: {
        breadcrumbs: selection.objectId
          ? [
              {
                id: "object",
                label: selection.objectId,
                selection: buildObjectSelection(
                  selection.objectId,
                  "object.physics",
                  "Physics",
                ),
              },
              { id: "ct", label: "Charge transport" },
            ]
          : [
              {
                id: "session",
                label: "Session Model",
                selection: buildRootSelection("session.root", "model:session", "Session Model"),
              },
              { id: "ct", label: "Charge transport" },
            ],
        searchable: true,
        extraMenuActions: [
          {
            id: "view-ct-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) =>
              ctx.openCodePreview(
                `${ctx.draft.id} JSON`,
                "json",
                JSON.stringify(ctx.draft.preservedRaw ?? ctx.draft, null, 2),
              ),
          },
        ],
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Charge Transport",
                confirmTitle: (d) => `Delete charge transport "${d.id}"?`,
                confirmDescription:
                  "This removes the charge transport solver definition and any structured closure cuts.",
                onDelete: async (ctx) => {
                  const res = await kernel.api.model.deleteCurrentTransport(baseline.id, {
                    base_revision: scene.data?.revision ?? 0,
                  });
                  publishCommittedSceneResource(
                    kernel.resources,
                    res.committed_scene,
                    res.scene_revision,
                  );
                  invalidateSpinAuthoringResources(
                    kernel.resources,
                    res,
                    transportMutationResourceKeys("current_transport"),
                  );
                  ctx.selectNode(
                    buildRootSelection("session.root", "model:session", "Session Model"),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Zap,
        title: (d) => d.id,
        renameFieldKey: baseline.exists ? undefined : "id",
        kindLabel: "Charge transport",
        entityId: baseline.id,
        statePill: (d) => ({
          tone: "ok",
          label: d.exists ? "Configured" : "New draft",
        }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "model", label: "Model", value: d.modelKind.replace(/_/g, " ") },
        {
          id: "jmag",
          label: "|J|",
          value:
            d.modelKind === "prescribed_current_density"
              ? `${(vectorNorm(d.currentDensityVec) / 1e9).toFixed(2)} GA/m\u00b2`
              : null,
        },
        {
          id: "leads",
          label: "Lead prep",
          value: d.externalLeadPreparation.replace(/_/g, " "),
        },
      ],
      modeTabs: [
        { id: "model", label: "Model & Domain", icon: Zap },
        { id: "electrodes", label: "Electrodes & Closure", icon: GitBranch },
        { id: "solver", label: "Solver & Leads", icon: Sliders },
      ],
      sections: [
        {
          id: "ct-model-domain",
          modeTabId: "model",
          title: "Conduction model & target domain",
          icon: Zap,
          defaultOpen: true,
          rows: [
            {
              key: "id",
              type: "text",
              mono: true,
              label: "Transport identifier",
              disabledReason: (d) =>
                d.exists ? "Identifier is fixed once referenced by spin torques or Oersted fields." : null,
              validate: (v) => (v.trim().length === 0 ? "Identifier is required." : null),
            },
            {
              key: "targetScopeKey",
              type: "select",
              label: "Conducting object / region",
              options: scopeOptions,
            },
            {
              key: "modelKind",
              type: "select",
              label: "Charge conduction formulation",
              structural: true,
              options: [
                {
                  value: "prescribed_current_density",
                  label: "Prescribed uniform current density J(t)",
                },
                {
                  value: "ohmic_steady_state",
                  label: "Ohmic Laplace / Poisson solve (∇ · σ∇V = 0)",
                },
                {
                  value: "anisotropic_amr_ahe",
                  label: "Magnetoresistive AMR + AHE tensor solve",
                },
              ],
            },
            {
              key: "currentDensityVec",
              type: "vector3",
              label: "Prescribed current density",
              symbol: <>J</>,
              units: CURRENT_DENSITY_UNITS,
              defaultDisplayUnit: "GA/m\u00b2",
              axisPresets: true,
              showWhen: (d) => d.modelKind === "prescribed_current_density",
            },
            {
              key: "envelopeKind",
              type: "segmented",
              label: "Time envelope",
              structural: true,
              showWhen: (d) => d.modelKind === "prescribed_current_density",
              options: [
                { value: "constant", label: "DC" },
                { value: "pulse", label: "Pulse" },
                { value: "sinusoidal", label: "RF" },
                { value: "expression", label: "f(t)" },
              ],
            },
            {
              key: "pulseDurationS",
              type: "quantity",
              label: "Pulse width",
              units: TIME_UNITS,
              defaultDisplayUnit: "ns",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.modelKind === "prescribed_current_density" && d.envelopeKind === "pulse",
            },
            {
              key: "rfFrequencyHz",
              type: "quantity",
              label: "Drive frequency",
              units: FREQUENCY_UNITS,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.modelKind === "prescribed_current_density" && d.envelopeKind === "sinusoidal",
            },
            {
              key: "envelopeExpr",
              type: "expression",
              label: "Dimensionless time envelope g(t)",
              allowedVariables: ["t", "pi"],
              showWhen: (d) =>
                d.modelKind === "prescribed_current_density" && d.envelopeKind === "expression",
            },
            {
              key: "sigma",
              type: "quantity",
              label: "Isotropic conductivity",
              symbol: <>&sigma;</>,
              units: CONDUCTIVITY_UNITS,
              defaultDisplayUnit: "MS/m",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.modelKind === "ohmic_steady_state",
            },
            {
              key: "sigmaParallel",
              type: "quantity",
              label: "Longitudinal conductivity (∥ m)",
              symbol: <>&sigma;<sub>&parallel;</sub></>,
              units: CONDUCTIVITY_UNITS,
              defaultDisplayUnit: "MS/m",
              min: 0,
              showWhen: (d) => d.modelKind === "anisotropic_amr_ahe",
            },
            {
              key: "sigmaPerp",
              type: "quantity",
              label: "Transverse conductivity (⊥ m)",
              symbol: <>&sigma;<sub>&perp;</sub></>,
              units: CONDUCTIVITY_UNITS,
              defaultDisplayUnit: "MS/m",
              min: 0,
              showWhen: (d) => d.modelKind === "anisotropic_amr_ahe",
            },
            {
              key: "sigmaAhe",
              type: "quantity",
              label: "Anomalous Hall conductivity",
              symbol: <>&sigma;<sub>AHE</sub></>,
              units: CONDUCTIVITY_UNITS,
              defaultDisplayUnit: "kS/m",
              showWhen: (d) => d.modelKind === "anisotropic_amr_ahe",
            },
          ],
        },
        {
          id: "ct-electrodes-closure",
          modeTabId: "electrodes",
          title: "Boundary electrodes & closed-loop closure",
          icon: GitBranch,
          defaultOpen: true,
          rows: [
            {
              key: "electrodeMode",
              type: "segmented",
              label: "Excitation topology",
              structural: true,
              options: [
                { value: "voltage_pair", label: "Voltage ΔV" },
                { value: "current_pair", label: "Current I" },
                { value: "structured_closure", label: "Loop Closure" },
              ],
            },
            {
              key: "anodePotentialV",
              type: "quantity",
              label: "Source electrode potential",
              symbol: <>V<sub>+</sub></>,
              units: VOLTAGE_UNITS,
              defaultDisplayUnit: "mV",
              showWhen: (d) => d.electrodeMode === "voltage_pair",
            },
            {
              key: "cathodePotentialV",
              type: "quantity",
              label: "Ground / drain potential",
              symbol: <>V<sub>&minus;</sub></>,
              units: VOLTAGE_UNITS,
              defaultDisplayUnit: "mV",
              showWhen: (d) => d.electrodeMode === "voltage_pair",
            },
            {
              key: "terminalCurrentA",
              type: "quantity",
              label: "Injected terminal current",
              symbol: <>I</>,
              units: CURRENT_UNITS,
              defaultDisplayUnit: "mA",
              showWhen: (d) => d.electrodeMode === "current_pair",
            },
            {
              key: "structuredClosureEnabled",
              type: "switch",
              label: "Enable structured closed-loop current closure",
              structural: true,
              showWhen: (d) => d.electrodeMode === "structured_closure",
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) =>
                d.electrodeMode === "structured_closure" || d.structuredClosureEnabled,
              render: (ctx) => {
                const nodeId = `model:physics:current-transport:${encodeURIComponent(
                  ctx.draft.id,
                )}:structured-current-closure:${encodeURIComponent(ctx.draft.closureId)}`;
                return (
                  <InspectorShortcutCards
                    items={[
                      {
                        id: "closure-shortcut",
                        title: `Structured Closure (${ctx.draft.closureId})`,
                        subtitle: `${ctx.draft.sourceCutCount} cut plane(s) · dedicated child inspector`,
                        badge: `${ctx.draft.sourceCutCount} cuts`,
                        selection: {
                          kind: "physics.structured-current-closure",
                          label: ctx.draft.closureId,
                          nodeId,
                          objectId: selection.objectId,
                          ref: {
                            currentTransportId: ctx.draft.id,
                            kind: "physics.structured-current-closure",
                            nodeId,
                            structuredCurrentClosureId: ctx.draft.closureId,
                            type: "structured-current-closure",
                          },
                        },
                      },
                    ]}
                    onSelect={ctx.selectNode}
                  />
                );
              },
            },
          ],
        },
        {
          id: "ct-solver-leads",
          modeTabId: "solver",
          title: "Solver, lead preparation & conservation",
          icon: Sliders,
          defaultOpen: true,
          rows: [
            {
              key: "externalLeadPreparation",
              type: "select",
              label: "External lead preparation",
              options: [
                { value: "disabled", label: "Disabled (solve strictly inside body)" },
                { value: "extend_contacts", label: "Extend equipotential contact pads" },
                { value: "full_lead_padding", label: "Full asymptotic lead padding" },
              ],
            },
            {
              key: "conservativeCurrentView",
              type: "switch",
              label: "Publish divergence-free conservative current view",
            },
            {
              key: "solverTolerance",
              type: "number",
              label: "Linear Krylov / AMG relative tolerance",
              min: 1e-14,
              max: 1e-3,
              scrub: "log",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Charge transport definition matches SceneDocument",
        onApply: async (draft) => {
          const scope = decodeScope(draft.targetScopeKey);
          const hasClosure =
            draft.electrodeMode === "structured_closure" || draft.structuredClosureEnabled;
          const existingClosure = (draft.preservedRaw?.structured_current_closure ??
            null) as Record<string, unknown> | null;
          const rawExistingCuts = Array.isArray(existingClosure?.source_cuts)
            ? (existingClosure.source_cuts as Record<string, unknown>[])
            : [];
          const structured_current_closure: SceneStructuredCurrentClosure | null = hasClosure
            ? {
                closure_id: draft.closureId,
                kind: "closed_geometry",
                schema_version: "structured_current_closure.v1",
                source_cuts: rawExistingCuts.map((c, idx) =>
                  normalizeSourceCutRecord(c, idx, scope),
                ),
              }
            : null;

          const model: KnownSceneCurrentTransport["model"] =
            draft.modelKind === "ohmic_steady_state"
              ? "ohmic_poisson"
              : draft.modelKind === "anisotropic_amr_ahe"
                ? "magnetoresistive_poisson"
                : "prescribed_density";

          const resource: KnownSceneCurrentTransport = {
            kind: "current_transport",
            name: draft.id.trim(),
            model,
            domain: [scope],
            coupling: "one_way",
            gauge: "dirichlet_reference",
            external_lead_preparation:
              draft.externalLeadPreparation === "disabled"
                ? null
                : { mode: draft.externalLeadPreparation },
            conservative_current_view:
              draft.conservativeCurrentView && !hasClosure ? { enabled: true } : null,
            solver: {
              engine: "gmres",
              linear: {
                absolute_tolerance: 1e-14,
                max_iterations: 1000,
                relative_tolerance: draft.solverTolerance,
              },
              operator_version: hasClosure
                ? "fv_charge_harmonic_source_cut_v1"
                : "fv_charge_harmonic_v1",
              physical_residual_version: "charge_balance_integrated_l2.v1",
            },
            ...(draft.modelKind === "prescribed_current_density"
              ? { current_density: [...draft.currentDensityVec] }
              : draft.modelKind === "ohmic_steady_state"
                ? {
                    conductivity_s_per_m: draft.sigma,
                    materials: [{ region: scope, material: { sigma_Spm: draft.sigma } }],
                  }
                : {
                    conductivity_s_per_m: draft.sigmaParallel,
                    materials: [
                      {
                        region: scope,
                        material: {
                          sigma_Spm: draft.sigmaParallel,
                          sigma_parallel_Spm: draft.sigmaParallel,
                          sigma_perpendicular_Spm: draft.sigmaPerp,
                          sigma_AHE_Spm: draft.sigmaAhe,
                        },
                      },
                    ],
                  }),
            structured_current_closure,
          };

          const req: CurrentTransportMutationRequest = {
            base_revision: scene.data?.revision ?? 0,
            resource,
          };
          const res = draft.exists
            ? await kernel.api.model.replaceCurrentTransport(draft.id.trim(), req)
            : await kernel.api.model.createCurrentTransport(req);
          publishCommittedSceneResource(
            kernel.resources,
            res.committed_scene,
            res.scene_revision,
          );
          invalidateSpinAuthoringResources(
            kernel.resources,
            res,
            transportMutationResourceKeys("current_transport"),
          );
          kernel.resources.invalidate(MODEL_SCENE_PATH, res.scene_revision);
          kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, res.scene_revision);
          return true;
        },
      },
    }),
    [
      baseline.exists,
      baseline.id,
      kernel.api.model,
      kernel.resources,
      scene.data?.revision,
      scopeOptions,
      selection.objectId,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 2. StructuredCurrentClosureInspectorPanel (`physics.structured-current-closure`)
 *    Edits ONLY `closure_id` + source cuts list (NO M10 cloning!)
 * ══════════════════════════════════════════════════════════════════════════════ */

interface ClosureSourceCutSummary {
  readonly source_cut_id: string;
  readonly axis: string;
  readonly offset_m: number;
  readonly potential_jump_V: number;
  readonly raw: Record<string, unknown>;
}

interface StructuredClosureSpecDraft {
  ownerTransportId: string;
  closureId: string;
  cuts: readonly ClosureSourceCutSummary[];
  ownerRaw: Record<string, unknown> | null;
}

export function StructuredCurrentClosureInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const transports = useCurrentTransportsResource({ enabled: true });
  const scene = useSceneResource();

  const closureRef =
    selection.ref?.type === "structured-current-closure" ? selection.ref : null;
  const ownerId =
    closureRef?.currentTransportId ??
    ((transports.data?.items?.[0] as Record<string, unknown> | undefined)?.name as string | undefined) ??
    "charge-transport-1";

  const ownerRecord = useMemo(() => {
    const items = (transports.data?.items ?? []) as Record<string, unknown>[];
    return items.find((it) => (it.name ?? it.id) === ownerId) ?? null;
  }, [ownerId, transports.data?.items]);

  const baseline = useMemo<StructuredClosureSpecDraft>(() => {
    const closure = (ownerRecord?.structured_current_closure ?? null) as Record<
      string,
      unknown
    > | null;
    const rawCuts = Array.isArray(closure?.source_cuts)
      ? (closure.source_cuts as Record<string, unknown>[])
      : [];
    const cuts: ClosureSourceCutSummary[] = rawCuts.map((c, idx) => {
      const plane = (c.plane ?? null) as Record<string, unknown> | null;
      const drive = (c.drive ?? null) as Record<string, unknown> | null;
      return {
        source_cut_id: String(c.source_cut_id ?? `cut-${idx + 1}`),
        axis: String(plane?.axis ?? "x").toUpperCase(),
        offset_m: typeof plane?.offset_m === "number" ? plane.offset_m : 0,
        potential_jump_V:
          typeof drive?.potential_jump_V === "number" ? drive.potential_jump_V : 0.01,
        raw: c,
      };
    });
    return {
      ownerTransportId: ownerId,
      closureId:
        typeof closure?.closure_id === "string"
          ? closure.closure_id
          : closureRef?.structuredCurrentClosureId ?? `${ownerId}-closure`,
      cuts,
      ownerRaw: ownerRecord,
    };
  }, [closureRef?.structuredCurrentClosureId, ownerId, ownerRecord]);

  const spec = useMemo<InspectorSpec<StructuredClosureSpecDraft>>(
    () => ({
      id: "physics.structured-current-closure",
      header: {
        breadcrumbs: [
          {
            id: "ct",
            label: ownerId,
            selection: {
              kind: "physics.current-transport",
              label: ownerId,
              nodeId: `model:physics:current-transport:${encodeURIComponent(ownerId)}`,
              objectId: selection.objectId,
              ref: {
                currentTransportId: ownerId,
                kind: "physics.current-transport",
                nodeId: `model:physics:current-transport:${encodeURIComponent(ownerId)}`,
                type: "current-transport",
              },
            },
          },
          { id: "closure", label: baseline.closureId },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: GitBranch,
        title: (d) => d.closureId,
        renameFieldKey: "closureId",
        kindLabel: "Closed-loop structured current closure",
        entityId: baseline.closureId,
        statePill: (d) => ({
          tone: d.cuts.length > 0 ? "ok" : "warn",
          label: `${d.cuts.length} source cut${d.cuts.length === 1 ? "" : "s"}`,
        }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "owner", label: "Transport", value: d.ownerTransportId },
        { id: "cuts", label: "Source cuts", value: String(d.cuts.length) },
      ],
      sections: [
        {
          id: "closure-identity-cuts",
          title: "Closure topology & source-cut planes",
          icon: Scissors,
          defaultOpen: true,
          rows: [
            {
              key: "closureId",
              type: "text",
              mono: true,
              label: "Closure identifier",
              validate: (v) => (v.trim().length === 0 ? "Closure ID is required." : null),
            },
            {
              type: "table",
              label: "Electromotive source-cut planes",
              wide: true,
              showWhen: (d) => d.cuts.length > 0,
              rowKey: (rawRow) => (rawRow as ClosureSourceCutSummary).source_cut_id,
              rows: (d) => d.cuts,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as ClosureSourceCutSummary;
                const nodeId = `${selection.nodeId ?? "closure"}:source-cut:${encodeURIComponent(
                  row.source_cut_id,
                )}`;
                ctx.selectNode({
                  kind: "physics.structured-current-source-cut",
                  label: row.source_cut_id,
                  nodeId,
                  objectId: selection.objectId,
                  ref: {
                    currentTransportId: ctx.draft.ownerTransportId,
                    kind: "physics.structured-current-source-cut",
                    nodeId,
                    structuredCurrentClosureId: ctx.draft.closureId,
                    structuredCurrentSourceCutId: row.source_cut_id,
                    type: "structured-current-source-cut",
                  },
                });
              },
              columns: [
                {
                  id: "id",
                  header: "Cut ID",
                  mono: true,
                  renderCell: (rawRow) => (rawRow as ClosureSourceCutSummary).source_cut_id,
                },
                {
                  id: "axis",
                  header: "Plane",
                  mono: true,
                  renderCell: (rawRow) => {
                    const row = rawRow as ClosureSourceCutSummary;
                    return `${row.axis} @ ${(row.offset_m * 1e9).toFixed(1)} nm`;
                  },
                },
                {
                  id: "dv",
                  header: "ΔV (mV)",
                  mono: true,
                  align: "right",
                  renderCell: (rawRow) =>
                    ((rawRow as ClosureSourceCutSummary).potential_jump_V * 1e3).toFixed(2),
                },
              ],
            },
          ],
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                const nextIdx = ctx.draft.cuts.length + 1;
                const cutId = `cut-${nextIdx}`;
                ctx.setField("cuts", [
                  ...ctx.draft.cuts,
                  {
                    source_cut_id: cutId,
                    axis: "X",
                    offset_m: 0,
                    potential_jump_V: 0.01,
                     raw: {
                       source_cut_id: cutId,
                       circuit_id: "loop-1",
                       plane: { axis: "x", normal: "positive_axis", offset_m: 0 },
                       drive: {
                         kind: "impressed_potential_jump",
                         drive_id: `drive-${nextIdx}`,
                         potential_jump_V: 0.01,
                         schema_version: "impressed_potential_jump.v1",
                       },
                     },
                   },
                 ]);
               }}
             >
               <Plus aria-hidden="true" size={12} />
               <span>Add Source Cut</span>
             </Button>
           ),
         },
       ],
       commitBar: {
         mode: "staged",
         cleanMessage: () => "Closure topology matches parent CurrentTransport",
         lockReason: (d) => (!d.ownerRaw ? "Parent charge transport is not loaded." : null),
         onApply: async (draft) => {
           if (!draft.ownerRaw) return false;
           const fallbackScope: SceneRegionRefItem = {
             object_id: selection.objectId ?? scene.data?.objects?.[0]?.id ?? "layer-1",
           };
           const domScope = extractDomainScope(draft.ownerRaw, fallbackScope);
           const closure: SceneStructuredCurrentClosure = {
             closure_id: draft.closureId.trim(),
             kind: "closed_geometry",
             schema_version: "structured_current_closure.v1",
             source_cuts: draft.cuts.map((c, idx) =>
               normalizeSourceCutRecord(c.raw, idx, domScope),
             ),
           };
           const resource = normalizeCurrentTransportOwner(
             draft.ownerRaw,
             draft.ownerTransportId,
             domScope,
             closure,
           );
           const req: CurrentTransportMutationRequest = {
             base_revision: scene.data?.revision ?? 0,
             resource,
           };
           const res = await kernel.api.model.replaceCurrentTransport(
             draft.ownerTransportId,
             req,
           );
          publishCommittedSceneResource(
            kernel.resources,
            res.committed_scene,
            res.scene_revision,
          );
          invalidateSpinAuthoringResources(
            kernel.resources,
            res,
            transportMutationResourceKeys("current_transport"),
          );
          return true;
        },
      },
    }),
    [
      baseline.closureId,
      kernel.api.model,
      kernel.resources,
      ownerId,
      scene.data?.objects,
      scene.data?.revision,
      selection.nodeId,
      selection.objectId,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 3. StructuredCurrentSourceCutInspectorPanel (`physics.structured-current-source-cut`)
 *    Edits ONLY the single source-cut plane & ΔV jump!
 * ══════════════════════════════════════════════════════════════════════════════ */

interface SourceCutSpecDraft {
  ownerTransportId: string;
  closureId: string;
  sourceCutId: string;
  circuitId: string;
  driveId: string;
  axis: "x" | "y" | "z";
  orientation: "1" | "-1";
  offsetM: number;
  potentialJumpV: number;
  ownerRaw: Record<string, unknown> | null;
}

export function StructuredCurrentSourceCutInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const transports = useCurrentTransportsResource({ enabled: true });
  const scene = useSceneResource();

  const cutRef =
    selection.ref?.type === "structured-current-source-cut" ? selection.ref : null;
  const ownerId = cutRef?.currentTransportId ?? "charge-transport-1";
  const closureId = cutRef?.structuredCurrentClosureId ?? `${ownerId}-closure`;
  const cutId = cutRef?.structuredCurrentSourceCutId ?? "cut-1";

  const ownerRecord = useMemo(() => {
    const items = (transports.data?.items ?? []) as Record<string, unknown>[];
    return items.find((it) => (it.name ?? it.id) === ownerId) ?? null;
  }, [ownerId, transports.data?.items]);

  const baseline = useMemo<SourceCutSpecDraft>(() => {
    const closure = (ownerRecord?.structured_current_closure ?? null) as Record<
      string,
      unknown
    > | null;
    const cuts = Array.isArray(closure?.source_cuts)
      ? (closure.source_cuts as Record<string, unknown>[])
      : [];
    const cut = cuts.find((c) => c.source_cut_id === cutId) ?? cuts[0] ?? null;
    const plane = (cut?.plane ?? null) as Record<string, unknown> | null;
    const drive = (cut?.drive ?? null) as Record<string, unknown> | null;
    const rawAxis = String(plane?.axis ?? "x").toLowerCase();
    return {
      ownerTransportId: ownerId,
      closureId,
      sourceCutId: String(cut?.source_cut_id ?? cutId),
      circuitId: String(cut?.circuit_id ?? "loop-1"),
      driveId: String(drive?.drive_id ?? cut?.drive_id ?? "drive-1"),
      axis: rawAxis === "y" || rawAxis === "z" ? rawAxis : "x",
      orientation:
        plane?.normal === "negative_axis" || plane?.orientation === -1 ? "-1" : "1",
      offsetM: typeof plane?.offset_m === "number" ? plane.offset_m : 0,
      potentialJumpV:
        typeof drive?.potential_jump_V === "number" ? drive.potential_jump_V : 0.01,
      ownerRaw: ownerRecord,
    };
  }, [closureId, cutId, ownerId, ownerRecord]);

  const spec = useMemo<InspectorSpec<SourceCutSpecDraft>>(
    () => ({
      id: "physics.structured-current-source-cut",
      header: {
        breadcrumbs: [
          {
            id: "closure",
            label: closureId,
            selection: {
              kind: "physics.structured-current-closure",
              label: closureId,
              nodeId: `model:physics:current-transport:${encodeURIComponent(
                ownerId,
              )}:structured-current-closure:${encodeURIComponent(closureId)}`,
              objectId: selection.objectId,
              ref: {
                currentTransportId: ownerId,
                kind: "physics.structured-current-closure",
                nodeId: `model:physics:current-transport:${encodeURIComponent(
                  ownerId,
                )}:structured-current-closure:${encodeURIComponent(closureId)}`,
                structuredCurrentClosureId: closureId,
                type: "structured-current-closure",
              },
            },
          },
          { id: "cut", label: baseline.sourceCutId },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Scissors,
        title: (d) => d.sourceCutId,
        renameFieldKey: "sourceCutId",
        kindLabel: "Closed-loop electromotive source cut",
        entityId: baseline.sourceCutId,
        statePill: (d) => ({
          tone: Math.abs(d.potentialJumpV) > 0 ? "ok" : "warn",
          label: `${d.axis.toUpperCase()} cut`,
        }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "axis", label: "Normal", value: `${d.orientation === "-1" ? "-" : "+"}${d.axis.toUpperCase()}` },
        { id: "dv", label: "Jump ΔV", value: `${(d.potentialJumpV * 1e3).toFixed(2)} mV` },
      ],
      sections: [
        {
          id: "source-cut-plane-drive",
          title: "Cut-plane geometry & potential jump",
          icon: Scissors,
          defaultOpen: true,
          rows: [
            {
              key: "sourceCutId",
              type: "text",
              mono: true,
              label: "Source cut ID",
              validate: (v) => (v.trim().length === 0 ? "Source cut ID is required." : null),
            },
            {
              key: "circuitId",
              type: "text",
              mono: true,
              label: "Loop circuit ID",
              validate: (v) => (v.trim().length === 0 ? "Circuit ID is required." : null),
            },
            {
              key: "driveId",
              type: "text",
              mono: true,
              label: "Drive branch ID",
              validate: (v) => (v.trim().length === 0 ? "Drive ID is required." : null),
            },
            {
              key: "axis",
              type: "segmented",
              label: "Cut-plane normal axis",
              options: [
                { value: "x", label: "X" },
                { value: "y", label: "Y" },
                { value: "z", label: "Z" },
              ],
            },
            {
              key: "orientation",
              type: "segmented",
              label: "Circulation orientation",
              options: [
                { value: "1", label: "+1 (Forward)" },
                { value: "-1", label: "-1 (Reverse)" },
              ],
            },
            {
              key: "offsetM",
              type: "quantity",
              label: "Plane coordinate offset",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
            },
            {
              key: "potentialJumpV",
              type: "quantity",
              label: "Electromotive potential jump",
              symbol: <>&Delta;V</>,
              units: VOLTAGE_UNITS,
              defaultDisplayUnit: "mV",
              validate: (v) =>
                Math.abs(v) < 1e-15 ? "Potential jump ΔV must be non-zero." : null,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Source-cut plane matches parent CurrentTransport",
        lockReason: (d) => (!d.ownerRaw ? "Parent charge transport is not loaded." : null),
        onApply: async (draft) => {
          if (!draft.ownerRaw) return false;
          const fallbackScope: SceneRegionRefItem = {
            object_id: selection.objectId ?? scene.data?.objects?.[0]?.id ?? "layer-1",
          };
          const domScope = extractDomainScope(draft.ownerRaw, fallbackScope);
          const closure = (draft.ownerRaw.structured_current_closure ?? {}) as Record<
            string,
            unknown
          >;
          const existingCuts = (Array.isArray(closure.source_cuts)
            ? (closure.source_cuts as Record<string, unknown>[])
            : []
          ).map((c, idx) => normalizeSourceCutRecord(c, idx, domScope));
          const existingCut = existingCuts.find((c) => c.source_cut_id === cutId);
          const nextCut: SceneStructuredCurrentSourceCut = {
            source_cut_id: draft.sourceCutId.trim(),
            circuit_id: draft.circuitId.trim(),
            region: existingCut?.region ?? domScope,
            plane: {
              axis: draft.axis,
              normal: draft.orientation === "-1" ? "negative_axis" : "positive_axis",
              offset_m: draft.offsetM,
            },
            drive: {
              kind: "impressed_potential_jump",
              drive_id: draft.driveId.trim(),
              potential_jump_V: draft.potentialJumpV,
              schema_version: "impressed_potential_jump.v1",
            },
          };
          const replaced = existingCuts.some((c) => c.source_cut_id === cutId)
            ? existingCuts.map((c) => (c.source_cut_id === cutId ? nextCut : c))
            : [...existingCuts, nextCut];
          const updatedClosure: SceneStructuredCurrentClosure = {
            closure_id: draft.closureId,
            kind: "closed_geometry",
            schema_version: "structured_current_closure.v1",
            source_cuts: replaced,
          };
          const resource = normalizeCurrentTransportOwner(
            draft.ownerRaw,
            draft.ownerTransportId,
            domScope,
            updatedClosure,
          );
          const req: CurrentTransportMutationRequest = {
            base_revision: scene.data?.revision ?? 0,
            resource,
          };
          const res = await kernel.api.model.replaceCurrentTransport(
            draft.ownerTransportId,
            req,
          );
          publishCommittedSceneResource(
            kernel.resources,
            res.committed_scene,
            res.scene_revision,
          );
          invalidateSpinAuthoringResources(
            kernel.resources,
            res,
            transportMutationResourceKeys("current_transport"),
          );
          return true;
        },
      },
    }),
    [
      baseline.sourceCutId,
      closureId,
      cutId,
      kernel.api.model,
      kernel.resources,
      ownerId,
      scene.data?.objects,
      scene.data?.revision,
      selection.objectId,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 4. SpinTransportInspectorPanel (`physics.spin-transport`)
 *    Title: "Spin transport" — ZERO <textarea>, ZERO unit="1", ZERO "unknown" interface labels!
 * ══════════════════════════════════════════════════════════════════════════════ */

interface SpinTransportInterfaceLink {
  id: string;
  readableLabel: string;
  selection: Omit<Selection, "moduleSource">;
}

interface SpinTransportSpecDraft {
  id: string;
  exists: boolean;
  targetScopeKey: string;
  sigmaS: number;
  lambdaSf: number;
  lambdaJ: number;
  lambdaPhi: number;
  polarizationP: number;
  spinHallAngle: number;
  boundaryKind:
    | "spin_insulating"
    | "spin_sink"
    | "homogeneous_spin_potential_gradient"
    | "periodic_spin";
  reciprocalPolicy: "disabled" | "linear_feedback" | "full_self_consistent";
  currentSourceId: string;
  interfaces: readonly SpinTransportInterfaceLink[];
  preservedRaw: Record<string, unknown> | null;
}

export function SpinTransportInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const spinTransports = useSpinTransportsResource({ enabled: true });
  const currentTransports = useCurrentTransportsResource({ enabled: true });

  const scopeOptions = useMemo(
    () => buildTargetScopeSelectOptions(scene.data),
    [scene.data],
  );

  const selectedId =
    selection.ref?.type === "spin-transport"
      ? selection.ref.spinTransportId ?? null
      : null;

  const matched = useMemo(() => {
    const items = (spinTransports.data?.items ?? []) as Record<string, unknown>[];
    if (selectedId) {
      return items.find((it) => (it.id ?? it.name) === selectedId) ?? null;
    }
    return items[0] ?? null;
  }, [selectedId, spinTransports.data?.items]);

  const currentOptions = useMemo(() => {
    const base = [{ value: "", label: "None (zero charge drive)" }];
    for (const ct of (currentTransports.data?.items ?? []) as Record<string, unknown>[]) {
      const id = String(ct.name ?? ct.id ?? "");
      if (id) base.push({ value: id, label: id });
    }
    return base;
  }, [currentTransports.data?.items]);

  const baseline = useMemo<SpinTransportSpecDraft>(() => {
    const rec = matched ?? {};
    const id = String(rec.id ?? rec.name ?? selectedId ?? "spin-transport-1");
    const mats = Array.isArray(rec.materials)
      ? (rec.materials as Record<string, unknown>[])
      : [];
    const firstMat = ((mats[0]?.material ?? rec) as Record<string, unknown>);
    const rawIfaces = Array.isArray(rec.interfaces)
      ? (rec.interfaces as Record<string, unknown>[])
      : [];

    const interfaces: SpinTransportInterfaceLink[] = rawIfaces.map((iface, idx) => {
      const ifaceId = String(iface.interface_id ?? iface.id ?? `iface-${idx + 1}`);
      const sideA = (iface.normal_side ?? iface.side_a ?? null) as Record<string, unknown> | null;
      const sideB = (iface.ferromagnet_side ?? iface.side_b ?? null) as Record<string, unknown> | null;
      const labelA = formatReadableScopeLabel(sideA, scene.data, "Layer A");
      const labelB = formatReadableScopeLabel(sideB, scene.data, "Layer B");
      const nodeId = `model:physics:spin-interface:${encodeURIComponent(ifaceId)}`;
      return {
        id: ifaceId,
        readableLabel: `${ifaceId}: ${labelA} \u2194 ${labelB}`,
        selection: {
          kind: "physics.spin-interface",
          label: `${labelA} \u2194 ${labelB}`,
          nodeId,
          objectId: selection.objectId,
          ref: {
            kind: "physics.spin-interface",
            nodeId,
            spinInterfaceId: ifaceId,
            spinInterfaceOwnerId: id,
            type: "spin-interface",
          },
        },
      };
    });

    const defaultScope = selection.objectId
      ? encodeScope(selection.objectId, null)
      : scopeOptions[0]!.value;
    const matReg = ((mats[0]?.region ?? null) as Record<string, unknown> | null);
    const domScope =
      matReg && typeof matReg.object_id === "string" && matReg.object_id
        ? encodeScope(
            matReg.object_id,
            typeof matReg.region_id === "string" ? matReg.region_id : null,
          )
        : (() => {
            const d = extractDomainScope(rec, decodeScope(defaultScope));
            return encodeScope(d.object_id, d.region_id ?? null);
          })();
    const rawSolver = (rec.solver ?? null) as Record<string, unknown> | null;
    const rawBc = String(rawSolver?.default_external_boundary ?? "spin_insulating");
    const boundaryKind: SpinTransportSpecDraft["boundaryKind"] =
      rawBc === "spin_sink" ||
      rawBc === "homogeneous_spin_potential_gradient" ||
      rawBc === "periodic_spin"
        ? rawBc
        : "spin_insulating";
    const hasRecip = Boolean(rawSolver?.reciprocal_nonlinear);

    return {
      id,
      exists: Boolean(matched),
      targetScopeKey: domScope,
      sigmaS: typeof firstMat.sigma_s_Spm === "number" ? firstMat.sigma_s_Spm : 5.0e6,
      lambdaSf: typeof firstMat.lambda_sf_m === "number" ? firstMat.lambda_sf_m : 3.5e-9,
      lambdaJ: typeof firstMat.lambda_j_m === "number" ? firstMat.lambda_j_m : 1.2e-9,
      lambdaPhi: typeof firstMat.lambda_phi_m === "number" ? firstMat.lambda_phi_m : 2.0e-9,
      polarizationP:
        typeof firstMat.polarization_p === "number" ? firstMat.polarization_p : 0.45,
      spinHallAngle: typeof firstMat.theta_sh === "number" ? firstMat.theta_sh : 0.08,
      boundaryKind,
      reciprocalPolicy: hasRecip ? "full_self_consistent" : "disabled",
      currentSourceId:
        typeof rec.current_source_id === "string"
          ? rec.current_source_id
          : typeof rec.current_transport_id === "string"
            ? rec.current_transport_id
            : "",
      interfaces,
      preservedRaw: matched,
    };
  }, [matched, scene.data, scopeOptions, selectedId, selection.objectId]);

  const spec = useMemo<InspectorSpec<SpinTransportSpecDraft>>(
    () => ({
      id: "physics.spin-transport",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "st", label: "Spin transport" },
        ],
        searchable: true,
        extraMenuActions: [
          {
            id: "view-st-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) =>
              ctx.openCodePreview(
                `${ctx.draft.id} JSON`,
                "json",
                JSON.stringify(ctx.draft.preservedRaw ?? ctx.draft, null, 2),
              ),
          },
        ],
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Spin Transport",
                confirmTitle: (d) => `Delete spin transport "${d.id}"?`,
                confirmDescription:
                  "This removes the 3D spin-accumulation solver and its owned HM/FM interfaces.",
                onDelete: async (ctx) => {
                  const res = await kernel.api.model.deleteSpinTransport(baseline.id, {
                    base_revision: scene.data?.revision ?? 0,
                  });
                  publishCommittedSceneResource(
                    kernel.resources,
                    res.committed_scene,
                    res.scene_revision,
                  );
                  invalidateSpinAuthoringResources(
                    kernel.resources,
                    res,
                    transportMutationResourceKeys("spin_transport"),
                  );
                  ctx.selectNode(
                    buildRootSelection("session.root", "model:session", "Session Model"),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: (d) => d.id,
        renameFieldKey: baseline.exists ? undefined : "id",
        kindLabel: "Spin transport",
        entityId: baseline.id,
        statePill: (d) => ({
          tone: "ok",
          label: `${d.interfaces.length} interface${d.interfaces.length === 1 ? "" : "s"}`,
        }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "lsf", label: "λ_sf", value: `${(d.lambdaSf * 1e9).toFixed(2)} nm` },
        { id: "p", label: "Polarization P", value: d.polarizationP.toFixed(2) },
        { id: "sh", label: "θ_SH", value: d.spinHallAngle.toFixed(3) },
      ],
      modeTabs: [
        { id: "layers", label: "Diffusion & Layers", icon: Layers },
        { id: "interfaces", label: "Interfaces & BC", icon: GitBranch },
        { id: "coupling", label: "Coupling & Solver", icon: Cpu },
      ],
      sections: [
        {
          id: "st-diffusion-layers",
          modeTabId: "layers",
          title: "Drift-diffusion & Spin-Hall layer parameters",
          icon: Layers,
          defaultOpen: true,
          rows: [
            {
              key: "id",
              type: "text",
              mono: true,
              label: "Spin transport ID",
              disabledReason: (d) => (d.exists ? "Identifier is fixed once created." : null),
              validate: (v) => (v.trim().length === 0 ? "Identifier is required." : null),
            },
            {
              key: "targetScopeKey",
              type: "select",
              label: "Primary conducting / magnetic layer",
              options: scopeOptions,
            },
            {
              key: "sigmaS",
              type: "quantity",
              label: "Spin conductivity",
              symbol: <>&sigma;<sub>s</sub></>,
              units: CONDUCTIVITY_UNITS,
              defaultDisplayUnit: "MS/m",
              min: 0,
              minExclusive: true,
            },
            {
              key: "lambdaSf",
              type: "quantity",
              label: "Spin-flip diffusion length",
              symbol: <>&lambda;<sub>sf</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
            },
            {
              key: "lambdaJ",
              type: "quantity",
              label: "Transverse exchange length",
              symbol: <>&lambda;<sub>J</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
            },
            {
              key: "lambdaPhi",
              type: "quantity",
              label: "Spin dephasing length",
              symbol: <>&lambda;<sub>&phi;</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
            },
            {
              key: "polarizationP",
              type: "number",
              label: "Conductivity spin polarization",
              symbol: <>P</>,
              min: -1,
              max: 1,
              step: 0.02,
            },
            {
              key: "spinHallAngle",
              type: "number",
              label: "Spin Hall angle",
              symbol: <>&theta;<sub>SH</sub></>,
              min: -2,
              max: 2,
              step: 0.01,
            },
          ],
        },
        {
          id: "st-interfaces-bc",
          modeTabId: "interfaces",
          title: "HM/FM interfaces & outer boundary conditions",
          icon: GitBranch,
          defaultOpen: true,
          rows: [
            {
              key: "boundaryKind",
              type: "select",
              label: "Exterior boundary condition",
              options: [
                { value: "spin_insulating", label: "Spin-insulating (j_s · n̂ = 0)" },
                { value: "spin_sink", label: "Ideal spin sink (μ_s = 0)" },
                {
                  value: "homogeneous_spin_potential_gradient",
                  label: "Homogeneous gradient",
                },
                { value: "periodic_spin", label: "Periodic spin accumulation" },
              ],
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-2">
                  {ctx.draft.interfaces.length > 0 ? (
                    <InspectorShortcutCards
                      items={ctx.draft.interfaces.map((iface) => ({
                        id: iface.id,
                        title: iface.readableLabel,
                        subtitle: "Mixing conductance G↑↓ & spin-memory loss",
                        selection: iface.selection,
                      }))}
                      onSelect={ctx.selectNode}
                    />
                  ) : null}
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode({
                        kind: "physics.spin-interface",
                        label: "New HM/FM interface",
                        nodeId: "model:physics:spin-interface:draft",
                        objectId: selection.objectId,
                        ref: {
                          draft: true,
                          kind: "physics.spin-interface",
                          nodeId: "model:physics:spin-interface:draft",
                          spinInterfaceOwnerId: ctx.draft.id,
                          type: "spin-interface",
                        },
                      })
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add HM/FM Spin Interface</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "st-coupling-solver",
          modeTabId: "coupling",
          title: "Charge source & reciprocal feedback policy",
          icon: Cpu,
          defaultOpen: true,
          rows: [
            {
              key: "currentSourceId",
              type: "select",
              label: "Driving ChargeTransport solution",
              options: currentOptions,
            },
            {
              key: "reciprocalPolicy",
              type: "select",
              label: "Reciprocal nonlinear spin-pumping / ISHE policy",
              options: [
                { value: "disabled", label: "Disabled (one-way J_c -> μ_s)" },
                { value: "linear_feedback", label: "Linearized ISHE back-action" },
                { value: "full_self_consistent", label: "Full self-consistent coupled solve" },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Spin transport definition matches SceneDocument",
        onApply: async (draft) => {
          const scope = decodeScope(draft.targetScopeKey);
          const rawIfaces = Array.isArray(draft.preservedRaw?.interfaces)
            ? (draft.preservedRaw.interfaces as Record<string, unknown>[])
            : [];
          const interfaces = rawIfaces.map((iface, idx) =>
            normalizeSpinInterfaceRecord(iface, idx, scope, scope),
          );
          const resource: KnownSceneSpinTransport = {
            id: draft.id.trim(),
            schema_version: "spin_transport.v1",
            constitutive_version: "drift_diffusion_spin_hall.v1",
            current_source_id: draft.currentSourceId,
            domain: [scope],
            materials: [
              {
                region: scope,
                material: {
                  sigma_s_Spm: draft.sigmaS,
                  lambda_sf_m: draft.lambdaSf,
                  lambda_j_m: draft.lambdaJ,
                  lambda_phi_m: draft.lambdaPhi,
                  polarization_p: draft.polarizationP,
                  theta_sh: draft.spinHallAngle,
                },
              },
            ],
            boundaries: [],
            interfaces,
            mode: "steady",
            requested_execution: {
              device: "auto",
              discretization: "auto",
              execution_mode: "strict",
              precision: "double",
            },
            solver: {
              default_external_boundary: draft.boundaryKind,
              engine: "gmres",
              linear: {
                absolute_tolerance: 1e-14,
                max_iterations: 1000,
                relative_tolerance: 1e-10,
              },
              operator_version: "fv_spin_accumulation_v1",
              physical_residual_version: "spin_balance_integrated_l2.v1",
              ...(draft.reciprocalPolicy !== "disabled"
                ? {
                    reciprocal_nonlinear: {
                      eta_transport:
                        draft.reciprocalPolicy === "full_self_consistent" ? 1.0 : 0.5,
                      gmres_restart: 30,
                      max_picard_iterations:
                        draft.reciprocalPolicy === "full_self_consistent" ? 25 : 5,
                      relative_update_tolerance: 1e-8,
                    },
                  }
                : {}),
            },
          };
          const req: SpinTransportMutationRequest = {
            base_revision: scene.data?.revision ?? 0,
            resource,
          };
          const res = draft.exists
            ? await kernel.api.model.replaceSpinTransport(draft.id.trim(), req)
            : await kernel.api.model.createSpinTransport(req);
          publishCommittedSceneResource(
            kernel.resources,
            res.committed_scene,
            res.scene_revision,
          );
          invalidateSpinAuthoringResources(
            kernel.resources,
            res,
            transportMutationResourceKeys("spin_transport"),
          );
          return true;
        },
      },
    }),
    [
      baseline.exists,
      baseline.id,
      currentOptions,
      kernel.api.model,
      kernel.resources,
      scene.data?.revision,
      scopeOptions,
      selection.objectId,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 5. SpinInterfaceInspectorPanel (`physics.spin-interface`)
 *    Title: "HM/FM interface" — Commits & deletes via PATCH .../spin-transports/{owner_id}!
 * ══════════════════════════════════════════════════════════════════════════════ */

interface SpinInterfaceSpecDraft {
  ownerTransportId: string;
  interfaceId: string;
  exists: boolean;
  kind: "mixing_conductance" | "transparent";
  sideAScopeKey: string;
  sideBScopeKey: string;
  traceDirection: string;
  normalAToB: readonly [number, number, number];
  gUp: number;
  gDown: number;
  reGmix: number;
  imGmix: number;
  smlMode: "off" | "scalar" | "reservoir";
  smlDelta: number;
}

export function SpinInterfaceInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const projected = useSpinInterfacesResource();
  const spinTransports = useSpinTransportsResource({ enabled: true });

  const scopeOptions = useMemo(
    () => buildTargetScopeSelectOptions(scene.data),
    [scene.data],
  );

  const ifaceRef = selection.ref?.type === "spin-interface" ? selection.ref : null;
  const reqSpinIfaceId = ifaceRef?.spinInterfaceId;
  const reqSpinOwnerId = ifaceRef?.spinInterfaceOwnerId;
  const matched = useMemo(() => {
    const items = projected.data?.items ?? [];
    if (reqSpinIfaceId) {
      return (
        items.find(
          (it) =>
            it.interface_id === reqSpinIfaceId &&
            (!reqSpinOwnerId || it.owner_spin_transport_id === reqSpinOwnerId),
        ) ?? null
      );
    }
    return items[0] ?? null;
  }, [projected.data?.items, reqSpinIfaceId, reqSpinOwnerId]);

  const ownerOptions = useMemo(() => {
    const list = ((spinTransports.data?.items ?? []) as Record<string, unknown>[]).map((st) => {
      const id = String(st.id ?? st.name ?? "spin-transport-1");
      return { value: id, label: id };
    });
    return list.length > 0 ? list : [{ value: "spin-transport-1", label: "spin-transport-1" }];
  }, [spinTransports.data?.items]);

  const baseline = useMemo<SpinInterfaceSpecDraft>(() => {
    const ownerId =
      matched?.owner_spin_transport_id ?? reqSpinOwnerId ?? ownerOptions[0]!.value;
    const rec = ((matched?.interface ?? {}) as Record<string, unknown>);
    const ifaceId = String(
      matched?.interface_id ?? reqSpinIfaceId ?? "hm-fm-interface-1",
    );
    const kind = rec.kind === "transparent" ? "transparent" : "mixing_conductance";
    const sideA = (rec.normal_side ?? rec.side_a ?? null) as Record<string, unknown> | null;
    const sideB = (rec.ferromagnet_side ?? rec.side_b ?? null) as Record<string, unknown> | null;
    const fallbackA = scopeOptions[0]!.value;
    const fallbackB = scopeOptions[1]?.value ?? fallbackA;
    const rawNorm = Array.isArray(rec.normal_to_ferromagnet ?? rec.normal_a_to_b)
      ? ((rec.normal_to_ferromagnet ?? rec.normal_a_to_b) as unknown[])
      : [0, 0, 1];

    return {
      ownerTransportId: ownerId,
      interfaceId: ifaceId,
      exists: Boolean(matched),
      kind,
      sideAScopeKey: sideA?.object_id
        ? encodeScope(String(sideA.object_id), typeof sideA.region_id === "string" ? sideA.region_id : null)
        : fallbackA,
      sideBScopeKey: sideB?.object_id
        ? encodeScope(String(sideB.object_id), typeof sideB.region_id === "string" ? sideB.region_id : null)
        : fallbackB,
      traceDirection: INTERFACE_TRACE_DIRECTIONS[0]?.surfaceId ?? "x+",
      normalAToB: [
        Number(rawNorm[0]) || 0,
        Number(rawNorm[1]) || 0,
        Number(rawNorm[2]) || 1,
      ],
      gUp: typeof rec.g_up_Spm2 === "number" ? rec.g_up_Spm2 : 1.0e15,
      gDown: typeof rec.g_down_Spm2 === "number" ? rec.g_down_Spm2 : 0.2e15,
      reGmix:
        typeof rec.g_r_Spm2 === "number"
          ? rec.g_r_Spm2
          : typeof rec.re_g_mix_Spm2 === "number"
            ? rec.re_g_mix_Spm2
            : 0.5e15,
      imGmix:
        typeof rec.g_i_Spm2 === "number"
          ? rec.g_i_Spm2
          : typeof rec.im_g_mix_Spm2 === "number"
            ? rec.im_g_mix_Spm2
            : 0.05e15,
      smlMode: rec.spin_memory_loss
        ? "reservoir"
        : typeof rec.g_sml_Spm2 === "number"
          ? "scalar"
          : "off",
      smlDelta: 0.2,
    };
  }, [matched, ownerOptions, reqSpinIfaceId, reqSpinOwnerId, scopeOptions]);

  const sideADecoded = decodeScope(baseline.sideAScopeKey);
  const sideBDecoded = decodeScope(baseline.sideBScopeKey);
  const meshEvidence = useSpinInterfaceMeshEvidenceResource(
    { objectId: sideADecoded.object_id, regionId: sideADecoded.region_id ?? "" },
    { objectId: sideBDecoded.object_id, regionId: sideBDecoded.region_id ?? "" },
  );

  const meshStatusText = useMemo(() => {
    try {
      if (meshEvidence.data && meshEvidence.status === "ready") {
        const proof = verifySpinInterfaceMeshOrientation(meshEvidence.data, [
          ...baseline.normalAToB,
        ]);
        return `Verified (${proof.sharedFacetCount} shared facets, ${proof.interfaceAreaM2.toExponential(2)} m\u00b2)`;
      }
    } catch {
      // Fall through to concise guidance
    }
    return "Select two adjacent regions and build shared mesh to certify facet orientation";
  }, [baseline.normalAToB, meshEvidence.data, meshEvidence.status]);

  const spec = useMemo<InspectorSpec<SpinInterfaceSpecDraft>>(
    () => ({
      id: "physics.spin-interface",
      header: {
        breadcrumbs: [
          {
            id: "owner",
            label: baseline.ownerTransportId,
            selection: {
              kind: "physics.spin-transport",
              label: baseline.ownerTransportId,
              nodeId: `model:physics:spin-transport:${encodeURIComponent(
                baseline.ownerTransportId,
              )}`,
              objectId: selection.objectId,
              ref: null,
            },
          },
          { id: "iface", label: "HM/FM interface" },
        ],
        searchable: true,
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete HM/FM Interface",
                confirmTitle: (d) => `Delete interface "${d.interfaceId}"?`,
                confirmDescription:
                  "This removes the interface from its owning SpinTransport resource.",
                onDelete: async (ctx) => {
                  const owner = ((spinTransports.data?.items ?? []) as Record<string, unknown>[]).find(
                    (it) => (it.id ?? it.name) === ctx.draft.ownerTransportId,
                  );
                  if (owner) {
                    const fallbackScope = decodeScope(ctx.draft.sideAScopeKey);
                    const prevIfaces = (Array.isArray(owner.interfaces)
                      ? (owner.interfaces as Record<string, unknown>[])
                      : []
                    )
                      .filter((i) => (i.id ?? i.interface_id) !== ctx.draft.interfaceId)
                      .map((iface, idx) =>
                        normalizeSpinInterfaceRecord(iface, idx, fallbackScope, fallbackScope),
                      );
                    const resource = normalizeSpinTransportOwner(
                      owner,
                      ctx.draft.ownerTransportId,
                      fallbackScope,
                      prevIfaces,
                    );
                    const req: SpinTransportMutationRequest = {
                      base_revision: scene.data?.revision ?? 0,
                      resource,
                    };
                    const res = await kernel.api.model.replaceSpinTransport(
                      ctx.draft.ownerTransportId,
                      req,
                    );
                    publishCommittedSceneResource(
                      kernel.resources,
                      res.committed_scene,
                      res.scene_revision,
                    );
                    invalidateSpinAuthoringResources(
                      kernel.resources,
                      res,
                      transportMutationResourceKeys("spin_transport"),
                    );
                  }
                  ctx.selectNode(
                    buildRootSelection(
                      "physics.scope.cross-object",
                      "model:physics:cross-object",
                      "Cross-object Interfaces",
                    ),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: GitBranch,
        title: (d) => d.interfaceId,
        renameFieldKey: baseline.exists ? undefined : "interfaceId",
        kindLabel: "HM/FM interface",
        entityId: baseline.interfaceId,
        statePill: (d) => ({
          tone: "ok",
          label: d.kind === "mixing_conductance" ? "G↑↓ Mixing" : "Transparent",
        }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "owner", label: "Owner", value: d.ownerTransportId },
        {
          id: "gmix",
          label: "Re G↑↓",
          value:
            d.kind === "mixing_conductance"
              ? `${(d.reGmix / 1e12).toFixed(0)} TS/m\u00b2`
              : "Continuous",
        },
      ],
      sections: [
        {
          id: "si-sides-orientation",
          title: "Adjacent layers & interface normal",
          icon: GitBranch,
          defaultOpen: true,
          rows: [
            {
              key: "ownerTransportId",
              type: "select",
              label: "Owning SpinTransport",
              options: ownerOptions,
            },
            {
              key: "interfaceId",
              type: "text",
              mono: true,
              label: "Interface identifier",
              validate: (v) => (v.trim().length === 0 ? "Interface ID is required." : null),
            },
            {
              key: "kind",
              type: "segmented",
              label: "Boundary transmission model",
              structural: true,
              options: [
                { value: "mixing_conductance", label: "Magnetoelectronic G↑↓" },
                { value: "transparent", label: "Transparent continuity" },
              ],
            },
            {
              key: "sideAScopeKey",
              type: "select",
              label: "Side A (Normal / Heavy Metal)",
              options: scopeOptions,
              validate: (v, d) =>
                v === d.sideBScopeKey ? "Side A and Side B must be distinct." : null,
            },
            {
              key: "sideBScopeKey",
              type: "select",
              label: "Side B (Ferromagnet)",
              options: scopeOptions,
              validate: (v, d) =>
                v === d.sideAScopeKey ? "Side B must differ from Side A." : null,
            },
            {
              key: "normalAToB",
              type: "vector3",
              label: "Unit normal (Side A → Side B)",
              symbol: <>n&#770;<sub>AB</sub></>,
              axisPresets: true,
              normalizeAction: true,
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Interface normal must be non-zero." : null,
            },
            {
              type: "readonly",
              label: "Shared mesh facet verification",
              format: () => meshStatusText,
            },
          ],
        },
        {
          id: "si-conductances",
          title: "Spin-mixing conductances & memory loss",
          icon: Magnet,
          defaultOpen: true,
          showWhen: (d) => d.kind === "mixing_conductance",
          rows: [
            {
              key: "gUp",
              type: "quantity",
              label: "Majority-spin conductance",
              symbol: <>G<sub>&uarr;</sub></>,
              units: MIXING_CONDUCTANCE_UNITS,
              defaultDisplayUnit: "TS/m\u00b2",
              min: 0,
            },
            {
              key: "gDown",
              type: "quantity",
              label: "Minority-spin conductance",
              symbol: <>G<sub>&darr;</sub></>,
              units: MIXING_CONDUCTANCE_UNITS,
              defaultDisplayUnit: "TS/m\u00b2",
              min: 0,
            },
            {
              key: "reGmix",
              type: "quantity",
              label: "Real mixing conductance",
              symbol: <>Re G<sub>&uarr;&darr;</sub></>,
              units: MIXING_CONDUCTANCE_UNITS,
              defaultDisplayUnit: "TS/m\u00b2",
              min: 0,
            },
            {
              key: "imGmix",
              type: "quantity",
              label: "Imaginary mixing conductance",
              symbol: <>Im G<sub>&uarr;&darr;</sub></>,
              units: MIXING_CONDUCTANCE_UNITS,
              defaultDisplayUnit: "TS/m\u00b2",
            },
            {
              key: "smlMode",
              type: "segmented",
              label: "Spin-memory loss (SML)",
              structural: true,
              options: [
                { value: "off", label: "Off" },
                { value: "scalar", label: "Scalar δ" },
                { value: "reservoir", label: "Interfacial reservoir" },
              ],
            },
            {
              key: "smlDelta",
              type: "number",
              label: "Depolarization parameter",
              symbol: <>&delta;</>,
              min: 0,
              max: 10,
              step: 0.05,
              showWhen: (d) => d.smlMode !== "off",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "HM/FM interface matches owning SpinTransport",
        onApply: async (draft) => {
          const sideA = decodeScope(draft.sideAScopeKey);
          const sideB = decodeScope(draft.sideBScopeKey);
          const norm = normalizeVector3(draft.normalAToB, [0, 0, 1]);
          const ifaceId = draft.interfaceId.trim();
          const nextIface: SceneSpinInterfaceItem =
            draft.kind === "transparent"
              ? {
                  id: ifaceId,
                  kind: "transparent",
                  side_a: sideA,
                  side_b: sideB,
                  normal_a_to_b: norm,
                }
              : {
                  id: ifaceId,
                  kind: "mixing_conductance",
                  absorption: "ideal_transverse",
                  formula_version: "magnetoelectronic_circuit.v1",
                  normal_side: sideA,
                  ferromagnet_side: sideB,
                  normal_to_ferromagnet: norm,
                  g_up_Spm2: draft.gUp,
                  g_down_Spm2: draft.gDown,
                  g_r_Spm2: draft.reGmix,
                  g_i_Spm2: draft.imGmix,
                  ...(draft.smlMode === "scalar"
                    ? { g_sml_Spm2: draft.smlDelta * 1e15 }
                    : draft.smlMode === "reservoir"
                      ? {
                          spin_memory_loss: {
                            formula_version: "spin_memory_loss_reservoir.v1",
                            g_f_Spm2: draft.gUp,
                            g_n_Spm2: draft.gDown,
                            g_lattice_Spm2: Math.max(draft.smlDelta, 1e-6) * 1e15,
                          },
                        }
                      : {}),
                };

          const existingOwner = ((spinTransports.data?.items ?? []) as Record<
            string,
            unknown
          >[]).find((it) => (it.id ?? it.name) === draft.ownerTransportId);

          const prevIfaces = (Array.isArray(existingOwner?.interfaces)
            ? (existingOwner.interfaces as Record<string, unknown>[])
            : []
          ).map((iface, idx) => normalizeSpinInterfaceRecord(iface, idx, sideA, sideB));
          const hasExisting = prevIfaces.some((i) => i.id === ifaceId);
          const mergedIfaces: SceneSpinInterfaceItem[] = hasExisting
            ? prevIfaces.map((i) => (i.id === ifaceId ? nextIface : i))
            : [...prevIfaces, nextIface];

          const resource = normalizeSpinTransportOwner(
            existingOwner ?? { id: draft.ownerTransportId },
            draft.ownerTransportId,
            sideA,
            mergedIfaces,
          );
          const req: SpinTransportMutationRequest = {
            base_revision: scene.data?.revision ?? 0,
            resource,
          };
          const res = existingOwner
            ? await kernel.api.model.replaceSpinTransport(draft.ownerTransportId, req)
            : await kernel.api.model.createSpinTransport(req);
          publishCommittedSceneResource(
            kernel.resources,
            res.committed_scene,
            res.scene_revision,
          );
          invalidateSpinAuthoringResources(
            kernel.resources,
            res,
            transportMutationResourceKeys("spin_transport"),
          );
          return true;
        },
      },
    }),
    [
      baseline.exists,
      baseline.interfaceId,
      baseline.ownerTransportId,
      kernel.api.model,
      kernel.resources,
      meshStatusText,
      ownerOptions,
      scene.data?.revision,
      scopeOptions,
      selection.objectId,
      spinTransports.data?.items,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 6. SpinTorqueInspectorPanel (`physics.spin-torque`)
 *    Title: "Transport torque" — 5 models, Auto Hall (n̂ × Ĵ), ZERO <textarea>, ZERO unit="1"!
 * ══════════════════════════════════════════════════════════════════════════════ */

interface SpinTorqueSpecDraft {
  id: string;
  exists: boolean;
  targetScopeKey: string;
  torqueKind:
    | "spin_orbit_torque"
    | "slonczewski"
    | "zhang_li"
    | "drift_diffusion"
    | "interface_cpp";
  currentBindingMode: "inline_density" | "named_transport";
  inlineCurrentDensity: readonly [number, number, number];
  namedCurrentTransportId: string;
  spinPolarizationVec: readonly [number, number, number];
  stackNormalVec: readonly [number, number, number];
  xiDl: number;
  xiFl: number;
  polarizationDegree: number;
  betaNonAdiabatic: number;
  lambdaAsymmetry: number;
  freeLayerThickness: number;
  timeProfileKind: "constant" | "pulse" | "expression";
  timeExpression: string;
  preservedRaw: Record<string, unknown> | null;
}

export function computeAutoHallPolarization(
  stackNormal: readonly [number, number, number],
  currentVec: readonly [number, number, number],
): [number, number, number] {
  const n = normalizeVector3(stackNormal, [0, 0, 1]);
  const j = normalizeVector3(currentVec, [1, 0, 0]);
  const cross: [number, number, number] = [
    n[1] * j[2] - n[2] * j[1],
    n[2] * j[0] - n[0] * j[2],
    n[0] * j[1] - n[1] * j[0],
  ];
  return normalizeVector3(cross, [0, 1, 0]);
}

export function SpinTorqueInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const torques = useSpinTorquesResource({ enabled: true });
  const currentTransports = useCurrentTransportsResource({ enabled: true });

  const scopeOptions = useMemo(
    () => buildTargetScopeSelectOptions(scene.data),
    [scene.data],
  );
  const currentOptions = useMemo(() => {
    const opts = ((currentTransports.data?.items ?? []) as Record<string, unknown>[]).map((ct) => {
      const id = String(ct.name ?? ct.id ?? "");
      return { value: id, label: id };
    });
    return opts.length > 0 ? opts : [{ value: "charge-transport-1", label: "charge-transport-1" }];
  }, [currentTransports.data?.items]);

  const selectedId =
    selection.ref?.type === "spin-torque" ? selection.ref.spinTorqueId ?? null : null;

  const matched = useMemo(() => {
    const items = (torques.data?.items ?? []) as Record<string, unknown>[];
    if (selectedId) {
      return items.find((it) => (it.id ?? it.name) === selectedId) ?? null;
    }
    return items[0] ?? null;
  }, [selectedId, torques.data?.items]);

  const baseline = useMemo<SpinTorqueSpecDraft>(() => {
    const rec = matched ?? {};
    const id = String(rec.id ?? rec.name ?? selectedId ?? "spin-torque-1");
    const rawKind = String(rec.kind ?? "prescribed_sot");
    const torqueKind: SpinTorqueSpecDraft["torqueKind"] =
      rawKind === "slonczewski" ||
      rawKind === "zhang_li" ||
      rawKind === "drift_diffusion" ||
      rawKind === "interface_cpp"
        ? rawKind
        : rawKind === "drift_diffusion_spin_torque"
          ? "drift_diffusion"
          : "spin_orbit_torque";
    const drive = (rec.drive ?? null) as Record<string, unknown> | null;
    const spArr = Array.isArray(drive?.sigma_hat)
      ? (drive.sigma_hat as unknown[])
      : Array.isArray(rec.spin_polarization ?? rec.raw_spin_polarization)
        ? ((rec.spin_polarization ?? rec.raw_spin_polarization) as unknown[])
        : [0, 1, 0];
    const jArr = Array.isArray(rec.current_density ?? rec.current_density_Apm2)
      ? ((rec.current_density ?? rec.current_density_Apm2) as unknown[])
      : typeof drive?.current_density_Apm2 === "number"
        ? [drive.current_density_Apm2, 0, 0]
        : [1e11, 0, 0];
    const namedSource =
      typeof drive?.current_source_id === "string"
        ? drive.current_source_id
        : typeof rec.current_source === "string"
          ? rec.current_source
          : typeof rec.solve_id === "string"
            ? rec.solve_id
            : "";
    const targetRec = (rec.target ?? null) as Record<string, unknown> | null;
    const defaultScope = selection.objectId
      ? encodeScope(selection.objectId, null)
      : scopeOptions[0]!.value;
    const targetScopeKey =
      targetRec && typeof targetRec.object_id === "string" && targetRec.object_id
        ? encodeScope(
            targetRec.object_id,
            typeof targetRec.region_id === "string" ? targetRec.region_id : null,
          )
        : defaultScope;
    const rawTimeExpr =
      typeof rec.time_expression === "string"
        ? rec.time_expression
        : rec.time_expression && typeof rec.time_expression === "object"
          ? String((rec.time_expression as Record<string, unknown>).expression ?? "")
          : "";

    return {
      id,
      exists: Boolean(matched),
      targetScopeKey,
      torqueKind,
      currentBindingMode: namedSource ? "named_transport" : "inline_density",
      inlineCurrentDensity: [
        Number(jArr[0]) || 1e11,
        Number(jArr[1]) || 0,
        Number(jArr[2]) || 0,
      ],
      namedCurrentTransportId: namedSource || currentOptions[0]!.value,
      spinPolarizationVec: [
        Number(spArr[0]) || 0,
        Number(spArr[1]) || 1,
        Number(spArr[2]) || 0,
      ],
      stackNormalVec: Array.isArray(drive?.interface_normal ?? rec.stack_normal)
        ? ([
            Number(((drive?.interface_normal ?? rec.stack_normal) as unknown[])[0]) || 0,
            Number(((drive?.interface_normal ?? rec.stack_normal) as unknown[])[1]) || 0,
            Number(((drive?.interface_normal ?? rec.stack_normal) as unknown[])[2]) || 1,
          ] as const)
        : [0, 0, 1],
      xiDl: typeof rec.xi_dl === "number" ? rec.xi_dl : 0.08,
      xiFl:
        typeof rec.xi_fl === "number"
          ? rec.xi_fl
          : typeof rec.epsilon_prime === "number"
            ? rec.epsilon_prime
            : 0.02,
      polarizationDegree: typeof rec.degree === "number" ? rec.degree : 0.45,
      betaNonAdiabatic: typeof rec.beta === "number" ? rec.beta : 0.04,
      lambdaAsymmetry:
        typeof rec.lambda_asymmetry === "number"
          ? rec.lambda_asymmetry
          : typeof rec.lambda === "number"
            ? rec.lambda
            : 1.0,
      freeLayerThickness:
        typeof rec.free_layer_thickness_m === "number" ? rec.free_layer_thickness_m : 2.0e-9,
      timeProfileKind: rawTimeExpr.trim() ? "expression" : "constant",
      timeExpression: rawTimeExpr.trim() || "1.0",
      preservedRaw: matched,
    };
  }, [currentOptions, matched, scopeOptions, selectedId, selection.objectId]);

  const spec = useMemo<InspectorSpec<SpinTorqueSpecDraft>>(
    () => ({
      id: "physics.spin-torque",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "torque", label: "Transport torque" },
        ],
        searchable: true,
        extraMenuActions: [
          {
            id: "view-torque-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) =>
              ctx.openCodePreview(
                `${ctx.draft.id} JSON`,
                "json",
                JSON.stringify(ctx.draft.preservedRaw ?? ctx.draft, null, 2),
              ),
          },
        ],
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Spin Torque",
                confirmTitle: (d) => `Delete spin torque "${d.id}"?`,
                confirmDescription: "This removes the current-induced torque term from the model.",
                onDelete: async (ctx) => {
                  const res = await kernel.api.model.deleteSpinTorque(baseline.id, {
                    base_revision: scene.data?.revision ?? 0,
                  });
                  publishCommittedSceneResource(
                    kernel.resources,
                    res.committed_scene,
                    res.scene_revision,
                  );
                  invalidateSpinAuthoringResources(kernel.resources, res, [
                    SPIN_TORQUES_RESOURCE_KEY,
                  ]);
                  ctx.selectNode(
                    buildRootSelection("session.root", "model:session", "Session Model"),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Magnet,
        title: (d) => d.id,
        renameFieldKey: baseline.exists ? undefined : "id",
        kindLabel: "Transport torque",
        entityId: baseline.id,
        statePill: (d) => ({
          tone: "ok",
          label: d.torqueKind.toUpperCase().replace(/_/g, " "),
        }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "kind", label: "Mechanism", value: d.torqueKind.replace(/_/g, " ") },
        {
          id: "eff",
          label: "Efficiency",
          value:
            d.torqueKind === "spin_orbit_torque"
              ? `ξ_DL = ${d.xiDl}`
              : `P = ${d.polarizationDegree}`,
        },
      ],
      sections: [
        {
          id: "torque-model-target",
          title: "Torque mechanism & current binding",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              key: "id",
              type: "text",
              mono: true,
              label: "Torque identifier",
              validate: (v) => (v.trim().length === 0 ? "Identifier is required." : null),
            },
            {
              key: "targetScopeKey",
              type: "select",
              label: "Target ferromagnetic body / region",
              options: scopeOptions,
            },
            {
              key: "torqueKind",
              type: "select",
              label: "Spin-torque formulation",
              structural: true,
              options: [
                { value: "spin_orbit_torque", label: "Spin-orbit torque (SOT: DL + FL)" },
                { value: "slonczewski", label: "Slonczewski CPP spin-transfer torque" },
                { value: "zhang_li", label: "Zhang-Li CIP adiabatic / non-adiabatic STT" },
                { value: "drift_diffusion", label: "3D spin-accumulation exchange torque" },
                { value: "interface_cpp", label: "Interfacial CPP mixing-conductance torque" },
              ],
            },
            {
              key: "currentBindingMode",
              type: "segmented",
              label: "Current density source",
              structural: true,
              options: [
                { value: "inline_density", label: "Inline J vector" },
                { value: "named_transport", label: "Solved ChargeTransport" },
              ],
            },
            {
              key: "inlineCurrentDensity",
              type: "vector3",
              label: "Charge current density",
              symbol: <>J</>,
              units: CURRENT_DENSITY_UNITS,
              defaultDisplayUnit: "GA/m\u00b2",
              axisPresets: true,
              showWhen: (d) => d.currentBindingMode === "inline_density",
            },
            {
              key: "namedCurrentTransportId",
              type: "select",
              label: "Bound ChargeTransport solution",
              options: currentOptions,
              showWhen: (d) => d.currentBindingMode === "named_transport",
            },
          ],
        },
        {
          id: "torque-polarization-efficiencies",
          title: "Spin polarization & dimensionless efficiencies",
          icon: Sliders,
          defaultOpen: true,
          rows: [
            {
              key: "stackNormalVec",
              type: "vector3",
              label: "Bilayer interface normal",
              symbol: <>n&#770;</>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.torqueKind === "spin_orbit_torque",
            },
            {
              key: "spinPolarizationVec",
              type: "vector3",
              label: "Spin polarization unit vector",
              symbol: <>&sigma;&#770;</>,
              axisPresets: true,
              normalizeAction: true,
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Spin polarization vector must be non-zero." : null,
            },
            {
              key: "xiDl",
              type: "number",
              label: "Damping-like SOT efficiency",
              symbol: <>&xi;<sub>DL</sub></>,
              step: 0.01,
              showWhen: (d) => d.torqueKind === "spin_orbit_torque",
            },
            {
              key: "xiFl",
              type: "number",
              label: "Field-like SOT efficiency",
              symbol: <>&xi;<sub>FL</sub></>,
              step: 0.01,
              showWhen: (d) => d.torqueKind === "spin_orbit_torque",
            },
            {
              key: "polarizationDegree",
              type: "number",
              label: "Spin polarization degree",
              symbol: <>P</>,
              min: -1,
              max: 1,
              step: 0.02,
              showWhen: (d) =>
                d.torqueKind === "slonczewski" || d.torqueKind === "zhang_li",
            },
            {
              key: "betaNonAdiabatic",
              type: "number",
              label: "Non-adiabatic parameter",
              symbol: <>&beta;</>,
              step: 0.01,
              showWhen: (d) => d.torqueKind === "zhang_li",
            },
            {
              key: "lambdaAsymmetry",
              type: "number",
              label: "Slonczewski angular asymmetry",
              symbol: <>&Lambda;</>,
              min: 0.1,
              step: 0.05,
              showWhen: (d) => d.torqueKind === "slonczewski",
            },
            {
              key: "freeLayerThickness",
              type: "quantity",
              label: "Free-layer magnetic thickness",
              symbol: <>t<sub>F</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.torqueKind === "spin_orbit_torque" || d.torqueKind === "slonczewski",
            },
            {
              key: "timeProfileKind",
              type: "segmented",
              label: "Temporal modulation",
              structural: true,
              options: [
                { value: "constant", label: "DC (1)" },
                { value: "pulse", label: "Gate" },
                { value: "expression", label: "Formula g(t)" },
              ],
            },
            {
              key: "timeExpression",
              type: "expression",
              label: "Time modulation formula g(t)",
              allowedVariables: ["t", "pi"],
              showWhen: (d) => d.timeProfileKind === "expression",
            },
          ],
          footer: (ctx) =>
            ctx.draft.torqueKind === "spin_orbit_torque" ? (
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() =>
                  ctx.setField(
                    "spinPolarizationVec",
                    computeAutoHallPolarization(
                      ctx.draft.stackNormalVec,
                      ctx.draft.inlineCurrentDensity,
                    ),
                  )
                }
              >
                Auto Hall Polarization (n̂ × Ĵ)
              </Button>
            ) : null,
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Spin torque definition matches SceneDocument",
        onApply: async (draft) => {
          const scope = decodeScope(draft.targetScopeKey);
          const id = draft.id.trim();
          const sigmaHat = normalizeVector3(draft.spinPolarizationVec, [0, 1, 0]);
          const stackNormal = normalizeVector3(draft.stackNormalVec, [0, 0, 1]);
          let resource: SceneSpinTorque;

          if (draft.torqueKind === "spin_orbit_torque") {
            resource = {
              id,
              kind: "prescribed_sot",
              schema_version: "prescribed_sot.v1",
              formula_version: "prescribed_sot.fullmag.v1",
              free_layer_thickness_m: draft.freeLayerThickness,
              xi_dl: draft.xiDl,
              xi_fl: draft.xiFl,
              target: scope,
              drive:
                draft.currentBindingMode === "named_transport"
                  ? {
                      kind: "vector_current_source",
                      current_source_id: draft.namedCurrentTransportId,
                      drive_direction: normalizeVector3(draft.inlineCurrentDensity, [1, 0, 0]),
                      interface_normal: stackNormal,
                    }
                  : {
                      kind: "signed_scalar",
                      current_density_Apm2: vectorNorm(draft.inlineCurrentDensity),
                      sigma_hat: sigmaHat,
                    },
            };
          } else if (draft.torqueKind === "zhang_li") {
            resource = {
              id,
              kind: "zhang_li",
              formula_version: "zhang_li.fullmag.v1",
              degree: draft.polarizationDegree,
              beta: draft.betaNonAdiabatic,
              target: scope,
              ...(draft.currentBindingMode === "named_transport"
                ? { current_source: draft.namedCurrentTransportId }
                : { current_density: [...draft.inlineCurrentDensity] }),
            };
          } else if (draft.torqueKind === "drift_diffusion") {
            resource = {
              id,
              kind: "drift_diffusion_spin_torque",
              schema_version: "drift_diffusion_spin_torque.v1",
              formula_version: "drift_diffusion_spin_torque.fullmag.v1",
              solve_id: draft.namedCurrentTransportId || "spin-transport-1",
              target: scope,
            };
          } else {
            resource = {
              id,
              kind: "slonczewski",
              formula_version: "slonczewski.fullmag.v2",
              degree: draft.polarizationDegree,
              epsilon_prime: draft.xiFl,
              lambda_asymmetry: draft.lambdaAsymmetry,
              free_layer_thickness_m: draft.freeLayerThickness,
              spin_polarization: sigmaHat,
              stack_normal: stackNormal,
              target: scope,
              ...(draft.currentBindingMode === "named_transport"
                ? { current_source: draft.namedCurrentTransportId }
                : { current_density: [...draft.inlineCurrentDensity] }),
              ...(draft.timeProfileKind === "expression"
                ? { time_expression: { expression: draft.timeExpression.trim() } }
                : {}),
            };
          }

          const req: SpinTorqueMutationRequest = {
            base_revision: scene.data?.revision ?? 0,
            resource,
          };
          const res = draft.exists
            ? await kernel.api.model.replaceSpinTorque(id, req)
            : await kernel.api.model.createSpinTorque(req);
          publishCommittedSceneResource(
            kernel.resources,
            res.committed_scene,
            res.scene_revision,
          );
          invalidateSpinAuthoringResources(kernel.resources, res, [
            SPIN_TORQUES_RESOURCE_KEY,
          ]);
          return true;
        },
      },
    }),
    [
      baseline.exists,
      baseline.id,
      currentOptions,
      kernel.api.model,
      kernel.resources,
      scene.data?.revision,
      scopeOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 7. OerstedFieldInspectorPanel (`physics.oersted-field`)
 *    Title: "Oersted Field" — Biot-Savart wire vs CurrentTransport, ZERO <textarea>!
 * ══════════════════════════════════════════════════════════════════════════════ */

interface OerstedFieldSpecDraft {
  id: string;
  exists: boolean;
  kind: "oersted_cylinder" | "oersted_field";
  currentA: number;
  wireRadiusM: number;
  wireCenterM: readonly [number, number, number];
  wireAxis: readonly [number, number, number];
  currentSourceId: string;
  timeMode: "constant" | "expression";
  timeExpression: string;
  preservedRaw: Record<string, unknown> | null;
}

export function OerstedFieldInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const oerstedFields = useOerstedFieldsResource({ enabled: true });
  const currentTransports = useCurrentTransportsResource({ enabled: true });

  const currentOptions = useMemo(() => {
    const opts = ((currentTransports.data?.items ?? []) as Record<string, unknown>[]).map((ct) => {
      const id = String(ct.name ?? ct.id ?? "");
      return { value: id, label: id };
    });
    return opts.length > 0 ? opts : [{ value: "charge-transport-1", label: "charge-transport-1" }];
  }, [currentTransports.data?.items]);

  const selectedId =
    selection.ref?.type === "oersted-field" ? selection.ref.oerstedFieldId ?? null : null;

  const matched = useMemo(() => {
    const items = (oerstedFields.data?.items ?? []) as Record<string, unknown>[];
    if (selectedId) {
      return items.find((it) => (it.id ?? it.name) === selectedId) ?? null;
    }
    return items[0] ?? null;
  }, [oerstedFields.data?.items, selectedId]);

  const baseline = useMemo<OerstedFieldSpecDraft>(() => {
    const rec = matched ?? {};
    const id = String(rec.id ?? rec.name ?? selectedId ?? "oersted-field-1");
    const kind = rec.kind === "oersted_field" ? "oersted_field" : "oersted_cylinder";
    const center = Array.isArray(rec.center_m ?? rec.center)
      ? ((rec.center_m ?? rec.center) as unknown[])
      : [0, 0, 0];
    const axis = Array.isArray(rec.axis) ? (rec.axis as unknown[]) : [0, 0, 1];
    return {
      id,
      exists: Boolean(matched),
      kind,
      currentA:
        typeof rec.current === "number"
          ? rec.current
          : typeof rec.current_A === "number"
            ? rec.current_A
            : 5.0e-3,
      wireRadiusM:
        typeof rec.radius === "number"
          ? rec.radius
          : typeof rec.radius_m === "number"
            ? rec.radius_m
            : 50e-9,
      wireCenterM: [
        Number(center[0]) || 0,
        Number(center[1]) || 0,
        Number(center[2]) || 0,
      ],
      wireAxis: [Number(axis[0]) || 0, Number(axis[1]) || 0, Number(axis[2]) || 1],
      currentSourceId:
        typeof rec.source === "string" ? rec.source : currentOptions[0]!.value,
      timeMode: "constant",
      timeExpression: "sin(2 * pi * 1e9 * t)",
      preservedRaw: matched,
    };
  }, [currentOptions, matched, selectedId]);

  const spec = useMemo<InspectorSpec<OerstedFieldSpecDraft>>(
    () => ({
      id: "physics.oersted-field",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "oe", label: "Oersted Field" },
        ],
        searchable: false,
        extraMenuActions: [
          {
            id: "view-oe-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) =>
              ctx.openCodePreview(
                `${ctx.draft.id} JSON`,
                "json",
                JSON.stringify(ctx.draft.preservedRaw ?? ctx.draft, null, 2),
              ),
          },
        ],
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Oersted Field",
                confirmTitle: (d) => `Delete Oersted field "${d.id}"?`,
                confirmDescription:
                  "This removes the Ampère / Biot-Savart magnetic field contribution.",
                onDelete: async (ctx) => {
                  const res = await kernel.api.model.deleteOerstedField(baseline.id, {
                    base_revision: scene.data?.revision ?? 0,
                  });
                  publishCommittedSceneResource(
                    kernel.resources,
                    res.committed_scene,
                    res.scene_revision,
                  );
                  invalidateSpinAuthoringResources(kernel.resources, res, [
                    OERSTED_FIELDS_RESOURCE_KEY,
                  ]);
                  ctx.selectNode(
                    buildRootSelection("session.root", "model:session", "Session Model"),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Zap,
        title: (d) => d.id,
        renameFieldKey: baseline.exists ? undefined : "id",
        kindLabel: "Ampère / Biot-Savart Oersted field",
        entityId: baseline.id,
        statePill: (d) => ({
          tone: "ok",
          label: d.kind === "oersted_cylinder" ? "Analytic Wire" : "From Current",
        }),
      },
      facts: (d): readonly InspectorFact[] => {
        const bSurfaceMt =
          d.kind === "oersted_cylinder" && d.wireRadiusM > 0
            ? ((MU0_SI * Math.abs(d.currentA)) / (2 * Math.PI * d.wireRadiusM)) * 1e3
            : null;
        return [
          {
            id: "mode",
            label: "Source",
            value: d.kind === "oersted_cylinder" ? "Cylindrical wire" : d.currentSourceId,
          },
          {
            id: "bsurf",
            label: "B_Oe(R)",
            value: bSurfaceMt !== null ? `${bSurfaceMt.toFixed(2)} mT` : null,
            tone: "info",
          },
        ];
      },
      sections: [
        {
          id: "oersted-source-params",
          title: "Current source & Biot-Savart geometry",
          icon: Zap,
          defaultOpen: true,
          rows: [
            {
              key: "id",
              type: "text",
              mono: true,
              label: "Oersted field ID",
              validate: (v) => (v.trim().length === 0 ? "Identifier is required." : null),
            },
            {
              key: "kind",
              type: "segmented",
              label: "Field evaluation model",
              structural: true,
              options: [
                { value: "oersted_cylinder", label: "Cylindrical wire" },
                { value: "oersted_field", label: "From ChargeTransport" },
              ],
            },
            {
              key: "currentA",
              type: "quantity",
              label: "Wire current",
              symbol: <>I</>,
              units: CURRENT_UNITS,
              defaultDisplayUnit: "mA",
              showWhen: (d) => d.kind === "oersted_cylinder",
            },
            {
              key: "wireRadiusM",
              type: "quantity",
              label: "Wire radius",
              symbol: <>R</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.kind === "oersted_cylinder",
            },
            {
              key: "wireCenterM",
              type: "vector3",
              label: "Wire axis point",
              symbol: <>r<sub>0</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.kind === "oersted_cylinder",
            },
            {
              key: "wireAxis",
              type: "vector3",
              label: "Wire current direction",
              symbol: <>a&#770;</>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.kind === "oersted_cylinder",
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Wire axis must be non-zero." : null,
            },
            {
              type: "readonly",
              label: "Peak circumferential field at r = R",
              symbol: <>B<sub>Oe</sub>(R)</>,
              mono: true,
              showWhen: (d) => d.kind === "oersted_cylinder" && d.wireRadiusM > 0,
              format: (d) => {
                const bMt =
                  ((MU0_SI * Math.abs(d.currentA)) / (2 * Math.PI * d.wireRadiusM)) * 1e3;
                return `${bMt.toFixed(3)} mT`;
              },
            },
            {
              key: "currentSourceId",
              type: "select",
              label: "Source ChargeTransport solution",
              options: currentOptions,
              showWhen: (d) => d.kind === "oersted_field",
            },
            {
              key: "timeMode",
              type: "segmented",
              label: "Temporal modulation",
              structural: true,
              options: [
                { value: "constant", label: "Steady DC" },
                { value: "expression", label: "Formula g(t)" },
              ],
            },
            {
              key: "timeExpression",
              type: "expression",
              label: "Time envelope g(t)",
              allowedVariables: ["t", "pi"],
              showWhen: (d) => d.timeMode === "expression",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Oersted field definition matches SceneDocument",
        onApply: async (draft) => {
          const id = draft.id.trim();
          const resource: SceneOerstedField =
            draft.kind === "oersted_cylinder"
              ? {
                  id,
                  kind: "oersted_cylinder",
                  current: draft.currentA,
                  radius: draft.wireRadiusM,
                  center: [...draft.wireCenterM],
                  axis: normalizeVector3(draft.wireAxis, [0, 0, 1]),
                }
              : {
                  id,
                  kind: "oersted_field",
                  model: "from_current_solution",
                  source: draft.currentSourceId,
                };
          const req: OerstedFieldMutationRequest = {
            base_revision: scene.data?.revision ?? 0,
            resource,
          };
          const res = draft.exists
            ? await kernel.api.model.replaceOerstedField(id, req)
            : await kernel.api.model.createOerstedField(req);
          publishCommittedSceneResource(
            kernel.resources,
            res.committed_scene,
            res.scene_revision,
          );
          invalidateSpinAuthoringResources(kernel.resources, res, [
            OERSTED_FIELDS_RESOURCE_KEY,
          ]);
          return true;
        },
      },
    }),
    [baseline.exists, baseline.id, currentOptions, kernel.api.model, kernel.resources, scene.data?.revision],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export { ArrowRight };
