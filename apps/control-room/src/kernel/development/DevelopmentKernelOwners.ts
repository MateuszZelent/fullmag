import type { DevelopmentRestartResource, VisualizationStatePatch, VisualizationStateResource } from "../api/apiTypes";
import type { KernelApi } from "../types";
import type { LayoutState } from "../layout/layoutTypes";
import { cloneBoundedProjectJsonObject, validateProjectDocumentDevelopmentHandoff } from "../persistence/ProjectDocumentDevelopmentHandoff";
import { DevelopmentRestartCaptureError, type DevelopmentRestartCaptureReason, type DevelopmentRestartOwners } from "./DevelopmentRestartController";

const WORKSPACE_SCHEMA_V1 = "fullmag.development-layout-handoff.v1";
const WORKSPACE_SCHEMA_V2 = "fullmag.development-layout-handoff.v2";
const ABSENT_EDITOR = { schema: "fullmag.development-editor-handoff.v1", state: "absent" } as const;
type OwnerKernel = Pick<KernelApi, "api" | "cameraRegistry" | "layout" | "modules" | "pendingForms" | "projectDocument">;
type HandoffCamera = VisualizationStateResource["camera"];
type WorkspaceHandoff = { readonly layout: unknown; readonly camera?: HandoffCamera | null };

export interface DevelopmentKernelOwnerOptions {
  readonly applyPendingChanges: boolean;
  readonly carryUnsavedDocument: boolean;
  /** Pause old connectors and input without unmounting the owner's draft components. */
  pauseOldKernel(): () => void;
  /** Construct a fresh, unmounted kernel with a new pinned client/cache namespace. */
  prepareReplacement(apiInstance: string): Promise<OwnerKernel>;
  /** Resolve only after old connectors have unmounted and the new kernel is committed. */
  publishReplacement(kernel: OwnerKernel): Promise<void>;
}

/** Concrete document/layout owners; this workspace currently has no separate Python editor. */
export function createDevelopmentKernelOwners(
  kernel: OwnerKernel,
  options: DevelopmentKernelOwnerOptions,
): DevelopmentRestartOwners {
  return {
    capture: async () => {
      if (!kernel.pendingForms || !kernel.projectDocument) throw new DevelopmentRestartCaptureError(true);
      const pending = kernel.pendingForms.getTransitionSnapshot();
      // This synchronous rejection acquires no guard and never applies a form.
      if (!options.applyPendingChanges && (pending.dirtyOwnerCount > 0 || pending.applyingOwnerCount > 0
        || pending.preparing || pending.guarded)) {
        const reason = pending.dirtyOwnerCount > 0 && pending.applyingOwnerCount === 0
          && !pending.preparing && !pending.guarded ? "pending_changes" : "capture_rejected";
        throw new DevelopmentRestartCaptureError(true, reason);
      }
      let forms: Awaited<ReturnType<NonNullable<OwnerKernel["pendingForms"]>["prepareTransition"]>>;
      try {
        forms = await kernel.pendingForms.prepareTransition({ applyPendingChanges: options.applyPendingChanges });
      } catch {
        // A preparation observer may throw during cleanup. Its message or final
        // registry state cannot establish that cleanup was confirmed.
        throw new DevelopmentRestartCaptureError(false);
      }
      let document: ReturnType<NonNullable<OwnerKernel["projectDocument"]>["beginDevelopmentHandoff"]> | null = null;
      let resume: (() => void) | null = null;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseAll([() => forms.release(), () => document?.release(), () => resume?.()]);
      };
      let captureReason: DevelopmentRestartCaptureReason = "document_capture";
      try {
        document = kernel.projectDocument.beginDevelopmentHandoff({ carryUnsaved: options.carryUnsavedDocument });
        captureReason = "workspace_pause";
        resume = options.pauseOldKernel();
        // Read the stopped registry directly. The old API transport is paused
        // by the host, so a GET here would either fail or observe stale data.
        captureReason = "camera_observation";
        const cameraSnapshot = kernel.cameraRegistry.getSnapshot();
        const sourceCamera = validateCameraState(cameraSnapshot.camera);
        captureReason = "workspace_identity";
        const observation = await kernel.api.platform.developmentBackend();
        const identity = observation.workspace_identity;
        if (!observation.configured || !identity || identity.api_instance_id !== kernel.api.getExpectedApiInstance()
          || !Number.isSafeInteger(identity.session_epoch) || identity.session_epoch < 0
          || (identity.session_id !== null && (typeof identity.session_id !== "string" || !identity.session_id.trim()))) {
          throw new Error("Current workspace transition identity is unavailable.");
        }
        captureReason = "camera_observation";
        if (identity.session_id !== null
          && (cameraSnapshot.lastRemoteRevision === null || cameraSnapshot.remoteCamera === null
            || cameraSnapshot.dirty || cameraSnapshot.syncInFlight || cameraSnapshot.error !== null
            || !sameCamera(sourceCamera, validateCameraState(cameraSnapshot.remoteCamera)))) {
          throw new Error("Current session camera has not reached a clean observed state.");
        }
        captureReason = "workspace_layout";
        const originalLayout = kernel.layout.get();
        const workspace = cloneBoundedProjectJsonObject({
          schema: WORKSPACE_SCHEMA_V2,
          layout: originalLayout,
          // A sessionless workspace has no visualization resource endpoint.
          camera: identity.session_id === null ? null : sourceCamera,
        });
        const assertCurrent = () => {
          forms.assertCurrent(); document!.assertCurrent();
          if (kernel.layout.get() !== originalLayout
            || JSON.stringify(cloneBoundedProjectJsonObject(kernel.layout.get())) !== JSON.stringify(workspace.layout)) {
            throw new Error("Workspace layout changed during handoff.");
          }
          if (!sameCamera(validateCameraState(kernel.cameraRegistry.getSnapshot().camera), sourceCamera)) {
            throw new Error("Workspace camera changed during handoff.");
          }
        };
        assertCurrent();
        return {
          sessionId: identity.session_id,
          sessionEpoch: identity.session_epoch,
          editor: { ...ABSENT_EDITOR },
          workspace,
          projectDocument: cloneBoundedProjectJsonObject(document.handoff),
          assertCurrent,
          release,
        };
      } catch {
        try { release(); } catch { throw new DevelopmentRestartCaptureError(false); }
        throw new DevelopmentRestartCaptureError(true, captureReason);
      }
    },
    hydrate: async (resource: DevelopmentRestartResource) => {
      if (!resource.new_api_instance_id) throw new Error("Replacement API identity is missing.");
      const { sessionId, sessionEpoch } = validateRestartSessionIdentity(
        resource.session_id,
        resource.session_epoch,
      );
      const editor = cloneBoundedProjectJsonObject(resource.editor);
      if (Object.keys(editor).length !== 2 || editor.schema !== ABSENT_EDITOR.schema || editor.state !== "absent") {
        throw new Error("This workspace cannot restore an unsupported editor owner.");
      }
      const workspace = validateWorkspaceHandoff(resource.workspace, sessionId);
      const document = validateProjectDocumentDevelopmentHandoff(resource.project_document);
      const replacement = await options.prepareReplacement(resource.new_api_instance_id);
      if (replacement.api === kernel.api || replacement.api.resourceCacheScope === kernel.api.resourceCacheScope
        || replacement.api.getExpectedApiInstance() !== resource.new_api_instance_id || !replacement.projectDocument
        || replacement.projectDocument === kernel.projectDocument || replacement.layout === kernel.layout
        || replacement.cameraRegistry === kernel.cameraRegistry
        || !replacement.pendingForms || replacement.pendingForms === kernel.pendingForms) {
        throw new Error("Replacement owners are not fresh and pinned.");
      }
      const layout = validateLayout(workspace.layout, replacement);
      const observation = await replacement.api.platform.developmentBackend();
      const identity = observation.workspace_identity;
      if (!observation.configured || !identity || identity.api_instance_id !== resource.new_api_instance_id
        || identity.session_id !== sessionId || identity.session_epoch !== sessionEpoch) {
        throw new Error("Replacement workspace differs from the confirmed restart outcome.");
      }
      await replacement.projectDocument.restoreDevelopmentHandoff(document);
      replacement.layout.replace(layout);
      if (workspace.camera) {
        const cameraPatch = cameraStatePatch(workspace.camera);
        const acknowledged = await replacement.api.visualization.patch({ camera: cameraPatch });
        if (!sameCamera(validateCameraState(acknowledged.camera), workspace.camera)) {
          throw new Error("Replacement API did not acknowledge the handed-off camera.");
        }
        const readback = await replacement.api.visualization.state();
        if (!sameCamera(validateCameraState(readback.camera), workspace.camera)) {
          throw new Error("Replacement API camera readback differs from the handoff.");
        }
      }
      await options.publishReplacement(replacement);
    },
  };
}

function validateRestartSessionIdentity(
  sessionId: unknown,
  sessionEpoch: unknown,
): { readonly sessionId: string | null; readonly sessionEpoch: number } {
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId.trim())) {
    throw new Error("Replacement session identity is missing or invalid.");
  }
  if (typeof sessionEpoch !== "number" || !Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0) {
    throw new Error("Replacement session epoch is missing or invalid.");
  }
  return { sessionId, sessionEpoch };
}

function validateWorkspaceHandoff(value: unknown, sessionId: string | null): WorkspaceHandoff {
  const workspace = cloneBoundedProjectJsonObject(value);
  if (workspace.schema === WORKSPACE_SCHEMA_V1) {
    if (Object.keys(workspace).length !== 2 || !hasExactKeys(workspace, ["schema", "layout"])) {
      throw new Error("Invalid legacy workspace handoff.");
    }
    // v1 predates camera capture. Read it explicitly and preserve its original
    // behavior by leaving the replacement API camera untouched.
    return { layout: workspace.layout };
  }
  if (workspace.schema !== WORKSPACE_SCHEMA_V2
    || Object.keys(workspace).length !== 3
    || !hasExactKeys(workspace, ["schema", "layout", "camera"])) {
    throw new Error("Invalid workspace handoff.");
  }
  const camera = workspace.camera === null ? null : validateCameraState(workspace.camera);
  if ((sessionId === null) !== (camera === null)) {
    throw new Error("Workspace camera does not match the confirmed session identity.");
  }
  return { layout: workspace.layout, camera };
}

function validateCameraState(value: unknown): HandoffCamera {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Invalid workspace camera state.");
  }
  const camera = value as Record<string, unknown>;
  const keys = ["projection", "position", "target", "up", "fov_degrees", "orthographic_scale"];
  if (Object.keys(camera).length !== keys.length || !hasExactKeys(camera, keys)
    || (camera.projection !== "perspective" && camera.projection !== "orthographic")) {
    throw new Error("Invalid workspace camera state.");
  }
  const position = validateCameraVector(camera.position);
  const target = validateCameraVector(camera.target);
  const up = validateCameraVector(camera.up);
  if (position.every((value, index) => value === target[index])) {
    throw new Error("Camera position must not equal its target.");
  }
  if (up[0] ** 2 + up[1] ** 2 + up[2] ** 2 <= Number.EPSILON) {
    throw new Error("Camera up must not be zero.");
  }
  if (typeof camera.fov_degrees !== "number" || !Number.isFinite(camera.fov_degrees)
    || camera.fov_degrees < 1 || camera.fov_degrees > 179) {
    throw new Error("Camera field of view must be between 1 and 179 degrees.");
  }
  if (camera.orthographic_scale !== null
    && (typeof camera.orthographic_scale !== "number"
      || !Number.isFinite(camera.orthographic_scale)
      || camera.orthographic_scale <= 0)) {
    throw new Error("Camera orthographic scale must be positive and finite.");
  }
  return {
    projection: camera.projection,
    position,
    target,
    up,
    fov_degrees: camera.fov_degrees,
    orthographic_scale: camera.orthographic_scale,
  };
}

function validateCameraVector(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3
    || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2])) {
    throw new Error("Camera vectors must contain exactly three finite values.");
  }
  return [value[0], value[1], value[2]];
}

function cameraStatePatch(camera: HandoffCamera): NonNullable<VisualizationStatePatch["camera"]> {
  return {
    projection: camera.projection,
    position: [...camera.position],
    target: [...camera.target],
    up: [...camera.up],
    fov_degrees: camera.fov_degrees,
    orthographic_scale: camera.orthographic_scale,
  };
}

function sameCamera(left: HandoffCamera, right: HandoffCamera): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  return expected.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function releaseAll(callbacks: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try { callback(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Workspace owner cleanup is unconfirmed.");
}

function validateLayout(value: unknown, kernel: OwnerKernel): LayoutState {
  const layout = cloneBoundedProjectJsonObject(value);
  const ribbon = ["home", "view", "definitions", "geometry", "materials", "physics", "mesh", "study", "results", "automation"];
  const bottom = ["diagnostics", "engine", "logs", "operations", "problems", "quick-chart", "telemetry"];
  const slots = ["ribbon", "viewport-main", "panel-left", "panel-right", "panel-bottom", "status-bar", "start-screen", "overlay"];
  const keys = ["activeModuleTab", "activeBottomPanelTab", "activeViewportMainModuleId", "lastSpatialViewportMainModuleId", "panelVisible", "focusedSlot"];
  if (Object.keys(layout).some((key) => !keys.includes(key))
    || typeof layout.activeModuleTab !== "string" || !ribbon.includes(layout.activeModuleTab)
    || typeof layout.activeBottomPanelTab !== "string" || !bottom.includes(layout.activeBottomPanelTab)
    || typeof layout.activeViewportMainModuleId !== "string"
    || !kernel.modules.get(layout.activeViewportMainModuleId)?.slots.includes("viewport-main")
    || (layout.lastSpatialViewportMainModuleId !== undefined && layout.lastSpatialViewportMainModuleId !== "field-map" && layout.lastSpatialViewportMainModuleId !== "viewport-3d")
    || (layout.focusedSlot !== null && (typeof layout.focusedSlot !== "string" || !slots.includes(layout.focusedSlot)))) {
    throw new Error("Workspace layout contains unavailable modules or invalid preferences.");
  }
  const panels = cloneBoundedProjectJsonObject(layout.panelVisible);
  if (Object.keys(panels).length !== 3 || ["left", "right", "bottom"].some((key) => typeof panels[key] !== "boolean")) {
    throw new Error("Invalid workspace panel visibility.");
  }
  return layout as unknown as LayoutState;
}
