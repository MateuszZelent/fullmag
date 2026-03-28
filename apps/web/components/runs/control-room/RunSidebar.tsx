"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
  usePanelRef,
  type PanelSize,
} from "react-resizable-panels";
import ModelTree, { buildFullmagModelTree } from "../../panels/ModelTree";
import SettingsPanel from "../../panels/SettingsPanel";
import { useControlRoom } from "./ControlRoomContext";
import { findTreeNodeById, previewQuantityForTreeNode } from "./shared";
import s from "../RunControlRoom.module.css";

/**
 * RunSidebar — two-zone panel: narrow ModelTree + wider SettingsPanel.
 * All data consumed via useControlRoom() — zero prop drilling.
 */
export default function RunSidebar() {
  const ctx = useControlRoom();
  const navigatorPanelRef = usePanelRef();
  const inspectorPanelRef = usePanelRef();
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  /* ── Build model tree nodes ── */
  const modelTreeNodes = useMemo(
    () =>
      buildFullmagModelTree({
        backend: ctx.isFemBackend ? "FEM" : "FDM",
        geometryKind: ctx.mesherSourceKind ?? undefined,
        materialName:
          ctx.material?.name
            ?? (ctx.material?.msat != null ? `Msat=${(ctx.material.msat / 1e3).toFixed(0)} kA/m` : undefined),
        materialMsat: ctx.material?.msat,
        materialAex: ctx.material?.aex,
        materialAlpha: ctx.material?.alpha,
        meshStatus: ctx.effectiveFemMesh ? "ready" : "pending",
        meshElements: ctx.effectiveFemMesh?.elements.length,
        meshNodes: ctx.effectiveFemMesh?.nodes.length,
        meshFeOrder: ctx.meshFeOrder,
        meshName: ctx.meshName,
        solverStatus: ctx.hasSolverTelemetry ? "active" : "pending",
        solverIntegrator: ctx.solverPlan?.integrator ?? ctx.solverSettings.integrator,
        solverRelaxAlgorithm: ctx.solverPlan?.relaxation?.algorithm ?? ctx.solverSettings.relaxAlgorithm,
        demagMethod: "transfer-grid",
        exchangeEnabled: ctx.material?.exchangeEnabled,
        demagEnabled: ctx.material?.demagEnabled,
        zeemanField: ctx.material?.zeemanField,
        convergenceStatus:
          ctx.hasSolverTelemetry && ctx.effectiveDmDt > 0 && ctx.effectiveDmDt < 1e-5
            ? "ready"
            : ctx.hasSolverTelemetry
              ? "active"
              : undefined,
        scalarRowCount: ctx.scalarRows.length,
      }),
    [
      ctx.effectiveFemMesh, ctx.hasSolverTelemetry, ctx.isFemBackend, ctx.material,
      ctx.mesherSourceKind, ctx.meshFeOrder, ctx.meshName,
      ctx.solverPlan?.integrator, ctx.solverPlan?.relaxation?.algorithm,
      ctx.solverSettings.integrator, ctx.solverSettings.relaxAlgorithm,
      ctx.effectiveDmDt, ctx.scalarRows.length,
    ],
  );

  /* ── Determine active node (from explicit selection or viewport context) ── */
  const fallbackNodeId = useMemo(() => {
    const isMeshView = ctx.isFemBackend && ctx.effectiveViewMode === "Mesh";
    if (isMeshView) {
      if (ctx.femDockTab === "quality") return "mesh-quality";
      if (ctx.femDockTab === "mesher") return "mesh-size";
      return "mesh";
    }
    if (ctx.previewControlsActive) return "res-fields";
    if (ctx.interactiveControlsEnabled) return "study-solver";
    if (ctx.material) return "materials";
    return "geometry";
  }, [ctx.effectiveViewMode, ctx.femDockTab, ctx.interactiveControlsEnabled,
      ctx.isFemBackend, ctx.material, ctx.previewControlsActive]);

  const activeNodeId = ctx.selectedSidebarNodeId ?? fallbackNodeId;
  const activeNode = useMemo(
    () => findTreeNodeById(modelTreeNodes, activeNodeId),
    [activeNodeId, modelTreeNodes],
  );

  /* ── Tree click handler ── */
  const handleTreeClick = useCallback((id: string) => {
    ctx.setSelectedSidebarNodeId(id);
    switch (id) {
      case "geometry": case "geo-body": case "regions": case "reg-domain": case "reg-boundary":
        if (ctx.isFemBackend) ctx.openFemMeshWorkspace("mesh");
        else ctx.setViewMode("3D");
        return;
      case "mesh":
        if (ctx.isFemBackend) ctx.openFemMeshWorkspace("mesh");
        return;
      case "mesh-size": case "mesh-algorithm":
        if (ctx.isFemBackend) {
          ctx.setViewMode("Mesh");
          ctx.setFemDockTab("mesher");
          ctx.setMeshRenderMode((c) => (c === "surface" ? "surface+edges" : c));
        }
        return;
      case "mesh-quality":
        if (ctx.isFemBackend) ctx.openFemMeshWorkspace("quality");
        return;
      case "results": case "res-fields":
        if (ctx.isFemBackend && ctx.effectiveViewMode === "Mesh") ctx.setViewMode("3D");
        return;
      default: {
        const previewTarget = previewQuantityForTreeNode(id);
        if (previewTarget && ctx.quickPreviewTargets.some((t) => t.id === previewTarget && t.available)) {
          ctx.requestPreviewQuantity(previewTarget);
        }
      }
    }
  }, [ctx]);

  const handleNavigatorToggle = useCallback(() => {
    const panel = navigatorPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setNavigatorOpen(true);
      return;
    }
    panel.collapse();
    setNavigatorOpen(false);
  }, [navigatorPanelRef]);

  const handleInspectorToggle = useCallback(() => {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setInspectorOpen(true);
      return;
    }
    panel.collapse();
    setInspectorOpen(false);
  }, [inspectorPanelRef]);

  const handleNavigatorResize = useCallback((panelSize: PanelSize) => {
    setNavigatorOpen(panelSize.inPixels > 68);
  }, []);

  const handleInspectorResize = useCallback((panelSize: PanelSize) => {
    setInspectorOpen(panelSize.inPixels > 68);
  }, []);

  return (
    <div className={s.sidebar}>
      <PanelGroup
        orientation="vertical"
        className={s.sidebarStack}
        resizeTargetMinimumSize={{ coarse: 32, fine: 10 }}
      >
        <Panel
          id="sidebar-model-outline"
          defaultSize="34%"
          minSize="92px"
          collapsible
          collapsedSize="44px"
          panelRef={navigatorPanelRef}
          onResize={handleNavigatorResize}
        >
          <section className={s.sidebarPanelSection}>
            <button
              type="button"
              className={s.sectionHeaderButton}
              onClick={handleNavigatorToggle}
              aria-expanded={navigatorOpen}
            >
              <span className={s.sectionChevron} data-open={navigatorOpen}>▸</span>
              <span className={s.sectionTitle}>Model</span>
              <span className={s.sectionBadge}>{ctx.isFemBackend ? "FEM" : "FDM"}</span>
            </button>
            {navigatorOpen && (
              <div className={s.sidebarPanelBody}>
                <ModelTree nodes={modelTreeNodes} activeId={activeNodeId} onNodeClick={handleTreeClick} />
              </div>
            )}
          </section>
        </Panel>

        <PanelResizeHandle className={s.sidebarSectionResizeHandle} />

        <Panel
          id="sidebar-inspector"
          defaultSize="66%"
          minSize="140px"
          collapsible
          collapsedSize="44px"
          panelRef={inspectorPanelRef}
          onResize={handleInspectorResize}
        >
          <section className={s.sidebarPanelSection}>
            <button
              type="button"
              className={s.sectionHeaderButton}
              onClick={handleInspectorToggle}
              aria-expanded={inspectorOpen}
            >
              <span className={s.sectionChevron} data-open={inspectorOpen}>▸</span>
              <span className={s.sectionTitle}>Inspector</span>
              <span className={s.sectionBadge}>{activeNode?.label ?? "Workspace"}</span>
            </button>
            {inspectorOpen && (
              <div className={s.sidebarPanelBody}>
                <SettingsPanel nodeId={activeNodeId} nodeLabel={activeNode?.label ?? null} />
              </div>
            )}
          </section>
        </Panel>
      </PanelGroup>
    </div>
  );
}
