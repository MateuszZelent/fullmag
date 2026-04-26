"use client";

import { useCallback, useMemo } from "react";

import EngineConsole from "@/components/panels/EngineConsole";
import SettingsPanel from "@/components/panels/SettingsPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import type { RightInspectorTab } from "@/lib/workspace/workspace-store";
import {
  defaultMeshEntityViewState,
  type FemMeshPart,
  type MeshEntityViewState,
} from "@/lib/session/types";
import { CORE_UI_CAPABILITIES } from "@/lib/workspace/capability-contract";
import { summarizeCapabilityCoverage } from "@/lib/workspace/capability-audit";
import {
  useCommand,
  useModel,
  useTransport,
} from "../../runs/control-room/context-hooks";
import { DEFAULT_CONVERGENCE_THRESHOLD } from "../../panels/SolverSettingsPanel";
import { FemPartExplorerPanel } from "../../preview/fem/FemPartExplorerPanel";
import type { PartQualitySummary } from "../../preview/fem/FemPartExplorerPanel";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import GeometryInspectorRouter from "@/features/geometry-builder/inspector/GeometryInspectorRouter";

const ROLE_GROUPS: Array<{ role: FemMeshPart["role"]; label: string }> = [
  { role: "magnetic_object", label: "Magnetic" },
  { role: "interface", label: "Interfaces" },
  { role: "outer_boundary", label: "Boundary" },
  { role: "air", label: "Air" },
];

function WorkspaceRightToolbox() {
  const transport = useTransport();
  const command = useCommand();
  const model = useModel();
  const rightInspectorTab = useWorkspaceStore((state) => state.rightInspectorTab);
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);
  const capabilitySummary = useMemo(() => summarizeCapabilityCoverage(), []);
  const selectedNodeId = model.selectedSidebarNodeId ?? "study-root";

  const snapshot = model.visibleSubmeshSnapshot;
  const meshParts = model.meshParts;
  const meshEntityViewState = model.meshEntityViewState;

  const meshPartById = useMemo(
    () => new Map(meshParts.map((part) => [part.id, part])),
    [meshParts],
  );

  const visiblePartsOrdered = useMemo(
    () =>
      (snapshot?.items ?? [])
        .map((item) => meshPartById.get(item.id))
        .filter((part): part is FemMeshPart => Boolean(part)),
    [meshPartById, snapshot?.items],
  );

  const partQualityById = useMemo(() => {
    const quality = new Map<string, PartQualitySummary>();
    for (const item of snapshot?.items ?? []) {
      quality.set(item.id, {
        markers: item.markers,
        domainCount: item.domainCount,
        stats: item.qualityStats,
      });
    }
    return quality;
  }, [snapshot?.items]);

  const partExplorerGroups = useMemo(
    () =>
      ROLE_GROUPS.map((group) => ({
        label: group.label,
        parts: visiblePartsOrdered.filter((part) => part.role === group.role),
      })).filter((group) => group.parts.length > 0),
    [visiblePartsOrdered],
  );

  const roleVisibilitySummary = useMemo(
    () =>
      ROLE_GROUPS.map((group) => {
        const parts = meshParts.filter((part) => part.role === group.role);
        const visible = parts.filter(
          (part) =>
            meshEntityViewState[part.id]?.visible ?? defaultMeshEntityViewState(part).visible,
        ).length;
        return {
          role: group.role,
          label: group.label,
          total: parts.length,
          visible,
        };
      }).filter((entry) => entry.total > 0),
    [meshEntityViewState, meshParts],
  );

  const inspectedMeshPart = useMemo(() => {
    const selected = snapshot?.items.find((item) => item.isSelected);
    if (!selected) {
      return null;
    }
    return meshPartById.get(selected.id) ?? null;
  }, [meshPartById, snapshot?.items]);

  const inspectedPartQuality = useMemo(
    () => (inspectedMeshPart ? partQualityById.get(inspectedMeshPart.id) ?? null : null),
    [inspectedMeshPart, partQualityById],
  );

  const patchMeshPartViewState = useCallback(
    (partIds: string[], patch: Partial<MeshEntityViewState>) => {
      if (partIds.length === 0) {
        return;
      }
      model.setMeshEntityViewState((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const partId of partIds) {
          const part = meshPartById.get(partId);
          const current = next[partId] ?? (part ? defaultMeshEntityViewState(part) : null);
          if (!current) {
            continue;
          }
          const updated = { ...current, ...patch };
          if (
            !next[partId] ||
            updated.visible !== current.visible ||
            updated.renderMode !== current.renderMode ||
            updated.opacity !== current.opacity ||
            updated.colorField !== current.colorField
          ) {
            next[partId] = updated;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [meshPartById, model],
  );

  const handlePartSelect = useCallback(
    (partId: string) => {
      model.setSelectedEntityId(partId);
      model.setFocusedEntityId(partId);
    },
    [model],
  );

  const handleRoleVisibility = useCallback(
    (role: FemMeshPart["role"], visible: boolean) => {
      const ids = meshParts
        .filter((part) => part.role === role)
        .map((part) => part.id);
      patchMeshPartViewState(ids, { visible });
    },
    [meshParts, patchMeshPartViewState],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden border-l border-border/30 bg-card/20">
      <Tabs
        className="flex h-full min-h-0 flex-col"
        value={rightInspectorTab}
        onValueChange={(value) => setRightInspectorTab(value as RightInspectorTab)}
      >
        <div className="border-b border-border/10 px-4 py-2">
          <TabsList className="flex w-full justify-start gap-5">
            <TabsTrigger value="properties" className="text-[0.7rem] normal-case px-0">
              Properties
            </TabsTrigger>
            <TabsTrigger value="selected-submeshes" className="text-[0.7rem] normal-case px-0">
              Submeshes
            </TabsTrigger>
            <TabsTrigger value="tools" className="text-[0.7rem] normal-case px-0">
              Tools
            </TabsTrigger>
            <TabsTrigger value="console" className="text-[0.7rem] normal-case px-0">
              Console
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="properties" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="p-1">
              <SettingsPanel nodeId={selectedNodeId} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="selected-submeshes" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden px-0 py-0">
          {snapshot && snapshot.items.length > 0 ? (
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-2">
              <FemPartExplorerPanel
                className="max-h-none max-w-none rounded-xl"
                meshParts={meshParts}
                meshEntityViewState={meshEntityViewState}
                partQualityById={partQualityById}
                partExplorerGroups={partExplorerGroups}
                roleVisibilitySummary={roleVisibilitySummary}
                inspectedMeshPart={inspectedMeshPart}
                inspectedPartQuality={inspectedPartQuality}
                selectedEntityId={model.selectedEntityId}
                focusedEntityId={model.focusedEntityId}
                visiblePartsCount={snapshot.visiblePartsCount}
                onClose={() => setRightInspectorTab("properties")}
                onPartSelect={handlePartSelect}
                onEntityFocus={model.setFocusedEntityId}
                onPatchPart={(partId, patch) => patchMeshPartViewState([partId], patch)}
                onRoleVisibility={handleRoleVisibility}
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center">
              <div className="rounded-xl border border-border/25 bg-background/35 px-4 py-3 text-[0.75rem] text-muted-foreground">
                No active submesh snapshot.
                <br />
                Open FEM 3D/Mesh viewport to populate this list.
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="tools" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-3">
            <div className="space-y-3">
              <div className="rounded-xl border border-border/30 bg-background/35 p-3">
                <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Capability Coverage
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[0.72rem]">
                  <div className="rounded-md border border-border/30 bg-background/40 px-2.5 py-1.5">
                    <div className="text-[0.6rem] uppercase tracking-widest text-muted-foreground">Total</div>
                    <div className="font-mono text-foreground">{capabilitySummary.total}</div>
                  </div>
                  <div className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5">
                    <div className="text-[0.6rem] uppercase tracking-widest text-emerald-300/80">Implemented</div>
                    <div className="font-mono text-emerald-300">{capabilitySummary.implemented}</div>
                  </div>
                  <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5">
                    <div className="text-[0.6rem] uppercase tracking-widest text-amber-300/80">Partial</div>
                    <div className="font-mono text-amber-300">{capabilitySummary.partial}</div>
                  </div>
                  <div className="rounded-md border border-rose-500/25 bg-rose-500/10 px-2.5 py-1.5">
                    <div className="text-[0.6rem] uppercase tracking-widest text-rose-300/80">Missing</div>
                    <div className="font-mono text-rose-300">{capabilitySummary.missing}</div>
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  {CORE_UI_CAPABILITIES.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-md border border-border/25 bg-background/30 px-2.5 py-1.5 text-[0.7rem]"
                    >
                      <span className="font-medium text-foreground">{item.id}</span>
                      <span className="ml-1.5 text-muted-foreground">[{item.status}]</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="console" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <EngineConsole
            session={command.session ?? null}
            run={command.run ?? null}
            liveState={transport.effectiveLiveState ?? null}
            scalarRows={transport.scalarRows}
            engineLog={command.engineLog}
            artifacts={command.artifacts}
            quantities={command.quantities}
            connection={command.connection}
            error={command.error}
            presentationMode="current"
            convergenceThreshold={Number(model.solverSettings.torqueTolerance) || DEFAULT_CONVERGENCE_THRESHOLD}
            commandStatus={command.commandStatus}
            commandBusy={command.commandBusy}
            commandMessage={command.commandMessage}
            activity={command.activity}
            meshWorkspace={model.meshWorkspace}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function BuildRightInspector() {
  const builderActive = useGeometryBuilderStore((s) => s.builderMode.enabled);
  if (builderActive) return <GeometryInspectorRouter />;
  return <WorkspaceRightToolbox />;
}

export function StudyRightInspector() {
  return <WorkspaceRightToolbox />;
}

export function AnalyzeRightInspector() {
  return <WorkspaceRightToolbox />;
}
