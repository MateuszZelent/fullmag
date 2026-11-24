import type { KernelApi } from "../types";
import { validateProjectRunEnvelope } from "../resources/projectRunResources";
import { homeView } from "../layout/homeView";

/** Open an existing durable run. This performs GET only and creates no session. */
export async function openSavedRun(kernel: Pick<KernelApi, "savedRun" | "api" | "pendingForms" | "objectEditSession" | "savedResultsPlayback" | "visualization" | "selection" | "layout">, input: { projectId: string; runId: string }) {
  const { savedRun, api, pendingForms, objectEditSession } = kernel;
  if (!savedRun || !pendingForms) throw new Error("Saved run navigation is unavailable.");
  const projectId = input.projectId.trim(), runId = input.runId.trim();
  if (!projectId || !runId) throw new Error("Project ID and run ID are required.");
  if (objectEditSession.getSnapshot().dirty) throw new Error("Apply or cancel the current object edit first.");
  const generation = savedRun.beginOpen();
  const apiScope = api.resourceCacheScope;
  const transition = await pendingForms.prepareTransition({ applyPendingChanges: false });
  try {
    validateProjectRunEnvelope(await api.persistence.projects.getRun(projectId, runId), projectId, runId);
    transition.assertCurrent();
    if (api.resourceCacheScope !== apiScope) throw new Error("The API connection changed while opening saved results.");
    if (objectEditSession.getSnapshot().dirty) throw new Error("Object edits changed while opening saved results.");
    savedRun.openVerified({ projectId, runId, apiScope }, generation);
    kernel.savedResultsPlayback?.close();
    kernel.visualization.clearSavedFieldPresentation();
    kernel.selection.clear("saved-run");
    kernel.layout.setResultsSource("saved");
    kernel.layout.setActiveTab("results");
    homeView.close();
  } finally {
    transition.release();
  }
}
