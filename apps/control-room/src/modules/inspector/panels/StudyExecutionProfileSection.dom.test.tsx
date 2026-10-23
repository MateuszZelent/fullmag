import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import type {
  StudyExecutionProfileApplyResult,
  StudyExecutionProfileEditSession,
} from "./StudyExecutionProfileSection";
import { StudyExecutionProfileSection } from "./StudyExecutionProfileSection";

const mocks = vi.hoisted(() => ({
  resource: {
    data: {
      entries: [
        {
          client_intent_id: "profile-intent",
          profile: {
            defaults: { backend: "auto", device: "cpu", mode: "strict", precision: "double" },
            description: "Profile used by the acknowledgement tests.",
            profile_id: "test-profile",
            schema_version: "execution_profile.v1",
            version: "1",
          },
          profile_sha256: "test-profile-sha256",
          published_at: "2026-10-23T00:00:00Z",
          revision: 1,
        },
      ],
      next_offset: null,
      offset: 0,
      revision: 1,
      total: 1,
    },
    error: null as Error | null,
    refreshError: null as Error | null,
    refetch: vi.fn(),
    scope: "profile-catalog-test-scope",
    status: "ready" as "idle" | "loading" | "ready" | "stale" | "error",
  },
}));

vi.mock("@/kernel/resources/useExecutionProfilesResource", () => ({
  useExecutionProfilesResource: () => mocks.resource,
}));

const profile = mocks.resource.data.entries[0]!.profile;

describe("StudyExecutionProfileSection acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resource.error = null;
    mocks.resource.refreshError = null;
    mocks.resource.scope = "profile-catalog-test-scope";
    mocks.resource.status = "ready";
  });

  it("keeps a post-submit override edit dirty after the earlier assignment is acknowledged", async () => {
    const firstAck = deferred<StudyExecutionProfileApplyResult>();
    const secondAck = deferred<StudyExecutionProfileApplyResult>();
    const onApply = vi
      .fn()
      .mockImplementationOnce(() => firstAck.promise)
      .mockImplementationOnce(() => secondAck.promise);
    const harness = await mountSection({ onApply });

    try {
      await chooseProfile(harness.container);
      await changeInput(harness.container, "CPU threads override", "4");
      let applyResult!: Promise<boolean>;
      await act(async () => {
        applyResult = harness.applyRegisteredDraft();
        await flushPromises();
      });

      expect(onApply).toHaveBeenCalledOnce();
      expect(onApply.mock.calls[0]?.[0].execution_layers).toContainEqual(
        expect.objectContaining({
          request: expect.objectContaining({
            resources: expect.objectContaining({
              cpu: expect.objectContaining({ threads: 4 }),
            }),
          }),
        }),
      );
      await changeInput(harness.container, "CPU threads override", "8");
      await act(async () => {
        firstAck.resolve({ revision: 2, success: true });
        await flushPromises();
      });

      expect(await applyResult).toBe(false);
      expect(findControl(harness.container, "CPU threads override").value).toBe("8");
      expect(findButton(harness.container, "Apply execution profile").disabled).toBe(false);
      expect(harness.container.textContent).toContain(
        "Edits made while it was saving remain in the draft.",
      );

      await clickButton(harness.container, "Apply execution profile");
      expect(onApply).toHaveBeenCalledTimes(2);
      expect(onApply.mock.calls[1]?.[0].execution_layers).toContainEqual(
        expect.objectContaining({
          request: expect.objectContaining({
            resources: expect.objectContaining({
              cpu: expect.objectContaining({ threads: 8 }),
            }),
          }),
        }),
      );
      expect(onApply.mock.calls[1]?.[1]).toBe(2);
      await act(async () => {
        secondAck.resolve({ revision: 3, success: true });
        await flushPromises();
      });
      expect(findButton(harness.container, "Apply execution profile").disabled).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("becomes clean when no edits arrive after the submitted assignment", async () => {
    const onApply = vi.fn().mockResolvedValue({ revision: 2, success: true });
    const harness = await mountSection({ onApply });

    try {
      await chooseProfile(harness.container);
      let applyResult = false;
      await act(async () => {
        applyResult = await harness.applyRegisteredDraft();
      });

      expect(applyResult).toBe(true);
      expect(onApply).toHaveBeenCalledOnce();
      expect(findButton(harness.container, "Apply execution profile").disabled).toBe(true);
      expect(findControl(harness.container, "CPU threads override").value).toBe("");
    } finally {
      await harness.dispose();
    }
  });

  it("keeps the selected profile and its layers when a pending legacy removal is acknowledged", async () => {
    const removeAck = deferred<StudyExecutionProfileApplyResult>();
    const onApply = vi
      .fn()
      .mockImplementationOnce(() => removeAck.promise)
      .mockResolvedValueOnce({ revision: 3, success: true });
    const layer = {
      origin: { kind: "study", location: "Existing Study profile" },
      request: { precision: "single", resources: { cpu: { threads: 4 } } },
    };
    const harness = await mountSection({
      onApply,
      scene: {
        study: {
          execution_layers: [layer],
          execution_profile: profile,
        },
      },
    });

    try {
      await chooseProfile(harness.container, "__legacy__");
      let applyResult!: Promise<boolean>;
      await act(async () => {
        applyResult = harness.applyRegisteredDraft();
        await flushPromises();
      });
      expect(onApply.mock.calls[0]?.[0]).toMatchObject({
        execution_layers: null,
        execution_profile: null,
      });

      await chooseProfile(
        harness.container,
        JSON.stringify([profile.profile_id, profile.version]),
      );
      await act(async () => {
        removeAck.resolve({ revision: 2, success: true });
        await flushPromises();
      });

      expect(await applyResult).toBe(false);
      expect(findControl(harness.container, "Immutable profile version").value).toBe(
        JSON.stringify([profile.profile_id, profile.version]),
      );
      expect(findControl(harness.container, "CPU threads override").value).toBe("4");
      expect(findButton(harness.container, "Apply execution profile").disabled).toBe(false);

      await clickButton(harness.container, "Apply execution profile");
      await flushPromises();
      expect(onApply).toHaveBeenCalledTimes(2);
      expect(onApply.mock.calls[1]?.[0].execution_profile).toEqual(profile);
      expect(onApply.mock.calls[1]?.[0].execution_layers).toContainEqual(
        expect.objectContaining({
          origin: layer.origin,
          request: expect.objectContaining({
            precision: "single",
            resources: expect.objectContaining({
              cpu: expect.objectContaining({ threads: 4 }),
            }),
          }),
        }),
      );
      expect(onApply.mock.calls[1]?.[1]).toBe(2);
    } finally {
      await harness.dispose();
    }
  });

  it("preserves the dirty draft when the apply callback reports failure", async () => {
    const onApply = vi.fn().mockResolvedValue({
      message: "The scene revision changed.",
      stale: true,
      success: false,
    });
    const harness = await mountSection({ onApply });

    try {
      await chooseProfile(harness.container);
      await changeInput(harness.container, "CPU threads override", "4");
      await clickButton(harness.container, "Apply execution profile");
      await flushPromises();

      expect(findControl(harness.container, "CPU threads override").value).toBe("4");
      expect(findButton(harness.container, "Apply execution profile").disabled).toBe(true);
      expect(findButton(harness.container, "Cancel").disabled).toBe(false);
      expect(harness.container.textContent).toContain("The scene revision changed.");
    } finally {
      await harness.dispose();
    }
  });

  it("does not let a late acknowledgement replace a draft in a new session scope", async () => {
    const oldAck = deferred<StudyExecutionProfileApplyResult>();
    const onApply = vi.fn().mockImplementationOnce(() => oldAck.promise);
    const harness = await mountSection({ onApply, sessionScopeKey: "session-a" });

    try {
      await chooseProfile(harness.container);
      await clickButton(harness.container, "Apply execution profile");
      await flushPromises();

      mocks.resource.scope = "profile-catalog-next-scope";
      await harness.render({ onApply, sessionScopeKey: "session-b", sceneRevision: 7 });
      await chooseProfile(harness.container);
      await changeInput(harness.container, "CPU threads override", "12");

      await act(async () => {
        oldAck.resolve({ revision: 2, success: true });
        await flushPromises();
      });

      expect(findControl(harness.container, "CPU threads override").value).toBe("12");
      expect(findButton(harness.container, "Apply execution profile").disabled).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});

function createSectionProps({
  onApply,
  onEditSessionChange,
  scene = { study: {} },
  sceneRevision = 1,
  sessionScopeKey = "session-a",
}: {
  onApply: (assignment: unknown, baseRevision: number) => Promise<StudyExecutionProfileApplyResult>;
  onEditSessionChange?: (session: StudyExecutionProfileEditSession | null) => void;
  scene?: unknown;
  sceneRevision?: number;
  sessionScopeKey?: string;
}) {
  return {
    authoringBusy: false,
    onApply,
    onEditSessionChange: onEditSessionChange ?? vi.fn(),
    otherAuthoringDirty: false,
    scene,
    sceneRevision,
    sceneStatus: "ready",
    sessionScopeKey,
    stages: [],
  };
}

async function mountSection(options: {
  onApply: (assignment: unknown, baseRevision: number) => Promise<StudyExecutionProfileApplyResult>;
  scene?: unknown;
  sceneRevision?: number;
  sessionScopeKey?: string;
}) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  let editSession: StudyExecutionProfileEditSession | null = null;
  const onEditSessionChange = (session: StudyExecutionProfileEditSession | null) => {
    editSession = session;
  };
  const render = async (nextOptions: typeof options) => {
    await act(async () => {
      root.render(
        <StudyExecutionProfileSection
          {...createSectionProps({ ...nextOptions, onEditSessionChange })}
        />,
      );
    });
  };
  await render(options);
  return {
    container,
    dispose: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
    applyRegisteredDraft: () => {
      if (!editSession) throw new Error("Study edit session is not registered.");
      return editSession.apply();
    },
    render,
  };
}

async function chooseProfile(
  container: TestNode,
  selectedProfile = JSON.stringify([profile.profile_id, profile.version]),
): Promise<void> {
  await act(async () => {
    const select = findControl(container, "Immutable profile version");
    select.value = selectedProfile;
    select.dispatchEvent(new TestEvent("change", { bubbles: true }));
  });
}

async function changeInput(container: TestNode, label: string, value: string): Promise<void> {
  await act(async () => {
    const input = findControl(container, label);
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      TestElement.prototype,
      "value",
    )?.set;
    if (!nativeValueSetter) throw new Error("Missing native test input value setter.");
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

async function clickButton(container: TestNode, text: string): Promise<void> {
  await act(async () => findButton(container, text).click());
}

function findControl(container: TestNode, label: string): TestElement {
  const control = findElements(container, (element) =>
    (element.tagName === "INPUT" || element.tagName === "SELECT") &&
    element.getAttribute("aria-label") === label,
  )[0];
  if (!control) throw new Error(`Missing control ${label}.`);
  return control;
}

function findButton(container: TestNode, text: string): TestElement {
  const button = findElements(container, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text),
  )[0];
  if (!button) throw new Error(`Missing button ${text}.`);
  return button;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
