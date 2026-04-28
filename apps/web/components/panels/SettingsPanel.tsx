"use client";

import { useMemo } from "react";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { useViewport, useCommand, useModel } from "../runs/control-room/context-hooks";
import { Button } from "../ui/button";
import MeshSettingsPanel from "./MeshSettingsPanel";
import MeshStatisticsPanel from "./settings/MeshStatisticsPanel";
import { SidebarSection, InfoRow } from "./settings/primitives";
import { humanizeToken, readBuilderContract } from "./settings/helpers";
import GeometryPanel from "./settings/GeometryPanel";
import AntennaPanel from "./settings/AntennaPanel";
import MaterialPanel from "./settings/MaterialPanel";
import MagneticTexturePanel from "./settings/MagneticTexturePanel";
import MeshPanel from "./settings/MeshPanel";
import ObjectMeshPanel from "./settings/ObjectMeshPanel";
import PhysicsPanel from "./settings/PhysicsPanel";
import RuntimePanel from "./settings/RuntimePanel";
import RegionPanel from "./settings/RegionPanel";
import StudyPanel from "./settings/StudyPanel";
import UniversePanel from "./settings/UniversePanel";
import PreviewControlsPanel from "./settings/PreviewControlsPanel";
import ResultsPanel from "./settings/ResultsPanel";
import SolverTelemetryPanel from "./settings/SolverTelemetryPanel";
import EnergyPanel from "./settings/EnergyPanel";
import StateIoPanel from "./settings/StateIoPanel";
import VisualizationPresetPanel from "./settings/VisualizationPresetPanel";
import InspectorRegistryHost from "./InspectorRegistryHost";
// Legacy imports removed — routing is now handled by inspectorRegistry
// import { parseStudyNodeContext } from "@/lib/study-builder/node-context";
// import { isVisualizationTreeNode } from "../runs/control-room/visualizationPresets";
import {
  PanelKey,
} from "@/features/model-builder/registry/inspectorRegistry";

/* ── Main SettingsPanel ── */
interface SettingsPanelProps {
  nodeId: string;
}

function SessionInfoPanel() {
  const cmd = useCommand();

  return (
    <SidebarSection
      title="Session"
      icon="🔗"
      badge={cmd.sessionFooter.requestedBackend ?? null}
      defaultOpen={true}
    >
      <div className="grid gap-1">
        <InfoRow label="Backend" value={cmd.sessionFooter.requestedBackend ?? "—"} />
        <InfoRow label="Runtime" value={cmd.runtimeEngineLabel ?? "—"} />
        {cmd.sessionFooter.scriptPath && (
          <InfoRow label="Script" value={cmd.sessionFooter.scriptPath.split("/").pop() ?? "—"} />
        )}
      </div>
    </SidebarSection>
  );
}

function ScriptBuilderInfoPanel() {
  const cmd = useCommand();
  const builderContract = useMemo(() => readBuilderContract(cmd.metadata), [cmd.metadata]);
  const canSyncScriptBuilder =
    Boolean(builderContract?.rewriteStrategy === "canonical_rewrite" && cmd.sessionFooter.scriptPath);

  if (!builderContract) {
    return (
      <SidebarSection title="Script Builder" icon="📝" defaultOpen={true}>
        <div className="rounded-lg border border-border/30 bg-card/30 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
          Script builder metadata is not available for this workspace yet.
        </div>
      </SidebarSection>
    );
  }

  return (
    <SidebarSection
      title="Script Builder"
      icon="📝"
      badge={builderContract.sourceKind ? humanizeToken(builderContract.sourceKind) : null}
      defaultOpen={true}
    >
      <div className="grid gap-1">
        <InfoRow label="Entrypoint" value={builderContract.entrypointKind ?? "—"} />
        <InfoRow
          label="API surface"
          value={builderContract.scriptApiSurface ? humanizeToken(builderContract.scriptApiSurface) : "—"}
        />
        <InfoRow label="Sync strategy" value={builderContract.rewriteStrategy ?? "—"} />
        <InfoRow label="Phase" value={builderContract.phase ? humanizeToken(builderContract.phase) : "—"} />
        <div className="grid gap-1 pt-1">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            Editable scopes
          </span>
          <div className="flex flex-wrap gap-1.5">
            {builderContract.editableScopes.length > 0 ? builderContract.editableScopes.map((scope) => (
              <span
                key={scope}
                className="text-[0.6rem] font-bold uppercase tracking-widest border border-border/50 bg-muted/30 text-muted-foreground px-1.5 py-0.5 rounded-md inline-flex shadow-sm w-fit"
              >
                {humanizeToken(scope)}
              </span>
            )) : (
              <span className="font-mono text-xs text-muted-foreground">—</span>
            )}
          </div>
        </div>
        <div className="grid gap-2 pt-2">
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={!canSyncScriptBuilder || cmd.scriptSyncBusy}
            onClick={() => { void cmd.syncScriptBuilder(); }}
          >
            {cmd.scriptSyncBusy ? "Syncing Script…" : "Sync UI To Script"}
          </Button>
          <div className="text-[0.68rem] leading-relaxed text-muted-foreground">
            Rewrites the source `.py` file in canonical Fullmag form using the current builder contract plus solver and mesh settings from this control room.
          </div>
          {cmd.scriptSyncMessage && (
            <div className="text-[0.68rem] leading-relaxed text-muted-foreground p-2 rounded-md bg-muted/30 border border-border/40">
              {cmd.scriptSyncMessage}
            </div>
          )}
        </div>
      </div>
    </SidebarSection>
  );
}

export default function SettingsPanel({ nodeId }: SettingsPanelProps) {
  const viewport = useViewport();
  const cmd = useCommand();
  const model = useModel();
  const femDiscretization = resolveFemDiscretization(cmd.domainCapabilities, false);
  // studyNodeContext removed — routing now via inspectorRegistry
  const showSolverTelemetrySection = false;
  const showEnergySection = false;
  const selectedObjectNodeId = model.selectedObjectId ? `geo-${model.selectedObjectId}` : undefined;
  const selectedObjectMeshNodeId = model.selectedObjectId ? `geo-${model.selectedObjectId}-mesh` : undefined;
  const airboxSelected =
    nodeId === "universe-airbox" || nodeId === "universe-airbox-mesh";
  const selectedObjectPartId =
    model.selectedObjectId
      ? model.meshParts.find(
          (part) =>
            part.role === "magnetic_object" && part.object_id === model.selectedObjectId,
        )?.id ?? null
      : null;

  const showFullFemContext = () => {
    viewport.handleViewModeChange("3D");
    model.setObjectViewMode("context");
    model.setMeshEntityViewState((prev) => {
      const next = { ...prev };
      for (const part of model.meshParts) {
        const current = next[part.id];
        if (!current) continue;
        next[part.id] = { ...current, visible: true };
      }
      return next;
    });
  };

  const isolateSelectedObject = () => {
    if (!model.selectedObjectId) return;
    viewport.handleViewModeChange("3D");
    model.setObjectViewMode("isolate");
    model.setMeshEntityViewState((prev) => {
      const next = { ...prev };
      for (const part of model.meshParts) {
        const current = next[part.id];
        if (!current) continue;
        next[part.id] = {
          ...current,
          visible:
            part.role === "magnetic_object" && part.object_id === model.selectedObjectId,
        };
      }
      return next;
    });
    model.setSelectedEntityId(selectedObjectPartId);
    model.setFocusedEntityId(selectedObjectPartId);
  };

  const isolateAirbox = () => {
    const airPartId = model.airPart?.id ?? null;
    viewport.handleViewModeChange("3D");
    model.setObjectViewMode("isolate");
    model.setSelectedEntityId(airPartId);
    model.setFocusedEntityId(airPartId);
    model.setMeshEntityViewState((prev) => {
      const next = { ...prev };
      for (const part of model.meshParts) {
        const current = next[part.id];
        if (!current) continue;
        next[part.id] = { ...current, visible: part.role === "air" };
      }
      return next;
    });
  };

  const renderNodeContent = () => {
    // Shared mesh‐settings props (reused by composite panels)
    const meshSettingsProps = {
      options: model.meshOptions,
      onChange: model.setMeshOptions,
      quality: model.meshQualityData,
      nodeCount: model.effectiveFemMesh?.nodes.length,
      disabled: model.meshGenerating || !(cmd.awaitingCommand || cmd.isWaitingForCompute),
      waitMode: cmd.isWaitingForCompute,
    };

    return (
      <InspectorRegistryHost
        nodeId={nodeId}
        selectedObjectId={model.selectedObjectId}
        selectedObjectNodeId={selectedObjectNodeId}
        selectedObjectMeshNodeId={selectedObjectMeshNodeId}
      >
        {({ descriptor, panelProps }) => {
          const renderPrimary = () => {
            switch (descriptor.panelKey) {
              case PanelKey.SESSION:         return <SessionInfoPanel />;
              case PanelKey.SCRIPT_BUILDER:  return <ScriptBuilderInfoPanel />;
              case PanelKey.RUNTIME:         return <RuntimePanel nodeId={panelProps.nodeId as string | undefined} />;
              case PanelKey.VIS_PRESET:      return <VisualizationPresetPanel nodeId={panelProps.nodeId as string} />;
              case PanelKey.STUDY:           return <StudyPanel nodeId={panelProps.nodeId as string} />;
              case PanelKey.UNIVERSE:        return <UniversePanel />;
              case PanelKey.ANTENNA:         return <AntennaPanel nodeId={panelProps.nodeId as string} />;
              case PanelKey.PHYSICS:         return <PhysicsPanel nodeId={panelProps.nodeId as string | undefined} />;
              case PanelKey.RESULTS:         return <ResultsPanel />;
              case PanelKey.PREVIEW_CONTROLS: return <PreviewControlsPanel />;
              case PanelKey.ENERGY:          return <EnergyPanel />;
              case PanelKey.STATE_IO:        return <StateIoPanel />;
              case PanelKey.MATERIAL:        return <MaterialPanel nodeId={panelProps.nodeId as string} />;
              case PanelKey.MATERIAL_MAG:    return <MagneticTexturePanel nodeId={panelProps.nodeId as string} />;
              case PanelKey.OBJECT_MESH:     return <ObjectMeshPanel nodeId={panelProps.nodeId as string} />;
              case PanelKey.REGION:          return <RegionPanel nodeId={panelProps.nodeId as string} />;
              case PanelKey.MESH:            return <MeshPanel />;
              case PanelKey.MESH_STATISTICS: return <MeshStatisticsPanel />;
              case PanelKey.MESH_INFO:       return null;
              case PanelKey.OBJ_GEO_MESH:
                return (
                  <>
                    <GeometryPanel nodeId={panelProps.nodeId as string} />
                    <ObjectMeshPanel nodeId={panelProps.meshNodeId as string | undefined} />
                  </>
                );
              case PanelKey.GEOMETRY:
              default:
                return <GeometryPanel nodeId={panelProps.nodeId as string | undefined} />;
            }
          };

          const hasComposite = descriptor.compositeKeys?.includes(PanelKey.MESH_SETTINGS);

          return (
            <>
              {descriptor.infoBanner && (
                <SidebarSection title="Object Mesh Defaults" defaultOpen={true}>
                  <div className="rounded-lg border border-border/35 bg-background/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
                    {descriptor.infoBanner}
                  </div>
                </SidebarSection>
              )}
              {renderPrimary()}
              {hasComposite && <MeshSettingsPanel {...meshSettingsProps} />}
            </>
          );
        }}
      </InspectorRegistryHost>
    );
  };

  return (
    <div className="flex flex-col gap-1 pb-6">
      {/* ── Object Actions (only when an object is selected) ── */}
      {model.selectedObjectId ? (
        <section className="rounded-xl border border-border/40 bg-gradient-to-b from-card/50 to-card/20 px-4 py-3 shadow-[0_2px_12px_rgba(0,0,0,0.15)] backdrop-blur-xl mb-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground/70">
                Inspecting
              </div>
              <div className="truncate font-mono text-sm font-semibold text-foreground mt-0.5">
                {model.selectedObjectId}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => {
                  viewport.handleViewModeChange("3D");
                  model.requestFocusObject(model.selectedObjectId!);
                }}
              >
                Focus 3D
              </Button>
              {femDiscretization ? (
                <>
                  <Button
                    size="sm"
                    variant={model.objectViewMode === "context" ? "default" : "outline"}
                    type="button"
                    onClick={showFullFemContext}
                  >
                    Context
                  </Button>
                  <Button
                    size="sm"
                    variant={model.objectViewMode === "isolate" ? "default" : "outline"}
                    type="button"
                    onClick={isolateSelectedObject}
                  >
                    Isolate
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </section>
      ) : airboxSelected && femDiscretization ? (
        <section className="rounded-xl border border-border/40 bg-gradient-to-b from-card/50 to-card/20 px-4 py-3 shadow-[0_2px_12px_rgba(0,0,0,0.15)] backdrop-blur-xl mb-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground/70">
                Inspecting
              </div>
              <div className="truncate font-mono text-sm font-semibold text-foreground mt-0.5">
                Airbox
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="sm"
                variant={model.objectViewMode === "context" ? "default" : "outline"}
                type="button"
                onClick={showFullFemContext}
              >
                Context
              </Button>
              <Button
                size="sm"
                variant={model.objectViewMode === "isolate" ? "default" : "outline"}
                type="button"
                onClick={isolateAirbox}
              >
                Isolate
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Node-specific content (each sub-panel manages its own SidebarSections) ── */}
      {renderNodeContent()}

      {/* ── Global sections ── */}
      {showSolverTelemetrySection && (
        <SidebarSection title="Solver Telemetry" icon="📊" badge={cmd.workspaceStatus}>
          <SolverTelemetryPanel />
        </SidebarSection>
      )}

      {showEnergySection && (
        <SidebarSection title="Energy" icon="⚡">
          <EnergyPanel />
        </SidebarSection>
      )}
    </div>
  );
}
