"use client";

import { useEffect, useMemo, useState } from "react";

import { KernelProvider } from "@/kernel/KernelProvider";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { ExplorerTreeView } from "@/modules/explorer/ExplorerTreeView";
import {
  buildModelTree,
  collectExplorerNodeIds,
} from "@/modules/explorer/builders/buildModelTree";
import { modelTreeSnapshotFromScene } from "@/modules/explorer/builders/sceneModelTreeAdapter";
import { Button } from "@/shared/ui/Button";

type ScenarioId = "zero-and-missing" | "signed-nonzero" | "explicit-overrides";

const scenarioLabels: Record<ScenarioId, string> = {
  "zero-and-missing": "Zero and missing DMI",
  "signed-nonzero": "Positive and negative DMI",
  "explicit-overrides": "Explicit stack and Study overrides",
};

function sceneForScenario(scenario: ScenarioId): SceneResource {
  if (scenario === "zero-and-missing") {
    return {
      materials: [
        {
          id: "zero-dmi-material",
          name: "Zero DMI material",
          properties: { Dbulk: 0, Dind: 0 },
        },
        {
          id: "missing-dmi-material",
          name: "Missing DMI material",
          properties: { Dbulk: null, Dind: null },
        },
      ],
      objects: [
        {
          geometry: { geometry_kind: "Box" },
          id: "zero-dmi-film",
          material_ref: "zero-dmi-material",
          name: "Zero DMI film",
          role: "magnet",
        },
        {
          geometry: { geometry_kind: "Box" },
          id: "missing-dmi-film",
          material_ref: "missing-dmi-material",
          name: "Missing DMI film",
          role: "magnet",
        },
      ],
      study: { demag_enabled: true, exchange_enabled: true },
    } as SceneResource;
  }

  if (scenario === "signed-nonzero") {
    return {
      materials: [
        {
          id: "positive-dmi-material",
          name: "Positive DMI material",
          properties: { Dbulk: 0.5, Dind: 0.25 },
        },
        {
          id: "negative-dmi-material",
          name: "Negative DMI material",
          properties: { Dbulk: "-0.5", Dind: -0.25 },
        },
      ],
      objects: [
        {
          geometry: { geometry_kind: "Box" },
          id: "positive-dmi-film",
          material_ref: "positive-dmi-material",
          name: "Positive DMI film",
          role: "magnet",
        },
        {
          geometry: { geometry_kind: "Box" },
          id: "negative-dmi-film",
          material_ref: "negative-dmi-material",
          name: "Negative DMI film",
          role: "magnet",
        },
      ],
      study: { demag_enabled: true, exchange_enabled: true },
    } as SceneResource;
  }

  const stackWithInteractions = [
    { enabled: true, kind: "exchange" },
    { enabled: true, kind: "demag" },
    { enabled: true, kind: "interfacial_dmi" },
    { enabled: true, kind: "bulk_dmi" },
  ];

  return {
    materials: [
      {
        id: "explicit-nonzero-material",
        name: "Nonzero DMI material",
        properties: { Dbulk: -0.5, Dind: 0.25 },
      },
    ],
    objects: [
      {
        geometry: { geometry_kind: "Box" },
        id: "explicit-stack-film",
        material_ref: "explicit-nonzero-material",
        name: "Explicit stack film",
        physics_stack: [
          { enabled: true, kind: "interfacial_dmi" },
          { enabled: false, kind: " interfacial_dmi " },
          { enabled: false, kind: "bulk_dmi" },
          { enabled: true, kind: " bulk_dmi " },
          { enabled: true, kind: " uniaxial_anisotropy " },
          { enabled: false, kind: "uniaxial_anisotropy" },
          { enabled: true, kind: " exchange " },
          { enabled: true, kind: " demag " },
          { enabled: true, kind: "unknown_future_interaction" },
        ],
        role: "magnet",
      },
      {
        geometry: { geometry_kind: "Box" },
        id: "auxiliary-with-stack",
        material_ref: "explicit-nonzero-material",
        name: "Auxiliary with explicit stack",
        physics_stack: stackWithInteractions,
        role: "auxiliary",
      },
      {
        geometry: { geometry_kind: "Box" },
        id: "antenna-with-stack",
        material_ref: "explicit-nonzero-material",
        name: "Antenna with explicit stack",
        physics_stack: stackWithInteractions,
        role: "antenna",
      },
    ],
    study: { demag_enabled: true, exchange_enabled: false },
  } as SceneResource;
}

function ExplorerPhysicsReportingView() {
  const kernel = useKernel();
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  const [scenario, setScenario] = useState<ScenarioId>("zero-and-missing");
  const scene = useMemo(() => sceneForScenario(scenario), [scenario]);
  const snapshot = useMemo(() => modelTreeSnapshotFromScene(scene), [scene]);
  const nodes = useMemo(() => buildModelTree(snapshot), [snapshot]);
  const expandedIds = useMemo(
    () => new Set(collectExplorerNodeIds(nodes)),
    [nodes],
  );

  return (
    <main className="grid h-dvh min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-4 text-fm-primary">
      <header>
        <h1 className="text-lg font-semibold">Explorer physics reporting</h1>
        <p className="text-sm text-fm-secondary">
          Production scene adapter, model tree, and Explorer tree with controlled scene data.
        </p>
      </header>

      <section aria-label="Physics reporting scenarios" className="grid gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Scenario">
          {(Object.keys(scenarioLabels) as ScenarioId[]).map((id) => (
            <Button
              key={id}
              disabled={!interactive}
              aria-pressed={scenario === id}
              onClick={() => setScenario(id)}
              size="sm"
              variant={scenario === id ? "primary" : "secondary"}
            >
              {scenarioLabels[id]}
            </Button>
          ))}
        </div>
        <p data-testid="explorer-physics-reporting-scenario" data-scenario-id={scenario}>
          {scenarioLabels[scenario]}
        </p>
      </section>

      <section aria-label="Explorer" className="fm-explorer min-h-0 overflow-hidden rounded-lg border border-fm-border">
        <div className="border-b border-fm-border px-3 py-2 text-sm font-medium">
          Model tree
        </div>
        <ExplorerTreeView
          activeNodeId={null}
          expandedIds={expandedIds}
          keyboardRowId={null}
          kernel={kernel}
          moduleId="explorer"
          nodes={nodes}
          sceneResourceData={scene}
          tabId="model"
        />
      </section>
    </main>
  );
}

export default function ExplorerPhysicsReportingPage() {
  return (
    <KernelProvider>
      <ExplorerPhysicsReportingView />
    </KernelProvider>
  );
}
