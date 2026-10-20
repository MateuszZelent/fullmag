import type { ScriptFidelityResource } from "../api/apiTypes";

export interface FidelityView {
  readonly tone: "ok" | "warning";
  readonly headline: string;
  readonly detail: string;
  readonly notes: readonly string[];
}

/**
 * Words for the fidelity verdict. Workspace Compute always runs the project
 * scene; the stored script is the import source and archive, and only a
 * separate "Run in new window" executes the script itself.
 */
const SCENE_RUNS_NOTE =
  "Compute in this workspace runs the project scene; the stored script is kept as the import source and archive, and runs only when you start it separately with Run in new window.";

export function describeFidelity(fidelity: ScriptFidelityResource): FidelityView {
  const notes = fidelity.notes;
  switch (fidelity.round_trip) {
    case "verified":
      return {
        tone: "ok",
        headline: "Round trip verified",
        detail:
          `The compared parts of the scene (geometry, materials, magnets and initial state, regions, grid, study, runtime request and mesh policy) match a second evaluation of the original script. ${SCENE_RUNS_NOTE}`,
        notes,
      };
    case "failed":
      return {
        tone: "warning",
        headline: "Round trip failed",
        detail:
          `The scene in this project is not an exact copy of the script. ${SCENE_RUNS_NOTE} Results may therefore differ from running the script directly.`,
        notes,
      };
    case "not_checked":
      return {
        tone: "warning",
        headline: "Round trip not checked",
        detail:
          `The scene was exported but could not be compared with the script. ${SCENE_RUNS_NOTE}`,
        notes,
      };
  }
}
