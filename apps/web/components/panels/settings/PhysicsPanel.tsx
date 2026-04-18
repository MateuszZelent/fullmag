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
} from "../../../lib/session/magneticPhysics";
import type { ScriptBuilderMagneticInteractionEntry } from "../../../lib/session/types";
import { asRecord } from "../../runs/control-room/helpers";

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

  const externalField =
    model.sceneDocument?.study.external_field
    ?? model.modelBuilderGraph?.study.external_field
    ?? solverPlan?.externalField
    ?? null;

  const aggregatePhysicsStack = useMemo(() => {
    const sceneObjects = model.sceneDocument?.objects ?? [];
    const sceneMaterials = model.sceneDocument?.materials ?? [];
    const entries: ScriptBuilderMagneticInteractionEntry[] = [];
    for (const object of sceneObjects) {
      const materialDind =
        sceneMaterials.find((entry) => entry.id === object.material_ref)?.properties.Dind
        ?? null;
      entries.push(...ensureObjectPhysicsStack(object.physics_stack, materialDind));
    }
    return normalizePhysicsStack(entries);
  }, [model.sceneDocument]);

  const metadata = cmd.metadata ?? null;
  const capabilityEntries = useMemo(() => {
    const base = buildPhysicsCapabilityView(cmd.capabilities, aggregatePhysicsStack);
    return base.map((entry) => {
      let active = entry.active;
      if (entry.id === "zeeman") {
        active = hasNonZeroVector(externalField);
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
      } else if (entry.id === "exchange") {
        active = solverPlan?.exchangeEnabled ?? active;
      }
      return { ...entry, active };
    });
  }, [aggregatePhysicsStack, cmd.capabilities, externalField, metadata, solverPlan?.demagEnabled, solverPlan?.exchangeEnabled]);

  const capabilityById = useMemo(
    () => new Map(capabilityEntries.map((entry) => [entry.id, entry] as const)),
    [capabilityEntries],
  );

  const selectedModule =
    context.kind === "module" || context.kind === "module-method" || context.kind === "module-boundary"
      ? capabilityById.get(context.moduleId) ?? null
      : null;

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

  const renderModuleDetails = (entry: PhysicsCapabilityViewEntry) => {
    if (entry.id === "demag" && context.kind === "module-method") {
      return (
        <SidebarSection title="Demagnetization Method" defaultOpen={true}>
          <div className="grid gap-1">
            <InfoRow
              label="Family"
              value={solverPlan?.demagSolver?.family ?? (cmd.isFemBackend && solverPlan?.demagEnabled ? "hypre" : "—")}
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
              options={[
                { value: "auto", label: "Auto" },
                { value: "poisson_dirichlet", label: "Dirichlet" },
                { value: "poisson_robin", label: "Robin" },
              ]}
            />
            <div className="grid gap-1">
              <InfoRow
                label="Status"
                value={demagRealization === "auto" ? "Planner-managed" : "Explicit authoring"}
              />
              <InfoRow label="Effective" value={outerBoundaryLabel(demagRealization)} />
            </div>
            <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
              `Dirichlet` and `Robin` keep the solve on the shared-domain FEM path. This stays in the canonical
              `study.demag_realization` contract.
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
