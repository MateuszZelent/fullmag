import { FRONTEND_DIAGNOSTIC_FLAGS } from "./frontendDiagnosticFlags";

export type FrontendDiagnosticConsoleLevel =
  | "debug"
  | "info"
  | "log"
  | "trace"
  | "groupCollapsed"
  | "groupEnd";

export function shouldWriteFrontendDiagnosticConsole(): boolean {
  return (
    typeof process !== "undefined" &&
    process.env.NODE_ENV !== "production" &&
    FRONTEND_DIAGNOSTIC_FLAGS.diagnosticConsole.enableFrontendRuntimeLogs
  );
}

export function writeFrontendDiagnosticConsole(
  level: FrontendDiagnosticConsoleLevel,
  ...args: unknown[]
): void {
  if (!shouldWriteFrontendDiagnosticConsole()) {
    return;
  }
  switch (level) {
    case "debug":
      console.debug(...args);
      return;
    case "info":
      console.info(...args);
      return;
    case "log":
      console.log(...args);
      return;
    case "trace":
      console.trace(...args);
      return;
    case "groupCollapsed":
      console.groupCollapsed(...args);
      return;
    case "groupEnd":
      console.groupEnd();
      return;
  }
}
