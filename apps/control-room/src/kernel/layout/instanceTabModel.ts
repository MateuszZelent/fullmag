import type { DiscoveredInstance } from "../api/apiTypes";

export type SessionTone = "running" | "starting" | "waiting" | "failed" | "idle";

/**
 * The dot colour of a session lifecycle word; the word itself stays in the title.
 * Only an executing session is green: startup and a model parked for Compute differ.
 */
export function sessionTone(status: string | undefined): SessionTone {
  switch (status) {
    case "running":
      return "running";
    case "activating":
    case "materializing_script":
      return "starting";
    case "waiting_for_compute":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export function instanceTabLabel(instance: DiscoveredInstance | undefined): string {
  const session = instance?.sessions.find((entry) => entry.current) ?? instance?.sessions[0];
  return session?.name || (instance ? "No session" : "Unavailable");
}
