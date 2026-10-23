import { describe, expect, it } from "vitest";
import type { FrozenSpinsDefinition } from "@/kernel/api/apiTypes";
import { reconcileFrozenSpinsDraft } from "./frozenSpinsDraft";

const base: FrozenSpinsDefinition = {
  schema_version: "fullmag.frozen-spins.v1", id: "frozen", name: "A",
  selector: { kind: "in_object", object_id: "film" },
};

describe("Frozen Spins draft reconciliation", () => {
  it("adopts unrelated server fields while raw numeric text remains outside the AST", () => {
    expect(reconcileFrozenSpinsDraft(base, { ...base, name: "B" }, base, true)).toEqual({ draft: { ...base, name: "B" }, conflict: false });
  });
  it("keeps the visible selector and reports conflict when a server change would replace raw fields", () => {
    const incoming: FrozenSpinsDefinition = { ...base, name: "B", selector: { kind: "all_magnetic" } };
    expect(reconcileFrozenSpinsDraft(base, incoming, base, true)).toEqual({ draft: { ...base, name: "B" }, conflict: true });
  });
  it("merges independent canonical edits without overwriting either side", () => {
    expect(reconcileFrozenSpinsDraft(base, { ...base, enabled: false }, { ...base, name: "Local" }, false)).toEqual({ draft: { ...base, enabled: false, name: "Local" }, conflict: false });
  });
  it("keeps a local conflicting value for explicit resolution", () => {
    const draft = { ...base, name: "Local" };
    expect(reconcileFrozenSpinsDraft(base, { ...base, name: "Server" }, draft, false)).toEqual({ draft, conflict: true });
  });
  it("accepts matching edits without a conflict", () => {
    const draft = { ...base, name: "Same" };
    expect(reconcileFrozenSpinsDraft(base, draft, draft, false)).toEqual({ draft, conflict: false });
  });
});
