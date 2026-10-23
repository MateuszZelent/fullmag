import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import { FeedbackBanner } from "./FeedbackBanner";
import { FieldRow } from "./FieldRow";

export function GeometryValidationSummary({
  error,
  hasData,
  messages,
  refreshError,
  status,
}: {
  error: Error | null;
  hasData: boolean;
  messages: readonly string[];
  refreshError?: Error | null;
  status: ResourceStatus;
}) {
  const failures = [error, refreshError]
    .filter((failure): failure is Error => failure !== null && failure !== undefined)
    .map((failure) => failure.message)
    .filter((message, index, allMessages) => allMessages.indexOf(message) === index);
  const isCurrentResult =
    status === "ready" && hasData && failures.length === 0;
  const isPreviousResult = hasData && !isCurrentResult;

  let notice: string | null = null;
  let noticeKind: "error" | "warning" = "warning";
  if (failures.length > 0) {
    noticeKind = hasData ? "warning" : "error";
    notice = hasData
      ? `Geometry validation refresh failed: ${failures.join("; ")}. Showing the previous result.`
      : `Geometry validation could not be loaded: ${failures.join("; ")}. No validation result is available.`;
  } else if (isPreviousResult) {
    if (status === "stale") {
      notice = "The geometry validation result is stale; showing the previous result.";
    } else if (status === "loading") {
      notice = "Geometry validation is refreshing; showing the previous result.";
    } else if (status === "idle") {
      notice = "Geometry validation is idle; showing the previous result.";
    } else {
      notice = `Geometry validation is ${status}; showing the previous result.`;
    }
  } else if (status === "loading") {
    notice = "Geometry validation is loading.";
  } else if (status === "idle") {
    notice = "Geometry validation has not loaded for this session.";
  } else if (status === "stale") {
    notice = "No previous geometry validation result is available.";
  } else if (status === "error") {
    notice = "Geometry validation is unavailable; no result data was returned.";
    noticeKind = "error";
  } else if (status === "ready") {
    notice = "Geometry validation returned no result data.";
  }

  return (
    <>
      <FieldRow label="Fetch state" value={status} status={status} />
      {notice ? <FeedbackBanner kind={noticeKind} message={notice} /> : null}
      {messages.length > 0 ? (
        <ul className="fm-inspector-validation-list">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : isCurrentResult ? (
        <FieldRow label="Backend validation" value="no object issues" status="ready" />
      ) : isPreviousResult ? (
        <FieldRow
          label="Previous backend validation"
          value="no object issues (previous result)"
          status="stale"
        />
      ) : (
        <FieldRow label="Backend validation" value="unavailable" status={status} />
      )}
    </>
  );
}
