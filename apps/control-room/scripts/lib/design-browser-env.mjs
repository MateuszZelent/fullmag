import assert from "node:assert/strict";

// Shared inputs of the Control Room design browser checks. There is no default
// port: each DEV group publishes its own, so the caller names the page to test.
export function designCheckUrl() {
  const url = process.env.CONTROL_ROOM_URL;
  assert(url, "Set CONTROL_ROOM_URL to the workspace page of the DEV group under test, e.g. http://127.0.0.1:<port>/workspace.");
  return url;
}

export function designReportDir() {
  const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
  assert(output, "Set CONTROL_ROOM_DESIGN_REPORT_DIR to the task's registered run directory.");
  return output;
}
