"use client";

import { useMemo } from "react";

import { useCommand, useModel } from "../../runs/control-room/context-hooks";
import { fmtExp, fmtSI } from "../../runs/control-room/shared";
import { IntegratorSettingsPanel, RelaxationSettingsPanel } from "../SolverSettingsPanel";
import { Button } from "../../ui/button";
import SelectField from "../../ui/SelectField";
import TextField from "../../ui/TextField";
import { SidebarSection, InfoRow, StatusBadge } from "./primitives";
import {
  buildPhysicsCapabilityView,
  getPhysicsCatalogEntry,
  type PhysicsCapabilityViewEntry,
  type PhysicsCatalogId,
} from "../../../lib/session/physicsCatalog";
import {
  ensureObjectPhysicsStack,
  removeOptionalInteraction,
  upsertObjectInteraction,
} from "../../../lib/session/magneticPhysics";
import type {
  SceneObject,
  ScriptBuilderMagneticInteractionEntry,
  ScriptBuilderMagneticInteractionKind,
} from "../../../lib/session/types";
import { asRecord } from "../../runs/control-room/helpers";
import { resolveFemDiscretization } from "@/src/domain/capabilities";

function formatVector(value: number[] | null | undefined, unit: string): string {
  if (!value || value.length < 3) return "—";
  return value
    .slice(0, 3)
    .map((component) => fmtSI(Number(component) || 0, unit))
    .join(" · ");
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function hasNonZeroVector(value: number[] | null | undefined): boolean {
  return Boolean(value && value.some((component) => Math.abs(Number(component) || 0) > 0));
}

function hasNonZeroScalar(value: number | null | undefined): boolean {
  return Math.abs(Number(value ?? 0)) > 0;
}

function normalizePhysicsStack(
  stack: readonly ScriptBuilderMagneticInteractionEntry[],
): ScriptBuilderMagneticInteractionEntry[] {
  const byKind = new Map<string, ScriptBuilderMagneticInteractionEntry>();
  for (const entry of stack) {
    const current = byKind.get(entry.kind);
    if (!current) {
      byKind.set(entry.kind, entry);
      continue;
    }
    byKind.set(entry.kind, {
      ...current,
      enabled: current.enabled || entry.enabled,
      params: current.params ?? entry.params,
    });
  }
  return Array.from(byKind.values());
}

function availabilityBadge(entry: PhysicsCapabilityViewEntry): {
  label: string;
  tone: "default" | "info" | "success" | "warn";
} {
  if (entry.active && !entry.available) {
    return { label: "Active · Unsupported", tone: "warn" };
  }
  if (entry.active) {
    return { label: "Active", tone: "success" };
  }
  if (entry.available && entry.authorableInObjectPanel) {
    return { label: "Available", tone: "info" };
  }
  if (entry.available) {
    return { label: "Backend only", tone: "warn" };
  }
  return { label: "Unavailable", tone: "default" };
}

function catalogIdToObjectInteractionKind(
  moduleId: PhysicsCatalogId,
): ScriptBuilderMagneticInteractionKind | null {
  if (moduleId === "exchange") return "exchange";
  if (moduleId === "demag") return "demag";
  if (moduleId === "interfacial_dmi") return "interfacial_dmi";
  if (moduleId === "uniaxial_anisotropy") return "uniaxial_anisotropy";
  return null;
}

function interactionAxis(params: Record<string, unknown> | null | undefined): [number, number, number] {
  const raw = params?.axis;
  if (!Array.isArray(raw) || raw.length < 3) return [0, 0, 1];
  return [
    Number(raw[0] ?? 0),
    Number(raw[1] ?? 0),
    Number(raw[2] ?? 1),
  ];
}

type PhysicsNodeContext =
  | { kind: "root" }
  | { kind: "solver" }
  | { kind: "module"; moduleId: PhysicsCatalogId }
  | { kind: "module-method"; moduleId: "demag" }
  | { kind: "module-boundary"; moduleId: "demag" };

function parsePhysicsNodeContext(nodeId: string | null | undefined): PhysicsNodeContext {
  if (!nodeId || nodeId === "physics") return { kind: "root" };
  if (nodeId === "physics-solver") return { kind: "solver" };

  if (nodeId === "phys-demag-method" || nodeId === "physics-module-demag-method") {
    return { kind: "module-method", moduleId: "demag" };
  }
  if (
    nodeId === "phys-boundary"
    || nodeId === "phys-bc"
    || nodeId === "phys-demag-open-bc"
    || nodeId === "physics-module-demag-boundary"
  ) {
    return { kind: "module-boundary", moduleId: "demag" };
  }

  const legacyMap: Record<string, PhysicsCatalogId> = {
    "phys-exchange": "exchange",
    "phys-demag": "demag",
    "phys-zeeman": "zeeman",
    "phys-thermal": "thermal_noise",
    "phys-stt": "spin_transfer_torque",
    "phys-spin-torque": "spin_transfer_torque",
    "phys-dmi": "interfacial_dmi",
    "phys-anisotropy": "uniaxial_anisotropy",
  };
  const legacy = legacyMap[nodeId];
  if (legacy) {
    return { kind: "module", moduleId: legacy };
  }

  if (nodeId.startsWith("physics-module-")) {
    const suffix = nodeId.replace("physics-module-", "");
    const direct = getPhysicsCatalogEntry(suffix as PhysicsCatalogId);
    if (direct) {
      return { kind: "module", moduleId: direct.id };
    }
  }

  return { kind: "root" };
}

function outerBoundaryLabel(policy: string | null | undefined): string {
  if (policy === "poisson_dirichlet" || policy === "airbox_dirichlet") {
    return "Dirichlet";
  }
  if (policy === "poisson_robin" || policy === "airbox_robin") {
    return "Robin";
  }
  return "Planner-managed";
}

interface BoundaryPolicyOption {
  value: string;
  label: string;
  summary: string;
  whenToUse: string;
}

function boundaryPolicyOptionDetails(value: string): BoundaryPolicyOption {
  if (value === "poisson_dirichlet") {
    return {
      value,
      label: "Dirichlet",
      summary: "Fixed magnetic potential at outer boundary.",
      whenToUse: "Use when you have a large enough air region and want a conservative, simple boundary model.",
    };
  }
  if (value === "airbox_dirichlet") {
    return {
      value,
      label: "Dirichlet (airbox)",
      summary: "Dirichlet policy specialized for explicit airbox workflows.",
      whenToUse: "Use in airbox realizations when you need explicit outer-boundary control.",
    };
  }
  if (value === "poisson_robin") {
    return {
      value,
      label: "Robin",
      summary: "Mixed boundary condition approximating open boundary behavior.",
      whenToUse: "Default practical choice for finite domains with limited air padding.",
    };
  }
  if (value === "airbox_robin") {
    return {
      value,
      label: "Robin (airbox)",
      summary: "Robin policy specialized for explicit airbox realizations.",
      whenToUse: "Use in airbox realizations to better emulate open-domain decay at outer boundaries.",
    };
  }
  return {
    value: "auto",
    label: "Auto",
    summary: "Planner chooses realization and BC from backend capabilities.",
    whenToUse: "Recommended for most workflows unless you need deterministic BC control for validation.",
  };
}

function defaultFemSolverPolicyFromPlan(
  solverPlan: {
    demagSolver?: {
      method?: string | null;
      preconditioner?: string | null;
      relativeTolerance?: number | null;
      absoluteTolerance?: number | null;
      maxIterations?: number | null;
      printLevel?: number | null;
    } | null;
  } | null,
): Record<string, unknown> {
  const demagSolver = solverPlan?.demagSolver;
  return {
    solver: demagSolver?.method ?? "CG",
    preconditioner: demagSolver?.preconditioner ?? "AMG",
    rtol: demagSolver?.relativeTolerance ?? 1e-8,
    atol: demagSolver?.absoluteTolerance ?? null,
    max_iterations: demagSolver?.maxIterations ?? 500,
    print_level: demagSolver?.printLevel ?? 0,
  };
}

function solverPolicyFieldNumber(
  policy: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = policy?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export default function PhysicsPanel({ nodeId }: { nodeId?: string }) {
  const cmd = useCommand();
  const model = useModel();
  const solverPlan = model.solverPlan;
  const context = useMemo(() => parsePhysicsNodeContext(nodeId), [nodeId]);
  const femDiscretization = resolveFemDiscretization(
    cmd.domainCapabilities,
    cmd.isFemBackend,
  );

  const externalField =
    model.sceneDocument?.study.external_field
    ?? model.modelBuilderGraph?.study.external_field
    ?? solverPlan?.externalField
    ?? null;
  const sceneObjects = useMemo(
    () => model.sceneDocument?.objects ?? [],
    [model.sceneDocument?.objects],
  );
  const sceneMaterials = useMemo(
    () => model.sceneDocument?.materials ?? [],
    [model.sceneDocument?.materials],
  );
  const targetObject = useMemo<SceneObject | null>(() => {
    if (sceneObjects.length === 0) return null;
    if (model.selectedObjectId) {
      const selected = sceneObjects.find(
        (entry) => entry.id === model.selectedObjectId || entry.name === model.selectedObjectId,
      );
      if (selected) return selected;
    }
    return sceneObjects[0] ?? null;
  }, [sceneObjects, model.selectedObjectId]);
  const targetMaterialDind = useMemo(() => {
    if (!targetObject) return null;
    return sceneMaterials.find((entry) => entry.id === targetObject.material_ref)?.properties.Dind ?? null;
  }, [sceneMaterials, targetObject]);
  const targetObjectPhysicsStack = useMemo(() => {
    if (!targetObject) return [];
    return ensureObjectPhysicsStack(targetObject.physics_stack, targetMaterialDind);
  }, [targetObject, targetMaterialDind]);

  const physicsSignals = useMemo(() => {
    const sceneObjects = model.sceneDocument?.objects ?? [];
    const sceneMaterials = model.sceneDocument?.materials ?? [];
    const entries: ScriptBuilderMagneticInteractionEntry[] = [];
    let hasInterfacialDmiFromMaterial = false;
    for (const object of sceneObjects) {
      const materialDind =
        sceneMaterials.find((entry) => entry.id === object.material_ref)?.properties.Dind
        ?? null;
      if (hasNonZeroScalar(materialDind)) {
        hasInterfacialDmiFromMaterial = true;
      }
      entries.push(...ensureObjectPhysicsStack(object.physics_stack, materialDind));
    }
    return {
      aggregatePhysicsStack: normalizePhysicsStack(entries),
      hasInterfacialDmiFromMaterial,
    };
  }, [model.sceneDocument]);

  const metadata = cmd.metadata ?? null;
  const capabilityEntries = useMemo(() => {
    const base = buildPhysicsCapabilityView(cmd.capabilities, physicsSignals.aggregatePhysicsStack);
    return base.map((entry) => {
      let active = entry.active;
      let available = entry.available;
      if (entry.id === "zeeman") {
        active = hasNonZeroVector(externalField);
        if (active) {
          available = true;
        }
      } else if (entry.id === "interfacial_dmi") {
        active = active || physicsSignals.hasInterfacialDmiFromMaterial;
      } else if (entry.id === "thermal_noise") {
        active = metadata?.thermal_active === true;
      } else if (entry.id === "spin_transfer_torque") {
        active = metadata?.stt_active === true;
      } else if (entry.id === "spin_orbit_torque") {
        active = metadata?.sot_active === true;
      } else if (entry.id === "oersted") {
        active = metadata?.oersted_active === true;
      } else if (entry.id === "demag") {
        active = solverPlan?.demagEnabled ?? active;
        if (solverPlan?.demagEnabled === true) {
          available = true;
        }
      } else if (entry.id === "exchange") {
        active = solverPlan?.exchangeEnabled ?? active;
        if (solverPlan?.exchangeEnabled === true) {
          available = true;
        }
      }
      return { ...entry, active, available };
    });
  }, [
    cmd.capabilities,
    externalField,
    metadata,
    physicsSignals.aggregatePhysicsStack,
    physicsSignals.hasInterfacialDmiFromMaterial,
    solverPlan?.demagEnabled,
    solverPlan?.exchangeEnabled,
  ]);

  const capabilityById = useMemo(
    () => new Map(capabilityEntries.map((entry) => [entry.id, entry] as const)),
    [capabilityEntries],
  );

  const selectedModule =
    context.kind === "module" || context.kind === "module-method" || context.kind === "module-boundary"
      ? capabilityById.get(context.moduleId) ?? null
      : null;
  const selectedModuleInteractionKind = selectedModule
    ? catalogIdToObjectInteractionKind(selectedModule.id)
    : null;
  const selectedTargetInteraction = selectedModuleInteractionKind
    ? targetObjectPhysicsStack.find((entry) => entry.kind === selectedModuleInteractionKind) ?? null
    : null;

  const setTargetObjectPhysicsStack = (
    updater: (stack: ScriptBuilderMagneticInteractionEntry[]) => ScriptBuilderMagneticInteractionEntry[],
  ) => {
    if (!targetObject) return;
    model.setSceneDocument((previous) =>
      previous
        ? {
            ...previous,
            objects: previous.objects.map((entry) => {
              if (entry.id !== targetObject.id && entry.name !== targetObject.name) {
                return entry;
              }
              const current = ensureObjectPhysicsStack(entry.physics_stack, targetMaterialDind);
              return {
                ...entry,
                physics_stack: ensureObjectPhysicsStack(
                  updater(current),
                  targetMaterialDind,
                ),
              };
            }),
          }
        : previous,
    );
  };

  const femDemagSolverPolicy = asRecord(
    model.sceneDocument?.study.fem_demag_solver_policy
    ?? model.modelBuilderGraph?.study.fem_demag_solver_policy
    ?? null,
  );
  const effectiveFemDemagSolverPolicy =
    femDemagSolverPolicy ?? defaultFemSolverPolicyFromPlan(solverPlan);

  const setFemDemagSolverPolicy = (patch: Record<string, unknown>) => {
    model.setSceneDocument((previous) =>
      previous
        ? {
            ...previous,
            study: {
              ...previous.study,
              fem_demag_solver_policy: {
                ...defaultFemSolverPolicyFromPlan(solverPlan),
                ...(asRecord(previous.study.fem_demag_solver_policy) ?? {}),
                ...patch,
              },
            },
          }
        : previous,
    );
  };

  const setExternalFieldComponent = (axis: 0 | 1 | 2, rawValue: string) => {
    const parsed = parseOptionalNumber(rawValue);
    model.setSceneDocument((previous) => {
      if (!previous) return previous;
      const baseline = previous.study.external_field ?? [0, 0, 0];
      const nextField: [number, number, number] = [...baseline] as [number, number, number];
      nextField[axis] = parsed ?? 0;
      return {
        ...previous,
        study: {
          ...previous.study,
          external_field: nextField,
        },
      };
    });
  };

  const clearExternalField = () => {
    model.setSceneDocument((previous) =>
      previous
        ? {
            ...previous,
            study: {
              ...previous.study,
              external_field: null,
            },
          }
        : previous,
    );
  };

  const demagRealization = model.scriptBuilderDemagRealization ?? "auto";
  const demagBoundaryOptions = useMemo(() => {
    const supported = new Set(cmd.capabilities?.supported_demag_realizations ?? []);
    const values: string[] = ["auto"];
    if (supported.has("poisson_dirichlet")) values.push("poisson_dirichlet");
    if (supported.has("airbox_dirichlet")) values.push("airbox_dirichlet");
    if (supported.has("poisson_robin")) values.push("poisson_robin");
    if (supported.has("airbox_robin")) values.push("airbox_robin");
    if (demagRealization !== "auto" && !values.includes(demagRealization)) {
      values.push(demagRealization);
    }
    return values.map(boundaryPolicyOptionDetails);
  }, [cmd.capabilities?.supported_demag_realizations, demagRealization]);
  const selectedBoundaryPolicy = useMemo(() => {
    return demagBoundaryOptions.find((option) => option.value === demagRealization)
      ?? boundaryPolicyOptionDetails("auto");
  }, [demagBoundaryOptions, demagRealization]);

  const renderModuleDetails = (entry: PhysicsCapabilityViewEntry) => {
    if (entry.id === "demag" && context.kind === "module-method") {
      return (
        <SidebarSection title="Demagnetization Method" defaultOpen={true}>
          <div className="grid gap-1">
            <InfoRow
              label="Family"
              value={solverPlan?.demagSolver?.family ?? (femDiscretization && solverPlan?.demagEnabled ? "hypre" : "—")}
            />
            <InfoRow
              label="Resolved method"
              value={solverPlan?.demagSolver?.method ?? String(effectiveFemDemagSolverPolicy.solver ?? "CG")}
            />
            <InfoRow
              label="Resolved preconditioner"
              value={solverPlan?.demagSolver?.preconditioner ?? String(effectiveFemDemagSolverPolicy.preconditioner ?? "AMG")}
            />
            <InfoRow
              label="Resolved relative tolerance"
              value={solverPlan?.demagSolver?.relativeTolerance != null ? fmtExp(solverPlan.demagSolver.relativeTolerance) : "—"}
            />
            <InfoRow
              label="Resolved absolute tolerance"
              value={solverPlan?.demagSolver?.absoluteTolerance != null ? fmtExp(solverPlan.demagSolver.absoluteTolerance) : "—"}
            />
            <InfoRow
              label="Resolved print level"
              value={solverPlan?.demagSolver?.printLevel != null ? `${solverPlan.demagSolver.printLevel}` : "—"}
            />
          </div>
          <div className="mt-3 rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
            <div className="font-semibold text-foreground">Method guidance</div>
            <div className="mt-1">
              <span className="font-mono text-foreground">CG</span>: fastest default for symmetric positive-definite systems, especially with AMG.
            </div>
            <div className="mt-1">
              <span className="font-mono text-foreground">GMRES</span>: use when CG stagnates or for tougher/non-ideal linear systems; more robust but heavier.
            </div>
            <div className="mt-2 font-semibold text-foreground">Preconditioner guidance</div>
            <div className="mt-1">
              <span className="font-mono text-foreground">AMG</span>: recommended for most 3D FEM runs and larger meshes.
            </div>
            <div className="mt-1">
              <span className="font-mono text-foreground">JACOBI</span>: cheaper fallback for small/debug runs when AMG setup is not desired.
            </div>
            <div className="mt-1">
              <span className="font-mono text-foreground">NONE</span>: diagnostics only; typically too slow for production meshes.
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            <SelectField
              label="Linear method"
              value={String(effectiveFemDemagSolverPolicy.solver ?? "CG")}
              onchange={(value) => setFemDemagSolverPolicy({ solver: value })}
              options={[
                { value: "CG", label: "CG" },
                { value: "GMRES", label: "GMRES" },
              ]}
            />
            <SelectField
              label="Preconditioner"
              value={String(effectiveFemDemagSolverPolicy.preconditioner ?? "AMG")}
              onchange={(value) => setFemDemagSolverPolicy({ preconditioner: value })}
              options={[
                { value: "AMG", label: "AMG" },
                { value: "JACOBI", label: "JACOBI" },
                { value: "NONE", label: "NONE" },
              ]}
            />
            <div className="grid grid-cols-1 gap-3 @[980px]:grid-cols-2">
              <TextField
                label="Relative tolerance"
                value={String(solverPolicyFieldNumber(effectiveFemDemagSolverPolicy, "rtol") ?? "")}
                onchange={(event) => {
                  const next = parseOptionalNumber(event.target.value);
                  if (next != null && next > 0) setFemDemagSolverPolicy({ rtol: next });
                }}
                placeholder="1e-8"
                mono
              />
              <TextField
                label="Max iterations"
                value={String(solverPolicyFieldNumber(effectiveFemDemagSolverPolicy, "max_iterations") ?? "")}
                onchange={(event) => {
                  const next = parseOptionalNumber(event.target.value);
                  if (next != null && next >= 1) {
                    setFemDemagSolverPolicy({ max_iterations: Math.trunc(next) });
                  }
                }}
                placeholder="500"
                mono
              />
            </div>
            <div className="grid grid-cols-1 gap-3 @[980px]:grid-cols-2">
              <TextField
                label="Absolute tolerance"
                value={String(solverPolicyFieldNumber(effectiveFemDemagSolverPolicy, "atol") ?? "")}
                onchange={(event) => {
                  const trimmed = event.target.value.trim();
                  if (!trimmed) {
                    setFemDemagSolverPolicy({ atol: null });
                    return;
                  }
                  const next = parseOptionalNumber(trimmed);
                  if (next != null && next > 0) {
                    setFemDemagSolverPolicy({ atol: next });
                  }
                }}
                placeholder="disabled"
                mono
              />
              <TextField
                label="Print level"
                value={String(solverPolicyFieldNumber(effectiveFemDemagSolverPolicy, "print_level") ?? "")}
                onchange={(event) => {
                  const next = parseOptionalNumber(event.target.value);
                  if (next != null && next >= 0) {
                    setFemDemagSolverPolicy({ print_level: Math.trunc(next) });
                  }
                }}
                placeholder="0"
                mono
              />
            </div>
          </div>
        </SidebarSection>
      );
    }

    if (entry.id === "demag" && context.kind === "module-boundary") {
      return (
        <SidebarSection title="Demagnetization Boundary Conditions" defaultOpen={true}>
          <div className="grid gap-3">
            <SelectField
              label="Boundary policy"
              value={demagRealization}
              onchange={(value) => model.setScriptBuilderDemagRealization(value === "auto" ? null : value)}
              options={demagBoundaryOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
            />
            <div className="grid gap-1">
              <InfoRow
                label="Status"
                value={demagRealization === "auto" ? "Planner-managed" : "Explicit authoring"}
              />
              <InfoRow label="Effective" value={outerBoundaryLabel(demagRealization)} />
              <InfoRow
                label="Supported by backend"
                value={demagBoundaryOptions
                  .filter((option) => option.value !== "auto")
                  .map((option) => option.label)
                  .join(" · ") || "planner only"}
              />
            </div>
            <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
              <div className="font-semibold text-foreground">Selected policy</div>
              <div className="mt-1">{selectedBoundaryPolicy.summary}</div>
              <div className="mt-1">{selectedBoundaryPolicy.whenToUse}</div>
              <div className="mt-2 font-semibold text-foreground">Policy guidance</div>
              <div className="mt-1">
                <span className="font-mono text-foreground">Auto</span>: safest default, keeps planner/backend alignment.
              </div>
              <div className="mt-1">
                <span className="font-mono text-foreground">Dirichlet</span>: use with sufficiently large air region; may bias results if boundary is too close.
              </div>
              <div className="mt-1">
                <span className="font-mono text-foreground">Robin</span>: practical open-boundary approximation for finite domains with limited air padding.
              </div>
              <div className="mt-2">
                All options use the same canonical contract:
                <span className="font-mono text-foreground"> study.demag_realization</span>.
              </div>
            </div>
          </div>
        </SidebarSection>
      );
    }

    if (entry.id === "zeeman") {
      return (
        <SidebarSection title="Zeeman / External Field" defaultOpen={true}>
          <div className="grid grid-cols-1 gap-3 @[980px]:grid-cols-3">
            <TextField
              label="Bx [T]"
              value={externalField ? String(externalField[0]) : ""}
              onchange={(event) => setExternalFieldComponent(0, event.target.value)}
              placeholder="0"
              mono
            />
            <TextField
              label="By [T]"
              value={externalField ? String(externalField[1]) : ""}
              onchange={(event) => setExternalFieldComponent(1, event.target.value)}
              placeholder="0"
              mono
            />
            <TextField
              label="Bz [T]"
              value={externalField ? String(externalField[2]) : ""}
              onchange={(event) => setExternalFieldComponent(2, event.target.value)}
              placeholder="0"
              mono
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" type="button" onClick={clearExternalField}>
              Disable External Field
            </Button>
          </div>
          <div className="mt-3 grid gap-1">
            <InfoRow label="Vector" value={formatVector(externalField, "T")} />
            <InfoRow
              label="|B|"
              value={
                externalField
                  ? fmtExp(Math.sqrt(externalField[0] ** 2 + externalField[1] ** 2 + externalField[2] ** 2))
                  : "—"
              }
            />
          </div>
        </SidebarSection>
      );
    }

    if (!entry.authorableInObjectPanel && entry.id !== "demag") {
      return (
        <SidebarSection title="Module Details" defaultOpen={true}>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[0.72rem] leading-relaxed text-amber-100/90">
            This module is visible from backend/runtime capability profiles, but does not yet expose a first-class
            authoring editor in this panel.
          </div>
          <div className="mt-3 grid gap-1">
            <InfoRow label="Scope" value={entry.scope} />
            <InfoRow label="Runtime tags" value={entry.backendTerms.join(", ")} />
            <InfoRow label="Parameter hints" value={entry.parameterHints.join(" · ") || "—"} />
          </div>
        </SidebarSection>
      );
    }

    return (
      <SidebarSection title="Module Details" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
          {entry.authorableInObjectPanel
            ? "This interaction is object-scoped. Use the Object -> Material -> Magnetic Interactions editor to author parameters."
            : "No dedicated authoring surface is available yet."}
        </div>
        <div className="mt-3 grid gap-1">
          <InfoRow label="Scope" value={entry.scope} />
          <InfoRow label="Runtime tags" value={entry.backendTerms.join(", ")} />
          <InfoRow label="Parameter hints" value={entry.parameterHints.join(" · ") || "—"} />
        </div>
      </SidebarSection>
    );
  };

  const renderObjectInteractionAuthoring = (
    entry: PhysicsCapabilityViewEntry,
  ) => {
    if (!entry.authorableInObjectPanel) return null;
    const interactionKind = catalogIdToObjectInteractionKind(entry.id);
    if (!interactionKind) return null;
    if (entry.id === "demag" || entry.id === "exchange") {
      return (
        <SidebarSection title="Object Authoring" defaultOpen={true}>
          <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
            `{entry.label}` is mandatory in current object authoring semantics and stays enabled by contract.
          </div>
        </SidebarSection>
      );
    }
    if (!targetObject) {
      return (
        <SidebarSection title="Object Authoring" defaultOpen={true}>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-[0.72rem] leading-relaxed text-amber-100/90">
            Add an object first. Object-scoped interactions are authored per object.
          </div>
        </SidebarSection>
      );
    }

    const moduleEntry = selectedTargetInteraction;
    const moduleEnabled = moduleEntry?.enabled !== false;
    const moduleParams = moduleEntry?.params ?? {};
    const axis = interactionAxis(moduleEntry?.params);

    return (
      <SidebarSection title="Object Authoring" defaultOpen={true}>
        <div className="grid gap-2">
          <InfoRow label="Target object" value={targetObject.name} />
          {sceneObjects.length > 1 ? (
            <SelectField
              label="Authoring object"
              value={targetObject.id}
              onchange={(value) => model.setSelectedObjectId(value)}
              options={sceneObjects.map((object) => ({
                value: object.id,
                label: object.name,
              }))}
            />
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {!moduleEntry ? (
            <Button
              size="sm"
              variant="default"
              type="button"
              onClick={() => {
                setTargetObjectPhysicsStack((stack) =>
                  upsertObjectInteraction(stack, interactionKind, { enabled: true }),
                );
              }}
            >
              Activate On Object
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant={moduleEnabled ? "outline" : "default"}
                type="button"
                onClick={() => {
                  setTargetObjectPhysicsStack((stack) =>
                    upsertObjectInteraction(stack, interactionKind, { enabled: !moduleEnabled }),
                  );
                }}
              >
                {moduleEnabled ? "Disable" : "Enable"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  setTargetObjectPhysicsStack((stack) =>
                    removeOptionalInteraction(stack, interactionKind),
                  );
                }}
              >
                Remove
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => model.setSelectedSidebarNodeId(`physobj-${targetObject.name}`)}
          >
            Open Material Panel
          </Button>
        </div>
        {entry.id === "interfacial_dmi" && moduleEntry ? (
          <div className="mt-3 grid grid-cols-1 gap-3 @[980px]:grid-cols-2">
            <TextField
              label="Dind [J/m^2]"
              value={String(Number(moduleParams.dind ?? targetMaterialDind ?? 0))}
              onchange={(event) => {
                const next = parseOptionalNumber(event.target.value);
                if (next == null) return;
                setTargetObjectPhysicsStack((stack) =>
                  upsertObjectInteraction(stack, "interfacial_dmi", {
                    params: {
                      ...(moduleEntry.params ?? {}),
                      dind: next,
                    },
                  }),
                );
              }}
              mono
            />
            <div className="grid grid-cols-3 gap-2">
              {([0, 1, 2] as const).map((component) => (
                <TextField
                  key={component}
                  label={`n${component === 0 ? "x" : component === 1 ? "y" : "z"}`}
                  value={String(axis[component])}
                  onchange={(event) => {
                    const next = parseOptionalNumber(event.target.value);
                    if (next == null) return;
                    const nextAxis: [number, number, number] = [...axis];
                    nextAxis[component] = next;
                    setTargetObjectPhysicsStack((stack) =>
                      upsertObjectInteraction(stack, "interfacial_dmi", {
                        params: {
                          ...(moduleEntry.params ?? {}),
                          axis: nextAxis,
                        },
                      }),
                    );
                  }}
                  mono
                />
              ))}
            </div>
          </div>
        ) : null}
        {entry.id === "uniaxial_anisotropy" && moduleEntry ? (
          <div className="mt-3 grid grid-cols-1 gap-3 @[980px]:grid-cols-2">
            <TextField
              label="Ku1 [J/m^3]"
              value={String(Number(moduleParams.ku1 ?? 0))}
              onchange={(event) => {
                const next = parseOptionalNumber(event.target.value);
                if (next == null) return;
                setTargetObjectPhysicsStack((stack) =>
                  upsertObjectInteraction(stack, "uniaxial_anisotropy", {
                    params: {
                      ...(moduleEntry.params ?? {}),
                      ku1: next,
                    },
                  }),
                );
              }}
              mono
            />
            <div className="grid grid-cols-3 gap-2">
              {([0, 1, 2] as const).map((component) => (
                <TextField
                  key={component}
                  label={`axis ${component === 0 ? "x" : component === 1 ? "y" : "z"}`}
                  value={String(axis[component])}
                  onchange={(event) => {
                    const next = parseOptionalNumber(event.target.value);
                    if (next == null) return;
                    const nextAxis: [number, number, number] = [...axis];
                    nextAxis[component] = next;
                    setTargetObjectPhysicsStack((stack) =>
                      upsertObjectInteraction(stack, "uniaxial_anisotropy", {
                        params: {
                          ...(moduleEntry.params ?? {}),
                          axis: nextAxis,
                        },
                      }),
                    );
                  }}
                  mono
                />
              ))}
            </div>
          </div>
        ) : null}
      </SidebarSection>
    );
  };

  if (context.kind === "solver") {
    return (
      <>
        <SidebarSection title="Solver Defaults" defaultOpen={true}>
          <div className="grid gap-1">
            <InfoRow label="Integrator" value={solverPlan?.integrator ?? model.solverSettings.integrator ?? "—"} />
            <InfoRow label="Fixed dt" value={solverPlan?.fixedTimestep != null ? fmtExp(solverPlan.fixedTimestep) : (model.solverSettings.fixedTimestep || "adaptive")} />
            <InfoRow label="Relax algorithm" value={solverPlan?.relaxation?.algorithm ?? model.solverSettings.relaxAlgorithm ?? "—"} />
            <InfoRow
              label="Gamma"
              value={solverPlan?.gyromagneticRatio != null ? `${fmtExp(solverPlan.gyromagneticRatio)} m/(A·s)` : "—"}
            />
          </div>
        </SidebarSection>

        <SidebarSection title="Integrator" defaultOpen={true}>
          <IntegratorSettingsPanel
            settings={model.solverSettings}
            onChange={model.setSolverSettings}
            solverRunning={cmd.workspaceStatus === "running"}
          />
        </SidebarSection>

        <SidebarSection title="Relaxation" defaultOpen={true}>
          <RelaxationSettingsPanel
            settings={model.solverSettings}
            onChange={model.setSolverSettings}
            solverRunning={cmd.workspaceStatus === "running"}
          />
        </SidebarSection>
      </>
    );
  }

  if (selectedModule) {
    const badge = availabilityBadge(selectedModule);
    return (
      <>
        <SidebarSection title={selectedModule.label} defaultOpen={true}>
          <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
            {selectedModule.description}
          </div>
          <div className="mt-3 grid gap-1">
            <InfoRow label="Availability" value={badge.label} />
            <InfoRow label="Scope" value={selectedModule.scope} />
            <InfoRow label="Runtime tags" value={selectedModule.backendTerms.join(", ")} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {selectedModule.required ? <StatusBadge label="Required" tone="accent" /> : null}
            <StatusBadge label={badge.label} tone={badge.tone} />
          </div>
          {selectedModule.id === "demag" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={context.kind === "module-method" ? "default" : "outline"}
                type="button"
                onClick={() => model.setSelectedSidebarNodeId("physics-module-demag-method")}
              >
                Method
              </Button>
              <Button
                size="sm"
                variant={context.kind === "module-boundary" ? "default" : "outline"}
                type="button"
                onClick={() => model.setSelectedSidebarNodeId("physics-module-demag-boundary")}
              >
                Boundary Conditions
              </Button>
            </div>
          ) : null}
        </SidebarSection>
        {renderObjectInteractionAuthoring(selectedModule)}
        {renderModuleDetails(selectedModule)}
      </>
    );
  }

  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Active Physics Stack" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow
            label="Backend"
            value={solverPlan?.resolvedBackend ?? solverPlan?.backendKind ?? cmd.sessionFooter.requestedBackend ?? "—"}
          />
          <InfoRow label="Solver" value={solverPlan?.integrator ?? model.solverSettings.integrator ?? "—"} />
          <InfoRow label="Demag realization" value={demagRealization} />
          <InfoRow label="Exchange BC" value={solverPlan?.exchangeBoundary ?? "—"} />
          <InfoRow label="External field" value={formatVector(externalField, "T")} />
          <InfoRow
            label="Gamma"
            value={solverPlan?.gyromagneticRatio != null ? `${fmtExp(solverPlan.gyromagneticRatio)} m/(A·s)` : "—"}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" type="button" onClick={() => model.setSelectedSidebarNodeId("physics-solver")}>
            Open Solver
          </Button>
          {capabilityEntries
            .filter((entry) => entry.active)
            .map((entry) => (
              <StatusBadge
                key={entry.id}
                label={entry.label}
                tone="info"
              />
            ))}
        </div>
      </SidebarSection>

      <SidebarSection title="Capability Matrix" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
          Explorer tree for Physics is generated dynamically from backend capabilities and authored model state.
          Modules without first-class editors are displayed as read-only with explicit rationale.
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {capabilityEntries.map((entry) => {
            const badge = availabilityBadge(entry);
            return (
              <button
                key={entry.id}
                type="button"
                className="rounded-lg border border-border/35 bg-background/35 px-3 py-2 text-left transition-colors hover:bg-background/55"
                onClick={() => model.setSelectedSidebarNodeId(`physics-module-${entry.id}`)}
              >
                <div className="flex items-start gap-2">
                  <div>
                    <div className="text-xs font-semibold text-foreground">{entry.label}</div>
                    <div className="mt-1 text-[0.72rem] text-muted-foreground">{entry.description}</div>
                  </div>
                  <div className="ml-auto flex flex-wrap gap-1">
                    {entry.required ? <StatusBadge label="Required" tone="accent" /> : null}
                    <StatusBadge label={badge.label} tone={badge.tone} />
                  </div>
                </div>
                <div className="mt-2 text-[0.72rem] text-muted-foreground">{entry.detail}</div>
                {entry.parameterHints.length > 0 ? (
                  <div className="mt-2 text-[0.68rem] text-muted-foreground">
                    Parameters: {entry.parameterHints.join(" · ")}
                  </div>
                ) : null}
                <div className="mt-2 text-[0.68rem] text-muted-foreground">
                  Runtime tags: <span className="font-mono text-foreground">{entry.backendTerms.join(", ")}</span>
                </div>
              </button>
            );
          })}
        </div>
      </SidebarSection>
    </div>
  );
}
