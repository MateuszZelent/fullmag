"use client";

import { useCallback, useMemo } from "react";
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

  return (
    <div className={s.sidebar} style={{ display: "flex", flexDirection: "column" }}>
      {/* ── Model Tree (compact, fixed height) ── */}
      <div style={{ flex: "0 0 auto", maxHeight: "40%", overflow: "auto", borderBottom: "1px solid var(--ide-border)" }}>
        <ModelTree nodes={modelTreeNodes} activeId={activeNodeId} onNodeClick={handleTreeClick} />
      </div>

      {/* ── Settings Panel (scrollable, fills remaining space) ── */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <SettingsPanel nodeId={activeNodeId} nodeLabel={activeNode?.label ?? null} />
      </div>
    </div>
  );
}
