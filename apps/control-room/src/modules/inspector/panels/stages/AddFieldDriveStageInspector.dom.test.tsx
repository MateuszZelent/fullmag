import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
} from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  createDefaultStudyStageDraft,
  type StudyStageDraft,
} from "../StudyStageAuthoringModel";
import { StudyStageInspectorRouter } from "../StudyStageInspectorRouter";
import { validateFieldDriveDraft } from "@/shared/domain/physics/fieldDrive";

import {
  AddFieldDriveStageInspector,
} from "./AddFieldDriveStageInspector";
import type { StageInspectorFrameProps } from "./StageInspectorFrame";

const mockedUseStudyInspectorPanelController = vi.hoisted(() => vi.fn());

vi.mock("../StudyInspectorPanel", () => ({
  useStudyInspectorPanelController: mockedUseStudyInspectorPanelController,
}));

let routerController: ReturnType<typeof createRouterController> | null = null;

afterEach(() => {
  mockedUseStudyInspectorPanelController.mockReset();
  routerController = null;
});

describe("AddFieldDriveStageInspector numeric drafts", () => {
  it("keeps blank and sign-only text raw without writing zero, then allows explicit discard", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const onCommit = vi.fn();
    const onUpdateDraft = vi.fn();

    try {
      await act(async () => root.render(
        <StatefulAddFieldDrive
          onCommit={onCommit}
          onUpdateDraft={onUpdateDraft}
        />,
      ));

      const amplitude = findInput(container, "Amplitude");
      expect(amplitude.value).toBe("1");
      await act(async () => editControl(amplitude, ""));
      await act(async () => blurControl(amplitude));
      expect(onUpdateDraft).not.toHaveBeenCalled();
      expect(amplitude.value).toBe("");

      await act(async () => editControl(amplitude, "-"));
      await act(async () => blurControl(amplitude));
      expect(onUpdateDraft).not.toHaveBeenCalled();
      expect(amplitude.value).toBe("-");
      expect(findButton(container, "Discard pending inputs")).toBeDefined();

      await act(async () => findButton(container, "Discard pending inputs").click());
      expect(findInput(container, "Amplitude").value).toBe("1");
      expect(onUpdateDraft).not.toHaveBeenCalled();

      await act(async () => findButton(container, "Save stage").click());
      expect(onCommit).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("commits an allowed true zero while converting displayed mT back to canonical T", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const onCommit = vi.fn();
    const onUpdateDraft = vi.fn();

    try {
      await act(async () => root.render(
        <StatefulAddFieldDrive
          onCommit={onCommit}
          onUpdateDraft={onUpdateDraft}
        />,
      ));

      const amplitude = findInput(container, "Amplitude");
      await act(async () => editControl(amplitude, "0"));
      expect(onUpdateDraft).not.toHaveBeenCalled();
      await act(async () => pressEnter(amplitude));

      const patch = onUpdateDraft.mock.calls[0]?.[0] as
        | AddFieldDrivePatch
        | undefined;
      expect(patch?.fieldDrive?.amplitude_B_T).toBe(0);
      expect(validateFieldDriveDraft(patch!.fieldDrive!)).not.toContain(
        "Amplitude must be finite and non-negative.",
      );
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps an optional sinc width blank as null instead of inventing zero", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const onCommit = vi.fn();
    const onUpdateDraft = vi.fn();
    const draft = createAddFieldDriveDraft();
    if (draft.kind !== "add_field_drive") throw new Error("Expected a Field Drive draft");
    const draftWithWidth: StudyStageDraft = {
      ...draft,
      fieldDrive: {
        ...draft.fieldDrive,
        spatial_profile: {
          axis: [1, 0, 0],
          center_m: 0,
          kind: "sinc",
          period_m: 1e-7,
          width_m: 2e-7,
          window: "none",
        },
      },
    };

    try {
      await act(async () => root.render(
        <StatefulAddFieldDrive
          initialDraft={draftWithWidth}
          onCommit={onCommit}
          onUpdateDraft={onUpdateDraft}
        />,
      ));

      const width = findInput(container, "Spatial width (m, optional)");
      expect(width.value).not.toBe("");
      await act(async () => editControl(width, ""));
      await act(async () => blurControl(width));

      const patch = onUpdateDraft.mock.calls[0]?.[0] as
        | AddFieldDrivePatch
        | undefined;
      expect(patch?.fieldDrive?.spatial_profile).toMatchObject({
        kind: "sinc",
        width_m: null,
      });
      expect(validateFieldDriveDraft(patch!.fieldDrive!)).not.toContain(
        "Spatial sinc width must be finite and positive when set.",
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("parks a hidden waveform draft until it is restored or explicitly discarded", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const onCommit = vi.fn();
    const onUpdateDraft = vi.fn();

    try {
      await act(async () => root.render(
        <StatefulAddFieldDrive
          onCommit={onCommit}
          onUpdateDraft={onUpdateDraft}
        />,
      ));
      const initialCutoff = findInput(container, "Cutoff fc").value;
      await act(async () => editControl(findInput(container, "Cutoff fc"), "-"));
      await act(async () => blurControl(findInput(container, "Cutoff fc")));

      await act(async () => changeSelect(findSelect(container, "Function in time"), "sinusoidal"));
      expect(findInput(container, "Frequency (Hz)").value).toBe("1e9");
      expect(findButton(container, "Discard pending inputs")).toBeDefined();
      expect(onCommit).not.toHaveBeenCalled();
      await act(async () => findButton(container, "Save stage").click());
      expect(onCommit).not.toHaveBeenCalled();

      await act(async () => changeSelect(findSelect(container, "Function in time"), "sinc_pulse"));
      expect(findInput(container, "Cutoff fc").value).toBe("-");
      await act(async () => findButton(container, "Discard pending inputs").click());
      expect(findInput(container, "Cutoff fc").value).toBe(initialCutoff);

      await act(async () => findButton(container, "Save stage").click());
      expect(onCommit).toHaveBeenCalledOnce();
      expect(onUpdateDraft).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps incomplete piecewise points raw and commits only a complete finite list", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const onCommit = vi.fn();
    const onUpdateDraft = vi.fn();

    try {
      await act(async () => root.render(
        <StatefulAddFieldDrive
          onCommit={onCommit}
          onUpdateDraft={onUpdateDraft}
        />,
      ));
      await act(async () => changeSelect(findSelect(container, "Function in time"), "piecewise_linear"));
      const updatesBeforePoints = onUpdateDraft.mock.calls.length;
      const points = findTextarea(container, "Points (time, value; one pair per line)");
      await act(async () => editControl(points, "0, 0\n-"));
      await act(async () => blurControl(points));
      expect(points.value).toBe("0, 0\n-");
      expect(onUpdateDraft).toHaveBeenCalledTimes(updatesBeforePoints);
      await act(async () => findButton(container, "Save stage").click());
      expect(onCommit).not.toHaveBeenCalled();

      await act(async () => editControl(points, "0, 0\n2e-9, 1"));
      await act(async () => blurControl(points));
      const patch = onUpdateDraft.mock.calls.at(-1)?.[0] as
        | AddFieldDrivePatch
        | undefined;
      expect(onUpdateDraft).toHaveBeenCalledTimes(updatesBeforePoints + 1);
      expect(patch?.fieldDrive?.waveform).toMatchObject({
        kind: "piecewise_linear",
        points: [[0, 0], [2e-9, 1]],
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("blocks local and registered applies on raw input and protects reset while authoring is busy", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    routerController = createRouterController();
    mockedUseStudyInspectorPanelController.mockImplementation(
      () => routerController!.value,
    );
    const renderRouter = () => (
      <InspectorEditSessionProvider store={sessions}>
        <StudyStageInspectorRouter selection={studyStageSelection()} />
      </InspectorEditSessionProvider>
    );

    try {
      await act(async () => root.render(renderRouter()));
      const amplitude = findInput(container, "Amplitude");
      await act(async () => editControl(amplitude, "2"));

      const registered = sessions.getCurrentSession();
      expect(registered?.dirty).toBe(true);
      expect(registered?.valid).toBe(false);
      expect(registered?.applyBlockReason).toContain("pending numeric inputs");
      let applied: boolean | undefined;
      await act(async () => {
        applied = await registered!.apply();
      });
      expect(applied).toBe(false);
      expect(routerController!.commitStageDrafts).not.toHaveBeenCalled();

      await act(async () => editControl(amplitude, "-"));
      const save = findButton(container, "Save stage");
      expect(save.disabled).toBe(true);
      await act(async () => save.click());
      expect(routerController!.commitStageDrafts).not.toHaveBeenCalled();

      routerController!.value.state.authoringBusy = true;
      await act(async () => root.render(renderRouter()));
      await act(async () => sessions.getCurrentSession()!.reset());
      expect(findInput(container, "Amplitude").value).toBe("-");
      expect(routerController!.dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "revertStageDrafts" }),
      );

      routerController!.value.state.authoringBusy = false;
      await act(async () => root.render(renderRouter()));
      await act(async () => sessions.getCurrentSession()!.reset());
      expect(findInput(container, "Amplitude").value).toBe("1");
      expect(routerController!.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "revertStageDrafts" }),
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("clears raw drafts when the session or stable stage identity changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    routerController = createRouterController();
    mockedUseStudyInspectorPanelController.mockImplementation(
      () => routerController!.value,
    );
    const renderRouter = () => (
      <InspectorEditSessionProvider store={sessions}>
        <StudyStageInspectorRouter selection={studyStageSelection()} />
      </InspectorEditSessionProvider>
    );

    try {
      await act(async () => root.render(renderRouter()));
      await act(async () => editControl(findInput(container, "Amplitude"), "-"));
      await act(async () => blurControl(findInput(container, "Amplitude")));
      expect(findInput(container, "Amplitude").value).toBe("-");

      routerController!.value.sessionScopeKey = "session-b";
      await act(async () => root.render(renderRouter()));
      expect(findInput(container, "Amplitude").value).toBe("1");

      await act(async () => editControl(findInput(container, "Amplitude"), "-"));
      await act(async () => blurControl(findInput(container, "Amplitude")));
      expect(findInput(container, "Amplitude").value).toBe("-");

      routerController!.value.state.selectedDraftIndex = 1;
      await act(async () => root.render(renderRouter()));
      expect(findInput(container, "Amplitude").value).toBe("1");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves raw input across a stage ID rename and blocks both applies", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    routerController = createRouterController();
    mockedUseStudyInspectorPanelController.mockImplementation(
      () => routerController!.value,
    );
    const selection = studyStageSelection("canonical-stage-1", 0);
    const renderRouter = (nextSelection = selection) => (
      <InspectorEditSessionProvider store={sessions}>
        <StudyStageInspectorRouter selection={nextSelection} />
      </InspectorEditSessionProvider>
    );

    try {
      await act(async () => root.render(renderRouter()));
      await act(async () => editControl(findInput(container, "Amplitude"), "-"));
      await act(async () => blurControl(findInput(container, "Amplitude")));

      await act(async () =>
        editControl(findInput(container, "Stage ID"), "renamed-stage-id"),
      );
      await act(async () => root.render(renderRouter()));

      expect(findInput(container, "Amplitude").value).toBe("-");
      expect(findInput(container, "Stage ID").value).toBe("renamed-stage-id");
      expect(findButton(container, "Save stage").disabled).toBe(true);
      expect(sessions.getCurrentSession()?.dirty).toBe(true);
      expect(sessions.getCurrentSession()?.valid).toBe(false);
      expect(sessions.getCurrentSession()?.applyBlockReason).toContain(
        "pending numeric inputs",
      );
      let applied: boolean | undefined;
      await act(async () => {
        applied = await sessions.getCurrentSession()!.apply();
      });
      expect(applied).toBe(false);
      expect(routerController!.commitStageDrafts).not.toHaveBeenCalled();

      routerController!.value.state.selectedDraftIndex = 1;
      await act(async () =>
        root.render(renderRouter(studyStageSelection("canonical-stage-2", 1))),
      );
      expect(findInput(container, "Amplitude").value).toBe("1");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function StatefulAddFieldDrive({
  initialDraft,
  onCommit,
  onUpdateDraft,
}: {
  initialDraft?: StudyStageDraft;
  onCommit: () => void;
  onUpdateDraft: (patch: Partial<StudyStageDraft>) => void;
}) {
  const [draft, setDraft] = useState(initialDraft ?? createAddFieldDriveDraft);
  const updateDraft = (patch: Partial<StudyStageDraft>) => {
    onUpdateDraft(patch);
    setDraft((current) => ({ ...current, ...patch }) as StudyStageDraft);
  };
  return (
    <AddFieldDriveStageInspector
      {...stageProps(draft, updateDraft, onCommit)}
    />
  );
}

function stageProps(
  draft: StudyStageDraft,
  onUpdateDraft: (patch: Partial<StudyStageDraft>) => void,
  onCommit: () => void,
): StageInspectorFrameProps {
  return {
    authoringBusy: false,
    authoringFeedback: null,
    draft,
    draftIndex: 0,
    expectedKind: "add_field_drive",
    kindLabel: "Add Field Drive",
    onCommit,
    onUpdateDraft,
    scene: null,
    stage: null,
    stageExecutionRevision: null,
    validation: [],
  };
}

function createAddFieldDriveDraft(): StudyStageDraft {
  return createDefaultStudyStageDraft("add_field_drive", 0);
}

type AddFieldDrivePatch = Partial<
  Extract<StudyStageDraft, { kind: "add_field_drive" }>
>;

function createRouterController() {
  const firstDraft = createAddFieldDriveDraft();
  const secondDraft = {
    ...createDefaultStudyStageDraft("add_field_drive", 1),
    stageId: "add_field_drive-stable-second",
  };
  const drafts = [firstDraft, secondDraft];
  const state = {
    authoringBusy: false,
    authoringFeedback: null,
    authoringFeedbackScope: null,
    baselineStageDrafts: drafts,
    globalDraft: { demagEnabled: false, requestedPrecision: "float64" },
    selectedDraftIndex: 0,
    stageDrafts: drafts,
  };
  const dispatch = vi.fn((action: {
    type: string;
    index?: number;
    patch?: Partial<StudyStageDraft>;
  }) => {
    if (action.type === "revertStageDrafts") {
      state.stageDrafts = state.baselineStageDrafts;
    } else if (
      action.type === "updateStageDraft" &&
      action.index != null &&
      action.patch
    ) {
      state.stageDrafts = state.stageDrafts.map((draft, index) =>
        index === action.index
          ? ({ ...draft, ...action.patch } as StudyStageDraft)
          : draft,
      );
    }
  });
  const commitStageDrafts = vi.fn(async () => true);
  return {
    commitStageDrafts,
    dispatch,
    value: {
      commandDisabledReason: () => null,
      commitStageDrafts,
      dispatch,
      k0ModalReadinessFor: () => ({}),
      model: {
        requested: { backend: "fdm", device: "cpu", mode: "time" },
        selectedStage: null,
      },
      runtimeStatus: null,
      runCommand: vi.fn(),
      scene: { data: null, status: "ready" },
      sceneHasPayload: false,
      sceneRevision: null,
      sceneStageCount: 0,
      sessionScopeKey: "session-a",
      stageExecution: { data: null },
      state,
    },
  };
}

function studyStageSelection(
  stageId?: string,
  stageIndex = 0,
): InspectorPanelProps["selection"] {
  if (stageId === undefined) {
    return {
      kind: "study.stage.add_field_drive",
      nodeId: "field-drive-stage",
    } as InspectorPanelProps["selection"];
  }
  const nodeId = `study:session:stage:${stageId}`;
  return {
    kind: "study.stage.add_field_drive",
    nodeId,
    ref: {
      kind: "study.stage.add_field_drive",
      nodeId,
      stageId,
      stageIndex,
      type: "study-stage",
    },
  } as InspectorPanelProps["selection"];
}

function editControl(control: TestElement, value: string): void {
  const tracker = (control as TestElement & {
    _valueTracker?: { setValue: (next: string) => void };
  })._valueTracker;
  const previous = control.value;
  control.value = value;
  tracker?.setValue(previous);
  control.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

function changeSelect(control: TestElement, value: string): void {
  const tracker = (control as TestElement & {
    _valueTracker?: { setValue: (next: string) => void };
  })._valueTracker;
  const previous = control.value;
  control.value = value;
  tracker?.setValue(previous);
  control.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

function blurControl(control: TestElement): void {
  control.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
}

function pressEnter(control: TestElement): void {
  control.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
}

function findInput(root: TestNode, label: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
    "input " + label,
  );
}

function findTextarea(root: TestNode, label: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "TEXTAREA" && element.getAttribute("aria-label") === label,
    "textarea " + label,
  );
}

function findSelect(root: TestNode, label: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "SELECT" && element.getAttribute("aria-label") === label,
    "select " + label,
  );
}

function findButton(root: TestNode, text: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent.includes(text),
    "button " + text,
  );
}

function findElement(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
  description: string,
): TestElement {
  const visit = (node: TestNode): TestElement | null => {
    if (node instanceof TestElement && predicate(node)) return node;
    for (const child of node.childNodes) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const found = visit(root);
  if (!found) throw new Error("Missing " + description);
  return found;
}
