/**
 * useMeshCommandPipeline – extracted from ControlRoomContext.tsx
 *
 * Command infrastructure and mesh operation callbacks:
 *  appendFrontendTrace, enqueueCommand, buildMeshOptionsPayload,
 *  enqueueStudyDomainRemesh, updatePreview,
 *  handleStudyDomainMeshGenerate, handleAirboxMeshGenerate,
 *  handleObjectMeshOverrideRebuild, handleLassoRefine.
 */
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { MeshOptionsState, SizeFieldSpec } from "../../../panels/MeshSettingsPanel";
import type { DisplaySelection, MeshCommandTarget, SceneDocument } from "../../../../lib/session/types";
import type { FemMeshData } from "../../../preview/FemMeshView3D";
import { parseOptionalFiniteNumberText } from "../controlRoomUtils";
import type { currentLiveApiClient } from "../../../../lib/liveApiClient";
import type { useBuilderAutoSync } from "./useBuilderAutoSync";

type LiveApiClient = ReturnType<typeof currentLiveApiClient>;
type BuilderAutoSync = ReturnType<typeof useBuilderAutoSync>;

export interface UseMeshCommandPipelineParams {
  liveApi: LiveApiClient;
  meshPerGeometryPayload: Record<string, unknown>[];
  requestedDisplaySelection: DisplaySelection;
  kindForQuantity: (quantity: string) => string;
  meshOptions: MeshOptionsState;
  setMeshOptions: Dispatch<SetStateAction<MeshOptionsState>>;
  meshHmax: number | null;
  session: { script_path?: string | null } | null;
  localBuilderDraft: SceneDocument | null;
  localBuilderSignature: string;
  builderAutoSync: BuilderAutoSync;
  femMeshDataRef: MutableRefObject<FemMeshData | null>;
  femTopologyKeyRef: MutableRefObject<string | null>;
  pendingMeshConfigSignatureRef: MutableRefObject<string | null>;
  meshConfigSignatureRef: MutableRefObject<string | null>;
  // state setters
  setCommandPostInFlight: Dispatch<SetStateAction<boolean>>;
  setCommandErrorMessage: Dispatch<SetStateAction<string | null>>;
  setFrontendTraceLog: Dispatch<SetStateAction<Array<{ timestamp_unix_ms: number; level: string; message: string }>>>;
  setPreviewPostInFlight: Dispatch<SetStateAction<boolean>>;
  setPreviewMessage: Dispatch<SetStateAction<string | null>>;
  setOptimisticDisplaySelection: Dispatch<SetStateAction<DisplaySelection | null>>;
  setMeshGenerating: Dispatch<SetStateAction<boolean>>;
  setScriptSyncBusy: Dispatch<SetStateAction<boolean>>;
  setScriptSyncMessage: Dispatch<SetStateAction<string | null>>;
}

export interface UseMeshCommandPipelineReturn {
  appendFrontendTrace: (level: string, message: string) => void;
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>;
  buildMeshOptionsPayload: (options: MeshOptionsState, refinementZonesOverride?: MeshOptionsState["refinementZones"]) => Record<string, unknown>;
  enqueueStudyDomainRemesh: (meshReason: string, meshOptionsPayload: Record<string, unknown>, meshTarget?: MeshCommandTarget) => Promise<void>;
  updatePreview: (path: string, payload?: Record<string, unknown>) => Promise<void>;
  meshGenTopologyRef: MutableRefObject<string | null>;
  meshGenGenerationRef: MutableRefObject<string | null>;
  femGenerationIdRef: MutableRefObject<string | null>;
  handleStudyDomainMeshGenerate: (meshReason?: string) => Promise<void>;
  handleAirboxMeshGenerate: () => Promise<void>;
  handleObjectMeshOverrideRebuild: (objectId?: string | null) => Promise<void>;
  handleLassoRefine: (faceIndices: number[], factor: number) => Promise<void>;
}

export function useMeshCommandPipeline({
  liveApi,
  meshPerGeometryPayload,
  requestedDisplaySelection,
  kindForQuantity,
  meshOptions,
  setMeshOptions,
  meshHmax,
  session,
  localBuilderDraft,
  localBuilderSignature,
  builderAutoSync,
  femMeshDataRef,
  femTopologyKeyRef,
  pendingMeshConfigSignatureRef,
  meshConfigSignatureRef,
  setCommandPostInFlight,
  setCommandErrorMessage,
  setFrontendTraceLog,
  setPreviewPostInFlight,
  setPreviewMessage,
  setOptimisticDisplaySelection,
  setMeshGenerating,
  setScriptSyncBusy,
  setScriptSyncMessage,
}: UseMeshCommandPipelineParams): UseMeshCommandPipelineReturn {

  const appendFrontendTrace = useCallback((level: string, message: string) => {
    if (level === "error") {
      console.error(`[control-room] ${message}`);
    } else if (level === "warn") {
      console.warn(`[control-room] ${message}`);
    } else {
      console.info(`[control-room] ${message}`);
    }
    setFrontendTraceLog((prev) => {
      const next = [
        ...prev,
        {
          timestamp_unix_ms: Date.now(),
          level,
          message,
        },
      ];
      return next.length > 120 ? next.slice(next.length - 120) : next;
    });
  }, []);

  const enqueueCommand = useCallback(async (payload: Record<string, unknown>) => {
    setCommandPostInFlight(true);
    setCommandErrorMessage(null);
    const commandKind =
      typeof payload.kind === "string" ? payload.kind.toUpperCase() : "COMMAND";
    appendFrontendTrace("info", `TX: ${commandKind} ${JSON.stringify(payload)}`);
    try {
      await liveApi.queueCommand(payload);
      appendFrontendTrace("system", `RX: HTTP accepted ${commandKind}`);
    } catch (e) {
      appendFrontendTrace(
        "error",
        `RX: HTTP rejected ${commandKind} — ${e instanceof Error ? e.message : "Failed to queue command"}`,
      );
      setCommandErrorMessage(e instanceof Error ? e.message : "Failed to queue command");
    } finally {
      setCommandPostInFlight(false);
    }
  }, [appendFrontendTrace, liveApi]);

  const buildMeshOptionsPayload = useCallback(
    (
      options: MeshOptionsState,
      refinementZonesOverride?: MeshOptionsState["refinementZones"],
    ) => ({
      algorithm_2d: options.algorithm2d,
      algorithm_3d: options.algorithm3d,
      size_mode: options.sizeControlMode === "custom" ? "custom" : "predefined",
      hmax: parseOptionalFiniteNumberText(options.maximumElementSize || options.hmax),
      hmin: parseOptionalFiniteNumberText(options.minimumElementSize || options.hmin),
      maximum_element_size: parseOptionalFiniteNumberText(options.maximumElementSize || options.hmax),
      minimum_element_size: parseOptionalFiniteNumberText(options.minimumElementSize || options.hmin),
      calibrate_for: options.calibrateFor,
      size_preset: options.sizePreset,
      size_factor: options.sizeFactor,
      size_from_curvature: options.sizeFromCurvature,
      curvature_factor: parseOptionalFiniteNumberText(options.curvatureFactor || ""),
      growth_rate: parseOptionalFiniteNumberText(options.maximumElementGrowthRate || options.growthRate),
      maximum_element_growth_rate: parseOptionalFiniteNumberText(
        options.maximumElementGrowthRate || options.growthRate,
      ),
      narrow_regions: options.narrowRegions,
      narrow_region_resolution: parseOptionalFiniteNumberText(options.narrowRegionResolution || ""),
      smoothing_steps: options.smoothingSteps,
      optimize: options.optimize || null,
      optimize_iterations: options.optimizeIters,
      compute_quality: options.computeQuality,
      per_element_quality: options.perElementQuality,
      interface_hmax: parseOptionalFiniteNumberText(options.interfaceHMax),
      interface_thickness: parseOptionalFiniteNumberText(options.interfaceThickness),
      transition_distance: parseOptionalFiniteNumberText(options.transitionDistance),
      transition_growth: parseOptionalFiniteNumberText(options.transitionGrowth),
      adaptive_enabled: options.adaptiveEnabled,
      adaptive_policy: options.adaptivePolicy,
      adaptive_indicator: options.adaptiveIndicator,
      adaptive_target_quantity: options.adaptiveTargetQuantity,
      adaptive_convergence_metric: options.adaptiveConvergenceMetric,
      adaptive_theta: options.adaptiveTheta,
      adaptive_h_min: parseOptionalFiniteNumberText(options.adaptiveHMin),
      adaptive_h_max: parseOptionalFiniteNumberText(options.adaptiveHMax),
      adaptive_max_passes: options.adaptiveMaxPasses,
      adaptive_error_tolerance: parseOptionalFiniteNumberText(options.adaptiveErrorTolerance),
      size_fields:
        (refinementZonesOverride ?? options.refinementZones).length > 0
          ? (refinementZonesOverride ?? options.refinementZones)
          : undefined,
      per_geometry: meshPerGeometryPayload,
    }),
    [meshPerGeometryPayload],
  );

  const enqueueStudyDomainRemesh = useCallback(
    async (
      meshReason: string,
      meshOptionsPayload: Record<string, unknown>,
      meshTarget: MeshCommandTarget = { kind: "study_domain" },
    ) => {
      setCommandPostInFlight(true);
      setCommandErrorMessage(null);
      const targetKindLabel =
        meshTarget.kind === "object_mesh"
          ? `object_mesh:${meshTarget.object_id}`
          : meshTarget.kind;
      const payload = {
        kind: "remesh",
        mesh_target: meshTarget,
        mesh_reason: meshReason,
        mesh_options: meshOptionsPayload,
      };
      appendFrontendTrace("info", `TX: REMESH ${JSON.stringify(payload)}`);
      try {
        await liveApi.queueRemesh({
          mesh_options: meshOptionsPayload,
          mesh_target: meshTarget,
          mesh_reason: meshReason,
        });
        appendFrontendTrace(
          "system",
          `RX: HTTP accepted REMESH target=${targetKindLabel} reason=${meshReason}`,
        );
      } catch (e) {
        appendFrontendTrace(
          "error",
          `RX: HTTP rejected REMESH target=${targetKindLabel} — ${e instanceof Error ? e.message : "Failed to queue command"}`,
        );
        setCommandErrorMessage(
          e instanceof Error ? e.message : "Failed to queue remesh command",
        );
        throw e;
      } finally {
        setCommandPostInFlight(false);
      }
    },
    [appendFrontendTrace, liveApi],
  );

  const updatePreview = useCallback(async (path: string, payload: Record<string, unknown> = {}) => {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.trace(`[fullmag-diag] updatePreview path=${path}`, payload);
    }
    const nextSelection: DisplaySelection = { ...requestedDisplaySelection };
    switch (path) {
      case "/quantity":
        nextSelection.quantity = typeof payload.quantity === "string" ? payload.quantity : nextSelection.quantity;
        nextSelection.kind = kindForQuantity(nextSelection.quantity) as DisplaySelection["kind"];
        break;
      case "/component":
        nextSelection.component = typeof payload.component === "string" ? payload.component : nextSelection.component;
        break;
      case "/layer":
        nextSelection.layer = Number(payload.layer ?? nextSelection.layer);
        break;
      case "/allLayers":
        nextSelection.all_layers = Boolean(payload.allLayers ?? nextSelection.all_layers);
        break;
      case "/everyN":
        nextSelection.every_n = Number(payload.everyN ?? nextSelection.every_n);
        break;
      case "/XChosenSize":
        nextSelection.x_chosen_size = Number(payload.xChosenSize ?? nextSelection.x_chosen_size);
        break;
      case "/YChosenSize":
        nextSelection.y_chosen_size = Number(payload.yChosenSize ?? nextSelection.y_chosen_size);
        break;
      case "/autoScaleEnabled":
        nextSelection.auto_scale_enabled = Boolean(payload.autoScaleEnabled ?? nextSelection.auto_scale_enabled);
        break;
      case "/maxPoints":
        nextSelection.max_points = Number(payload.maxPoints ?? nextSelection.max_points);
        break;
      default:
        setPreviewPostInFlight(true);
        setPreviewMessage(null);
        try { await liveApi.updatePreview(path, payload); }
        catch (e) { setPreviewMessage(e instanceof Error ? e.message : "Failed to update preview"); }
        finally { setPreviewPostInFlight(false); }
        return;
    }
    setOptimisticDisplaySelection(nextSelection);
    setPreviewPostInFlight(true);
    setPreviewMessage(`Switching to ${nextSelection.quantity}`);
    try {
      await liveApi.updateDisplaySelection(nextSelection);
    }
    catch (e) {
      setOptimisticDisplaySelection(null);
      setPreviewMessage(e instanceof Error ? e.message : "Failed to update preview");
    }
    finally { setPreviewPostInFlight(false); }
  }, [kindForQuantity, liveApi, requestedDisplaySelection]);

  const meshGenTopologyRef = useRef<string | null>(null);
  const meshGenGenerationRef = useRef<string | null>(null);
  const femGenerationIdRef = useRef<string | null>(null);

  const handleStudyDomainMeshGenerate = useCallback(async (meshReason = "manual_ui_rebuild_selected") => {
    setMeshGenerating(true);
    meshGenTopologyRef.current = femTopologyKeyRef.current;
    meshGenGenerationRef.current = femGenerationIdRef.current;
    pendingMeshConfigSignatureRef.current = meshConfigSignatureRef.current;
    try {
      await enqueueStudyDomainRemesh(
        meshReason,
        buildMeshOptionsPayload(meshOptions),
      );
    } catch (err) {
      setCommandErrorMessage(err instanceof Error ? err.message : "Mesh generation failed");
      setMeshGenerating(false);
      meshGenTopologyRef.current = null;
      meshGenGenerationRef.current = null;
      pendingMeshConfigSignatureRef.current = null;
    }
  }, [buildMeshOptionsPayload, enqueueStudyDomainRemesh, meshOptions]);

  const handleAirboxMeshGenerate = useCallback(async () => {
    setMeshGenerating(true);
    meshGenTopologyRef.current = femTopologyKeyRef.current;
    meshGenGenerationRef.current = femGenerationIdRef.current;
    pendingMeshConfigSignatureRef.current = meshConfigSignatureRef.current;
    try {
      await enqueueStudyDomainRemesh(
        "airbox_parameter_changed",
        buildMeshOptionsPayload(meshOptions),
        { kind: "airbox" },
      );
    } catch (err) {
      setCommandErrorMessage(
        err instanceof Error ? err.message : "Airbox mesh rebuild failed",
      );
      setMeshGenerating(false);
      meshGenTopologyRef.current = null;
      meshGenGenerationRef.current = null;
      pendingMeshConfigSignatureRef.current = null;
    }
  }, [buildMeshOptionsPayload, enqueueStudyDomainRemesh, meshOptions]);

  const handleObjectMeshOverrideRebuild = useCallback(
    async (objectId?: string | null) => {
      setMeshGenerating(true);
      meshGenTopologyRef.current = femTopologyKeyRef.current;
      meshGenGenerationRef.current = femGenerationIdRef.current;
      pendingMeshConfigSignatureRef.current = meshConfigSignatureRef.current;
      try {
        const scriptPath = session?.script_path ?? null;
        if (!scriptPath) {
          throw new Error("No script path is available for the active workspace");
        }
        setScriptSyncBusy(true);
        setScriptSyncMessage(null);
        appendFrontendTrace("info", `TX: SCRIPT_SYNC ${scriptPath}`);
        builderAutoSync.cancelPendingPush();
        await liveApi.updateSceneDocument(localBuilderDraft);
        builderAutoSync.recordPushSignature(localBuilderSignature);
        const response = await liveApi.syncScript();
        const syncedPath =
          typeof response.script_path === "string" && response.script_path.trim().length > 0
            ? response.script_path
            : scriptPath;
        setScriptSyncMessage(
          `Synced ${syncedPath.split("/").pop() ?? "script"} to canonical Python`,
        );
        appendFrontendTrace(
          "success",
          `RX: SCRIPT_SYNC ok — ${syncedPath.split("/").pop() ?? "script"}`,
        );
        await enqueueStudyDomainRemesh(
          objectId ? `object_mesh_override_changed:${objectId}` : "object_mesh_override_changed",
          buildMeshOptionsPayload(meshOptions),
          objectId ? { kind: "object_mesh", object_id: objectId } : { kind: "study_domain" },
        );
      } catch (err) {
        setCommandErrorMessage(
          err instanceof Error ? err.message : "Object mesh override rebuild failed",
        );
        setMeshGenerating(false);
        meshGenTopologyRef.current = null;
        meshGenGenerationRef.current = null;
        pendingMeshConfigSignatureRef.current = null;
      } finally {
        setScriptSyncBusy(false);
      }
    },
    [
      appendFrontendTrace,
      buildMeshOptionsPayload,
      enqueueStudyDomainRemesh,
      liveApi,
      localBuilderDraft,
      localBuilderSignature,
      meshOptions,
      session?.script_path,
    ],
  );

  const handleLassoRefine = useCallback(async (faceIndices: number[], factor: number) => {
    const currentFemMeshData = femMeshDataRef.current;
    if (!currentFemMeshData || faceIndices.length === 0) return;
    const nodes = currentFemMeshData.nodes;
    const faces = currentFemMeshData.boundaryFaces;
    let xmin = Infinity, ymin = Infinity, zmin = Infinity;
    let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
    for (const fi of faceIndices) {
      for (let v = 0; v < 3; v++) {
        const ni = faces[fi * 3 + v];
        const x = nodes[ni * 3], y = nodes[ni * 3 + 1], z = nodes[ni * 3 + 2];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        if (z < zmin) zmin = z; if (z > zmax) zmax = z;
      }
    }
    const currentHmax = parseOptionalFiniteNumberText(meshOptions.hmax) ?? (meshHmax ?? 20e-9);
    const targetH = currentHmax * factor;
    const pad = currentHmax * 2;
    const zone: SizeFieldSpec = {
      kind: "Box",
      params: {
        VIn: targetH, VOut: currentHmax,
        XMin: xmin - pad, XMax: xmax + pad,
        YMin: ymin - pad, YMax: ymax + pad,
        ZMin: zmin - pad, ZMax: zmax + pad,
      },
    };
    const updatedZones = [...meshOptions.refinementZones, zone];
    setMeshOptions((prev) => ({ ...prev, refinementZones: updatedZones }));

    setMeshGenerating(true);
    meshGenTopologyRef.current = femTopologyKeyRef.current;
    meshGenGenerationRef.current = femGenerationIdRef.current;
    pendingMeshConfigSignatureRef.current = meshConfigSignatureRef.current;
    try {
      await enqueueStudyDomainRemesh(
        "lasso_refine",
        buildMeshOptionsPayload(meshOptions, updatedZones),
      );
    } catch (err) {
      setCommandErrorMessage(err instanceof Error ? err.message : "Lasso refine failed");
      setMeshGenerating(false);
      meshGenTopologyRef.current = null;
      meshGenGenerationRef.current = null;
      pendingMeshConfigSignatureRef.current = null;
    }
  }, [buildMeshOptionsPayload, enqueueStudyDomainRemesh, meshHmax, meshOptions, setMeshOptions]);

  return {
    appendFrontendTrace,
    enqueueCommand,
    buildMeshOptionsPayload,
    enqueueStudyDomainRemesh,
    updatePreview,
    meshGenTopologyRef,
    meshGenGenerationRef,
    femGenerationIdRef,
    handleStudyDomainMeshGenerate,
    handleAirboxMeshGenerate,
    handleObjectMeshOverrideRebuild,
    handleLassoRefine,
  };
}
