/**
 * useMeshCommandPipeline – extracted from ControlRoomContext.tsx
 *
 * Command infrastructure and mesh operation callbacks:
 *  appendFrontendTrace, enqueueCommand, buildMeshOptionsPayload,
 *  enqueueStudyDomainRemesh, patchDisplay, updatePreview,
 *  handleStudyDomainMeshGenerate, handleAirboxMeshGenerate,
 *  handleObjectMeshOverrideRebuild, handleLassoRefine.
 */
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { MeshOptionsState, SizeFieldSpec } from "../../../panels/MeshSettingsPanel";
import type { DisplaySelection, MeshCommandTarget, SceneDocument } from "../../../../lib/session/types";
import type { FemMeshData } from "../../../preview/FemMeshView3D";
import {
  displayPatchFromPreviewComponent,
} from "@/src/api/displaySelection";
import type {
  DisplayPatchRequest,
} from "@/src/api/generated/openapi-types";
import { parseOptionalFiniteNumberText } from "../controlRoomUtils";
import type { ControlRoomApi } from "../controlRoomApi";
import type { useBuilderAutoSync } from "./useBuilderAutoSync";

type BuilderAutoSync = ReturnType<typeof useBuilderAutoSync>;

export interface UseMeshCommandPipelineParams {
  liveApi: ControlRoomApi;
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
  patchDisplay: (
    patch: DisplayPatchRequest,
    optimisticSelectionOverride?: DisplaySelection,
    message?: string,
  ) => Promise<void>;
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
  const selectionToDisplayPatch = useCallback(
    (selection: DisplaySelection): DisplayPatchRequest => ({
      active_quantity_id: selection.quantity,
      view_mode: selection.view_mode,
      field_component: selection.field_component,
      auto_contrast: selection.auto_scale_enabled,
      vector_density: selection.every_n,
      slice_mode: selection.all_layers ? "all" : "single",
      slice_layer: selection.layer,
      max_points: selection.max_points,
      x_chosen_size: selection.x_chosen_size,
      y_chosen_size: selection.y_chosen_size,
    }),
    [],
  );

  const applyDisplayPatchToSelection = useCallback((selection: DisplaySelection, patch: DisplayPatchRequest): DisplaySelection => {
    const nextSelection: DisplaySelection = { ...selection };
    if (typeof patch.active_quantity_id === "string" && patch.active_quantity_id.trim().length > 0) {
      nextSelection.quantity = patch.active_quantity_id;
      nextSelection.kind = kindForQuantity(nextSelection.quantity) as DisplaySelection["kind"];
      if (nextSelection.kind !== "vector_field") {
        nextSelection.view_mode = "2d";
        nextSelection.field_component = "magnitude";
      }
    }
    if (patch.view_mode === "2d" || patch.view_mode === "3d") {
      nextSelection.view_mode = patch.view_mode;
    }
    if (
      patch.field_component === "x" ||
      patch.field_component === "y" ||
      patch.field_component === "z" ||
      patch.field_component === "magnitude"
    ) {
      nextSelection.field_component = patch.field_component;
    }
    if (typeof patch.auto_contrast === "boolean") {
      nextSelection.auto_scale_enabled = patch.auto_contrast;
    }
    if (typeof patch.vector_density === "number" && Number.isFinite(patch.vector_density)) {
      nextSelection.every_n = patch.vector_density;
    }
    if (patch.slice_mode === "all" || patch.slice_mode === "single") {
      nextSelection.all_layers = patch.slice_mode === "all";
    }
    if (typeof patch.slice_layer === "number" && Number.isFinite(patch.slice_layer)) {
      nextSelection.layer = patch.slice_layer;
    }
    if (typeof patch.max_points === "number" && Number.isFinite(patch.max_points)) {
      nextSelection.max_points = patch.max_points;
    }
    if (typeof patch.x_chosen_size === "number" && Number.isFinite(patch.x_chosen_size)) {
      nextSelection.x_chosen_size = patch.x_chosen_size;
    }
    if (typeof patch.y_chosen_size === "number" && Number.isFinite(patch.y_chosen_size)) {
      nextSelection.y_chosen_size = patch.y_chosen_size;
    }
    return nextSelection;
  }, [kindForQuantity]);

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

  const patchDisplay = useCallback(async (
    patch: DisplayPatchRequest,
    optimisticSelectionOverride?: DisplaySelection,
    message?: string,
  ) => {
    const nextSelection = optimisticSelectionOverride ?? applyDisplayPatchToSelection(
      requestedDisplaySelection,
      patch,
    );
    setOptimisticDisplaySelection(nextSelection);
    setPreviewPostInFlight(true);
    setPreviewMessage(message ?? (patch.active_quantity_id ? `Switching to ${nextSelection.quantity}` : "Updating display"));
    try {
      await liveApi.patchDisplay(patch);
    }
    catch (e) {
      setOptimisticDisplaySelection(null);
      setPreviewMessage(e instanceof Error ? e.message : "Failed to update preview");
    }
    finally { setPreviewPostInFlight(false); }
  }, [
    applyDisplayPatchToSelection,
    liveApi,
    requestedDisplaySelection,
  ]);

  const updatePreview = useCallback(async (path: string, payload: Record<string, unknown> = {}) => {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.trace(`[fullmag-diag] updatePreview path=${path}`, payload);
    }
    const nextSelection: DisplaySelection = { ...requestedDisplaySelection };
    let displayPatch: DisplayPatchRequest | null = null;
    switch (path) {
      case "/quantity":
        nextSelection.quantity = typeof payload.quantity === "string" ? payload.quantity : nextSelection.quantity;
        nextSelection.kind = kindForQuantity(nextSelection.quantity) as DisplaySelection["kind"];
        if (nextSelection.kind !== "vector_field") {
          nextSelection.view_mode = "2d";
          nextSelection.field_component = "magnitude";
        }
        displayPatch = selectionToDisplayPatch(nextSelection);
        break;
      case "/component":
        Object.assign(nextSelection, displayPatchFromPreviewComponent(
          payload.component === "3D" ||
            payload.component === "x" ||
            payload.component === "y" ||
            payload.component === "z" ||
            payload.component === "magnitude"
            ? payload.component
            : "magnitude",
          nextSelection.field_component,
        ));
        displayPatch = {
          view_mode: nextSelection.view_mode,
          field_component: nextSelection.field_component,
        };
        break;
      case "/layer":
        nextSelection.layer = Number(payload.layer ?? nextSelection.layer);
        displayPatch = { slice_layer: nextSelection.layer };
        break;
      case "/allLayers":
        nextSelection.all_layers = Boolean(payload.allLayers ?? nextSelection.all_layers);
        displayPatch = {
          slice_mode: nextSelection.all_layers ? "all" : "single",
        };
        break;
      case "/everyN":
        nextSelection.every_n = Number(payload.everyN ?? nextSelection.every_n);
        displayPatch = { vector_density: nextSelection.every_n };
        break;
      case "/XChosenSize":
        nextSelection.x_chosen_size = Number(payload.xChosenSize ?? nextSelection.x_chosen_size);
        displayPatch = { x_chosen_size: nextSelection.x_chosen_size };
        break;
      case "/YChosenSize":
        nextSelection.y_chosen_size = Number(payload.yChosenSize ?? nextSelection.y_chosen_size);
        displayPatch = { y_chosen_size: nextSelection.y_chosen_size };
        break;
      case "/autoScaleEnabled":
        nextSelection.auto_scale_enabled = Boolean(payload.autoScaleEnabled ?? nextSelection.auto_scale_enabled);
        displayPatch = { auto_contrast: nextSelection.auto_scale_enabled };
        break;
      case "/maxPoints":
        nextSelection.max_points = Number(payload.maxPoints ?? nextSelection.max_points);
        displayPatch = { max_points: nextSelection.max_points };
        break;
      case "/refresh":
        displayPatch = selectionToDisplayPatch(nextSelection);
        break;
      default:
        setPreviewMessage(`Unsupported display mutation: ${path}`);
        return;
    }
    await patchDisplay(
      displayPatch ?? selectionToDisplayPatch(nextSelection),
      nextSelection,
      `Switching to ${nextSelection.quantity}`,
    );
  }, [
    kindForQuantity,
    patchDisplay,
    requestedDisplaySelection,
    selectionToDisplayPatch,
  ]);

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
        if (!localBuilderDraft) {
          throw new Error("No scene document is available for script sync");
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
    patchDisplay,
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
