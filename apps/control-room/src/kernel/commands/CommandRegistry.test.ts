import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./CommandRegistry";
import type { CommandContribution } from "./commandTypes";

function command(id: string): CommandContribution {
  return {
    id,
    title: id,
    group: "test",
    scope: "global",
    run: () => ({ status: "completed" }),
  };
}

describe("CommandRegistry", () => {
  it("registers and lists commands", () => {
    const registry = new CommandRegistry();
    const contribution = command("workspace.reset-layout");

    registry.register(contribution);

    expect(registry.get("workspace.reset-layout")).toBe(contribution);
    expect(registry.all()).toEqual([contribution]);
  });

  it("rejects duplicate command ids", () => {
    const registry = new CommandRegistry();

    registry.register(command("workspace.reset-layout"));

    expect(() => registry.register(command("workspace.reset-layout"))).toThrow(
      'Command "workspace.reset-layout" is already registered.',
    );
  });
});
