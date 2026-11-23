"use client";

import {
  Activity,
  ArrowRight,
  Link2,
  Plus,
  Sliders,
  Waves,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
} from "@/kernel/api/apiPaths";
import type { JsonObject } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import { publishCommittedSceneResource, useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorSpec } from "../../template";
import {
  buildRootSelection,
  InspectorShortcutCards,
  SpecInspectorHost,
} from "../../panels/model-roots/SpecInspectorHost";
import { extractFieldDriveItems, buildModelScopeMutationContext } from "./modelScopeShared";

/* ── 5. GlobalPhysicsScopeInspectorPanel (`physics.scope.global`) ── */

interface GlobalTermRow {
  id: string;
  moduleKind: string;
  label: string;
  subtitle: string;
  enabled: boolean;
}

interface GlobalPhysicsDraft {
  terms: readonly GlobalTermRow[];
  activeCount: number;
  fieldDriveCount: number;
  couplingCount: number;
}

export function GlobalPhysicsScopeInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const fieldDrives = useFieldDrivesResource();

  const studyRec = (scene.data?.study ?? null) as Record<string, unknown> | null;
  const graphModules = useMemo(() => {
    const g = (physicsGraph.data ?? null) as Record<string, unknown> | null;
    return Array.isArray(g?.modules) ? (g.modules as Record<string, unknown>[]) : [];
  }, [physicsGraph.data]);

  const terms = useMemo<readonly GlobalTermRow[]>(() => {
    const findMod = (kind: string) =>
      graphModules.find((m) => m.kind === kind || m.id === kind);
    const isModActive = (kind: string, fallback: boolean) => {
      const mod = findMod(kind);
      if (mod && typeof mod.activation === "string") {
        return mod.activation === "active";
      }
      return fallback;
    };

    const demagEnabled =
      typeof studyRec?.demag_enabled === "boolean"
        ? studyRec.demag_enabled
        : isModActive("demag", true);
    const zeemanEnabled =
      Array.isArray(studyRec?.external_field) || isModActive("zeeman", false);
    const pbcRec =
      studyRec?.pbc && typeof studyRec.pbc === "object"
        ? (studyRec.pbc as Record<string, unknown>)
        : null;
    const pbcEnabled =
      Boolean(pbcRec) ||
      Boolean(studyRec?.periodic_boundary_conditions) ||
      isModActive("periodic_bc", false);
    const thermalRec =
      studyRec?.thermal_noise && typeof studyRec.thermal_noise === "object"
        ? (studyRec.thermal_noise as Record<string, unknown>)
        : null;
    const thermalEnabled =
      (thermalRec !== null &&
        typeof thermalRec.temperature === "number" &&
        thermalRec.temperature > 0) ||
      (typeof studyRec?.temperature_k === "number" && studyRec.temperature_k > 0) ||
      isModActive("thermal_noise", false);
    const rotatedDmiVal = studyRec?.rotated_interfacial_dmi;
    const rotatedDmiEnabled =
      (typeof rotatedDmiVal === "number" && Number.isFinite(rotatedDmiVal)) ||
      (typeof rotatedDmiVal === "string" &&
        rotatedDmiVal.trim() !== "" &&
        Number.isFinite(Number(rotatedDmiVal))) ||
      isModActive("rotated_interfacial_dmi", false);

    return [
      {
        id: findMod("demag")?.id ? String(findMod("demag")!.id) : "demag",
        moduleKind: "demag",
        label: "Demagnetization (stray field)",
        subtitle: "Long-range magnetostatic dipole-dipole field",
        enabled: demagEnabled,
      },
      {
        id: findMod("zeeman")?.id ? String(findMod("zeeman")!.id) : "zeeman",
        moduleKind: "zeeman",
        label: "External magnetic field (Zeeman)",
        subtitle: "Uniform static bias field B_ext across the domain",
        enabled: zeemanEnabled,
      },
      {
        id: findMod("periodic_bc")?.id ? String(findMod("periodic_bc")!.id) : "periodic_bc",
        moduleKind: "periodic_bc",
        label: "Periodic boundary conditions",
        subtitle: "1D, 2D, or 3D translational periodicity",
        enabled: pbcEnabled,
      },
      {
        id: findMod("thermal_noise")?.id ? String(findMod("thermal_noise")!.id) : "thermal_noise",
        moduleKind: "thermal_noise",
        label: "Thermal fluctuations (Brown)",
        subtitle: "Stochastic Langevin field at finite temperature T",
        enabled: thermalEnabled,
      },
      {
        id: findMod("rotated_interfacial_dmi")?.id
          ? String(findMod("rotated_interfacial_dmi")!.id)
          : "rotated_interfacial_dmi",
        moduleKind: "rotated_interfacial_dmi",
        label: "Rotated interfacial DMI",
        subtitle: "Global symmetry-broken chiral exchange frame",
        enabled: rotatedDmiEnabled,
      },
    ];
  }, [graphModules, studyRec]);

  const fieldDriveCount = extractFieldDriveItems(fieldDrives.data).length;
  const couplingCount = scene.data?.couplings?.length ?? 0;

  const baseline = useMemo<GlobalPhysicsDraft>(
    () => ({
      terms,
      activeCount: terms.filter((t) => t.enabled).length,
      fieldDriveCount,
      couplingCount,
    }),
    [couplingCount, fieldDriveCount, terms],
  );

  const handleToggleTerm = useCallback(
    async (moduleKind: string, nextEnabled: boolean) => {
      const patch: JsonObject = {};
      if (moduleKind === "demag") {
        patch.demag_enabled = nextEnabled;
      } else if (moduleKind === "thermal_noise") {
        const existingThermal =
          studyRec?.thermal_noise && typeof studyRec.thermal_noise === "object"
            ? (studyRec.thermal_noise as Record<string, unknown>)
            : null;
        const prevTemp =
          typeof existingThermal?.temperature === "number" && existingThermal.temperature > 0
            ? existingThermal.temperature
            : 300;
        const prevSeed =
          typeof existingThermal?.seed === "string" && existingThermal.seed.trim()
            ? existingThermal.seed.trim()
            : undefined;
        patch.thermal_noise = nextEnabled
          ? {
              temperature: prevTemp,
              ...(prevSeed ? { seed: prevSeed } : {}),
            }
          : null;
      } else if (moduleKind === "zeeman") {
        patch.external_field = nextEnabled
          ? Array.isArray(studyRec?.external_field) && studyRec.external_field.length === 3
            ? (studyRec.external_field as number[])
            : [0, 0, 0.01]
          : null;
      } else if (moduleKind === "periodic_bc") {
        patch.pbc = nextEnabled
          ? {
              axes: ["periodic", "open", "open"],
              demag: "macro_geometry",
            }
          : null;
      } else if (moduleKind === "rotated_interfacial_dmi") {
        const existingDmi = studyRec?.rotated_interfacial_dmi;
        const defaultDmi =
          typeof existingDmi === "number" && Number.isFinite(existingDmi)
            ? existingDmi
            : 0.003;
        patch.rotated_interfacial_dmi = nextEnabled ? defaultDmi : null;
      }
      const { context } = buildModelScopeMutationContext(
        kernel,
        scene.data,
        scene.sessionScopeKey,
      );
      const reqOptions = scene.sessionScopeKey
        ? { sessionScopeKey: scene.sessionScopeKey }
        : undefined;
      const tx = await runAuthoringMutationWithHistory(
        context,
        `${nextEnabled ? "Enable" : "Disable"} ${moduleKind}`,
        async ({ baseRevision: capturedRev }) => {
          const payload = {
            kind: "merge_patch" as const,
            base_revision: capturedRev ?? scene.data?.revision ?? 0,
            merge_patch: { study: patch },
          };
          return reqOptions
            ? kernel.api.model.commitTransaction(payload, reqOptions)
            : kernel.api.model.commitTransaction(payload);
        },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, tx.scene_revision);
      kernel.resources.invalidate(MODEL_SCENE_PATH, tx.scene_revision);
      kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, tx.scene_revision);
    },
    [kernel, scene.data, scene.sessionScopeKey, studyRec],
  );

  const spec = useMemo<InspectorSpec<GlobalPhysicsDraft>>(
    () => ({
      id: "physics.scope.global",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "global-physics", label: "Global Physics" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: () => "Global Physics",
        kindLabel: "Global Hamiltonian scope",
        entityId: "model:physics:global",
        statePill: (draft) => ({
          tone: draft.activeCount > 0 ? "ok" : "neutral",
          label: `${draft.activeCount} active`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "active", label: "Active terms", value: String(draft.activeCount) },
        { id: "drives", label: "Field drives", value: String(draft.fieldDriveCount) },
        { id: "couplings", label: "Couplings", value: String(draft.couplingCount) },
      ],
      sections: [
        {
          id: "global-physics-matrix",
          title: "Global interaction switches",
          icon: Sliders,
          defaultOpen: true,
          summary: (d) => `${d.activeCount} of ${d.terms.length} enabled`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="global-physics-switches">
                  {ctx.draft.terms.map((term) => {
                    const nodeId = `model:physics:global:module:${encodeURIComponent(term.id)}`;
                    return (
                      <div
                        key={term.moduleKind}
                        className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--fm-text)]">
                            {term.label}
                          </div>
                          <div className="truncate text-xs text-[var(--fm-text-muted)]">
                            {term.subtitle}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Switch
                            aria-label={`Toggle ${term.label}`}
                            checked={term.enabled}
                            onCheckedChange={(checked) => {
                              void handleToggleTerm(term.moduleKind, checked);
                            }}
                          />
                          <Button
                            aria-label={`Configure ${term.label}`}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.selectNode({
                                kind: "physics.module",
                                label: term.label,
                                nodeId,
                                objectId: null,
                                ref: {
                                  kind: "physics.module",
                                  nodeId,
                                  physicsActivation: term.enabled ? "active" : "inactive",
                                  physicsModuleId: term.id,
                                  physicsModuleKind: term.moduleKind,
                                  physicsScopeKind: "global",
                                  type: "physics-module",
                                },
                              })
                            }
                          >
                            <ArrowRight aria-hidden="true" size={12} />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ),
            },
          ],
        },
        {
          id: "global-physics-collections",
          title: "Excitations & inter-object couplings",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards
                  items={[
                    {
                      id: "field-drives",
                      title: "Field Drives",
                      subtitle: "Time-dependent RF pulses, harmonics & spatial masks",
                      badge: `${ctx.draft.fieldDriveCount}`,
                      selection: buildRootSelection(
                        "physics.field-drives",
                        "model:physics:field-drives",
                        "Field Drives",
                      ),
                    },
                    {
                      id: "couplings",
                      title: "Couplings",
                      subtitle: "RKKY, interlayer exchange & surface exchange",
                      badge: `${ctx.draft.couplingCount}`,
                      selection: buildRootSelection(
                        "physics.couplings",
                        "model:physics:couplings",
                        "Couplings",
                      ),
                    },
                  ]}
                  onSelect={ctx.selectNode}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () =>
          "Switches commit immediately; select a child module to edit its field parameters",
      },
    }),
    [handleToggleTerm],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 6. CrossObjectPhysicsScopeInspectorPanel (`physics.scope.cross-object`) ── */

interface CrossObjectLinkRow {
  id: string;
  label: string;
  kindLabel: string;
  endpointsLabel: string;
  selection: Omit<Selection, "moduleSource">;
}

interface CrossObjectDraft {
  links: readonly CrossObjectLinkRow[];
}

export function CrossObjectPhysicsScopeInspectorPanel({ selection }: InspectorPanelProps) {
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();

  const links = useMemo<readonly CrossObjectLinkRow[]>(() => {
    const items: CrossObjectLinkRow[] = [];
    for (const cpl of scene.data?.couplings ?? []) {
      const rec = cpl as Record<string, unknown>;
      const id = String(rec.id ?? "");
      const kind = String(rec.kind ?? "rkky");
      const epA = (rec.endpoint_a ?? rec.side_a ?? null) as Record<string, unknown> | null;
      const epB = (rec.endpoint_b ?? rec.side_b ?? null) as Record<string, unknown> | null;
      const aLabel = String(epA?.object_id ?? epA?.region_id ?? "Side A");
      const bLabel = String(epB?.object_id ?? epB?.region_id ?? "Side B");
      const nodeId = `model:physics:couplings:${id}`;
      items.push({
        id: `cpl:${id}`,
        label: String(rec.name ?? id),
        kindLabel: kind.toUpperCase(),
        endpointsLabel: `${aLabel} \u2194 ${bLabel}`,
        selection: {
          kind: "physics.coupling",
          label: String(rec.name ?? id),
          nodeId,
          objectId: null,
          ref: {
            couplingId: id,
            kind: "physics.coupling",
            nodeId,
            type: "physics-coupling",
          },
        },
      });
    }

    const g = (physicsGraph.data ?? null) as Record<string, unknown> | null;
    const mods = Array.isArray(g?.modules) ? (g.modules as Record<string, unknown>[]) : [];
    for (const mod of mods) {
      if (mod.kind !== "spin_interface") continue;
      const id = String(mod.id ?? "interface");
      const scopes = Array.isArray(mod.applies_to)
        ? (mod.applies_to as Record<string, unknown>[])
        : [];
      const first = scopes[0];
      const sideA = (first?.side_a ?? null) as Record<string, unknown> | null;
      const sideB = (first?.side_b ?? null) as Record<string, unknown> | null;
      const endpointsLabel =
        sideA || sideB
          ? `${String(sideA?.object_id ?? "HM")} \u2194 ${String(sideB?.object_id ?? "FM")}`
          : "HM \u2194 FM";
      const nodeId = `model:physics:cross-object:module:${encodeURIComponent(id)}`;
      items.push({
        id: `si:${id}`,
        label: String(mod.label ?? mod.name ?? id),
        kindLabel: "HM/FM Interface",
        endpointsLabel,
        selection: {
          kind: "physics.spin-interface",
          label: String(mod.label ?? id),
          nodeId,
          objectId: null,
          ref: {
            kind: "physics.spin-interface",
            nodeId,
            spinInterfaceId: id,
            type: "spin-interface",
          },
        },
      });
    }
    return items;
  }, [physicsGraph.data, scene.data?.couplings]);

  const baseline = useMemo<CrossObjectDraft>(() => ({ links }), [links]);

  const spec = useMemo<InspectorSpec<CrossObjectDraft>>(
    () => ({
      id: "physics.scope.cross-object",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "cross-object", label: "Cross-object Interfaces" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Link2,
        title: () => "Cross-object Interfaces",
        kindLabel: "Inter-object physics scope",
        entityId: "model:physics:cross-object",
        statePill: (draft) => ({
          tone: draft.links.length > 0 ? "ok" : "neutral",
          label: `${draft.links.length} links`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "links", label: "Active links", value: String(draft.links.length) },
      ],
      sections: [
        {
          id: "cross-object-actions",
          title: "Create interface interaction",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode(
                        buildRootSelection(
                          "physics.couplings",
                          "model:physics:couplings",
                          "Couplings",
                        ),
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Surface Coupling</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode({
                        kind: "physics.spin-interface",
                        label: "New HM/FM interface",
                        nodeId: "model:physics:spin-interface:draft",
                        objectId: null,
                        ref: {
                          draft: true,
                          kind: "physics.spin-interface",
                          nodeId: "model:physics:spin-interface:draft",
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
          id: "cross-object-links",
          title: "Authored cross-object links",
          icon: Link2,
          defaultOpen: true,
          emptyState: (d) =>
            d.links.length === 0
              ? {
                  icon: Link2,
                  title: "No cross-object links configured",
                  description:
                    "Add an RKKY / interlayer exchange surface coupling or an HM/FM spin-mixing interface.",
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.links.length > 0,
              rowKey: (rawRow) => (rawRow as CrossObjectLinkRow).id,
              rows: (d) => d.links,
              onSelectRow: (rawRow, ctx) =>
                ctx.selectNode((rawRow as CrossObjectLinkRow).selection),
              columns: [
                {
                  id: "label",
                  header: "Interface",
                  renderCell: (rawRow) => (
                    <span className="font-medium text-[var(--fm-text)]">
                      {(rawRow as CrossObjectLinkRow).label}
                    </span>
                  ),
                },
                {
                  id: "kind",
                  header: "Kind",
                  renderCell: (rawRow) => (rawRow as CrossObjectLinkRow).kindLabel,
                },
                {
                  id: "endpoints",
                  header: "Endpoints",
                  mono: true,
                  renderCell: (rawRow) => (rawRow as CrossObjectLinkRow).endpointsLabel,
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Select a link to edit its coupling constants or mixing conductance",
      },
    }),
    [],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
