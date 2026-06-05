import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { Accordion } from "@/shared/ui/Accordion";

import { createDefaultStudyStageDraft } from "../StudyStageAuthoringModel";
import type { StudyStageModel } from "../StudyInspectorPanelModel";
import { EigenmodesStageInspector } from "./EigenmodesStageInspector";
import { FrequencyResponseStageInspector } from "./FrequencyResponseStageInspector";
import { HysteresisStageInspector } from "./HysteresisStageInspector";
import { RelaxStageInspector } from "./RelaxStageInspector";
import { RunStageInspector } from "./RunStageInspector";
import { SaveStateStageInspector } from "./SaveStateStageInspector";
import type { StageInspectorFrameProps } from "./StageInspectorFrame";

function stage(kind: string): StudyStageModel {
  return {
    algorithm: null,
    artifactRefs: [],
    checkpointRef: null,
    commandId: null,
    completedAtIso: null,
    completedAtUnixMs: null,
    energyTolerance: null,
    index: 0,
    kind,
    label: kind,
    maxSteps: null,
    progressPercent: 0,
    runtimeMetric: null,
    stageId: `${kind}-1`,
    status: "queued",
    stopReason: null,
    torqueTolerance: null,
    torqueToleranceFormatted: null,
    torqueToleranceShortFormatted: null,
    untilSeconds: null,
  };
}

function props(kind: Parameters<typeof createDefaultStudyStageDraft>[0]): StageInspectorFrameProps {
  return {
    authoringBusy: false,
    authoringFeedback: null,
    draft: createDefaultStudyStageDraft(kind, 0),
    draftIndex: 0,
    expectedKind: kind,
    kindLabel: kind,
    onCommit: () => undefined,
    onUpdateDraft: () => undefined,
    stage: stage(kind),
    stageExecutionRevision: 7,
    validation: [],
  };
}

function render(children: ReactNode): string {
  return renderToStaticMarkup(
    <Accordion type="multiple" defaultValue={["identity", "authoring", "telemetry"]}>
      {children}
    </Accordion>,
  );
}

describe("Study stage inspectors", () => {
  it("renders a dedicated inspector for every supported study stage kind", () => {
    expect(render(<RelaxStageInspector {...props("relax")} />)).toContain(
      "Relax Results",
    );
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Run Results",
    );
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Hysteresis Results");
    expect(
      render(<EigenmodesStageInspector {...props("eigenmodes")} />),
    ).toContain("Eigenmode Results");
    expect(
      render(
        <FrequencyResponseStageInspector
          {...props("frequency_response")}
        />,
      ),
    ).toContain("Frequency Results");
    expect(render(<SaveStateStageInspector {...props("save_state")} />)).toContain(
      "Output Settings",
    );
  });
});
