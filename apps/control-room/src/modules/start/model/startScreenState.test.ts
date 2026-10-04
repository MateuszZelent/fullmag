import { afterEach, describe, expect, it, vi } from "vitest";

import { startScreenStore, type StartScreenHost } from "./startScreenState";

function fakeHost(): StartScreenHost {
  return {
    createProblemDisabledReason: null,
    disabledReason: () => null,
    execute: async () => ({ status: "completed" }),
    isEnabled: () => true,
  };
}

afterEach(() => {
  startScreenStore.resetForTests();
});

describe("startScreenStore", () => {
  it("returns to Home when the screen detaches", () => {
    const detach = startScreenStore.attach(fakeHost());
    startScreenStore.setSection("learn");

    detach();

    expect(startScreenStore.getSnapshot()).toEqual({
      host: null,
      section: "home",
      selectedProjectId: null,
      selectedScriptId: null,
      openScriptNonce: 0,
      selectedTemplateId: null,
      searchFocusNonce: 0,
      rebuildNonce: 0,
      focusListNonce: 0,
      docsRequest: null,
      selectionAction: null,
    });
  });

  it("does not let a stale detach undo a newer attach", () => {
    const first = fakeHost();
    const second = fakeHost();
    const detachFirst = startScreenStore.attach(first);
    startScreenStore.attach(second);

    detachFirst();

    expect(startScreenStore.getSnapshot().host).toBe(second);
  });

  it("notifies only on change and keeps the snapshot identity otherwise", () => {
    const listener = vi.fn();
    startScreenStore.subscribe(listener);
    const before = startScreenStore.getSnapshot();

    startScreenStore.setSection("home");
    expect(listener).not.toHaveBeenCalled();
    expect(startScreenStore.getSnapshot()).toBe(before);

    startScreenStore.setSection("import");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps one selected item: a project and a script exclude each other", () => {
    startScreenStore.setSelectedProject("p1");
    startScreenStore.setSelectedScript(7);
    expect(startScreenStore.getSnapshot()).toMatchObject({
      selectedProjectId: null,
      selectedScriptId: 7,
    });

    startScreenStore.setSelectedProject("p2");
    expect(startScreenStore.getSnapshot()).toMatchObject({
      selectedProjectId: "p2",
      selectedScriptId: null,
    });

    // Clearing one kind does not clear the other.
    startScreenStore.setSelectedScript(9);
    startScreenStore.setSelectedProject(null);
    expect(startScreenStore.getSnapshot().selectedScriptId).toBe(9);
  });

  it("makes every open-script request distinct", () => {
    startScreenStore.requestOpenScript();
    startScreenStore.requestOpenScript();
    expect(startScreenStore.getSnapshot().openScriptNonce).toBe(2);
  });

  it("renders Home on the server", () => {
    startScreenStore.attach(fakeHost());
    startScreenStore.setSection("about");

    expect(startScreenStore.getServerSnapshot()).toEqual({
      host: null,
      section: "home",
      selectedProjectId: null,
      selectedScriptId: null,
      openScriptNonce: 0,
      selectedTemplateId: null,
      searchFocusNonce: 0,
      rebuildNonce: 0,
      focusListNonce: 0,
      docsRequest: null,
      selectionAction: null,
    });
  });
});
