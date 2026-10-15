// Compatibility aliases for host telemetry; neither handler owns RuntimeSession.
export function isHostTelemetryRead(method, path) {
  return method === "GET" && (
    path === "/v2/sessions/current/diagnostics/cpu" ||
    path === "/v2/sessions/current/diagnostics/gpu"
  );
}

export function isForbiddenRuntimeMutation(method, path, sessionMode) {
  if (method === "GET") return false;
  if (sessionMode === "absent" &&
      (path === "/v2/sessions" || path.startsWith("/v2/sessions/"))) return true;
  return path.includes("/simulation/") ||
    path.includes("/preparation") ||
    path.includes("/meshing/") ||
    path.includes("/restore") ||
    path.includes("/compute") ||
    path.includes("/model/");
}
