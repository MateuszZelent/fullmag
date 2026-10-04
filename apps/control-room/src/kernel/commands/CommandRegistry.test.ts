import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

import { CommandRegistry } from "./CommandRegistry";
import { CommandDiagnosticsController } from "./CommandDiagnosticsController";
import type { CommandContext, CommandContribution } from "./commandTypes";
import { SessionCommandCancelledError } from "./commandSessionScope";

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

function setupWithDiagnostics() {
  const diagnostics = new CommandDiagnosticsController();
  const setup = setupWithBus();
  setup.registry.attachDiagnostics(diagnostics);
  return { ...setup, diagnostics };
}

describe("CommandRegistry", () => {
  it("reports obsolete-session cancellation without relabeling it as a failure", async () => {
    const { bus, registry } = setupWithBus();
    const completed = vi.fn();
    bus.on("command:completed", completed);
    registry.register(command("cancel", {
      run: () => { throw new SessionCommandCancelledError(); },
    }));
    expect((await registry.execute("cancel", { source: "test" })).status).toBe("cancelled");
    expect(completed).toHaveBeenCalledWith({ commandId: "cancel", status: "cancelled" });
  });

  it("captures scope before submitted listeners can switch the session", async () => {
    const { bus, registry } = setupWithBus();
    let scope = "session=a&epoch=1";
    let listener: (() => void) | undefined;
    registry.attachSessionScopeSource({
      getScopeKey: () => scope,
      subscribe: (next) => { listener = next; return () => {}; },
    });
    bus.on("command:submitted", () => {
      scope = "session=b&epoch=2";
      listener?.();
    });
    registry.register(command("start", {
      run: (context) => {
        expect(context.sessionScopeKey).toBe("session=a&epoch=1");
        expect(context.isCurrentSessionScope?.()).toBe(false);
        return { status: "cancelled" };
      },
    }));
    expect((await registry.execute("start", { source: "test" })).status).toBe("cancelled");
  });

  it("captures the current scope and permanently fences a pending command across A-B-A", async () => {
    const registry = new CommandRegistry();
    let scope = "session=a&epoch=1";
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    registry.attachSessionScopeSource({
      getScopeKey: () => scope,
      subscribe: (next) => { listener = next; return unsubscribe; },
    });
    let captured!: CommandContext;
    let finish!: () => void;
    registry.register(command("pending", {
      run: async (context) => {
        captured = context;
        await new Promise<void>((resolve) => { finish = resolve; });
        return { status: context.isCurrentSessionScope?.() ? "completed" : "cancelled" };
      },
    }));
    const result = registry.execute("pending", { source: "test" });
    expect(captured.sessionScopeKey).toBe(scope);
    expect(captured.isCurrentSessionScope?.()).toBe(true);
    scope = "session=b&epoch=2";
    listener?.();
    scope = "session=a&epoch=1";
    listener?.();
    expect(captured.isCurrentSessionScope?.()).toBe(false);
    finish();
    expect((await result).status).toBe("cancelled");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps an explicitly stale scope and releases the observer after an error", async () => {
    const registry = new CommandRegistry();
    const unsubscribe = vi.fn();
    registry.attachSessionScopeSource({
      getScopeKey: () => "session=b&epoch=2",
      subscribe: () => unsubscribe,
    });
    registry.register(command("stale", {
      run: (context) => {
        expect(context.sessionScopeKey).toBe("session=a&epoch=1");
        expect(context.isCurrentSessionScope?.()).toBe(false);
        throw new Error("stale");
      },
    }));
    expect((await registry.execute("stale", {
      source: "test", sessionScopeKey: "session=a&epoch=1",
    })).status).toBe("failed");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

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

  it("execute refuses disabled commands before running side effects", async () => {
    const { bus, diagnostics, registry } = setupWithDiagnostics();
    const submitted = vi.fn();
    const completed = vi.fn();
    const runFn = vi.fn(() => ({ status: "completed" as const }));
    bus.on("command:submitted", submitted);
    bus.on("command:completed", completed);
    registry.register(
      command("selection-only", {
        disabledReason: () => "Select an object first.",
        isEnabled: () => false,
        run: runFn,
      }),
    );

    const result = await registry.execute("selection-only", { source: "test" });

    expect(result).toEqual({
      message: "Select an object first.",
      status: "failed",
    });
    expect(runFn).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(diagnostics.list()).toMatchObject([
      {
        commandId: "selection-only",
        disabledReason: "Select an object first.",
        source: "test",
        status: "disabled",
      },
    ]);
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
    const { bus, diagnostics, registry } = setupWithDiagnostics();
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
    expect(diagnostics.list()).toMatchObject([
      {
        commandId: "run-me",
        source: "test",
        status: "submitted",
      },
      {
        commandId: "run-me",
        source: "test",
        status: "completed",
      },
    ]);
  });

  it("passes command input through command context", async () => {
    const { registry } = setupWithBus();
    const runFn = vi.fn(() => ({ status: "completed" as const }));
    registry.register(command("run-with-input", { run: runFn }));

    const result = await registry.execute(
      "run-with-input",
      { source: "test" },
      70,
    );

    expect(result.status).toBe("completed");
    expect(runFn).toHaveBeenCalledWith({ source: "test", input: 70 });
  });

  it("execute returns failed for unknown command", async () => {
    const { diagnostics, registry } = setupWithDiagnostics();
    const result = await registry.execute("nope", {
      source: "test",
      sourceDetail: "missing-case",
    });
    expect(result.status).toBe("failed");
    expect(diagnostics.list()).toMatchObject([
      {
        commandId: "nope",
        message: "Unknown command: nope",
        source: "test",
        sourceDetail: "missing-case",
        status: "missing",
      },
    ]);
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
