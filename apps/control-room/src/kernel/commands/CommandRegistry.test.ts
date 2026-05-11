import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

import { CommandRegistry } from "./CommandRegistry";
import type { CommandContribution } from "./commandTypes";

function command(id: string, extra?: Partial<CommandContribution>): CommandContribution {
  return {
    id,
    title: id,
    group: "test",
    scope: "global",
    run: () => ({ status: "completed" }),
    ...extra,
  };
}

function setupWithBus() {
  const bus = new EventBus<KernelEventMap>();
  const registry = new CommandRegistry();
  registry.attach(bus);
  return { bus, registry };
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

  it("unregister removes a command", () => {
    const registry = new CommandRegistry();
    registry.register(command("test.cmd"));
    registry.unregister("test.cmd");
    expect(registry.get("test.cmd")).toBeUndefined();
  });

  it("byCategory filters by category", () => {
    const registry = new CommandRegistry();
    registry.register(command("a", { category: "geometry" }));
    registry.register(command("b", { category: "mesh" }));
    registry.register(command("c", { category: "geometry" }));

    const geo = registry.byCategory("geometry");
    expect(geo.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("isEnabled returns true when no predicate", () => {
    const registry = new CommandRegistry();
    registry.register(command("cmd"));
    expect(registry.isEnabled("cmd", { source: "test" })).toBe(true);
  });

  it("isEnabled delegates to command predicate", () => {
    const registry = new CommandRegistry();
    registry.register(
      command("cmd", {
        isEnabled: (ctx) => ctx.source === "ribbon",
      }),
    );
    expect(registry.isEnabled("cmd", { source: "ribbon" })).toBe(true);
    expect(registry.isEnabled("cmd", { source: "palette" })).toBe(false);
  });

  it("isActive delegates to command predicate", () => {
    const registry = new CommandRegistry();
    registry.register(
      command("cmd", {
        isActive: (ctx) => ctx.source === "ribbon",
      }),
    );

    expect(registry.isActive("cmd", { source: "ribbon" })).toBe(true);
    expect(registry.isActive("cmd", { source: "palette" })).toBe(false);
    expect(registry.isActive("missing", { source: "ribbon" })).toBe(false);
  });

  it("notifies subscribers after command execution so active state can refresh", async () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register(command("cmd"));
    listener.mockClear();

    await registry.execute("cmd", { source: "test" });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("execute runs command and emits events", async () => {
    const { bus, registry } = setupWithBus();
    const submitted = vi.fn();
    const completed = vi.fn();
    bus.on("command:submitted", submitted);
    bus.on("command:completed", completed);

    const runFn = vi.fn(() => ({ status: "completed" as const }));
    registry.register(command("run-me", { run: runFn }));

    const result = await registry.execute("run-me", { source: "test" });
    expect(result.status).toBe("completed");
    expect(runFn).toHaveBeenCalledWith({ source: "test" });
    expect(submitted).toHaveBeenCalledWith({ commandId: "run-me" });
    expect(completed).toHaveBeenCalledWith({
      commandId: "run-me",
      status: "completed",
    });
  });

  it("execute returns failed for unknown command", async () => {
    const { registry } = setupWithBus();
    const result = await registry.execute("nope", { source: "test" });
    expect(result.status).toBe("failed");
  });

  it("execute catches thrown errors", async () => {
    const { registry } = setupWithBus();
    registry.register(
      command("boom", {
        run: () => { throw new Error("kaboom"); },
      }),
    );
    const result = await registry.execute("boom", { source: "test" });
    expect(result.status).toBe("failed");
    expect(result.message).toBe("kaboom");
  });
});
