import { describe, expect, it, vi } from "vitest";

import { createInspectorChildDraftRegistry } from "./inspectorChildDraftRegistry";

describe("Inspector child draft registration", () => {
  it("updates the actions without notifying subscribers when visible flags are unchanged", () => {
    const registry = createInspectorChildDraftRegistry<{ dirty: boolean; valid: boolean; reset: () => void }>();
    const owner = Symbol();
    const onChange = vi.fn();
    const unsubscribe = registry.subscribe(onChange);

    const first = { dirty: true, valid: true, reset: vi.fn() };
    registry.publish(owner, "texture:A", first);
    const snapshot = registry.getSnapshot();
    const next = { ...first, reset: vi.fn() };
    registry.publish(owner, "texture:A", next);

    expect(registry.getSnapshot()).toBe(snapshot);
    expect(registry.getSession("texture:A")).toBe(next);
    expect(registry.getSession("texture:B")).toBeNull();
    expect(onChange).toHaveBeenCalledOnce();

    unsubscribe();
    registry.retire(owner);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("does not retire a replacement editor for the same target", () => {
    const registry = createInspectorChildDraftRegistry();
    const firstOwner = Symbol();
    const nextOwner = Symbol();

    registry.publish(firstOwner, "profile", { dirty: false, valid: true });
    registry.publish(nextOwner, "profile", { dirty: true, valid: false });
    registry.retire(firstOwner);

    expect(registry.getSnapshot()).toMatchObject({ dirty: true, valid: false });
    registry.retire(nextOwner);
    expect(registry.getSession("profile")).toBeNull();
    expect(registry.getSnapshot()).toBeNull();
    expect(registry.getServerSnapshot()).toBeNull();
  });
});
