import type { DevelopmentRestartResource } from "../api/apiTypes";
import type { KernelApi } from "../types";
import type { LayoutState } from "../layout/layoutTypes";
import { cloneBoundedProjectJsonObject, validateProjectDocumentDevelopmentHandoff } from "../persistence/ProjectDocumentDevelopmentHandoff";
import { DevelopmentRestartCaptureError, type DevelopmentRestartOwners } from "./DevelopmentRestartController";

const WORKSPACE_SCHEMA = "fullmag.development-layout-handoff.v1";
const ABSENT_EDITOR = { schema: "fullmag.development-editor-handoff.v1", state: "absent" } as const;
type OwnerKernel = Pick<KernelApi, "api" | "layout" | "modules" | "pendingForms" | "projectDocument">;

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
        || pending.preparing || pending.guarded)) throw new DevelopmentRestartCaptureError(true);
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
      try {
        document = kernel.projectDocument.beginDevelopmentHandoff({ carryUnsaved: options.carryUnsavedDocument });
        resume = options.pauseOldKernel();
        const observation = await kernel.api.platform.developmentBackend();
        const identity = observation.workspace_identity;
        if (!observation.configured || !identity || identity.api_instance_id !== kernel.api.getExpectedApiInstance()
          || !Number.isSafeInteger(identity.session_epoch) || identity.session_epoch < 0
          || (identity.session_id !== null && (typeof identity.session_id !== "string" || !identity.session_id.trim()))) {
          throw new Error("Current workspace transition identity is unavailable.");
        }
        const originalLayout = kernel.layout.get();
        const workspace = cloneBoundedProjectJsonObject({ schema: WORKSPACE_SCHEMA, layout: originalLayout });
        const assertCurrent = () => {
          forms.assertCurrent(); document!.assertCurrent();
          if (kernel.layout.get() !== originalLayout
            || JSON.stringify(cloneBoundedProjectJsonObject(kernel.layout.get())) !== JSON.stringify(workspace.layout)) {
            throw new Error("Workspace layout changed during handoff.");
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
        throw new DevelopmentRestartCaptureError(true);
      }
    },
    hydrate: async (resource: DevelopmentRestartResource) => {
      if (!resource.new_api_instance_id) throw new Error("Replacement API identity is missing.");
      const editor = cloneBoundedProjectJsonObject(resource.editor);
      if (Object.keys(editor).length !== 2 || editor.schema !== ABSENT_EDITOR.schema || editor.state !== "absent") {
        throw new Error("This workspace cannot restore an unsupported editor owner.");
      }
      const workspace = cloneBoundedProjectJsonObject(resource.workspace);
      if (Object.keys(workspace).length !== 2 || workspace.schema !== WORKSPACE_SCHEMA) throw new Error("Invalid workspace handoff.");
      const document = validateProjectDocumentDevelopmentHandoff(resource.project_document);
      const replacement = await options.prepareReplacement(resource.new_api_instance_id);
      if (replacement.api === kernel.api || replacement.api.resourceCacheScope === kernel.api.resourceCacheScope
        || replacement.api.getExpectedApiInstance() !== resource.new_api_instance_id || !replacement.projectDocument
        || replacement.projectDocument === kernel.projectDocument || replacement.layout === kernel.layout
        || !replacement.pendingForms || replacement.pendingForms === kernel.pendingForms) {
        throw new Error("Replacement owners are not fresh and pinned.");
      }
      const layout = validateLayout(workspace.layout, replacement);
      const observation = await replacement.api.platform.developmentBackend();
      const identity = observation.workspace_identity;
      if (!observation.configured || !identity || identity.api_instance_id !== resource.new_api_instance_id
        || identity.session_id !== resource.session_id || identity.session_epoch !== resource.session_epoch) {
        throw new Error("Replacement workspace differs from the confirmed restart outcome.");
      }
      await replacement.projectDocument.restoreDevelopmentHandoff(document);
      replacement.layout.replace(layout);
      await options.publishReplacement(replacement);
    },
  };
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
