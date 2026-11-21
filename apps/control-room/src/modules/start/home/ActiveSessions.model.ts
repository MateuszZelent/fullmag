import type { ProjectStatus } from "../model/types";

/** The pill colour for a session lifecycle word; the word itself stays visible. */
export function sessionPillStatus(status: string): ProjectStatus {
  switch (status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "awaiting_command":
    case "waiting_for_compute":
    case "completed":
      return "ready";
    case "closed":
    case "stopped":
    case "cancelled":
      return "readonly";
    case "activating":
    case "materializing_script":
    default:
      return "draft";
  }
}
