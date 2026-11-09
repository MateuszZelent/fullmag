import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StudyRuntimeSection } from "./StudyInspectorPanel";
import { resolveStudyInspectorModel, studySnapshotFromScene } from "./StudyInspectorPanelModel";

function recoveryMarkup(retryReason: string | null) {
  const runCommand = vi.fn();
  const html = renderToStaticMarkup(
    <StudyRuntimeSection
      commandDisabledReason={(id) => id === "study.retry-compute"
        ? retryReason : "Wait for the original Compute confirmation."}
      model={resolveStudyInspectorModel({
        currentRun: null,
        snapshot: studySnapshotFromScene(null),
        solverStatus: null,
        stageExecution: null,
      })}
      onOpenCommand={() => undefined}
      runCommand={runCommand}
      stepValue="unavailable"
    />,
  );
  const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)];
  return { html, buttons, runCommand };
}

describe("Study Runtime Compute recovery affordance", () => {
  it("keeps an explicit original-request retry visible while a fresh Compute is blocked", () => {
    const { html, buttons, runCommand } = recoveryMarkup(null);
    const retry = buttons.find(([, , label]) => label.includes("Retry original Compute"));
    const compute = buttons.find(([, attributes]) => /aria-label="Compute:/.test(attributes));

    expect(retry).toBeDefined();
    expect(retry![1]).not.toContain("disabled");
    expect(compute).toBeDefined();
    expect(compute![1]).toContain("disabled");
    expect(html).toContain("confirmation");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("does not offer retry when the original request body is unavailable", () => {
    const { html, runCommand } = recoveryMarkup("No original Compute request is available for retry.");

    expect(html).not.toContain("Retry original Compute");
    expect(runCommand).not.toHaveBeenCalled();
  });
});
