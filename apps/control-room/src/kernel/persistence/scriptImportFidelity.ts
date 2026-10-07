import type { ScriptFidelityResource } from "../api/apiTypes";

export interface FidelityView {
  readonly tone: "ok" | "warning";
  readonly headline: string;
  readonly detail: string;
  readonly notes: readonly string[];
}

/**
 * Words for the fidelity verdict. A verified round trip still says the stored
 * script is the source for runs; a failed one says the scene is not a copy.
 */
export function describeFidelity(fidelity: ScriptFidelityResource): FidelityView {
  const notes = fidelity.notes;
  switch (fidelity.round_trip) {
    case "verified":
      return {
        tone: "ok",
        headline: "Round trip verified",
        detail:
          "Geometry, materials, grid and study of the scene match the original script. The script is stored in the project and remains the source for runs.",
        notes,
      };
    case "failed":
      return {
        tone: "warning",
        headline: "Round trip failed",
        detail:
          "The scene in this project is not an exact copy of the script. Scene edits may not reproduce what the script does; the stored script remains the source for runs.",
        notes,
      };
    case "not_checked":
      return {
        tone: "warning",
        headline: "Round trip not checked",
        detail:
          "The scene was exported but could not be compared with the script. The stored script remains the source for runs.",
        notes,
      };
  }
}
