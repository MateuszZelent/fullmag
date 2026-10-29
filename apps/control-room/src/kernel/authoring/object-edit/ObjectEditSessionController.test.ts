import { describe, expect, it } from "vitest";

import { ObjectEditSessionController } from "./ObjectEditSessionController";

describe("ObjectEditSessionController", () => {
  it("does not admit a late ACK into a later A-to-B-to-A selection epoch", () => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const targetA = {
      objectId: "object-a",
      sessionScopeKey: "session-a",
      targetKey: "object.geometry:object-a",
    };
    const identityA1 = controller.activate(targetA, { value: 1 });
    const operation = controller.beginApply(identityA1);
    expect(operation).not.toBeNull();

    controller.activate({
      objectId: "object-b",
      sessionScopeKey: "session-a",
      targetKey: "object.geometry:object-b",
    }, { value: 20 });
    const identityA3 = controller.activate(targetA, { value: 3 });

    expect(identityA3.epoch).toBeGreaterThan(identityA1.epoch);
    expect(controller.acknowledge(
      operation!,
      { value: 2 },
      (_current, _submitted, canonical) => ({ dirty: false, draft: canonical }),
    )).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      draft: { value: 3 },
      identity: identityA3,
    });
  });

  it("can reconcile unsent fields even without edits during the submitted operation", () => {
    const controller = new ObjectEditSessionController<{ name: string; position: number }>();
    const identity = controller.activate({ objectId: "a", sessionScopeKey: "s", targetKey: "a" }, { name: "Unsent name", position: 1 });
    const operation = controller.beginApply(identity)!;
    let reconciliations = 0;
    expect(controller.acknowledge(operation, { name: "Server name", position: 2 }, (current, _submitted, canonical) => {
      reconciliations += 1;
      return { dirty: true, draft: { ...canonical, name: current.name } };
    }, { reconcileUnchangedDraft: true })).toBe(true);
    expect(reconciliations).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ applyOperationId: null, dirty: true, draft: { name: "Unsent name", position: 2 } });
  });
  it("keeps edits made after Apply while adopting the acknowledged baseline", () => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const identity = controller.activate({
      objectId: "object-a",
      sessionScopeKey: "session-a",
      targetKey: "object.geometry:object-a",
    }, { value: 0 });
    controller.updateDraft(identity, () => ({ value: 1 }));
    const operation = controller.beginApply(identity)!;
    controller.updateDraft(identity, () => ({ value: 2 }));

    expect(controller.acknowledge(
      operation,
      { value: 1 },
      (currentDraft, submittedDraft, canonicalDraft) => ({
        dirty: currentDraft.value !== canonicalDraft.value,
        draft: currentDraft.value !== submittedDraft.value
          ? currentDraft
          : canonicalDraft,
      }),
    )).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      applyOperationId: null,
      dirty: true,
      draft: { value: 2 },
    });
  });

  it("releases session-scoped serialization after the session is cleared", () => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const target = {
      objectId: "object-a",
      sessionScopeKey: "session-a",
      targetKey: "object.geometry:object-a",
    };
    const oldIdentity = controller.activate(target, { value: 0 });
    const oldOperation = controller.beginApply(oldIdentity)!;

    controller.clear();
    const newIdentity = controller.activate(target, { value: 1 });

    expect(controller.beginApply(newIdentity)).not.toBeNull();
    expect(controller.acknowledge(
      oldOperation,
      { value: -1 },
      (_current, _submitted, canonical) => ({ dirty: false, draft: canonical }),
    )).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      draft: { value: 1 },
      identity: newIdentity,
    });
  });

  it("serializes Apply across objects in one session and notifies the new owner on release", () => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const target = (objectId: string) => ({ objectId, sessionScopeKey: "session-a", targetKey: objectId });
    const a = controller.activate(target("a"), { value: 1 });
    const operation = controller.beginApply(a)!;
    const b = controller.activate(target("b"), { value: 2 });
    expect(controller.getSnapshot().applyOperationId).toBeNull();
    expect(controller.hasPendingApply("session-a")).toBe(true);
    expect(controller.beginApply(b)).toBeNull();
    const beforeRelease = controller.getSnapshot();
    expect(controller.reject(operation)).toBe(false);
    expect(controller.getSnapshot()).not.toBe(beforeRelease);
    expect(controller.getSnapshot().draft).toEqual({ value: 2 });
    expect(controller.hasPendingApply("session-a")).toBe(false);
    expect(controller.beginApply(b)).not.toBeNull();
  });

  it("blocks both Apply during a gesture and gesture start during Apply", () => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const identity = controller.activate({ objectId: "a", sessionScopeKey: "scope-a", targetKey: "a" }, { value: 1 });
    const gesture = controller.beginGesture("scope-a", "a")!;
    expect(controller.hasActiveGesture("scope-a")).toBe(true);
    expect(controller.beginGesture("scope-a", "b")).toBeNull();
    expect(controller.beginApply(identity)).toBeNull();
    expect(controller.reset(identity, { value: 0 })).toBe(false);
    expect(controller.endGesture(gesture)).toBe(true);
    const operation = controller.beginApply(identity)!;
    expect(controller.beginGesture("scope-a", "a")).toBeNull();
    expect(controller.beginGesture("scope-a", "b")).toBeNull();
    controller.reject(operation);
    expect(controller.beginGesture("scope-a", "a")).not.toBeNull();
  });

  it("keeps reservations scoped and ignores a stale gesture release after clear", () => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const oldGesture = controller.beginGesture("scope-a", "a")!;
    const identity = controller.activate({ objectId: "b", sessionScopeKey: "scope-b", targetKey: "b" }, { value: 2 });
    expect(controller.beginApply(identity)).not.toBeNull();
    controller.clear();
    const newGesture = controller.beginGesture("scope-a", "a")!;
    expect(newGesture).not.toBe(oldGesture);
    expect(controller.endGesture(oldGesture)).toBe(false);
    expect(controller.hasActiveGesture("scope-a")).toBe(true);
    expect(controller.endGesture(newGesture)).toBe(true);
  });

  it.each(["gesture", "mutation"] as const)("notifies on clear of a %s reservation without an active draft", (kind) => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const token = kind === "gesture"
      ? controller.beginGesture("scope-a", "a")!
      : controller.beginSceneMutation("scope-a", "a")!;
    let notifications = 0;
    controller.subscribe(() => { notifications += 1; });
    const beforeClear = controller.getSnapshot();
    controller.clear();
    expect(notifications).toBe(1);
    expect(controller.getSnapshot()).not.toBe(beforeClear);
    expect(controller.hasActiveGesture("scope-a")).toBe(false);
    expect(controller.hasPendingWrite("scope-a")).toBe(false);
    expect(kind === "gesture" ? controller.endGesture(token) : controller.endSceneMutation(token)).toBe(false);
  });

  it("reserves identity and delete writes against Apply and gesture start", () => {
    const controller = new ObjectEditSessionController<{ value: number }>();
    const identity = controller.activate({ objectId: "a", sessionScopeKey: "scope-a", targetKey: "a" }, { value: 1 });
    const deletion = controller.beginSceneMutation("scope-a", "a")!;
    expect(controller.hasPendingWrite("scope-a")).toBe(true);
    expect(controller.hasPendingApply("scope-a")).toBe(false);
    expect(controller.beginApply(identity)).toBeNull();
    expect(controller.beginGesture("scope-a", "b")).toBeNull();
    expect(controller.beginSceneMutation("scope-a", "b")).toBeNull();
    expect(controller.endSceneMutation(deletion)).toBe(true);
    expect(controller.beginApply(identity)).not.toBeNull();
    expect(controller.beginSceneMutation("scope-a", "a")).toBeNull();
    controller.clear();
    const newer = controller.beginSceneMutation("scope-a", "a")!;
    expect(newer).not.toBe(deletion);
    expect(controller.endSceneMutation(deletion)).toBe(false);
    expect(controller.hasPendingWrite("scope-a")).toBe(true);
    expect(controller.endSceneMutation(newer)).toBe(true);
  });

  it("rebases a dirty draft only through the supplied rebase against the previous canonical", () => {
    type Draft = { base: number; name: string };
    const controller = new ObjectEditSessionController<Draft>();
    const identity = controller.activate({ objectId: "a", sessionScopeKey: "s", targetKey: "a" }, { base: 4, name: "Canonical" });
    controller.updateDraft(identity, (draft) => ({ ...draft, name: "Edited" }));
    const seen: Array<[Draft, Draft, Draft]> = [];

    controller.refreshCanonical(identity, { base: 5, name: "Canonical" }, (draft, previous, canonical) => {
      seen.push([draft, previous, canonical]);
      return { ...draft, base: canonical.base };
    });

    expect(seen).toEqual([[{ base: 4, name: "Edited" }, { base: 4, name: "Canonical" }, { base: 5, name: "Canonical" }]]);
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, draft: { base: 5, name: "Edited" } });

    controller.refreshCanonical(identity, { base: 6, name: "Canonical" });
    expect(controller.getSnapshot().draft).toEqual({ base: 5, name: "Edited" });
  });
});

