import { describe, expect, it, vi } from "vitest";

import { inspectorActionState, type InspectorEditSession } from "./InspectorEditSession";
import {
  applyInspectorSessionAndShouldContinue,
  shouldGuardInspectorSelection,
} from "./InspectorDirtySelectionGuard";

function session(
  patch: Partial<InspectorEditSession> = {},
): InspectorEditSession {
  return {
    apply: vi.fn(),
    applying: false,
    dirty: false,
    mode: "staged",
    reset: vi.fn(),
    valid: true,
    ...patch,
  };
}

describe("inspectorActionState", () => {
  it("enables Apply only for a valid dirty staged draft", () => {
    expect(inspectorActionState(session({ dirty: true })).canApply).toBe(true);
    expect(inspectorActionState(session({ dirty: false })).canApply).toBe(false);
    expect(inspectorActionState(session({ dirty: true, valid: false })).canApply).toBe(false);
  });

  it("keeps live viewport Reset honest without presenting Apply", () => {
    const state = inspectorActionState(
      session({ dirty: true, mode: "liveViewport" }),
    );

    expect(state.canApply).toBe(false);
    expect(state.canReset).toBe(true);
    expect(state.applyReason).toBe("Viewport changes are applied live");
  });

  it("explains a runtime lock", () => {
    const state = inspectorActionState(
      session({ dirty: true, lockReason: "Locked while the solver is running" }),
    );

    expect(state.canApply).toBe(false);
    expect(state.canReset).toBe(false);
    expect(state.applyReason).toBe("Locked while the solver is running");
  });

  it("guards selection only for an unapplied staged draft", () => {
    expect(shouldGuardInspectorSelection(session({ dirty: true, mode: "staged" }))).toBe(true);
    expect(shouldGuardInspectorSelection(session({ dirty: true, mode: "liveViewport" }))).toBe(false);
    expect(shouldGuardInspectorSelection(session({ dirty: true, mode: "immediate" }))).toBe(false);
    expect(shouldGuardInspectorSelection(session({ dirty: false, mode: "staged" }))).toBe(false);
  });

  it("continues a guarded selection change only after confirmed apply success", async () => {
    expect(
      await applyInspectorSessionAndShouldContinue(
        session({ apply: vi.fn().mockResolvedValue(true) }),
      ),
    ).toBe(true);
    expect(
      await applyInspectorSessionAndShouldContinue(
        session({ apply: vi.fn().mockResolvedValue(false) }),
      ),
    ).toBe(false);
  });
});
