import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResultContextSelector,
  resultContextOptions,
} from "./ResultContextSelector";

describe("ResultContextSelector", () => {
  it("exposes only resource-backed or explicitly known run identities", () => {
    expect(
      resultContextOptions({
        currentRunId: "run-current",
        knownRunIds: ["run-saved", "run-current", "run-saved"],
      }),
    ).toEqual([
      { id: "run-current", label: "Current run · run-current" },
      { id: "run-saved", label: "Run · run-saved" },
    ]);
  });

  it("shows an honest unavailable state when no run resource exists", () => {
    const html = renderToStaticMarkup(
      <ResultContextSelector
        currentRunId={null}
        knownRunIds={[]}
        onChange={() => undefined}
        selectedRunId={null}
      />,
    );

    expect(html).toContain("Result context unavailable");
    expect(html).toContain("Run catalog is not published");
    expect(html).not.toContain("Recent Runs");
  });
});
