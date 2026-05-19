import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CommandDiagnosticEntry } from "@/kernel/commands/CommandDiagnosticsController";

import { CommandAuditTable } from "./CommandAuditTable";

describe("CommandAuditTable", () => {
  it("renders command audit source, status, and disabled reason", () => {
    const entries: CommandDiagnosticEntry[] = [
      {
        commandId: "study.compute-fields",
        disabledReason: "Field data plane is unavailable.",
        id: "1",
        message: "Field data plane is unavailable.",
        source: "ribbon",
        sourceDetail: "study",
        status: "disabled",
        timestampMs: 1_779_000_000_000,
      },
    ];

    const html = renderToStaticMarkup(<CommandAuditTable entries={entries} />);

    expect(html).toContain("Command audit");
    expect(html).toContain("study.compute-fields");
    expect(html).toContain("ribbon:study");
    expect(html).toContain("disabled");
    expect(html).toContain("Field data plane is unavailable.");
  });

  it("renders no markup when there are no command audit entries", () => {
    const html = renderToStaticMarkup(<CommandAuditTable entries={[]} />);

    expect(html).toBe("");
  });
});
