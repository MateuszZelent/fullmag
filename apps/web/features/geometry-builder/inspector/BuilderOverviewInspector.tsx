"use client";

/**
 * P3 — Geometry Builder Overview Inspector
 *
 * Shown when no primitive is selected in the builder.
 * Displays canonical scene quick-create buttons, builder status, build actions, and
 * keyboard shortcuts.
 */

import {
  Box,
  Circle,
  Cylinder,
  Disc,
  Triangle,
  Keyboard,
  Info,
  Layers,
  Grid3x3,
  AlertTriangle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import type { PrimitiveKind } from "../model/types";
import { useCommand, useModel } from "@/components/runs/control-room/context-hooks";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import {
  createScenePrimitiveAuthoringUpdate,
  resolveScenePresetForPrimitiveKind,
} from "../scene/scenePrimitiveAuthoring";
import { useSceneAuthoringActions } from "@/src/hooks/resources/useSceneDocument";
import type { GeometryCapabilitiesResource, GeometryValidationResource } from "@/src/api/types";

const QUICK_CREATE: Array<{
  kind: PrimitiveKind;
  label: string;
  icon: React.ReactNode;
  color: string;
}> = [
  { kind: "box", label: "Box", icon: <Box size={18} />, color: "text-emerald-400" },
  { kind: "cylinder", label: "Cylinder", icon: <Cylinder size={18} />, color: "text-cyan-400" },
  { kind: "sphere", label: "Sphere", icon: <Circle size={18} />, color: "text-violet-400" },
  { kind: "disk", label: "Disk", icon: <Disc size={18} />, color: "text-sky-400" },
  { kind: "triangular_prism", label: "Triangle", icon: <Triangle size={18} />, color: "text-amber-400" },
];

const SHORTCUTS = [
  { key: "Q", action: "Camera mode" },
  { key: "W", action: "Move tool" },
  { key: "E", action: "Rotate tool" },
  { key: "R", action: "Scale tool" },
  { key: "F", action: "Focus selected" },
  { key: "Shift+F", action: "Frame all" },
  { key: "G", action: "Toggle snap" },
  { key: "Del", action: "Delete selected" },
  { key: "Ctrl+D", action: "Duplicate" },
  { key: "Esc", action: "Cancel manipulation" },
  { key: "Ctrl+Z", action: "Undo" },
  { key: "Ctrl+Shift+Z", action: "Redo" },
];

export default function BuilderOverviewInspector() {
  const command = useCommand();
  const model = useModel();
  const sceneAuthoring = useSceneAuthoringActions();
  const graphNodes = useGeometryBuilderStore((s) => s.graph.nodes);
  const draftPrimitiveCount = useMemo(
    () => graphNodes.filter((node) => node.kind === "primitive").length,
    [graphNodes],
  );
  const sceneObjectCount = model.sceneDocument?.objects.length ?? 0;
  const dirty = useGeometryBuilderStore((s) => s.dirty);
  const isRunBlocked = useGeometryBuilderStore((s) => s.isRunBlocked());
  const runBlockedReason = useGeometryBuilderStore((s) => s.getRunBlockedReason());
  const geometryBuildBlockedReason = useGeometryBuilderStore((s) =>
    s.getGeometryBuildBlockedReason(),
  );
  const getBackendBuildBlockedReason = useGeometryBuilderStore((s) =>
    s.getBackendBuildBlockedReason,
  );
  const femDiscretization = resolveFemDiscretization(
    command.domainCapabilities,
    command.isFemBackend,
  );
  const backendBuildBlockedReason = getBackendBuildBlockedReason(femDiscretization);
  const buildTargetLabel = femDiscretization ? "FEM Mesh" : "FDM Grid";
  const meshGenerating = model.meshGenerating;
  const [backendValidation, setBackendValidation] =
    useState<GeometryValidationResource | null>(null);
  const [backendCapabilities, setBackendCapabilities] =
    useState<GeometryCapabilitiesResource | null>(null);
  const [sceneCommitError, setSceneCommitError] = useState<string | null>(null);

  const canCreateScenePrimitive = Boolean(model.sceneDocument);

  useEffect(() => {
    let cancelled = false;
    if (!model.sceneDocument) {
      setBackendValidation(null);
      setBackendCapabilities(null);
      return;
    }
    void sceneAuthoring.getGeometryCapabilities()
      .then((capabilities) => {
        if (!cancelled) {
          setBackendCapabilities(capabilities);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("failed to load backend geometry capabilities", error);
          setBackendCapabilities(null);
        }
      });
    void sceneAuthoring.getGeometryValidation()
      .then((validation) => {
        if (!cancelled) {
          setBackendValidation(validation);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("failed to load backend geometry validation", error);
          setBackendValidation(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [model.sceneDocument?.revision, sceneAuthoring]);

  const handleCreatePrimitive = useCallback((kind: PrimitiveKind) => {
    const scene = model.sceneDocument;
    if (!scene) {
      return;
    }
    const referenceOverlay =
      model.selectedObjectId
        ? model.objectOverlays.find((overlay) => overlay.id === model.selectedObjectId) ?? null
        : null;
    let update: ReturnType<typeof createScenePrimitiveAuthoringUpdate>;
    try {
      update = createScenePrimitiveAuthoringUpdate({
        scene,
        kind,
        placementOverlay: referenceOverlay ?? model.objectOverlays[0] ?? null,
      });
    } catch (error) {
      setSceneCommitError(
        error instanceof Error ? error.message : "Scene object creation is not available",
      );
      return;
    }
    model.setSceneDocument(update.scene);
    setSceneCommitError(null);
    model.setSelectedSidebarNodeId(`geo-${update.selectedObjectId}`);
    model.setSelectedObjectId(update.selectedObjectId);
    model.setSelectedEntityId(null);
    model.setFocusedEntityId(null);
    model.requestFocusObject(update.selectedObjectId);
    void sceneAuthoring
      .createObject(update.createObjectRequest)
      .then(() => sceneAuthoring.updateSceneMergePatch(update.postCreateMergePatch))
      .then((committedScene) => {
        model.setSceneDocument(committedScene);
      })
      .catch((error) => {
        console.error("failed to commit inspector primitive transaction", error);
        void sceneAuthoring
          .updateSceneMergePatch(update.mergePatch)
          .then((committedScene) => {
            model.setSceneDocument(committedScene);
          })
          .catch((fallbackError) => {
            console.error("failed to fallback commit inspector primitive merge patch", fallbackError);
            model.setSceneDocument(scene);
            setSceneCommitError(
              fallbackError instanceof Error
                ? fallbackError.message
                : "Scene object commit failed",
            );
          });
      });
  }, [model, sceneAuthoring]);

  const primitiveCapabilities = useMemo(() => {
    const entries = new Map<string, GeometryCapabilitiesResource["primitive_capabilities"][number]>();
    for (const capability of backendCapabilities?.primitive_capabilities ?? []) {
      entries.set(capability.id, capability);
    }
    return entries;
  }, [backendCapabilities]);

  const getCreateState = useCallback((kind: PrimitiveKind) => {
    if (!canCreateScenePrimitive) {
      return {
        enabled: false,
        status: "unsupported" as const,
        title: "Scene document is not loaded",
        badge: "Unavailable",
      };
    }
    const presetResolution = resolveScenePresetForPrimitiveKind(kind);
    const backendCapability = primitiveCapabilities.get(kind);
    const isProduction =
      presetResolution.status === "production" &&
      Boolean(presetResolution.presetKind) &&
      (backendCapability == null || backendCapability.status === "production");
    if (!isProduction) {
      return {
        enabled: false,
        status: presetResolution.status,
        title:
          presetResolution.message ??
          backendCapability?.label ??
          `${kind} is not available as a production SceneDocument primitive`,
        badge: presetResolution.status === "preview" ? "Preview" : "Unsupported",
      };
    }
    return {
      enabled: true,
      status: "production" as const,
      title: `Create ${backendCapability?.label ?? kind} in the backend scene document`,
      badge: "Production",
    };
  }, [canCreateScenePrimitive, primitiveCapabilities]);

  const sceneGeometryReady = sceneObjectCount > 0 && Boolean(model.sceneDocument);
  const canBuildMesh =
    sceneGeometryReady &&
    Boolean(femDiscretization) &&
    !backendBuildBlockedReason &&
    !meshGenerating;

  const handleBuildMesh = useCallback(() => {
    if (backendBuildBlockedReason) {
      return;
    }
    if (femDiscretization) {
      void model.handleStudyDomainMeshGenerate("geometry_scene_build_mesh");
    }
  }, [backendBuildBlockedReason, femDiscretization, model]);

  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      {/* ── Quick Create ─────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1">
          Create Primitive
        </h3>
        <div className="grid grid-cols-2 gap-1.5">
          {QUICK_CREATE.map(({ kind, label, icon, color }) => {
            const createState = getCreateState(kind);
            return (
              <button
                key={kind}
                type="button"
                disabled={!createState.enabled}
                className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-muted/50 hover:bg-muted border border-border/50 hover:border-border transition-colors disabled:pointer-events-none disabled:opacity-40"
                onClick={() => handleCreatePrimitive(kind)}
                title={createState.title}
              >
                <span className={color}>{icon}</span>
                <span className="text-xs text-foreground">{label}</span>
                {!createState.enabled && (
                  <span className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground">
                    {createState.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Build Actions ─────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1">
          Build
        </h3>
        <div className="space-y-1.5">
          <div className="flex w-full items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400">
            <Layers size={13} />
            SceneDocument
            <span className="ml-auto text-[9px] font-normal text-emerald-400/70">
              canonical
            </span>
          </div>

          <button
            type="button"
            disabled={!canBuildMesh}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/30"
            onClick={handleBuildMesh}
          >
            <Grid3x3 size={13} />
            {meshGenerating ? "Queueing Mesh Build…" : `Build ${buildTargetLabel}`}
            {sceneGeometryReady && femDiscretization && (
              <span className="ml-auto text-[9px] font-normal text-cyan-400/70">● out of date</span>
            )}
          </button>
        </div>

        {/* Build status messages */}
        {!sceneGeometryReady && (
          <p className="text-[10px] text-muted-foreground">
            Create a scene object before building a solver mesh.
          </p>
        )}
        {sceneGeometryReady && !femDiscretization && (
          <p className="text-[10px] text-muted-foreground">
            FDM uses the canonical domain/grid path; Geometry mesh build is available for FEM.
          </p>
        )}
        {geometryBuildBlockedReason && (
          <div className="flex items-start gap-1.5 text-[10px] text-red-400">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{geometryBuildBlockedReason}</span>
          </div>
        )}
        {backendBuildBlockedReason && (
          <div className="flex items-start gap-1.5 text-[10px] text-red-400">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{backendBuildBlockedReason}</span>
          </div>
        )}
        {sceneCommitError && (
          <div className="flex items-start gap-1.5 text-[10px] text-red-400">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{sceneCommitError}</span>
          </div>
        )}
      </div>

      {/* ── Status ───────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1">
          Builder Status
        </h3>
        <div className="text-xs text-muted-foreground space-y-1.5">
          <div className="flex items-center justify-between">
            <span>Scene objects</span>
            <span className="font-mono">{sceneObjectCount}</span>
          </div>
          {draftPrimitiveCount > 0 && (
            <div className="flex items-center justify-between">
              <span>Draft primitives</span>
              <span className="font-mono">{draftPrimitiveCount}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span>Geometry</span>
            <span className={dirty.geometryDraftDirty ? "text-amber-400" : "text-emerald-400"}>
              {dirty.geometryDraftDirty ? "⚠ modified" : "✓ clean"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Mesh</span>
            <span className={dirty.meshDirty ? "text-amber-400" : "text-emerald-400"}>
              {dirty.meshDirty ? "⚠ out of date" : "✓ current"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Solver</span>
            <span className={isRunBlocked ? "text-red-400" : "text-emerald-400"}>
              {isRunBlocked ? "✗ blocked" : "✓ ready"}
            </span>
          </div>
          {runBlockedReason && (
            <div className="flex items-start gap-1.5 text-[10px] text-amber-400 mt-1">
              <Info size={12} className="shrink-0 mt-0.5" />
              <span>{runBlockedReason}</span>
            </div>
          )}
          {backendValidation && (
            <div className="flex items-center justify-between">
              <span>Backend realization</span>
              <span className={
                backendValidation.status === "blocked"
                  ? "text-red-400"
                  : backendValidation.status === "warning"
                    ? "text-amber-400"
                    : "text-emerald-400"
              }>
                {backendValidation.status}
              </span>
            </div>
          )}
          {backendValidation?.diagnostics.slice(0, 4).map((diagnostic) => (
            <div
              key={diagnostic.id}
              className={
                diagnostic.severity === "error"
                  ? "flex items-start gap-1.5 text-[10px] text-red-400"
                  : "flex items-start gap-1.5 text-[10px] text-amber-400"
              }
            >
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>{diagnostic.message}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Shortcuts ────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1 flex items-center gap-1.5">
          <Keyboard size={12} />
          Shortcuts
        </h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
          {SHORTCUTS.map(({ key, action }) => (
            <div key={key} className="flex items-center gap-2">
              <kbd className="inline-flex items-center px-1.5 py-0.5 rounded bg-muted font-mono text-[9px] text-muted-foreground border border-border/50">
                {key}
              </kbd>
              <span className="text-muted-foreground">{action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
