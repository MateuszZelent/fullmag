import { describe, expect, it } from "vitest";

import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
} from "./inspectorDraftState";

interface DraftFixture {
  value: string;
}

function dirty(draft: DraftFixture, baseDraft: DraftFixture): boolean {
  return draft.value !== baseDraft.value;
}

describe("inspectorDraftState", () => {
  it("keeps a dirty draft when the same resource publishes a new base snapshot", () => {
    const state = updateInspectorDraftState({
      baseDraft: { value: "server-a" },
      baseKey: "revision:1",
      currentDraft: { value: "server-a" },
      identityKey: "object:film",
      isDirty: dirty,
      patch: { value: "local-edit" },
    });

    expect(
      resolveInspectorDraftState({
        baseDraft: { value: "server-b" },
        baseKey: "revision:2",
        identityKey: "object:film",
        isDirty: dirty,
        state,
      }),
    ).toEqual({
      dirty: true,
      draft: { value: "local-edit" },
    });
  });

  it("refreshes a clean draft when the same resource publishes a new base snapshot", () => {
    const state = initialInspectorDraftState({
      baseDraft: { value: "server-a" },
      baseKey: "revision:1",
      identityKey: "object:film",
    });

    expect(
      resolveInspectorDraftState({
        baseDraft: { value: "server-b" },
        baseKey: "revision:2",
        identityKey: "object:film",
        isDirty: dirty,
        state,
      }),
    ).toEqual({
      dirty: false,
      draft: { value: "server-b" },
    });
  });

  it("resets to the base draft when selection identity changes", () => {
    const state = updateInspectorDraftState({
      baseDraft: { value: "server-a" },
      baseKey: "revision:1",
      currentDraft: { value: "server-a" },
      identityKey: "object:film",
      isDirty: dirty,
      patch: { value: "local-edit" },
    });

    expect(
      resolveInspectorDraftState({
        baseDraft: { value: "other" },
        baseKey: "revision:1",
        identityKey: "object:other",
        isDirty: dirty,
        state,
      }),
    ).toEqual({
      dirty: false,
      draft: { value: "other" },
    });
  });
});
