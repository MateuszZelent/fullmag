const SESSION_ERROR_HISTORY_PATH = "/v2/sessions/current/diagnostics/session-errors";

export function createSessionErrorHistoryFixture(sessionId) {
  const history = { clearGeneration: 0, entries: [], revision: 0, sessionId };
  return (request, path) => {
    if (path !== SESSION_ERROR_HISTORY_PATH) return null;
    switch (request.method()) {
      case "GET":
        return { body: history, status: 200 };
      case "POST": {
        const append = request.postDataJSON();
        if (append.clearGeneration !== history.clearGeneration) {
          return { body: { code: "session_error_history_cleared" }, status: 409 };
        }
        for (const { eventId, ...event } of append.events) {
          if (history.entries.some((entry) => entry.fingerprint === eventId)) continue;
          history.entries.push({ ...event, fingerprint: eventId, sessionId });
          history.revision += 1;
        }
        return { body: history, status: 200 };
      }
      case "DELETE":
        history.entries = [];
        history.clearGeneration += 1;
        history.revision += 1;
        return { body: history, status: 200 };
      default:
        return null;
    }
  };
}
